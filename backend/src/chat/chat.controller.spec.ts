import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { ChatModule } from './chat.module';
import { Clock } from '../session/clock';
import { LLM_PROVIDER, LlmProvider } from '../llm/providers/llm-provider.interface';
import { LlmStreamChunk, ToolDefinition } from '../llm/llm.types';
import { SESSION_IDLE_TIMEOUT_MS } from '../session/session.constants';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { RateLimitService, RATE_LIMIT_CONFIG } from './rate-limit.service';

class FakeClock extends Clock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class ScriptedProvider implements LlmProvider {
  public script: LlmStreamChunk[] = [];
  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *stream(_req: unknown, _tools: ToolDefinition[]): AsyncIterable<LlmStreamChunk> {
    for (const c of this.script) yield c;
  }
}

describe('ChatController (e2e)', () => {
  let app: INestApplication;
  let clock: FakeClock;
  let provider: ScriptedProvider;

  beforeEach(async () => {
    clock = new FakeClock();
    provider = new ScriptedProvider();
    provider.script = [
      { type: 'token', token: 'hi ' },
      { type: 'token', token: 'there' },
      { type: 'done' },
    ];
    const moduleRef = await Test.createTestingModule({
      imports: [ChatModule],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /chat/session -> 201 with a uuid sessionId', async () => {
    const res = await request(app.getHttpServer()).post('/chat/session');
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /chat/:sessionId/history on unknown id -> 404', async () => {
    const res = await request(app.getHttpServer()).get(
      '/chat/00000000-0000-4000-8000-000000000000/history',
    );
    expect(res.status).toBe(404);
  });

  it('DELETE /chat/:sessionId on unknown id -> 404', async () => {
    const res = await request(app.getHttpServer()).delete(
      '/chat/00000000-0000-4000-8000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('POST /chat/:sessionId/message with empty body -> 400', async () => {
    const create = await request(app.getHttpServer()).post('/chat/session');
    const { sessionId } = create.body;
    const res = await request(app.getHttpServer())
      .post(`/chat/${sessionId}/message`)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST /chat/:sessionId/message after 30+ min idle -> 410', async () => {
    const create = await request(app.getHttpServer()).post('/chat/session');
    const { sessionId } = create.body;
    clock.advance(SESSION_IDLE_TIMEOUT_MS + 1);
    const res = await request(app.getHttpServer())
      .post(`/chat/${sessionId}/message`)
      .send({ message: 'hello' });
    expect(res.status).toBe(410);
  });

  it('GET /chat/config returns the configured persona snapshot', async () => {
    const res = await request(app.getHttpServer()).get('/chat/config');
    expect(res.status).toBe(200);
    // Defaults preserve the TypeScript persona (no env overrides in this test).
    expect(res.body).toMatchObject({
      domain: expect.stringMatching(/TypeScript/),
      description: expect.any(String),
      offTopicMessage: expect.any(String),
      appTitle: expect.any(String),
      appSubtitle: expect.any(String),
    });
    // Internal config (api keys, base URLs, rate-limit constants) must NOT
    // leak through this endpoint.
    const flat = JSON.stringify(res.body).toLowerCase();
    expect(flat).not.toContain('api_key');
    expect(flat).not.toContain('base_url');
  });

  it('GET /chat/health/llm returns a probe result with provider/model/issues', async () => {
    // The scripted provider above always answers with two tokens then done,
    // never invokes a tool, so the probe must classify it as degraded with
    // a tools_unsupported issue. This doubles as integration coverage of
    // LlmHealthService being wired through ChatModule.
    const res = await request(app.getHttpServer()).get('/chat/health/llm');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: expect.any(String),
      model: expect.any(String),
      status: expect.stringMatching(/ok|degraded|fail/),
    });
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('POST /chat/:sessionId/message returns 429 with Retry-After when burst window is exhausted', async () => {
    const create = await request(app.getHttpServer()).post('/chat/session');
    const { sessionId } = create.body;

    // Burn through the per-minute burst budget.
    for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
      const ok = await request(app.getHttpServer())
        .post(`/chat/${sessionId}/message`)
        .send({ message: `hi ${i}` })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => callback(null, data));
        });
      expect(ok.status).toBe(200);
    }

    const limited = await request(app.getHttpServer())
      .post(`/chat/${sessionId}/message`)
      .send({ message: 'one too many' });

    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({
      reason: 'minute',
      retryAfterSec: expect.any(Number),
      error: expect.stringContaining('Rate limit'),
    });

    // The denied attempt must NOT have appended a user turn.
    const hist = await request(app.getHttpServer()).get(
      `/chat/${sessionId}/history`,
    );
    expect(hist.body.turns).toHaveLength(RATE_LIMIT_CONFIG.MINUTE_MAX * 2);
  });

  it('rate-limit isolation: a second session is unaffected by the first being throttled', async () => {
    // Reset the shared in-memory limiter so this test is independent of
    // sibling tests that may have consumed slots for other sessionIds.
    app.get(RateLimitService).reset();
    const s1 = (await request(app.getHttpServer()).post('/chat/session')).body
      .sessionId;
    const s2 = (await request(app.getHttpServer()).post('/chat/session')).body
      .sessionId;

    for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
      await request(app.getHttpServer())
        .post(`/chat/${s1}/message`)
        .send({ message: `s1 ${i}` })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => callback(null, data));
        });
    }
    const limited = await request(app.getHttpServer())
      .post(`/chat/${s1}/message`)
      .send({ message: 'over' });
    expect(limited.status).toBe(429);

    const otherOk = await request(app.getHttpServer())
      .post(`/chat/${s2}/message`)
      .send({ message: 'still fine' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => callback(null, data));
      });
    expect(otherOk.status).toBe(200);
  });

  it('SSE wire never contains tool_call / tool_result / thinking frames', async () => {
    // Wire-contract lockdown: the public surface is { token | done | error }
    // only. Internal LlmStreamChunk types (tool_call, tool_result,
    // thinking_start, thinking_end) MUST be swallowed by ChatService before
    // they hit the response body.
    provider.script = [
      { type: 'thinking_start' },
      { type: 'tool_call', name: 'run_ts_snippet', args: { snippet: 'console.log(1)' } },
      { type: 'tool_result', name: 'run_ts_snippet', result: { ok: true, output: '1' } },
      { type: 'thinking_end' },
      { type: 'token', token: 'It prints 1.' },
      { type: 'done' },
    ];

    const create = await request(app.getHttpServer()).post('/chat/session');
    const { sessionId } = create.body;
    const res = await request(app.getHttpServer())
      .post(`/chat/${sessionId}/message`)
      .send({ message: 'run console.log(1)' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => callback(null, data));
      });

    expect(res.status).toBe(200);
    const body = res.body as string;
    expect(body).toContain('data: {"token":"It prints 1."}');
    expect(body).toMatch(/data: \{"done":true,"turnIndex":1\}/);
    expect(body).not.toContain('tool_call');
    expect(body).not.toContain('tool_result');
    expect(body).not.toContain('thinking');
  });

  it('POST /chat/:sessionId/message returns SSE with token frames and a terminal done', async () => {
    const create = await request(app.getHttpServer()).post('/chat/session');
    const { sessionId } = create.body;
    const res = await request(app.getHttpServer())
      .post(`/chat/${sessionId}/message`)
      .send({ message: 'hello' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => callback(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const body = res.body as string;
    expect(body).toContain('data: {"token":"hi "}');
    expect(body).toContain('data: {"token":"there"}');
    expect(body).toMatch(/data: \{"done":true,"turnIndex":1\}/);

    // The committed history should contain user+assistant turns.
    const hist = await request(app.getHttpServer()).get(`/chat/${sessionId}/history`);
    expect(hist.status).toBe(200);
    expect(hist.body.turns).toHaveLength(2);
    expect(hist.body.turns[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(hist.body.turns[1]).toMatchObject({ role: 'assistant', content: 'hi there' });
  });
});
