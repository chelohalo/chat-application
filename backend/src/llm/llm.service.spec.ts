import { LlmService } from './llm.service';
import { LLM_PROVIDER, LlmProvider } from './providers/llm-provider.interface';
import { Test } from '@nestjs/testing';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from './llm.types';
import { GeminiLlmProvider } from './providers/gemini.provider';
import { ConfigService } from '@nestjs/config';
import { ExpertConfigService } from '../config/expert-config.service';

class RecordingProvider implements LlmProvider {
  capturedReq?: LlmRequest;
  capturedTools?: ToolDefinition[];
  constructor(private readonly script: LlmStreamChunk[]) {}

  async *stream(
    req: LlmRequest,
    tools: ToolDefinition[],
  ): AsyncIterable<LlmStreamChunk> {
    this.capturedReq = req;
    this.capturedTools = tools;
    for (const c of this.script) yield c;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/**
 * Construct ExpertConfigService against an in-memory env so tests don't
 * depend on process.env state. Pass `env` to override individual values.
 */
function buildExpertConfig(
  env: Record<string, string | undefined> = {},
): ExpertConfigService {
  const cfg = {
    get: <T = string>(key: string): T | undefined => env[key] as T | undefined,
  } as unknown as ConfigService;
  return new ExpertConfigService(cfg);
}

describe('LlmService', () => {
  it('forwards history + newMessage to provider with a default system prompt', async () => {
    const provider = new RecordingProvider([
      { type: 'token', token: 'hello' },
      { type: 'done' },
    ]);
    const svc = new LlmService(provider, buildExpertConfig());
    const out = await collect(
      svc.stream({
        history: [
          { turnIndex: 0, role: 'user', content: 'prev', createdAt: 0 },
        ],
        newMessage: 'what is a generic?',
        systemPrompt: '',
      }),
    );
    expect(provider.capturedReq?.newMessage).toBe('what is a generic?');
    expect(provider.capturedReq?.history).toHaveLength(1);
    expect(provider.capturedReq?.systemPrompt).toMatch(/TypeScript/);
    expect(out).toEqual([
      { type: 'token', token: 'hello' },
      { type: 'done' },
    ]);
  });

  it('exposes the default tool name (run_ts_snippet) to the provider', async () => {
    const provider = new RecordingProvider([{ type: 'done' }]);
    const svc = new LlmService(provider, buildExpertConfig());
    await collect(svc.stream({ history: [], newMessage: 'hi', systemPrompt: '' }));
    expect(provider.capturedTools?.map((t) => t.name)).toEqual(['run_ts_snippet']);
  });

  it('renames the tool when EXPERT_TOOL_NAME is set', async () => {
    const provider = new RecordingProvider([{ type: 'done' }]);
    const svc = new LlmService(
      provider,
      buildExpertConfig({ EXPERT_TOOL_NAME: 'lookup_stats' }),
    );
    await collect(svc.stream({ history: [], newMessage: 'hi', systemPrompt: '' }));
    expect(provider.capturedTools?.map((t) => t.name)).toEqual(['lookup_stats']);
  });

  it('uses the configured persona in the synthesized system prompt', async () => {
    const provider = new RecordingProvider([{ type: 'done' }]);
    const svc = new LlmService(
      provider,
      buildExpertConfig({
        EXPERT_DOMAIN: 'sports',
        EXPERT_DESCRIPTION: 'You are a sports expert.',
        OFF_TOPIC_MESSAGE: 'I can only answer questions related to sports.',
        EXPERT_TOOL_NAME: 'lookup_stats',
        EXPERT_TOOL_DESCRIPTION: 'Look up sports stats.',
      }),
    );
    await collect(svc.stream({ history: [], newMessage: 'hi', systemPrompt: '' }));
    expect(provider.capturedReq?.systemPrompt).toContain('You are a sports expert.');
    expect(provider.capturedReq?.systemPrompt).toContain('sports');
    expect(provider.capturedReq?.systemPrompt).toContain('lookup_stats');
    expect(provider.capturedReq?.systemPrompt).not.toMatch(/TypeScript/);
  });

  it('forwards the full tool_call -> tool_result -> token sequence to the caller', async () => {
    const provider = new RecordingProvider([
      { type: 'tool_call', name: 'run_ts_snippet', args: { snippet: 'console.log(1)' } },
      { type: 'tool_result', name: 'run_ts_snippet', result: { ok: true, output: '1' } },
      { type: 'token', token: 'It ' },
      { type: 'token', token: 'prints 1.' },
      { type: 'done' },
    ]);
    const svc = new LlmService(provider, buildExpertConfig());
    const out = await collect(
      svc.stream({ history: [], newMessage: 'run this', systemPrompt: '' }),
    );
    expect(out.map((c) => c.type)).toEqual([
      'tool_call',
      'tool_result',
      'token',
      'token',
      'done',
    ]);
  });

  it('can be wired through the NestJS DI container using LLM_PROVIDER token', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmService,
        {
          provide: LLM_PROVIDER,
          useValue: new RecordingProvider([{ type: 'done' }]),
        },
        { provide: ExpertConfigService, useValue: buildExpertConfig() },
      ],
    }).compile();
    const svc = moduleRef.get(LlmService);
    const out = await collect(
      svc.stream({ history: [], newMessage: 'hi', systemPrompt: '' }),
    );
    expect(out).toEqual([{ type: 'done' }]);
  });
});

