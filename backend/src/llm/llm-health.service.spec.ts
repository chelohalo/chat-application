import { ConfigService } from '@nestjs/config';
import { LlmHealthService } from './llm-health.service';
import { LlmService } from './llm.service';
import { LlmRequest, LlmStreamChunk } from './llm.types';

/**
 * Test-only LlmService stub that lets each test inject a custom chunk
 * sequence per call. The probe runs two streams (text ping + tool ping),
 * so we model that as a FIFO queue of programmed responses.
 */
class StubLlmService {
  programmed: LlmStreamChunk[][] = [];
  calls: LlmRequest[] = [];

  push(chunks: LlmStreamChunk[]): void {
    this.programmed.push(chunks);
  }

  stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.calls.push(req);
    const chunks = this.programmed.shift() ?? [{ type: 'done' } as LlmStreamChunk];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

function makeService(
  stub: StubLlmService,
  env: Record<string, string> = {},
): LlmHealthService {
  return new LlmHealthService(
    stub as unknown as LlmService,
    new ConfigService({
      LLM_API_KEY: 'k',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-4o-mini',
      ...env,
    }),
  );
}

describe('LlmHealthService', () => {
  it('reports status=ok when both pings succeed and the tool is invoked', async () => {
    const stub = new StubLlmService();
    stub.push([
      { type: 'token', token: 'ok' },
      { type: 'done' },
    ]);
    stub.push([
      { type: 'tool_call', name: 'run_ts_snippet', args: { snippet: 'console.log("ok")' } },
      { type: 'tool_result', name: 'run_ts_snippet', result: { ok: true } },
      { type: 'token', token: 'Done.' },
      { type: 'done' },
    ]);

    const health = await makeService(stub).getHealth();
    expect(health.status).toBe('ok');
    expect(health.issues).toEqual([]);
    expect(stub.calls).toHaveLength(2);
  });

  it('classifies auth errors as fatal', async () => {
    const stub = new StubLlmService();
    stub.push([
      { type: 'error', message: 'LLM API key is missing or unauthorized.' },
    ]);
    const health = await makeService(stub).getHealth();
    expect(health.status).toBe('fail');
    expect(health.issues[0].kind).toBe('auth');
    expect(health.issues[0].suggestion).toMatch(/LLM_API_KEY/i);
    // Tool ping skipped after the first failure to save budget.
    expect(stub.calls).toHaveLength(1);
  });

  it('classifies insufficient-credits / quota errors as fatal', async () => {
    const stub = new StubLlmService();
    stub.push([
      {
        type: 'error',
        message:
          'LLM API key is valid but has no available credits. Add billing at the provider...',
      },
    ]);
    const health = await makeService(stub).getHealth();
    expect(health.status).toBe('fail');
    expect(health.issues[0].kind).toBe('quota');
  });

  it('flags tools_unsupported as degraded (not fatal) when the model never invokes the tool', async () => {
    const stub = new StubLlmService();
    stub.push([
      { type: 'token', token: 'ok' },
      { type: 'done' },
    ]);
    stub.push([
      { type: 'token', token: "I won't use the tool." },
      { type: 'done' },
    ]);

    const health = await makeService(stub).getHealth();
    expect(health.status).toBe('degraded');
    expect(health.issues.some((i) => i.kind === 'tools_unsupported')).toBe(true);
  });

  it('flags thinking_inline when the text ping leaks <think> markers', async () => {
    const stub = new StubLlmService();
    stub.push([
      { type: 'token', token: 'before <think>oops</think> ok' },
      { type: 'done' },
    ]);
    stub.push([
      { type: 'tool_call', name: 'run_ts_snippet', args: {} },
      { type: 'tool_result', name: 'run_ts_snippet', result: {} },
      { type: 'token', token: 'fine' },
      { type: 'done' },
    ]);

    const health = await makeService(stub).getHealth();
    expect(health.status).toBe('degraded');
    expect(health.issues.some((i) => i.kind === 'thinking_inline')).toBe(true);
  });

  it('caches results for 5 minutes so repeated probes are free', async () => {
    const stub = new StubLlmService();
    stub.push([{ type: 'token', token: 'ok' }, { type: 'done' }]);
    stub.push([
      { type: 'tool_call', name: 'run_ts_snippet', args: {} },
      { type: 'tool_result', name: 'run_ts_snippet', result: {} },
      { type: 'done' },
    ]);
    const svc = makeService(stub);
    const first = await svc.getHealth();
    const second = await svc.getHealth();
    expect(stub.calls.length).toBe(2);
    expect(second.lastChecked).toBe(first.lastChecked);
  });

  it('skips upstream traffic entirely for the mock provider', async () => {
    const stub = new StubLlmService();
    const health = await makeService(stub, { LLM_PROVIDER: 'mock' }).getHealth();
    expect(stub.calls.length).toBe(0);
    expect(health.status).toBe('ok');
    expect(health.provider).toBe('mock');
  });

  it('deduplicates concurrent probes through a shared in-flight promise', async () => {
    const stub = new StubLlmService();
    stub.push([{ type: 'token', token: 'ok' }, { type: 'done' }]);
    stub.push([
      { type: 'tool_call', name: 'run_ts_snippet', args: {} },
      { type: 'tool_result', name: 'run_ts_snippet', result: {} },
      { type: 'done' },
    ]);
    const svc = makeService(stub);
    const [a, b] = await Promise.all([svc.getHealth(), svc.getHealth()]);
    expect(a).toBe(b);
    expect(stub.calls.length).toBe(2);
  });
});
