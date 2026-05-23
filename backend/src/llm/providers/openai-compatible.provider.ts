import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';
import { ThinkingFilter } from './thinking-filter';

/**
 * OpenAI Chat Completions request/response shapes — narrow types covering
 * only the fields we actually read or write.
 */
interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface OAIDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OAIDeltaToolCall[];
}

interface OAIChoice {
  index?: number;
  delta?: OAIDelta;
  finish_reason?: string | null;
}

interface OAIStreamChunk {
  choices?: OAIChoice[];
}

class OpenAIUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`OpenAI-compat HTTP ${status}: ${bodyText.slice(0, 300)}`);
    this.name = 'OpenAIUpstreamError';
  }
}

/** Retry budget for transient 5xx, matched to the Gemini provider's policy. */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

/**
 * Streaming provider for ANY OpenAI Chat Completions-compatible endpoint.
 *
 * Verified working with:
 *   - OpenAI               LLM_BASE_URL=https://api.openai.com/v1
 *   - Groq                 LLM_BASE_URL=https://api.groq.com/openai/v1
 *   - Cerebras             LLM_BASE_URL=https://api.cerebras.ai/v1
 *   - Together AI          LLM_BASE_URL=https://api.together.xyz/v1
 *   - OpenRouter           LLM_BASE_URL=https://openrouter.ai/api/v1
 *   - Mistral La Plateforme LLM_BASE_URL=https://api.mistral.ai/v1
 *   - Ollama (local)       LLM_BASE_URL=http://localhost:11434/v1
 *
 * Behaviour:
 *   1. Round 1 fully buffered. We need to know whether the model intends to
 *      call a tool BEFORE we stream the first user-visible token — that's the
 *      assignment's "tool_use → handler → tool_result → final response cycle
 *      must complete before the first token is streamed" requirement.
 *   2. If the buffered round 1 contained no tool_calls, we re-emit the
 *      accumulated text as token chunks (chunked roughly by whitespace so the
 *      UI still feels like streaming).
 *   3. If it contained tool_calls, we invoke the handler, build the OpenAI
 *      `role:'tool'` turn, and stream round 2 token-by-token directly to the
 *      caller — no buffering there since the assistant has committed to a
 *      final answer.
 */