describe('GeminiLlmProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function sseStream(frames: object[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const f of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        controller.close();
      },
    });
  }

  it('runs the tool_use -> handler -> tool_result -> final-token loop end to end', async () => {
    const round1 = sseStream([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'run_ts_snippet', args: { snippet: 'console.log(2+2)' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const round2 = sseStream([
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'It prints 4.' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    const responses = [round1, round2];
    const fetchCalls: { url: string; body: unknown }[] = [];
    global.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, body: JSON.parse(init.body as string) });
      return {
        ok: true,
        body: responses.shift()!,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const config = new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.0-flash' });
    const provider = new GeminiLlmProvider(config);

    const toolCalls: string[] = [];
    const tool: ToolDefinition = {
      name: 'run_ts_snippet',
      description: 'stub',
      parametersJsonSchema: { type: 'object' },
      handler: async (args) => {
        toolCalls.push(JSON.stringify(args));
        return { ok: true, output: '4' };
      },
    };

    const out = await collect(
      provider.stream(
        { history: [], newMessage: 'run console.log(2+2)', systemPrompt: 'sys' },
        [tool],
      ),
    );

    expect(toolCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(2);
    // Final answer text only appears AFTER tool_call + tool_result.
    const types = out.map((c) => c.type);
    expect(types).toEqual(['tool_call', 'tool_result', 'token', 'done']);
    expect(out.find((c) => c.type === 'token')).toMatchObject({ token: 'It prints 4.' });
  });

  it('maps a 500 from the upstream to a transient-outage user message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
      body: new ReadableStream(),
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'error' });
    expect((out[0] as { message: string }).message).toMatch(
      /temporarily unavailable/i,
    );
  });

  it('maps a 429 with "retry in Xs" into a rate-limit message containing the wait time', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () =>
        '{"error":{"code":429,"message":"Quota exceeded. Please retry in 22.5s."}}',
      body: new ReadableStream(),
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/rate limited/i);
    expect((out[0] as { message: string }).message).toMatch(/~23s/);
  });

  it('maps a 429 with "limit: 0" into a daily-quota-exhausted message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () =>
        'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.0-flash',
      body: new ReadableStream(),
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/daily quota/i);
  });

  function okStreamWith(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text }] },
                  finishReason: 'STOP',
                },
              ],
            })}\r\n\r\n`,
          ),
        );
        controller.close();
      },
    });
  }

  it('retries up to TWO times on transient 5xx and surfaces success', async () => {
    let attempt = 0;
    global.fetch = (async () => {
      attempt++;
      if (attempt <= 2) {
        return {
          ok: false,
          status: attempt === 1 ? 500 : 503,
          text: async () => 'transient',
          body: null,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: okStreamWith('recovered'),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(attempt).toBe(3);
    expect(out.filter((c) => c.type === 'token')).toEqual([
      { type: 'token', token: 'recovered' },
    ]);
  });

  it('gives up after exhausting the 5xx retry budget and surfaces a transient error', async () => {
    let attempt = 0;
    global.fetch = (async () => {
      attempt++;
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal error encountered',
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(attempt).toBe(3); // 1 original + 2 retries
    expect((out[0] as { message: string }).message).toMatch(
      /temporarily unavailable/i,
    );
  });

  it('does NOT retry on 4xx (quota / auth / bad request)', async () => {
    let attempt = 0;
    global.fetch = (async () => {
      attempt++;
      return {
        ok: false,
        status: 429,
        text: async () => 'rate limited',
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(attempt).toBe(1);
  });

  it('maps a 401/403 into a missing-api-key message', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
      body: new ReadableStream(),
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(new ConfigService({ LLM_API_KEY: 'k' }));
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect((out[0] as { message: string }).message).toMatch(/api key/i);
  });

  it('parses SSE frames whether the server uses LF or CRLF blank-line separators', async () => {
    // Regression: Google's generativelanguage streaming endpoint terminates
    // each SSE event with "\r\n\r\n". A parser that only splits on "\n\n"
    // (or that hard-requires a trailing blank line) leaves the entire stream
    // unconsumed in the buffer and returns zero tokens, even on a 200 OK.
    const encoder = new TextEncoder();
    const crlfStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'Hello' }] },
                },
              ],
            })}\r\n\r\n`,
          ),
        );
        // Last frame intentionally has NO trailing separator — server closed
        // the connection right after the final byte of the JSON payload.
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: ' world' }] },
                  finishReason: 'STOP',
                },
              ],
            })}`,
          ),
        );
        controller.close();
      },
    });
    global.fetch = (async () => ({
      ok: true,
      body: crlfStream,
      text: async () => '',
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.5-flash' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    const tokens = out
      .filter((c): c is { type: 'token'; token: string } => c.type === 'token')
      .map((c) => c.token);
    expect(tokens.join('')).toBe('Hello world');
    expect(out.at(-1)).toEqual({ type: 'done' });
  });

  it('handles SSE frames split across multiple reader chunks', async () => {
    // Defensive: the network can split a single frame's bytes across reads,
    // including in the middle of the "\r\n\r\n" separator. The parser must
    // wait for the full separator before flushing.
    const encoder = new TextEncoder();
    const wholeFrame =
      'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'tok1' }] },
            finishReason: 'STOP',
          },
        ],
      }) +
      '\r\n\r\n';
    const bytes = encoder.encode(wholeFrame);
    const splitStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Cut right between '\r\n' and '\r\n' — i.e. inside the separator.
        const mid = bytes.length - 2;
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    global.fetch = (async () => ({
      ok: true,
      body: splitStream,
      text: async () => '',
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.5-flash' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    expect(out.filter((c) => c.type === 'token')).toEqual([
      { type: 'token', token: 'tok1' },
    ]);
  });

  it('strips chain-of-thought parts (thought: true) from the streamed output', async () => {
    // Gemma 4 always emits "thoughts" before the final answer and rejects
    // thinkingConfig. The parser must filter these server-side so the user
    // never sees raw chain-of-thought tokens in the chat bubble.
    const stream = sseStream([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: '*   Topic: generics. *   Draft 1:', thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'reusable components.', thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Final answer here.' }],
              // No `thought` field on the real answer.
            },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    global.fetch = (async () => ({
      ok: true,
      body: stream,
      text: async () => '',
    })) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemma-4-26b-a4b-it' }),
    );
    const out = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );
    const tokens = out
      .filter((c): c is { type: 'token'; token: string } => c.type === 'token')
      .map((c) => c.token);
    expect(tokens).toEqual(['Final answer here.']);
    expect(out.at(-1)).toEqual({ type: 'done' });
  });

  it('auto-falls back without thinkingConfig when the server rejects it with 400, and remembers it for subsequent calls', async () => {
    // Simulates: provider is configured for a 2.5-family model (so it WOULD
    // send thinkingConfig), but the server responds with the exact 400 that
    // gemma returns. The provider must observe, drop the field, retry, and
    // succeed — and not re-send thinkingConfig on the NEXT request either.
    const sentBodies: { generationConfig?: Record<string, unknown> }[] = [];
    let phase = 0;
    global.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sentBodies.push(body);
      phase++;
      if (phase === 1) {
        // First call goes out WITH thinkingConfig; server rejects.
        return {
          ok: false,
          status: 400,
          clone() {
            return {
              text: async () => 'Thinking budget is not supported for this model.',
            } as unknown as Response;
          },
          text: async () => 'Thinking budget is not supported for this model.',
          body: null,
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: okStreamWith('hello'),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.5-flash' }),
    );
    const out1 = await collect(
      provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []),
    );

    expect(phase).toBe(2); // initial 400 + 1 fallback retry
    expect(sentBodies[0].generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(sentBodies[1].generationConfig?.thinkingConfig).toBeUndefined();
    expect(out1.filter((c) => c.type === 'token')).toEqual([
      { type: 'token', token: 'hello' },
    ]);

    // Second request from the SAME provider must skip thinkingConfig outright.
    await collect(
      provider.stream({ history: [], newMessage: 'hi again', systemPrompt: 's' }, []),
    );
    expect(sentBodies[2].generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('does NOT send thinkingConfig to gemma-* models (server rejects it with 400)', async () => {
    const captured: { body: { generationConfig?: Record<string, unknown> } }[] = [];
    const okStream = sseStream([
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    global.fetch = (async (_url: string, init: RequestInit) => {
      captured.push({ body: JSON.parse(init.body as string) });
      return {
        ok: true,
        body: okStream,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemma-4-26b-a4b-it' }),
    );
    await collect(provider.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []));
    expect(captured[0].body.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('disables thinking on gemini-2.5 models, leaves 2.0 untouched', async () => {
    const captured: { url: string; body: { generationConfig?: unknown } }[] = [];
    const okStream = sseStream([
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]);
    let responses = [okStream];
    global.fetch = (async (url: string, init: RequestInit) => {
      captured.push({ url, body: JSON.parse(init.body as string) });
      return {
        ok: true,
        body: responses.shift()!,
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const p25 = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.5-flash' }),
    );
    await collect(p25.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []));
    expect(captured[0].body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 0 },
    });

    responses = [
      sseStream([
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
        },
      ]),
    ];
    const p20 = new GeminiLlmProvider(
      new ConfigService({ LLM_API_KEY: 'k', LLM_MODEL: 'gemini-2.0-flash' }),
    );
    await collect(p20.stream({ history: [], newMessage: 'hi', systemPrompt: 's' }, []));
    expect(
      (captured[1].body.generationConfig as Record<string, unknown>).thinkingConfig,
    ).toBeUndefined();
  });
});
