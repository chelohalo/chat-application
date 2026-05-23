import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/types';

/**
 * Session bootstrap + validation middleware.
 *
 * Why validation matters: NestJS holds sessions in memory, so any backend
 * restart silently invalidates every `sid` cookie a browser already holds.
 * A naive "is the cookie present?" check would let those stale cookies
 * through, which causes the very first message after a restart to fail with
 * a 404 from the backend (surfaced to the user as "Session expired").
 *
 * Strategy:
 *   1. If the cookie exists and the backend still recognises it, pass through.
 *   2. Otherwise (no cookie OR cookie points at a dead session), mint a
 *      fresh session via NestJS and replace the cookie before the Server
 *      Component runs. The Server Component, the BFF Route Handler, and the
 *      browser then all agree on the same session id.
 *
 * The matcher is restricted to "/" so we don't pay an extra round trip on
 * API routes, static assets, or anything else.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const nestUrl = process.env.NEST_API_URL ?? 'http://localhost:3001';
  const existing = req.cookies.get(SESSION_COOKIE)?.value;

  if (existing && (await isSessionAlive(nestUrl, existing))) {
    return NextResponse.next();
  }

  const fresh = await mintSession(nestUrl);
  if (!fresh) {
    // Backend unreachable or returned non-2xx. Drop any stale cookie so the
    // page doesn't try to use it, and let the Server Component render with
    // whatever fallback it has (it will surface a generic error banner).
    const res = NextResponse.next();
    if (existing) {
      res.cookies.delete(SESSION_COOKIE);
      req.cookies.delete(SESSION_COOKIE);
    }
    return res;
  }

  const res = NextResponse.next();
  res.cookies.set({
    name: SESSION_COOKIE,
    value: fresh,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60,
  });
  // Surface the cookie on this same request so the downstream Server
  // Component sees it without a redirect.
  req.cookies.set(SESSION_COOKIE, fresh);
  return res;
}

async function isSessionAlive(nestUrl: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${nestUrl}/chat/${sessionId}/history`, {
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function mintSession(nestUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${nestUrl}/chat/session`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { sessionId: string };
    return json.sessionId;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ['/'],
};
