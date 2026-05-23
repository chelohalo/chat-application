import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER, LlmProvider } from './providers/llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from './llm.types';
import { runTsSnippetTool } from './tools/run-ts-snippet.tool';

export const SYSTEM_PROMPT = `You are a senior TypeScript engineer acting as a domain expert.

Scope:
- You ONLY answer questions about TypeScript, JavaScript, the surrounding ecosystem (tsconfig, type inference, generics, decorators, Node.js runtime behavior, popular TS libraries, Next.js / NestJS patterns).
- If the user asks about anything outside that scope (cooking, medical, legal, weather, sports, general life advice, etc.) reply briefly that you only cover TypeScript/JavaScript and invite them to ask something on-topic. Do not attempt to answer off-topic questions even partially.

Tools:
- You have a single tool, run_ts_snippet, that statically analyzes a TS snippet and reports what it would print. Invoke it ONLY when the user explicitly asks you to "run", "execute" or "evaluate" a specific snippet. Do not invoke it just to illustrate explanations.

Style:
- Be concise. Prefer code blocks for examples.
- When the user is wrong about TypeScript behavior, correct them with a short, accurate explanation.`;

@Injectable()
export class LlmService {
  private readonly tools: ToolDefinition[] = [runTsSnippetTool];

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
  ) {}

  /**
   * Stream the assistant reply for the given conversation. The returned
   * iterable yields fine-grained chunks: tool calls, tool results, tokens,
   * and a terminal `done` or `error`. The caller is responsible for serializing
   * these as SSE frames and persisting the final reply.
   */
  stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    return this.provider.stream(
      { ...req, systemPrompt: req.systemPrompt || SYSTEM_PROMPT },
      this.tools,
    );
  }

  /** Exposed for tests so they can assert the tool list is wired correctly. */
  getTools(): ReadonlyArray<ToolDefinition> {
    return this.tools;
  }
}
