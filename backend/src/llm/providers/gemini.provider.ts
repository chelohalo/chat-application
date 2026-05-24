import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';

interface GeminiPart {
  text?: string;
  /**
   * Set to `true` for chain-of-thought tokens that the model produces while
   * "thinking" (notably on Gemma 4, which always emits thoughts and does NOT
   * accept thinkingConfig). These must NEVER be streamed to the user — they
   * contain meta-reasoning, drafts, and self-critique, not the final answer.
   */
  thought?: boolean;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    /**
     * Opaque continuation token emitted by Gemini 2.5+ "thinking" models when
     * they decide to invoke a tool mid-reasoning. Round 2 MUST echo this on
     * the same functionCall part or the API rejects with 400:
     *   "Function call is missing a thought_signature in functionCall parts."
     * Older / non-thinking models (1.5, 2.0, gemma) omit it; the round-2
     * payload just leaves it undefined and stays valid.
     */
    thoughtSignature?: string;
  };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Carries the upstream HTTP status (and a snippet of body) so the caller can
 * map the failure to a user-facing message — quota vs outage vs config error.
 */
class GeminiUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`Gemini HTTP ${status}: ${bodyText.slice(0, 300)}`);
    this.name = 'GeminiUpstreamError';
  }
}

/**
 * Real Gemini streaming provider with one-hop function calling.
 *
 * Loop:
 *   1. POST streamGenerateContent with the user's full history + the tool schema.
 *   2. If the model emits a functionCall part, accumulate it and finish reading
 *      that round WITHOUT yielding any text tokens.
 *   3. Invoke the local tool handler, append both the functionCall and
 *      functionResponse to the conversation, and re-issue streamGenerateContent.
 *   4. Stream text tokens from the second round to the caller. This guarantees
 *      tool resolution completes before the first user-visible token.
 */
