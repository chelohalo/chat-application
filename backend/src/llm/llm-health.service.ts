import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';

export type LlmIssueKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'tools_unsupported'
  | 'thinking_inline'
  | 'model_not_found'
  | 'empty_response'
  | 'unreachable';

export interface LlmIssue {
  kind: LlmIssueKind;
  message: string;
  suggestion?: string;
}

export interface LlmHealth {
  status: 'ok' | 'degraded' | 'fail';
  provider: string;
  model: string;
  issues: LlmIssue[];
  lastChecked: number | null;
}

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Proactive health probe for the configured LlmProvider.
 *
 * The probe runs TWO short streams against the real upstream:
 *   1. Text ping: "Reply with the single word ok." A successful response
 *      tells us auth + quota are OK and the model produces visible text. If
 *      the stream returns nothing we record `empty_response`; if `<think>`
 *      blocks leak through the visible token stream we record
 *      `thinking_inline` so the UI knows to surface a hint.
 *   2. Tool ping: prompt the model to invoke run_ts_snippet on a trivial
 *      snippet. If no tool_call chunk is emitted, the model either doesn't
 *      support OpenAI/Anthropic-style tool calling or chose to ignore the
 *      tool — either way our run_ts_snippet feature won't work and the UI
 *      surfaces `tools_unsupported`.
 *
 * Results are cached for CACHE_TTL_MS so the endpoint stays cheap even
 * under repeated polling from the UI.
 */
@Injectable()
export class LlmHealthService {
  private readonly logger = new Logger(LlmHealthService.name);
  private cached: LlmHealth | null = null;
  private inflight: Promise<LlmHealth> | null = null;

  constructor(
    private readonly llm: LlmService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns cached health if fresh; otherwise runs a probe and caches it.
   * Concurrent callers share the in-flight probe instead of duplicating it.
   */
  async getHealth(forceRefresh = false): Promise<LlmHealth> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cached &&
      this.cached.lastChecked &&
      now - this.cached.lastChecked < CACHE_TTL_MS
    ) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.probe().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async probe(): Promise<LlmHealth> {
    const provider = this.detectProviderLabel();
    const model = this.config.get<string>('LLM_MODEL') ?? '(default)';
    const issues: LlmIssue[] = [];

    if (provider === 'mock') {
      // Mock provider trivially passes every probe; skip the upstream traffic.
      const health: LlmHealth = {
        status: 'ok',
        provider,
        model,
        issues: [],
        lastChecked: Date.now(),
      };
      this.cached = health;
      return health;
    }

    const textResult = await this.runProbe(
      'Reply with the single word ok.',
      'Reply with exactly the word "ok". No punctuation.',
    );
    if (textResult.error) {
      issues.push(this.classifyError(textResult.error));
    } else {
      if (textResult.text.trim().length === 0) {
        issues.push({
          kind: 'empty_response',
          message: 'Model returned no visible text on a basic prompt.',
          suggestion:
            'The model may be filtered or misconfigured. Try a different LLM_MODEL.',
        });
      }
      if (textResult.sawThinkingTag) {
        issues.push({
          kind: 'thinking_inline',
          message:
            'Model emits <think>…</think> reasoning blocks inline. The app filters them automatically so you only see the final answer.',
        });
      }
    }

    // Skip the tool ping if the first call already failed (saves upstream
    // budget and a redundant entry in the issues list).
    if (!textResult.error) {
      const toolResult = await this.runProbe(
        'Use the run_ts_snippet tool on this snippet: console.log("ok")',
        'When the user asks to run, execute, or evaluate a snippet, invoke the run_ts_snippet tool with the snippet. Do not answer in text first.',
      );
      if (toolResult.error) {
        // Surface only if the error is actionable (e.g. tools rejected).
        if (/tool/i.test(toolResult.error.message)) {
          issues.push({
            kind: 'tools_unsupported',
            message: `Model does not appear to support tool calling: ${toolResult.error.message}`,
            suggestion: this.toolSuggestion(),
          });
        }
        // Other errors (transient 5xx after the text ping worked) we ignore.
      } else if (!toolResult.sawToolCall) {
        issues.push({
          kind: 'tools_unsupported',
          message:
            'Model did not invoke the tool even when explicitly instructed. The run_ts_snippet feature will not work.',
          suggestion: this.toolSuggestion(),
        });
      }
    }

    const status: LlmHealth['status'] = (() => {
      if (issues.length === 0) return 'ok';
      const fatal = issues.some(
        (i) => i.kind === 'auth' || i.kind === 'quota' || i.kind === 'unreachable' || i.kind === 'model_not_found',
      );
      return fatal ? 'fail' : 'degraded';
    })();

    const health: LlmHealth = {
      status,
      provider,
      model,
      issues,
      lastChecked: Date.now(),
    };
    this.cached = health;
    this.logger.log(
      `Health probe: status=${status}, issues=[${issues.map((i) => i.kind).join(',') || 'none'}]`,
    );
    return health;
  }

