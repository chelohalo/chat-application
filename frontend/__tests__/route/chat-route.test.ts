/**
 * @jest-environment node
 */

// next/headers cookies() — mocked so the Route Handler reads our test session id.
let mockSessionCookie: string | undefined = 'sess-abc';
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'sid' && mockSessionCookie
        ? { value: mockSessionCookie }
        : undefined,
  }),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/route';
import { __resetRateLimit, RATE_LIMIT_CONFIG } from '@/lib/rate-limit';

function makeReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseUpstream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) {
          controller.enqueue(encoder.encode(`data: ${f}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('/api/chat BFF route handler', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    mockSessionCookie = 'sess-abc';
    __resetRateLimit();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('proxies the upstream SSE stream byte-for-byte', async () => {
    global.fetch = jest.fn(async () =>
      sseUpstream([
        JSON.stringify({ token: 'hi ' }),
        JSON.stringify({ token: 'there' }),
        JSON.stringify({ done: true, turnIndex: 1 }),
      ]),
    ) as unknown as typeof fetch;

    const res = await POST(makeReq({ message: 'hello' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await readAll(res.body!);
    expect(body).toContain('data: {"token":"hi "}');
    expect(body).toContain('data: {"token":"there"}');
    expect(body).toContain('"done":true');
  });

  it('returns {sessionExpired: true} JSON when NestJS returns 410', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'gone' }), { status: 410 }),
    ) as unknown as typeof fetch;
    const res = await POST(makeReq({ message: 'hello' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ sessionExpired: true });
  });

  it('returns {sessionExpired: true} when NestJS returns 404', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    ) as unknown as typeof fetch;
    const res = await POST(makeReq({ message: 'hello' }));
    expect(await res.json()).toEqual({ sessionExpired: true });
  });

  it('returns {sessionExpired: true} when no session cookie is present', async () => {
    mockSessionCookie = undefined;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await POST(makeReq({ message: 'hello' }));
    expect(await res.json()).toEqual({ sessionExpired: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty message without calling upstream', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await POST(makeReq({ message: '  ' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces per-session rate limit and returns 429 with Retry-After', async () => {
    global.fetch = jest.fn(async () => sseUpstream([])) as unknown as typeof fetch;
    // Burn through the budget.
    for (let i = 0; i < RATE_LIMIT_CONFIG.MAX_REQUESTS; i++) {
      const ok = await POST(makeReq({ message: 'hi' }));
      expect(ok.status).toBe(200);
    }
    const limited = await POST(makeReq({ message: 'hi' }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await POST(makeReq({ message: 'hi' }));
    expect(res.status).toBe(502);
  });
});
