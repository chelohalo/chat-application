import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { ChatModule } from './chat.module';
import { Clock } from '../session/clock';
import { LLM_PROVIDER, LlmProvider } from '../llm/providers/llm-provider.interface';
import { LlmStreamChunk, ToolDefinition } from '../llm/llm.types';
import { SESSION_IDLE_TIMEOUT_MS } from '../session/session.constants';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

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
  constructor(private readonly script: LlmStreamChunk[]) {}
  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *stream(_req: unknown, _tools: ToolDefinition[]): AsyncIterable<LlmStreamChunk> {
    for (const c of this.script) yield c;
  }
}

describe('ChatController (e2e)', () => {
  let app: INestApplication;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock();
    const moduleRef = await Test.createTestingModule({
      imports: [ChatModule],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(LLM_PROVIDER)
      .useValue(
        new ScriptedProvider([
          { type: 'token', token: 'hi ' },
          { type: 'token', token: 'there' },
          { type: 'done' },
        ]),
      )
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
