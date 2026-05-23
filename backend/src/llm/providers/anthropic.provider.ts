import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';
import { ThinkingFilter } from './thinking-filter';

/**
 * Narrow Anthropic Messages API types — only the fields we actually read/write.
 * Reference: https://docs.anthropic.com/en/api/messages-streaming
 */
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: {
    type: 'text' | 'tool_use';
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

class AnthropicUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`Anthropic HTTP ${status}: ${bodyText.slice(0, 300)}`);
    this.name = 'AnthropicUpstreamError';
  }
}

const TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

/**
 * Native streaming provider for Anthropic Claude (api.anthropic.com).
 *
 * Anthropic's wire format is NOT OpenAI-compatible:
 *   - Auth uses `x-api-key` (no Bearer prefix) + required `anthropic-version`.
 *   - System prompt is a top-level `system` field, not a message turn.
 *   - SSE frames are typed with `event: <name>` lines preceding `data: {...}`.
 *   - Content arrives as ordered "blocks" (text, tool_use, tool_result) rather
 *     than a single `delta.content` stream — tool_use streams JSON args
 *     piece-by-piece via `input_json_delta`.
 *   - Tool definitions use `{name, description, input_schema}` (no wrapper).
 *   - Tool results round-trip as content blocks inside a `user` turn, not a
 *     dedicated `tool` role.
 *
 * Behaviour mirrors the other providers: round 1 is fully buffered so we can
 * detect tool calls BEFORE emitting any user-visible token, then round 2 is
 * streamed directly.
 */
