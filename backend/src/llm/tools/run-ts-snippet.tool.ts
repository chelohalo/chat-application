import { ToolDefinition } from '../llm.types';
import { ExpertConfigService } from '../../config/expert-config.service';

export interface RunTsSnippetResult {
  ok: boolean;
  output: string;
  note: string;
}

/**
 * Stub handler shared by every persona. The "execution" is a deterministic
 * string analyzer — we report what we *would* run and return canned output —
 * so the tool_use -> handler -> tool_result -> final response cycle is fully
 * wired without ever evaluating arbitrary code inside the container.
 *
 * Different domains can rename the tool via EXPERT_TOOL_NAME and rewrite
 * its description via EXPERT_TOOL_DESCRIPTION; the handler logic stays the
 * same because for non-TS personas the model is instructed by the system
 * prompt not to invoke the tool anyway.
 */
function handler(args: Record<string, unknown>): RunTsSnippetResult {
  const snippet = typeof args.snippet === 'string' ? args.snippet : '';
  const trimmed = snippet.trim();
  if (!trimmed) {
    return { ok: false, output: '', note: 'No snippet provided.' };
  }

  const lines = trimmed.split('\n').length;
  const consoleMatches = trimmed.match(/console\.log\([^)]*\)/g) ?? [];
  const simulatedOutput =
    consoleMatches.length > 0
      ? consoleMatches.map((c) => `[stubbed] ${c}`).join('\n')
      : '[stubbed] (no console.log calls detected)';

  return {
    ok: true,
    output: simulatedOutput,
    note: `Stub TS sandbox: analyzed ${lines} line(s). Replace with a real isolated-vm or tsx-runner in production.`,
  };
}

/**
 * Build the single tool exposed to the model, parameterized by the
 * configured persona. Default name/description preserve the original
 * TypeScript behavior so existing tests + sample interactions still pass.
 */
export function buildExpertTool(config: ExpertConfigService): ToolDefinition {
  return {
    name: config.toolName,
    description: config.toolDescription,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        snippet: {
          type: 'string',
          description:
            'A self-contained input the tool should analyze (e.g. a TypeScript snippet under 40 lines).',
        },
      },
      required: ['snippet'],
    },
    handler,
  };
}
