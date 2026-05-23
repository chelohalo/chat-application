import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createNestSession } from '@/lib/nest-client';
import { SESSION_COOKIE } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Bootstrap or rotate a session by proxying to NestJS and setting an HttpOnly cookie. */
export async function POST(): Promise<NextResponse> {
  try {
    const sessionId = await createNestSession();
    const res = NextResponse.json({ sessionId });
    res.cookies.set({
      name: SESSION_COOKIE,
      value: sessionId,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60, // matches the 30-min idle on the backend, with a small buffer
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to create session' },
      { status: 502 },
    );
  }
}

/** Clear the session cookie. Called on auto-expire flow. */
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  const store = await cookies();
  if (store.get(SESSION_COOKIE)) {
    res.cookies.set({
      name: SESSION_COOKIE,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return res;
}