@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly anthropicVersion = '2023-06-01';

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY') ?? '';
    this.model = config.get<string>('LLM_MODEL') ?? 'claude-3-5-haiku-20241022';
    this.baseUrl =
      (config.get<string>('LLM_BASE_URL') ?? '').trim() ||
      'https://api.anthropic.com/v1';
  }

  async *stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk> {
    if (!this.apiKey) {
      yield { type: 'error', message: 'LLM_API_KEY is not configured' };
      return;
    }

    const messages: AnthropicMessage[] = [
      ...req.history.map<AnthropicMessage>((t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: t.content,
      })),
      { role: 'user', content: req.newMessage },
    ];

    const toolDefs = tools.length
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parametersJsonSchema,
        }))
      : undefined;

    // Round 1: buffer all blocks. Anthropic emits text + tool_use as separate
    // indexed blocks; we accumulate them in order so the assistant turn for
    // round 2 can be reconstructed byte-for-byte if needed.
    type ToolCallAccum = { id: string; name: string; rawJson: string };
    const textBlocks: string[] = [];
    const toolCalls: ToolCallAccum[] = [];
    const blockIndex: Record<number, { kind: 'text' | 'tool_use'; ref: number }> = {};
    let stopReason: string | undefined;

    try {
      for await (const evt of this.callStream(messages, toolDefs, req.systemPrompt)) {
        if (evt.type === 'content_block_start') {
          const idx = evt.index ?? 0;
          const cb = evt.content_block;
          if (!cb) continue;
          if (cb.type === 'text') {
            textBlocks.push('');
            blockIndex[idx] = { kind: 'text', ref: textBlocks.length - 1 };
          } else if (cb.type === 'tool_use') {
            toolCalls.push({
              id: cb.id ?? '',
              name: cb.name ?? '',
              rawJson: '',
            });
            blockIndex[idx] = { kind: 'tool_use', ref: toolCalls.length - 1 };
          }
        } else if (evt.type === 'content_block_delta') {
          const idx = evt.index ?? 0;
          const slot = blockIndex[idx];
          if (!slot) continue;
          if (slot.kind === 'text' && evt.delta?.text) {
            textBlocks[slot.ref] += evt.delta.text;
          } else if (slot.kind === 'tool_use' && evt.delta?.partial_json) {
            toolCalls[slot.ref].rawJson += evt.delta.partial_json;
          }
        } else if (evt.type === 'message_delta') {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        }
      }
    } catch (err) {
      this.logger.error(`Anthropic round 1 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    const validCalls = toolCalls.filter((c) => c.name.length > 0);

    if (validCalls.length === 0) {
      const filter = new ThinkingFilter();
      for (const t of textBlocks) {
        if (t.length > 0) {
          for (const out of filter.push(t)) yield out;
        }
      }
      for (const out of filter.flush()) yield out;
      this.warnNonStop(stopReason);
      yield { type: 'done' };
      return;
    }

    // Take the first tool call. The assistant turn we reconstruct for round 2
    // includes all parallel tool_use blocks so Claude sees the full context.
    const call = validCalls[0];
    const parsedArgs = this.safeParseJson(call.rawJson);

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

    // Reconstruct assistant turn: text blocks first, then tool_use blocks,
    // matching the order Anthropic produced them (we don't strictly track
    // interleaving but Claude tolerates the grouped order in practice).
    const assistantBlocks: AnthropicContentBlock[] = [];
    for (const t of textBlocks) {
      if (t.length > 0) assistantBlocks.push({ type: 'text', text: t });
    }
    for (const c of toolCalls) {
      if (c.name) {
        assistantBlocks.push({
          type: 'tool_use',
          id: c.id || `toolu_${c.name}`,
          name: c.name,
          input: this.safeParseJson(c.rawJson),
        });
      }
    }

    const round2Messages: AnthropicMessage[] = [
      ...messages,
      { role: 'assistant', content: assistantBlocks },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id || `toolu_${call.name}`,
            content: JSON.stringify(toolResult),
          },
        ],
      },
    ];

    const filter = new ThinkingFilter();
    let round2Stop: string | undefined;
    try {
      for await (const evt of this.callStream(
        round2Messages,
        toolDefs,
        req.systemPrompt,
      )) {
        if (evt.type === 'content_block_delta' && evt.delta?.text) {
          for (const out of filter.push(evt.delta.text)) yield out;
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          round2Stop = evt.delta.stop_reason;
        }
      }
      for (const out of filter.flush()) yield out;
    } catch (err) {
      this.logger.error(`Anthropic round 2 failed: ${(err as Error).message}`);
      yield { type: 'error', message: this.toUserFacingError(err) };
      return;
    }

    this.warnNonStop(round2Stop);
    yield { type: 'done' };
  }

  private async *callStream(
    messages: AnthropicMessage[],
    tools: unknown,
    systemPrompt: string,
  ): AsyncIterable<AnthropicEvent> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/messages`;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      stream: true,
      messages,
      temperature: 0.4,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (tools) body.tools = tools;

    const res = await this.postWithRetries(url, body);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new AnthropicUpstreamError(res.status, text);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = this.drainFrames(buffer, false);
      for (const c of drained.events) yield c;
      buffer = drained.remainder;
    }
    const tail = this.drainFrames(buffer, true);
    for (const c of tail.events) yield c;
  }

  /**
   * Anthropic SSE frames look like:
   *   event: content_block_delta
   *   data: {"type":"content_block_delta", ... }
   *
   * Frames are separated by a blank line. We parse the `data:` payload and
   * trust the `type` field inside it — the `event:` line is redundant
   * because every payload self-identifies via its `type`.
   */
  private drainFrames(
    buffer: string,
    flushTail: boolean,
  ): { events: AnthropicEvent[]; remainder: string } {
    const events: AnthropicEvent[] = [];
    const sepRe = /\r?\n\r?\n/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = sepRe.exec(buffer)) !== null) {
      const frame = buffer.slice(lastEnd, m.index);
      lastEnd = m.index + m[0].length;
      const parsed = this.parseFrame(frame);
      if (parsed) events.push(parsed);
    }
    let remainder = buffer.slice(lastEnd);
    if (flushTail && remainder.trim().length > 0) {
      const parsed = this.parseFrame(remainder);
      if (parsed) events.push(parsed);
      remainder = '';
    }
    return { events, remainder };
  }

  private parseFrame(frame: string): AnthropicEvent | null {
    const dataLine = frame
      .split(/\r?\n/)
      .find((l) => l.startsWith('data:'));
    if (!dataLine) return null;
    const payload = dataLine.slice(5).trim();
    if (!payload) return null;
    try {
      return JSON.parse(payload) as AnthropicEvent;
    } catch {
      return null;
    }
  }

  private async postWithRetries(url: string, body: unknown): Promise<Response> {
    let res = await this.postOnce(url, body);
    for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
      // 529 is Anthropic-specific "Overloaded".
      if (res.status !== 500 && res.status !== 502 && res.status !== 503 && res.status !== 529) {
        break;
      }
      this.logger.warn(`Anthropic ${res.status}; retrying after ${delay}ms`);
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
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });
  }

  private toUserFacingError(err: unknown): string {
    if (!(err instanceof AnthropicUpstreamError)) return 'LLM unavailable';
    if (err.status === 429) {
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
    if (err.status === 404 || /model:.*not.*found/i.test(err.bodyText)) {
      return 'The configured LLM model was not found. Check LLM_MODEL.';
    }
    if (err.status === 400 && /credit balance is too low/i.test(err.bodyText)) {
      return 'Anthropic account has no available credits. Add billing at console.anthropic.com or switch to a provider with a free tier (LLM_PROVIDER=groq).';
    }
    if (err.status === 529) {
      return 'The LLM provider is overloaded. Please try again in a moment.';
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
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private warnNonStop(stopReason: string | undefined): void {
    if (!stopReason) return;
    if (
      stopReason !== 'end_turn' &&
      stopReason !== 'tool_use' &&
      stopReason !== 'stop_sequence' &&
      stopReason !== 'max_tokens'
    ) {
      this.logger.warn(`Non-standard stop_reason: ${stopReason}`);
    }
  }
}
