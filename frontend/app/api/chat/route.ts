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
 * - Enforces per-session rate limit (≤ 20 / hour).
 * - Pipes NestJS's text/event-stream response straight through.
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
    return NextResponse.json(
      {
        error: `Rate limit exceeded (${RATE_LIMIT_CONFIG.MAX_REQUESTS}/hour per session). Try again later.`,
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
      'X-RateLimit-Remaining': String(rl.remaining),
    },
  });
}
