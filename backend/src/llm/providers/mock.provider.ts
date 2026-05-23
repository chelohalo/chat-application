import { Injectable, Logger } from '@nestjs/common';
import { LlmProvider } from './llm-provider.interface';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from '../llm.types';
import { ExpertConfigService } from '../../config/expert-config.service';

/**
 * Deterministic, network-free provider used when no LLM_API_KEY is configured
 * and in unit tests. Demonstrates the tool-call loop: if the user asks the model
 * to "run" or "evaluate" something, we invoke the configured tool first and
 * then stream a reply that references the tool result.
 *
 * Persona copy (refusal, on-topic reply) is pulled from ExpertConfigService
 * so swapping EXPERT_DOMAIN / OFF_TOPIC_MESSAGE in env immediately changes
 * the mock's outputs too.
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  private readonly logger = new Logger(MockLlmProvider.name);

  constructor(private readonly expertConfig: ExpertConfigService) {}

  async *stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk> {
    const lower = req.newMessage.toLowerCase();
    const offTopic = this.detectOffTopic(lower);

    if (offTopic) {
      for (const token of this.tokenize(this.expertConfig.offTopicMessage)) {
        yield { type: 'token', token };
      }
      yield { type: 'done' };
      return;
    }

    const wantsRun = /\b(run|evaluate|execute)\b/.test(lower);
    let toolNote = '';

    if (wantsRun) {
      const toolName = this.expertConfig.toolName;
      const tool = tools.find((t) => t.name === toolName);
      if (tool) {
        const snippet = this.extractSnippet(req.newMessage) ?? req.newMessage;
        yield {
          type: 'tool_call',
          name: tool.name,
          args: { snippet },
        };
        try {
          const result = await tool.handler({ snippet });
          yield { type: 'tool_result', name: tool.name, result };
          const parsed = result as { output?: string };
          toolNote = ` Based on the sandbox, the output would be: ${parsed.output ?? '(no output)'}.`;
        } catch (err) {
          this.logger.warn(`Tool ${tool.name} failed: ${(err as Error).message}`);
          yield { type: 'error', message: 'Tool invocation failed.' };
          return;
        }
      }
    }

    const reply =
      `Here is what I can tell you about that ${this.expertConfig.domain} question.${toolNote} ` +
      'Let me know if you want me to dig deeper.';

    for (const token of this.tokenize(reply)) {
      yield { type: 'token', token };
    }
    yield { type: 'done' };
  }

  private tokenize(s: string): string[] {
    // Naive whitespace token split with the space preserved on the trailing side.
    return s.split(/(\s+)/).filter((p) => p.length > 0);
  }

  private extractSnippet(msg: string): string | null {
    const fenced = msg.match(/```(?:ts|typescript)?\n([\s\S]*?)```/i);
    return fenced ? fenced[1] : null;
  }

  private detectOffTopic(lower: string): boolean {
    // Lightweight heuristic that mirrors what the system prompt enforces.
    // This is mock-only and intentionally TypeScript-leaning; swapping
    // EXPERT_DOMAIN at the real-provider layer is what actually drives
    // refusal in production. On non-TS domains these terms may misfire
    // (e.g. EXPERT_DOMAIN=cooking + "recipe" -> still flagged off-topic).
    const offTopicTerms = [
      'recipe',
      'weather',
      'stock price',
      'medical',
      'legal advice',
    ];
    return offTopicTerms.some((t) => lower.includes(t));
  }
}
