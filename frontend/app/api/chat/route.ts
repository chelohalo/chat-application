import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { nestBaseUrl } from '@/lib/nest-client';
import { SESSION_COOKIE } from '@/lib/types';
import { checkRateLimit, RATE_LIMIT_CONFIG } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
// Note: explicitly Node.js runtime. The in-memory rate-limit store relies on
// shared process state, which the Edge Runtime does not provide.
export const runtime = 'nodejs';

interface ChatRequestBody {
  message?: unknown;
}

/**
 * BFF SSE proxy.
 *
 * - Reads sessionId from the HttpOnly cookie (never trusts the request body).
 * - Early-rejects with 429 when the local two-window limiter (20/hour and
 *   5/minute burst) trips, so we don't even ping NestJS in that case.
 * - Pipes NestJS's text/event-stream response straight through.
 * - On 429 from NestJS (the authoritative backend gate), the backend's
 *   JSON body and Retry-After header are passed through verbatim.
 * - On 404 / 410 from NestJS, returns { sessionExpired: true } JSON so the
 *   client can clear the cookie and reload.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ sessionExpired: true }, { status: 200 });
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    return NextResponse.json({ error: 'Message cannot be empty.' }, { status: 400 });
  }

  const rl = checkRateLimit(sessionId);
  if (!rl.allowed) {
    const limit =
      rl.reason === 'minute'
        ? `${RATE_LIMIT_CONFIG.MINUTE_MAX}/min`
        : `${RATE_LIMIT_CONFIG.HOUR_MAX}/hour`;
    return NextResponse.json(
      {
        error: `Rate limit exceeded (${limit} per session). Try again in ${rl.retryAfterSec}s.`,
        reason: rl.reason,
        retryAfterSec: rl.retryAfterSec,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfterSec) },
      },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${nestBaseUrl()}/chat/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      cache: 'no-store',
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Backend unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (upstream.status === 404 || upstream.status === 410) {
    return NextResponse.json({ sessionExpired: true }, { status: 200 });
  }
  if (upstream.status === 400) {
    return NextResponse.json({ error: 'Message cannot be empty.' }, { status: 400 });
  }
  if (upstream.status === 429) {
    // The backend is the authoritative gate. If our local view said "ok" but
    // the backend says "rate-limited" (e.g. another client on the same
    // session hit it from outside), surface the backend's verdict to the
    // user verbatim instead of pretending the request went through.
    const retryAfter = upstream.headers.get('Retry-After') ?? '60';
    const upstreamBody = await upstream
      .text()
      .then((t) => {
        try {
          return JSON.parse(t) as Record<string, unknown>;
        } catch {
          return { error: 'Rate limit exceeded. Try again later.' };
        }
      })
      .catch(() => ({ error: 'Rate limit exceeded. Try again later.' }));
    return NextResponse.json(upstreamBody, {
      status: 429,
      headers: { 'Retry-After': retryAfter },
    });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Backend error ${upstream.status}` },
      { status: 502 },
    );
  }

  // Pipe SSE straight through.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-RateLimit-Remaining-Hour': String(rl.remaining.hour),
      'X-RateLimit-Remaining-Minute': String(rl.remaining.minute),
    },
  });
}
