import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER, LlmProvider } from './providers/llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from './llm.types';
import { buildExpertTool } from './tools/run-ts-snippet.tool';
import { ExpertConfigService } from '../config/expert-config.service';

@Injectable()
export class LlmService {
  private readonly tools: ToolDefinition[];

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly expertConfig: ExpertConfigService,
  ) {
    // Built once at boot so the model always sees a consistent tool name
    // even though ExpertConfigService.toolName is technically a getter.
    this.tools = [buildExpertTool(expertConfig)];
  }

  /**
   * Stream the assistant reply for the given conversation. The returned
   * iterable yields fine-grained chunks: tool calls, tool results, tokens,
   * and a terminal `done` or `error`. The caller is responsible for serializing
   * these as SSE frames and persisting the final reply.
   *
   * If the caller doesn't supply a systemPrompt, we synthesize one from the
   * configured persona via ExpertConfigService. ChatService never passes a
   * non-empty prompt, so this fallback is what actually drives the model
   * persona in production.
   */
  stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    return this.provider.stream(
      {
        ...req,
        systemPrompt: req.systemPrompt || this.expertConfig.buildSystemPrompt(),
      },
      this.tools,
    );
  }

  /** Exposed for tests so they can assert the tool list is wired correctly. */
  getTools(): ReadonlyArray<ToolDefinition> {
    return this.tools;
  }
}