@Injectable()
export class OpenAICompatibleLlmProvider implements LlmProvider {
  private readonly logger = new Logger(OpenAICompatibleLlmProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  /**
   * Default endpoint per vendor alias. Saves the user from having to set
   * LLM_BASE_URL when they pick a well-known vendor: setting
   * LLM_PROVIDER=groq is enough to route to api.groq.com.
   *
   * Explicit LLM_BASE_URL always wins — useful for self-hosted OpenAI-compat
   * gateways (LiteLLM, vLLM, etc.) and for vendors that ship region-specific
   * endpoints.
   */
  private static readonly VENDOR_BASE_URLS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    'openai-compatible': 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    together: 'https://api.together.xyz/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    mistral: 'https://api.mistral.ai/v1',
    ollama: 'http://localhost:11434/v1',
  };

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY') ?? '';
    this.model = config.get<string>('LLM_MODEL') ?? 'gpt-4o-mini';
    const explicitUrl = (config.get<string>('LLM_BASE_URL') ?? '').trim();
    const vendor = (config.get<string>('LLM_PROVIDER') ?? '')
      .toLowerCase()
      .trim();
    this.baseUrl =
      explicitUrl ||
      OpenAICompatibleLlmProvider.VENDOR_BASE_URLS[vendor] ||
      OpenAICompatibleLlmProvider.VENDOR_BASE_URLS.openai;
  }

  /** Public so LlmModule can log the resolved endpoint for operator clarity. */
  get resolvedBaseUrl(): string {
    return this.baseUrl;
  }

  async *stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', message: 'LLM_API_KEY is not configured' };
      return;
    }

    const messages: OAIMessage[] = [
      { role: 'system', content: req.systemPrompt },
      ...req.history.map<OAIMessage>((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: t.content,
      })),
      { role: 'user', content: req.newMessage },
    ];

    const toolDefs = tools.length
      ? tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parametersJsonSchema,
          },
        }))
      : undefined;

    // Round 1: fully buffer so we can branch on tool_calls vs. text.
    let round1Text = '';
    const round1Calls: { id: string; name: string; args: string }[] = [];
    let round1Finish: string | null = null;
    try {
      for await (const chunk of this.callStream(messages, toolDefs)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) round1Finish = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') round1Text += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const slot = round1Calls[tc.index];
            if (!slot) {
              round1Calls[tc.index] = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              };
            } else {
              if (tc.id && !slot.id) slot.id = tc.id;
              if (tc.function?.name && !slot.name) slot.name = tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`OpenAI-compat round 1 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    const validCalls = round1Calls.filter((c) => c && c.name.length > 0);

    if (validCalls.length === 0) {
      // No tool — re-emit the buffered text as fake token chunks, run through
      // the thinking filter so any `<think>...</think>` reasoning gets
      // surfaced as thinking_start/end markers instead of leaking to the user.
      const filter = new ThinkingFilter();
      for (const part of this.chunkText(round1Text)) {
        for (const out of filter.push(part)) yield out;
      }
      for (const out of filter.flush()) yield out;
      this.enforceOnTopic(round1Finish);
      yield { type: 'done' };
      return;
    }

    // Take the first tool call. The assistant turn (with all tool_calls)
    // is still appended verbatim to messages so the model has full context.
    const call = validCalls[0];
    const parsedArgs = this.safeParseJson(call.args);

    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      yield { type: 'error', message: `Model requested unknown tool: ${call.name}` };
      return;
    }

    yield { type: 'tool_call', name: call.name, args: parsedArgs };
    let toolResult: unknown;
    try {
      toolResult = await tool.handler(parsedArgs);
    } catch (err) {
      this.logger.error(`Tool ${call.name} threw: ${(err as Error).message}`);
      yield { type: 'error', message: 'Tool invocation failed' };
      return;
    }
    yield { type: 'tool_result', name: call.name, result: toolResult };

    const round2Messages: OAIMessage[] = [
      ...messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: round1Calls
          .filter((c) => c && c.name.length > 0)
          .map((c) => ({
            id: c.id || `call_${c.name}`,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args || '{}' },
          })),
      },
      {
        role: 'tool',
        tool_call_id: call.id || `call_${call.name}`,
        content: JSON.stringify(toolResult),
      },
    ];

    // Round 2 can be streamed directly: the model has already decided to
    // produce a textual final answer. We still run tokens through the
    // thinking filter — some reasoning models like to think *again* after
    // seeing the tool result before committing to their final answer.
    const filter = new ThinkingFilter();
    let round2Finish: string | null = null;
    try {
      for await (const chunk of this.callStream(round2Messages, toolDefs)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) round2Finish = choice.finish_reason;
        const tok = choice.delta?.content;
        if (typeof tok === 'string' && tok.length > 0) {
          for (const out of filter.push(tok)) yield out;
        }
      }
      for (const out of filter.flush()) yield out;
    } catch (err) {
      this.logger.error(`OpenAI-compat round 2 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    this.enforceOnTopic(round2Finish);
    yield { type: 'done' };
  }

  private async *callStream(
    messages: OAIMessage[],
    tools: unknown,
  ): AsyncIterable<OAIStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      tools,
      stream: true,
      temperature: 0.4,
    };

    let res = await this.postWithRetries(url, body);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new OpenAIUpstreamError(res.status, text);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = this.drainFrames(buffer, false);
      for (const c of drained.chunks) yield c;
      buffer = drained.remainder;
    }
    const tail = this.drainFrames(buffer, true);
    for (const c of tail.chunks) yield c;
  }

  /**
   * SSE frame parser. Same dual-separator (\n\n or \r\n\r\n) approach we use
   * for Gemini, plus support for the OpenAI-specific `[DONE]` sentinel.
   */
  private drainFrames(
    buffer: string,
    flushTail: boolean,
  ): { chunks: OAIStreamChunk[]; remainder: string } {
    const chunks: OAIStreamChunk[] = [];
    const sepRe = /\r?\n\r?\n/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = sepRe.exec(buffer)) !== null) {
      const frame = buffer.slice(lastEnd, m.index);
      lastEnd = m.index + m[0].length;
      const parsed = this.parseSseFrame(frame);
      if (parsed) chunks.push(parsed);
    }
    let remainder = buffer.slice(lastEnd);
    if (flushTail && remainder.trim().length > 0) {
      const parsed = this.parseSseFrame(remainder);
      if (parsed) chunks.push(parsed);
      remainder = '';
    }
    return { chunks, remainder };
  }

  private parseSseFrame(frame: string): OAIStreamChunk | null {
    const dataLine = frame
      .split(/\r?\n/)
      .find((l) => l.startsWith('data:'));
    if (!dataLine) return null;
    const payload = dataLine.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload) as OAIStreamChunk;
    } catch {
      return null;
    }
  }

  private async postWithRetries(url: string, body: unknown): Promise<Response> {
    let res = await this.postOnce(url, body);
    for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
      if (res.status !== 500 && res.status !== 502 && res.status !== 503) break;
      this.logger.warn(`OpenAI-compat ${res.status}; retrying after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      res = await this.postOnce(url, body);
    }
    return res;
  }

  private postOnce(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  private toUserFacingError(err: unknown): string {
    if (!(err instanceof OpenAIUpstreamError)) return 'LLM unavailable';
    if (err.status === 429) {
      // OpenAI returns 429 + "insufficient_quota" both when credits ran out
      // AND when the account simply has no prepaid credits configured (since
      // 2023 new OpenAI accounts have a $0 quota until billing is set up).
      // The API key itself is valid in both cases, so 401 isn't appropriate.
      // We surface a message that covers both reads without misleading the
      // user into thinking they consumed budget they never had.
      if (/insufficient[_ ]quota/i.test(err.bodyText)) {
        return 'LLM API key is valid but has no available credits. Add billing at the provider (e.g. platform.openai.com/settings/organization/billing) or switch to a provider with a free tier (LLM_PROVIDER=groq).';
      }
      const retryMatch = err.bodyText.match(/try again in ([\d.]+)\s*s/i);
      if (retryMatch) {
        const seconds = Math.max(1, Math.ceil(Number(retryMatch[1])));
        return `Rate limited by the LLM. Please try again in ~${seconds}s.`;
      }
      return 'Rate limited by the LLM. Please try again in a minute.';
    }
    if (err.status === 401 || err.status === 403) {
      return 'LLM API key is missing or unauthorized. Check the backend configuration.';
    }
    if (err.status === 404) {
      return 'The configured LLM model was not found. Check LLM_MODEL.';
    }
    if (err.status >= 500) {
      return 'The LLM provider is temporarily unavailable. Please try again in a moment.';
    }
    return 'LLM unavailable';
  }

  private safeParseJson(s: string): Record<string, unknown> {
    if (!s) return {};
    try {
      const parsed = JSON.parse(s) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Splits buffered round-1 text into small "fake token" chunks so the UI
   * still feels streamy. Whitespace-preserving so reconstructing the full
   * string is just `chunks.join('')`.
   */
  private chunkText(s: string): string[] {
    if (!s) return [];
    return s.split(/(\s+)/).filter((p) => p.length > 0);
  }

  private enforceOnTopic(finishReason: string | null): void {
    if (!finishReason) return;
    if (
      finishReason !== 'stop' &&
      finishReason !== 'length' &&
      finishReason !== 'tool_calls'
    ) {
      this.logger.warn(`Non-stop finish reason: ${finishReason}`);
    }
  }
}
