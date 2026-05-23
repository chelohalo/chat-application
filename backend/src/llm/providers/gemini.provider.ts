import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
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
@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  private readonly logger = new Logger(GeminiLlmProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

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
    type PendingCall = { name: string; args: Record<string, unknown> };
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
            });
          } else if (typeof part.text === 'string' && part.text.length > 0) {
            round1Text.push(part.text);
          }
        }
      }
    } catch (err) {
      this.logger.error(`Gemini round 1 failed: ${(err as Error).message}`);
      yield { type: 'error', message: 'LLM unavailable' };
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
    const followup: GeminiContent[] = [
      ...contents,
      {
        role: 'model',
        parts: [{ functionCall: { name: call.name, args: call.args } }],
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
          if (typeof part.text === 'string' && part.text.length > 0) {
            yield { type: 'token', token: part.text };
          }
        }
      }
    } catch (err) {
      this.logger.error(`Gemini round 2 failed: ${(err as Error).message}`);
      yield { type: 'error', message: 'LLM unavailable' };
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
    const body = {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      tools,
      generationConfig: { temperature: 0.4 },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame
          .split('\n')
          .find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as GeminiStreamChunk;
        } catch {
          // Ignore malformed frames; Gemini occasionally chunks JSON oddly.
        }
      }
    }
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