/**
 * How many times to retry a transient 5xx from Google before giving up.
 * 2 retries (3 attempts total) covers Gemma's typical "Internal error
 * encountered" double-fault without making the worst-case latency painful.
 */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  private readonly logger = new Logger(GeminiLlmProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  /**
   * Sticky for the lifetime of this provider: once we learn the active model
   * rejects `thinkingConfig` (e.g. all gemma-* variants), we stop sending it
   * on subsequent calls. Saves a round-trip per request and keeps logs clean.
   */
  private thinkingConfigUnsupported = false;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY') ?? '';
    this.model = config.get<string>('LLM_MODEL') ?? 'gemini-2.0-flash';
    this.baseUrl =
      config.get<string>('LLM_BASE_URL') ??
      'https://generativelanguage.googleapis.com/v1beta';
  }

  async *stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', message: 'LLM_API_KEY is not configured' };
      return;
    }

    const contents: GeminiContent[] = [
      ...req.history.map<GeminiContent>((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: t.content }],
      })),
      { role: 'user', parts: [{ text: req.newMessage }] },
    ];

    const toolSchema = tools.length
      ? [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parametersJsonSchema,
            })),
          },
        ]
      : undefined;

    // Round 1: collect all parts first, decide tool vs. final-answer second.
    type PendingCall = {
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    };
    const round1Calls: PendingCall[] = [];
    const round1Text: string[] = [];
    let round1Finish: string | undefined;
    try {
      for await (const chunk of this.callStream(contents, toolSchema, req.systemPrompt)) {
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        round1Finish = candidate.finishReason ?? round1Finish;
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            round1Calls.push({
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              thoughtSignature: part.functionCall.thoughtSignature,
            });
          } else if (
            !part.thought &&
            typeof part.text === 'string' &&
            part.text.length > 0
          ) {
            round1Text.push(part.text);
          }
        }
      }
    } catch (err) {
      this.logger.error(`Gemini round 1 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    // No tool call: stream round 1 text as the final answer.
    if (round1Calls.length === 0) {
      for (const t of round1Text) yield { type: 'token', token: t };
      this.enforceOnTopic(round1Finish);
      yield { type: 'done' };
      return;
    }

    // Take the first tool call (we currently expose one tool and don't fan out).
    const call: PendingCall = round1Calls[0];

    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      yield { type: 'error', message: `Model requested unknown tool: ${call.name}` };
      return;
    }

    yield { type: 'tool_call', name: call.name, args: call.args };
    let toolResult: unknown;
    try {
      toolResult = await tool.handler(call.args);
    } catch (err) {
      this.logger.error(`Tool ${call.name} threw: ${(err as Error).message}`);
      yield { type: 'error', message: 'Tool invocation failed' };
      return;
    }
    yield { type: 'tool_result', name: call.name, result: toolResult };

    // Round 2: send tool result and stream the final answer.
    //
    // The model functionCall part MUST be echoed verbatim, including the
    // thoughtSignature if the model emitted one. Gemini 2.5+ thinking models
    // use the signature to resume their internal reasoning across the tool
    // round-trip; dropping it triggers a 400 "Function call is missing a
    // thought_signature in functionCall parts." Older models omit the field
    // entirely, in which case we leave it undefined and the part stays valid.
    const followup: GeminiContent[] = [
      ...contents,
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: call.name,
              args: call.args,
              ...(call.thoughtSignature !== undefined && {
                thoughtSignature: call.thoughtSignature,
              }),
            },
          },
        ],
      },
      {
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: { result: toolResult },
            },
          },
        ],
      },
    ];

    let round2Finish: string | undefined;
    try {
      for await (const chunk of this.callStream(followup, toolSchema, req.systemPrompt)) {
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        round2Finish = candidate.finishReason ?? round2Finish;
        for (const part of candidate.content?.parts ?? []) {
          if (
            !part.thought &&
            typeof part.text === 'string' &&
            part.text.length > 0
          ) {
            yield { type: 'token', token: part.text };
          }
        }
      }
    } catch (err) {
      this.logger.error(`Gemini round 2 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    this.enforceOnTopic(round2Finish);
    yield { type: 'done' };
  }

  private async *callStream(
    contents: GeminiContent[],
    tools: unknown,
    systemPrompt: string,
  ): AsyncIterable<GeminiStreamChunk> {
    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const buildBody = (): Record<string, unknown> => ({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      tools,
      generationConfig: this.buildGenerationConfig(),
    });

    let res = await this.postWithRetries(url, buildBody());

    // Auto-fallback: if the server rejects `thinkingConfig` (e.g. all gemma-*
    // models respond 400 "Thinking budget is not supported for this model"),
    // remember it for the lifetime of this provider and immediately retry
    // without the offending field. This lets a single provider serve any
    // Google AI Studio model without per-model branching at the call site.
    if (
      res.status === 400 &&
      !this.thinkingConfigUnsupported &&
      this.buildGenerationConfig().thinkingConfig
    ) {
      const text = await res.clone().text().catch(() => '');
      if (/thinking budget/i.test(text)) {
        this.logger.warn(
          `Model ${this.model} does not support thinkingConfig; falling back without it`,
        );
        this.thinkingConfigUnsupported = true;
        res = await this.postWithRetries(url, buildBody());
      }
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new GeminiUpstreamError(res.status, text);
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
    // Flush any final frame that wasn't followed by a trailing blank line.
    const tail = this.drainFrames(buffer, true);
    for (const c of tail.chunks) yield c;
  }

  /**
   * SSE frames per the spec end with a blank line, which the server may encode
   * as either `\n\n` or `\r\n\r\n`. Google's generativelanguage streaming
   * endpoint emits CRLF, so a naive `indexOf('\n\n')` never matches and the
   * entire response sits unconsumed in the buffer. We split on either form
   * and, when `flushTail` is set, also treat the leftover buffer as a final
   * frame so the last event isn't dropped if the trailing separator is short.
   */
  private drainFrames(
    buffer: string,
    flushTail: boolean,
  ): { chunks: GeminiStreamChunk[]; remainder: string } {
    const chunks: GeminiStreamChunk[] = [];
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

  /**
   * POST with N retries on 5xx (controlled by TRANSIENT_RETRY_DELAYS_MS).
   * Returns the last `Response` regardless of status — we let the caller
   * decide whether to consume the body or treat it as an error. We never
   * retry 4xx because those failures are deterministic.
   */
  private async postWithRetries(url: string, body: unknown): Promise<Response> {
    let res = await this.postOnce(url, body);
    for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
      if (res.status !== 500 && res.status !== 503) break;
      this.logger.warn(`Gemini ${res.status}; retrying after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      res = await this.postOnce(url, body);
    }
    return res;
  }

  private postOnce(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private parseSseFrame(frame: string): GeminiStreamChunk | null {
    const dataLine = frame
      .split(/\r?\n/)
      .find((l) => l.startsWith('data:'));
    if (!dataLine) return null;
    const payload = dataLine.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload) as GeminiStreamChunk;
    } catch {
      // Gemini occasionally chunks JSON oddly; skip unparseable frames.
      return null;
    }
  }

  /**
   * Many Google models have "thinking" enabled by default. Combined with a
   * tools schema, this frequently produces a successful response whose
   * `parts` contain only thought chunks (no user-visible text). Disabling
   * thinking via `thinkingBudget: 0` keeps the request snappier and removes
   * the entire class of "empty answer" failures server-side.
   *
   * Strategy:
   *   - Default: opt-in for any model name that historically supports it
   *     (currently the gemini-2.5+ family).
   *   - For models that REJECT thinkingConfig (e.g. all gemma-*), callStream
   *     observes the 400 once, flips `thinkingConfigUnsupported`, and we
   *     drop the field for every subsequent request. Until that learning
   *     happens we still filter `part.thought === true` client-side so the
   *     user never sees chain-of-thought tokens.
   */
  private buildGenerationConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = { temperature: 0.4 };
    if (this.thinkingConfigUnsupported) return config;
    if (/^gemini-(2\.5|3\.)/.test(this.model)) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }
    return config;
  }

  /**
   * Translate an upstream failure into a short message we feel comfortable
   * surfacing to end users. We deliberately keep these short and actionable;
   * the full upstream payload is already in the server log.
   */
  private toUserFacingError(err: unknown): string {
    if (!(err instanceof GeminiUpstreamError)) return 'LLM unavailable';
    if (err.status === 429) {
      const retryMatch = err.bodyText.match(/Please retry in ([\d.]+)\s*s/i);
      const isDaily = /PerDay|free_tier_input_token_count|limit:\s*0/i.test(
        err.bodyText,
      );
      if (isDaily && !retryMatch) {
        return 'The LLM free-tier daily quota is exhausted for this API key. Try again tomorrow or use a different model/key.';
      }
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

  /**
   * Defense-in-depth alongside the system prompt: if the model halted for a
   * non-stop reason like safety or recitation, surface a generic refusal.
   * We can't yield from here so callers should treat finish==='SAFETY' as
   * already-handled and just log.
   */
  private enforceOnTopic(finishReason: string | undefined): void {
    if (!finishReason) return;
    if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      this.logger.warn(`Non-STOP finish reason: ${finishReason}`);
    }
  }
}
