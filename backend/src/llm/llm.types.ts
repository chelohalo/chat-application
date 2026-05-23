import { Turn } from '../session/session.types';

export interface LlmRequest {
  history: Turn[];
  newMessage: string;
  systemPrompt: string;
}

export type LlmStreamChunk =
  | { type: 'token'; token: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: unknown }
  /**
   * Signals that the model has entered a chain-of-thought / reasoning block
   * (typically a `<think>...</think>` span). The provider hides the contents
   * from the visible token stream; the chat service translates these markers
   * into `{thinking:true}` / `{thinking:false}` SSE events so the UI can
   * surface a "Thinking..." indicator distinct from the typing dots.
   */
  | { type: 'thinking_start' }
  | { type: 'thinking_end' }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}
