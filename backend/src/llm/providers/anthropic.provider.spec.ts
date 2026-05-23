import { ConfigService } from '@nestjs/config';
import { AnthropicLlmProvider } from './anthropic.provider';
import { ToolDefinition } from '../llm.types';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/**
 * Build an Anthropic-style SSE stream. Anthropic frames each event with
 *   event: <type>\n
 *   data: <json>\n\n
 * — the `event:` line is mandatory for spec compliance but we ignore it in
 * the provider's parser (the JSON payload self-identifies via its `type`).
 */
function anthropicSse(events: Array<{ type: string; [k: string]: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(
          encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
        );
      }
      controller.close();
    },
  });
}

describe('AnthropicLlmProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('streams text-only completions when the model does NOT invoke a tool', async () => {
    const stream = anthropicSse([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);

    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    let body: Record<string, unknown> | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledHeaders = init.headers as Record<string, string>;
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        body: stream,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new AnthropicLlmProvider(
      new ConfigService({
        LLM_API_KEY: 'sk-ant-test',
        LLM_MODEL: 'claude-3-5-haiku-20241022',
      }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 'sys' }, []),
    );

    expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(calledHeaders['x-api-key']).toBe('sk-ant-test');
    expect(calledHeaders['anthropic-version']).toBe('2023-06-01');
    expect(body!.model).toBe('claude-3-5-haiku-20241022');
    expect(body!.stream).toBe(true);
    expect(body!.system).toBe('sys');
    expect(out.filter((c) => c.type === 'token').map((c) => (c as { token: string }).token).join('')).toBe('Hello world');
    expect(out.at(-1)).toEqual({ type: 'done' });
  });

  it('runs the tool_use -> handler -> tool_result -> final-token loop end to end', async () => {
    // Round 1: model emits a single tool_use block; args stream as input_json_delta chunks.
    const round1 = anthropicSse([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'run_ts_snippet',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"snippet":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"console.log(2+2)"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);
    // Round 2: final answer streamed as text.
    const round2 = anthropicSse([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'It prints 4.' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
    const responses = [round1, round2];
    const requests: Record<string, unknown>[] = [];
    global.fetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        body: responses.shift()!,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const toolInvocations: Record<string, unknown>[] = [];
    const tool: ToolDefinition = {
      name: 'run_ts_snippet',
      description: 'stub',
      parametersJsonSchema: { type: 'object' },
      handler: async (args) => {
        toolInvocations.push(args);
        return { ok: true, output: '4' };
      },
    };
    const provider = new AnthropicLlmProvider(
      new ConfigService({
        LLM_API_KEY: 'sk-ant-test',
        LLM_MODEL: 'claude-3-5-haiku-20241022',
      }),
    );
    const out = await collect(
      provider.stream(
        { history: [], newMessage: 'run console.log(2+2)', systemPrompt: 'sys' },
        [tool],
      ),
    );

    expect(toolInvocations).toEqual([{ snippet: 'console.log(2+2)' }]);
    expect(requests).toHaveLength(2);

    // Round 2 must include the assistant tool_use block AND a user tool_result.
    const r2messages = (requests[1].messages as Array<{
      role: string;
      content: unknown;
    }>);
    const assistant = r2messages.at(-2);
    const user = r2messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(Array.isArray(assistant?.content)).toBe(true);
    const assistantContent = assistant!.content as Array<{ type: string; id?: string }>;
    const toolUseBlock = assistantContent.find((b) => b.type === 'tool_use');
    expect(toolUseBlock?.id).toBe('toolu_abc');
    expect(user?.role).toBe('user');
    const userContent = user!.content as Array<{ type: string; tool_use_id?: string }>;
    expect(userContent[0].type).toBe('tool_result');
    expect(userContent[0].tool_use_id).toBe('toolu_abc');

    // Tool lifecycle surfaces in order.
    expect(out.map((c) => c.type)).toEqual(['tool_call', 'tool_result', 'token', 'done']);
    expect(out.find((c) => c.type === 'token')).toMatchObject({ token: 'It prints 4.' });
  });

  it('maps 401 to an auth-related message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"invalid x-api-key"}}',
      body: null,
    })) as unknown as typeof fetch;
    const provider = new AnthropicLlmProvider(
      new ConfigService({ LLM_API_KEY: 'bad', LLM_MODEL: 'claude-3-5-haiku-20241022' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/api key/i);
  });

  it('maps 400 with "credit balance is too low" to a billing message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Your credit balance is too low to access the Claude API."}}',
      body: null,
    })) as unknown as typeof fetch;
    const provider = new AnthropicLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'claude-3-5-haiku-20241022' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/no available credits|billing/i);
  });

  it('retries on 529 overloaded before giving up', async () => {
    let attempt = 0;
    global.fetch = (async () => {
      attempt++;
      if (attempt <= 2) {
        return {
          ok: false,
          status: 529,
          text: async () => 'overloaded',
          body: null,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: anthropicSse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'recovered' },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new AnthropicLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'claude-3-5-haiku-20241022' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(attempt).toBe(3);
    expect(out.filter((c) => c.type === 'token')).toEqual([
      { type: 'token', token: 'recovered' },
    ]);
  });

  it('honours LLM_BASE_URL override (gateway-style routing)', async () => {
    let calledUrl = '';
    global.fetch = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        body: anthropicSse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new AnthropicLlmProvider(
      new ConfigService({
        LLM_API_KEY: 'k',
        LLM_MODEL: 'claude-3-5-haiku-20241022',
        LLM_BASE_URL: 'http://my-anthropic-proxy:8080/v1',
      }),
    );
    await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(calledUrl).toBe('http://my-anthropic-proxy:8080/v1/messages');
  });
});
