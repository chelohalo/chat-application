import { Injectable } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { LlmService } from '../llm/llm.service';
import { LlmStreamChunk } from '../llm/llm.types';
import { Turn } from '../session/session.types';

export interface ChatStreamEvent {
  /** SSE event name (defaults to "message" if undefined). */
  event?: string;
  /** Payload to be JSON-encoded into the data: line. */
  data: Record<string, unknown>;
}

export const EMPTY_REPLY_FALLBACK =
  "I couldn't generate a response for that. Could you rephrase your question, " +
  'or add more detail about the TypeScript topic you want to explore?';

@Injectable()
export class ChatService {
  constructor(
    private readonly sessions: SessionService,
    private readonly llm: LlmService,
  ) {}

  createSession(): { sessionId: string } {
    const s = this.sessions.create();
    return { sessionId: s.id };
  }

  getHistory(sessionId: string): Turn[] {
    return this.sessions.getHistory(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Validate + record the user turn synchronously, so 404/410 throw as proper
   * HTTP responses BEFORE any SSE headers are flushed. Returns the snapshot
   * of history the LLM should see (without the just-added user turn — that's
   * passed separately as newMessage).
   */
  beginStream(sessionId: string, userMessage: string): Turn[] {
    const session = this.sessions.getActive(sessionId);
    const historySnapshot = [...session.turns];
    this.sessions.appendTurn(sessionId, 'user', userMessage);
    return historySnapshot;
  }

  /**
   * Stream a reply for the user's message as SSE events. Call beginStream
   * first so validation errors surface as HTTP status codes; this generator
   * never throws session-state errors itself.
   *
   *   - token chunks: { token: "..." }
   *   - tool lifecycle: { tool_call: {name, args} } and { tool_result: {name, result} }
   *   - terminal: { done: true, turnIndex: N } or { error: "LLM unavailable" }
   *
   * The assistant turn is committed only once the stream completes successfully
   * so a partial failure doesn't pollute conversation history.
   */
  async *streamReply(
    sessionId: string,
    userMessage: string,
    historySnapshot: Turn[],
  ): AsyncIterable<ChatStreamEvent> {

    let assistantText = '';
    let errored = false;

    try {
      for await (const chunk of this.llm.stream({
        history: historySnapshot,
        newMessage: userMessage,
        systemPrompt: '',
      })) {
        const event = this.toEvent(chunk);
        if (event) yield event;

        if (chunk.type === 'token') assistantText += chunk.token;
        if (chunk.type === 'error') {
          errored = true;
          break;
        }
      }
    } catch {
      errored = true;
      yield { data: { error: 'LLM unavailable' } };
    }

    if (errored) return;

    // Defense against LLMs that complete successfully but produce no text.
    // Gemini 2.5 with tools, safety-filtered prompts, and a few other edge
    // cases can return a clean STOP finish reason with zero text tokens.
    // Without this guard the UI would show an empty assistant bubble.
    if (!assistantText.trim()) {
      assistantText = EMPTY_REPLY_FALLBACK;
      yield { data: { token: assistantText } };
    }

    const turn = this.sessions.appendTurn(sessionId, 'assistant', assistantText);
    yield { data: { done: true, turnIndex: turn.turnIndex } };
  }

  private toEvent(chunk: LlmStreamChunk): ChatStreamEvent | null {
    switch (chunk.type) {
      case 'token':
        return { data: { token: chunk.token } };
      case 'tool_call':
        return { data: { tool_call: { name: chunk.name, args: chunk.args } } };
      case 'tool_result':
        return { data: { tool_result: { name: chunk.name, result: chunk.result } } };
      case 'thinking_start':
        return { data: { thinking: true } };
      case 'thinking_end':
        return { data: { thinking: false } };
      case 'error':
        return { data: { error: chunk.message } };
      case 'done':
        // We emit our own terminal "done" with the persisted turnIndex.
        return null;
    }
  }
}
