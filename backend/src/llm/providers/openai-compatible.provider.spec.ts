import { ConfigService } from '@nestjs/config';
import { OpenAICompatibleLlmProvider } from './openai-compatible.provider';
import { ToolDefinition } from '../llm.types';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function sseStream(frames: object[], opts?: { trailingDone?: boolean }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      if (opts?.trailingDone !== false) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      controller.close();
    },
  });
}

describe('OpenAICompatibleLlmProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('streams text-only completions when the model does NOT invoke a tool', async () => {
    const stream = sseStream([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    let body: Record<string, unknown> | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(url).toMatch(/\/chat\/completions$/);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
      return {
        ok: true,
        status: 200,
        body: stream,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'llama-3.3-70b' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 'sys' }, []),
    );
    expect(body!.model).toBe('llama-3.3-70b');
    expect(body!.stream).toBe(true);
    expect((body!.messages as { role: string }[])[0].role).toBe('system');
    expect(out.filter((c) => c.type === 'token').map((c) => (c as { token: string }).token).join('')).toBe('Hello world');
    expect(out.at(-1)).toEqual({ type: 'done' });
  });

  it('runs the tool_use -> handler -> tool_result -> final-token loop end to end', async () => {
    const round1 = sseStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'run_ts_snippet', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"snippet":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"console.log(2+2)"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const round2 = sseStream([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: 'It prints 4.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
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
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'llama-3.3-70b' }),
    );
    const out = await collect(
      provider.stream(
        { history: [], newMessage: 'run console.log(2+2)', systemPrompt: 'sys' },
        [tool],
      ),
    );

    expect(toolInvocations).toEqual([{ snippet: 'console.log(2+2)' }]);
    expect(requests).toHaveLength(2);
    // Round 2 messages must include the assistant tool_call AND the tool result.
    const r2messages = (requests[1].messages as { role: string; content?: string | null; tool_call_id?: string }[]);
    expect(r2messages.at(-2)?.role).toBe('assistant');
    expect(r2messages.at(-1)?.role).toBe('tool');
    expect(r2messages.at(-1)?.tool_call_id).toBe('call_abc');
    // Tool lifecycle is surfaced to the caller in order.
    expect(out.map((c) => c.type)).toEqual(['tool_call', 'tool_result', 'token', 'done']);
    expect(out.find((c) => c.type === 'token')).toMatchObject({ token: 'It prints 4.' });
  });

  it('translates 401 into an unauthorized message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Invalid API key"}}',
      body: null,
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'bad' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/api key/i);
  });

  it('translates 429 + insufficient_quota into a "no credits" message (different from rate limiting)', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () =>
        '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
      body: null,
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    const msg = (out[0] as { message: string }).message;
    expect(msg).toMatch(/no available credits/i);
    expect(msg).not.toMatch(/rate limited/i);
    expect(msg).toMatch(/billing|groq/i);
  });

  it('translates 429 with retry hint into a rate-limit message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limit reached. Please try again in 12.7s.',
      body: null,
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/rate limited/i);
    expect((out[0] as { message: string }).message).toMatch(/~13s/);
  });

  it('retries up to TWO times on transient 5xx before surfacing failure', async () => {
    let attempt = 0;
    global.fetch = (async () => {
      attempt++;
      if (attempt <= 2) {
        return {
          ok: false,
          status: attempt === 1 ? 500 : 502,
          text: async () => 'gateway hiccup',
          body: null,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          { choices: [{ delta: { content: 'recovered' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(attempt).toBe(3);
    expect(out.filter((c) => c.type === 'token')).toEqual([
      { type: 'token', token: 'recovered' },
    ]);
  });

  describe('vendor alias → base URL auto-resolution', () => {
    const cases: Array<[string, string]> = [
      ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
      ['cerebras', 'https://api.cerebras.ai/v1/chat/completions'],
      ['together', 'https://api.together.xyz/v1/chat/completions'],
      ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
      ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
      ['ollama', 'http://localhost:11434/v1/chat/completions'],
      ['openai', 'https://api.openai.com/v1/chat/completions'],
    ];

    it.each(cases)('LLM_PROVIDER=%s routes to %s without needing LLM_BASE_URL', async (vendor, expectedUrl) => {
      let calledUrl = '';
      global.fetch = (async (url: string) => {
        calledUrl = url;
        return {
          ok: true,
          status: 200,
          body: sseStream([
            { choices: [{ delta: { content: 'ok' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]),
          text: async () => '',
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const provider = new OpenAICompatibleLlmProvider(
        new ConfigService({ LLM_API_KEY: 'k', LLM_PROVIDER: vendor }),
      );
      expect(provider.resolvedBaseUrl).toBe(expectedUrl.replace('/chat/completions', ''));
      await collect(
        provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
      );
      expect(calledUrl).toBe(expectedUrl);
    });

    it('explicit LLM_BASE_URL overrides the vendor default', () => {
      const provider = new OpenAICompatibleLlmProvider(
        new ConfigService({
          LLM_API_KEY: 'k',
          LLM_PROVIDER: 'groq',
          LLM_BASE_URL: 'http://my-litellm-proxy:4000/v1',
        }),
      );
      expect(provider.resolvedBaseUrl).toBe('http://my-litellm-proxy:4000/v1');
    });

    it('unknown vendor alias falls back to OpenAI default', () => {
      const provider = new OpenAICompatibleLlmProvider(
        new ConfigService({ LLM_API_KEY: 'k', LLM_PROVIDER: 'never-heard-of-it' }),
      );
      expect(provider.resolvedBaseUrl).toBe('https://api.openai.com/v1');
    });
  });

  it('honours a custom LLM_BASE_URL (proves Groq / Cerebras / Ollama / etc. work via the same provider)', async () => {
    let calledUrl = '';
    global.fetch = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          { choices: [{ delta: { content: 'ok' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({
        LLM_API_KEY: 'gsk_groq',
        LLM_BASE_URL: 'https://api.groq.com/openai/v1',
        LLM_MODEL: 'llama-3.3-70b-versatile',
      }),
    );
    await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(calledUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('filters <think> reasoning blocks into thinking_start/end markers and hides the contents', async () => {
    const stream = sseStream([
      { choices: [{ delta: { content: 'Before. ' } }] },
      { choices: [{ delta: { content: '<think>hidden ' } }] },
      { choices: [{ delta: { content: 'reasoning</think> After.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      body: stream,
      text: async () => '',
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('Before.  After.');
    expect(tokenText).not.toContain('hidden');
    expect(out.filter((c) => c.type === 'thinking_start')).toHaveLength(1);
    expect(out.filter((c) => c.type === 'thinking_end')).toHaveLength(1);
  });

  it('tolerates a trailing data:[DONE] sentinel and chunks split across reader boundaries', async () => {
    const encoder = new TextEncoder();
    const whole =
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'split' } }],
      })}\r\n\r\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      })}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    const bytes = encoder.encode(whole);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const mid = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      body: stream,
      text: async () => '',
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(out.filter((c) => c.type === 'token').map((c) => (c as { token: string }).token)).toEqual([
      'split',
    ]);
  });
});