  private detectProviderLabel(): string {
    const explicit = (this.config.get<string>('LLM_PROVIDER') ?? '')
      .toLowerCase()
      .trim();
    if (explicit) return explicit;
    const apiKey = this.config.get<string>('LLM_API_KEY');
    if (!apiKey) return 'mock';
    const baseUrl = this.config.get<string>('LLM_BASE_URL') ?? '';
    const model = this.config.get<string>('LLM_MODEL') ?? '';
    if (/^claude-/i.test(model) || /api\.anthropic\.com/.test(baseUrl)) {
      return 'anthropic';
    }
    if (/generativelanguage\.googleapis\.com/.test(baseUrl)) return 'gemini';
    return 'openai';
  }

  private toolSuggestion(): string {
    return 'Try a model with explicit tool-calling support: llama-3.3-70b-versatile (Groq), gpt-4o-mini (OpenAI), claude-3-5-haiku-20241022 (Anthropic), or gemini-2.5-flash (Google).';
  }

  /**
   * Drive the full LlmService.stream() pipeline (including the round 1
   * buffering + tool-call loop) with a short timeout. Captures whether any
   * error chunk was emitted, whether a tool_call chunk was emitted, the
   * concatenated visible text, and whether `<think>` markers slipped through.
   */
  private async runProbe(
    message: string,
    systemPrompt: string,
  ): Promise<{
    text: string;
    sawToolCall: boolean;
    sawThinkingTag: boolean;
    error: { message: string } | null;
  }> {
    let text = '';
    let sawToolCall = false;
    let error: { message: string } | null = null;

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    try {
      const iter = this.llm.stream({
        history: [],
        newMessage: message,
        systemPrompt,
      });
      for await (const chunk of iter) {
        if (Date.now() > deadline) {
          error = { message: 'Probe timed out' };
          break;
        }
        if (chunk.type === 'token') text += chunk.token;
        else if (chunk.type === 'tool_call') sawToolCall = true;
        else if (chunk.type === 'error') {
          error = { message: chunk.message };
          break;
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (err) {
      error = { message: (err as Error).message };
    }

    const sawThinkingTag = /<think>|<\/think>|<thinking>/i.test(text);
    return { text, sawToolCall, sawThinkingTag, error };
  }

  private classifyError(err: { message: string }): LlmIssue {
    const m = err.message.toLowerCase();
    // Quota checks must come BEFORE the auth check: the provider's quota
    // message intentionally mentions "API key" ("API key is valid but has no
    // available credits") so users can map the issue back to their config.
    // Falling into the auth branch first would mis-classify a billing
    // problem as a key problem.
    if (/no available credits|insufficient_quota|no remaining quota|credit balance/.test(m)) {
      return {
        kind: 'quota',
        message: 'LLM API key has no available credits.',
        suggestion:
          'Add billing at the provider, or switch to LLM_PROVIDER=groq for a free tier.',
      };
    }
    if (/daily quota|free-tier daily/.test(m)) {
      return {
        kind: 'quota',
        message: 'LLM free-tier daily quota is exhausted.',
        suggestion: 'Try a different LLM_MODEL/key or come back tomorrow.',
      };
    }
    if (/unauthor|api key|missing|invalid_api_key/.test(m)) {
      return {
        kind: 'auth',
        message: 'LLM API key is invalid or missing.',
        suggestion: 'Verify LLM_API_KEY in the backend environment.',
      };
    }
    if (/rate limited|try again in/.test(m)) {
      return {
        kind: 'rate_limit',
        message: err.message,
        suggestion: 'This is transient. The next request should succeed.',
      };
    }
    if (/model.*not.*found|configured llm model/.test(m)) {
      return {
        kind: 'model_not_found',
        message: 'Configured LLM_MODEL is not available on this provider.',
        suggestion: 'Check LLM_MODEL spelling or pick one from env.example.',
      };
    }
    if (/temporarily unavailable|overloaded|unreachable/.test(m)) {
      return {
        kind: 'unreachable',
        message: 'LLM provider is currently unreachable or overloaded.',
        suggestion: 'Retry in a minute; check the provider status page.',
      };
    }
    return {
      kind: 'unreachable',
      message: err.message,
    };
  }
}
