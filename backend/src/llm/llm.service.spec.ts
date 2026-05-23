import { LlmService } from './llm.service';
import { LLM_PROVIDER, LlmProvider } from './providers/llm-provider.interface';
import { Test } from '@nestjs/testing';
import { LlmRequest, LlmStreamChunk, ToolDefinition } from './llm.types';
import { GeminiLlmProvider } from './providers/gemini.provider';
import { ConfigService } from '@nestjs/config';

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

describe('LlmService', () => {
  it('forwards history + newMessage to provider with a default system prompt', async () => {
    const provider = new RecordingProvider([
      { type: 'token', token: 'hello' },
      { type: 'done' },
    ]);
    const svc = new LlmService(provider);
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

  it('exposes the run_ts_snippet tool to the provider', async () => {
    const provider = new RecordingProvider([{ type: 'done' }]);
    const svc = new LlmService(provider);
    await collect(svc.stream({ history: [], newMessage: 'hi', systemPrompt: '' }));
    expect(provider.capturedTools?.map((t) => t.name)).toEqual(['run_ts_snippet']);
  });

  it('forwards the full tool_call -> tool_result -> token sequence to the caller', async () => {
    const provider = new RecordingProvider([
      { type: 'tool_call', name: 'run_ts_snippet', args: { snippet: 'console.log(1)' } },
      { type: 'tool_result', name: 'run_ts_snippet', result: { ok: true, output: '1' } },
      { type: 'token', token: 'It ' },
      { type: 'token', token: 'prints 1.' },
      { type: 'done' },
    ]);
    const svc = new LlmService(provider);
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

  it('emits a single error chunk when the upstream HTTP call fails', async () => {
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
    expect(out).toEqual([{ type: 'error', message: 'LLM unavailable' }]);
  });
});
