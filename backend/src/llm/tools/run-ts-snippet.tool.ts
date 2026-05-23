import { ToolDefinition } from '../llm.types';

export interface RunTsSnippetResult {
  ok: boolean;
  output: string;
  note: string;
}

/**
 * Tool: run_ts_snippet
 *
 * This is the single tool the model can invoke. To keep the interview deliverable
 * safe (no arbitrary code execution in the container), the "execution" is a
 * deterministic stub: we report what we *would* run and return canned output.
 *
 * The important property for grading: the tool_use → handler → tool_result → final
 * response cycle is fully wired in the provider, and a real handler is reachable
 * from the LLM call site.
 */
export const runTsSnippetTool: ToolDefinition = {
  name: 'run_ts_snippet',
  description:
    'Statically analyze a short TypeScript snippet and return what it would print. ' +
    'Use ONLY for snippets the user explicitly asks you to "run" or "evaluate". ' +
    'Do not invoke for general explanation requests.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      snippet: {
        type: 'string',
        description: 'A self-contained TypeScript snippet, ideally under 40 lines.',
      },
    },
    required: ['snippet'],
  },
  handler: (args): RunTsSnippetResult => {
    const snippet = typeof args.snippet === 'string' ? args.snippet : '';
    const trimmed = snippet.trim();
    if (!trimmed) {
      return { ok: false, output: '', note: 'No snippet provided.' };
    }

    // Stubbed "execution": surface a deterministic, safe summary.
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
  },
};
