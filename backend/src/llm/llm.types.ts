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
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}
