import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  /**
   * Streams the model response. If the model issues a tool call, the provider
   * is responsible for invoking the tool handler and continuing the loop
   * before emitting the first user-visible token.
   */
  stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk>;
}
