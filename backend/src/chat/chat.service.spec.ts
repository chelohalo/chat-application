import { ChatService, EMPTY_REPLY_FALLBACK } from './chat.service';
import { SessionService } from '../session/session.service';
import { LlmService } from '../llm/llm.service';
import { Clock } from '../session/clock';
import { LlmStreamChunk } from '../llm/llm.types';

class FakeClock extends Clock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
}

/**
 * Hand-rolled LlmService stub: lets each test inject the sequence of
 * provider chunks ChatService should observe. We don't construct a real
 * LlmService because that would pull in the provider DI graph.
 */
class StubLlm {
  constructor(private readonly script: LlmStreamChunk[]) {}
  stream(): AsyncIterable<LlmStreamChunk> {
    const s = this.script;
    return (async function* () {
      for (const c of s) yield c;
    })();
  }
}

function buildService(script: LlmStreamChunk[]): {
  service: ChatService;
  sessions: SessionService;
} {
  const sessions = new SessionService(new FakeClock());
  const llm = new StubLlm(script) as unknown as LlmService;
  const service = new ChatService(sessions, llm);
  return { service, sessions };
}

async function drain(it: AsyncIterable<{ data: Record<string, unknown> }>): Promise<
  Record<string, unknown>[]
> {
  const out: Record<string, unknown>[] = [];
  for await (const e of it) out.push(e.data);
  return out;
}

describe('ChatService', () => {
  it('streams tokens then commits the assistant turn and emits done', async () => {
    const { service, sessions } = buildService([
      { type: 'token', token: 'hi ' },
      { type: 'token', token: 'there' },
      { type: 'done' },
    ]);
    const s = sessions.create();
    const history = service.beginStream(s.id, 'hola');
    const events = await drain(service.streamReply(s.id, 'hola', history));

    expect(events).toEqual([
      { token: 'hi ' },
      { token: 'there' },
      { done: true, turnIndex: 1 },
    ]);
    const turns = sessions.getHistory(s.id);
    expect(turns[1]).toMatchObject({ role: 'assistant', content: 'hi there' });
  });

  it('emits a fallback token when the LLM completes with zero text', async () => {
    // Reproduces the Gemini 2.5-flash + tools case: stream completes cleanly
    // (no error chunk) but no tokens are produced.
    const { service, sessions } = buildService([{ type: 'done' }]);
    const s = sessions.create();
    const history = service.beginStream(s.id, 'que es typescript?');
    const events = await drain(service.streamReply(s.id, 'que es typescript?', history));

    expect(events).toEqual([
      { token: EMPTY_REPLY_FALLBACK },
      { done: true, turnIndex: 1 },
    ]);
    const turns = sessions.getHistory(s.id);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      content: EMPTY_REPLY_FALLBACK,
    });
  });

  it('treats whitespace-only output as empty and falls back', async () => {
    const { service, sessions } = buildService([
      { type: 'token', token: '   ' },
      { type: 'token', token: '\n\n' },
      { type: 'done' },
    ]);
    const s = sessions.create();
    const history = service.beginStream(s.id, 'hola');
    const events = await drain(service.streamReply(s.id, 'hola', history));

    expect(events.at(-2)).toEqual({ token: EMPTY_REPLY_FALLBACK });
    expect(events.at(-1)).toEqual({ done: true, turnIndex: 1 });
  });

  it('does NOT inject a fallback when the LLM errored mid-stream', async () => {
    const { service, sessions } = buildService([
      { type: 'token', token: 'partial' },
      { type: 'error', message: 'LLM unavailable' },
    ]);
    const s = sessions.create();
    const history = service.beginStream(s.id, 'hola');
    const events = await drain(service.streamReply(s.id, 'hola', history));

    // No done frame, no fallback. The user turn is recorded but no assistant
    // turn is committed (history length stays at 1).
    expect(events).toEqual([{ token: 'partial' }, { error: 'LLM unavailable' }]);
    expect(sessions.getHistory(s.id)).toHaveLength(1);
  });

  it('forwards tool_call and tool_result events to the client', async () => {
    const { service, sessions } = buildService([
      { type: 'tool_call', name: 'run_ts_snippet', args: { snippet: 'console.log(1)' } },
      { type: 'tool_result', name: 'run_ts_snippet', result: { ok: true, output: '1' } },
      { type: 'token', token: 'It prints 1.' },
      { type: 'done' },
    ]);
    const s = sessions.create();
    const history = service.beginStream(s.id, 'run console.log(1)');
    const events = await drain(service.streamReply(s.id, 'run console.log(1)', history));

    expect(events.map((e) => Object.keys(e)[0])).toEqual([
      'tool_call',
      'tool_result',
      'token',
      'done',
    ]);
  });
});
