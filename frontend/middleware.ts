import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/types';

/**
 * Session bootstrap middleware.
 *
 * Next.js Server Components can READ cookies via `cookies()` but cannot
 * SET them. The assignment requires that the page Server Component receive
 * an already-bootstrapped session — without a client useEffect — so the
 * cookie has to land before page.tsx renders.
 *
 * Middleware runs on every navigation request, BEFORE the page renders.
 * If the user has no session cookie, we mint one by calling NestJS and
 * attach a Set-Cookie header to the very same response. The Server Component
 * then sees the cookie via `cookies()` and fetches the (empty) history.
 *
 * We restrict the matcher to "/" so this doesn't fire on API routes,
 * static assets, or anything else.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (req.cookies.get(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  const nestUrl = process.env.NEST_API_URL ?? 'http://localhost:3001';
  try {
    const upstream = await fetch(`${nestUrl}/chat/session`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!upstream.ok) {
      // Fall through — page render will surface a generic "Connection lost"
      // banner to the user via the ChatBox client component.
      return NextResponse.next();
    }
    const json = (await upstream.json()) as { sessionId: string };
    const res = NextResponse.next();
    res.cookies.set({
      name: SESSION_COOKIE,
      value: json.sessionId,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,
    });
    // Also surface the cookie on the current request so the Server Component
    // sees it within THIS render pass, not just on the next round trip.
    req.cookies.set(SESSION_COOKIE, json.sessionId);
    return res;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/'],
};
