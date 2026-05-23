import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { ChatBox } from '@/components/ChatBox';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  createNestSession,
  fetchNestHistory,
  fetchLlmHealth,
} from '@/lib/nest-client';
import {
  SESSION_COOKIE,
  THEME_COOKIE,
  DEFAULT_THEME,
  BackendTurn,
  ChatMessage,
  Theme,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

interface BootstrapResult {
  sessionId: string;
  initialMessages: ChatMessage[];
}

/**
 * Read the session cookie that middleware.ts validated/planted, then load
 * history server-side. Middleware is the source of truth: it has already
 * verified that the session exists in NestJS (or minted a fresh one) before
 * this Server Component runs, so the happy path is just "read cookie, fetch
 * history".
 *
 * The defensive fallback at the bottom only runs when the backend was
 * unreachable from middleware — in that case the cookie was cleared and we
 * try one more time here. If it still fails, the error bubbles up and the
 * Server Component re-throws, which Next renders as an error boundary.
 */
async function bootstrap(): Promise<BootstrapResult> {
  const jar = await cookies();
  const existing = jar.get(SESSION_COOKIE)?.value;

  if (existing) {
    const { status, turns } = await fetchNestHistory(existing);
    if (status === 200) {
      return { sessionId: existing, initialMessages: turnsToMessages(turns) };
    }
  }

  const fresh = await createNestSession();
  return { sessionId: fresh, initialMessages: [] };
}

function turnsToMessages(turns: BackendTurn[]): ChatMessage[] {
  return turns.map<ChatMessage>((t) =>
    t.role === 'user'
      ? {
          kind: 'user',
          id: `srv-${t.turnIndex}`,
          turnIndex: t.turnIndex,
          content: t.content,
          createdAt: t.createdAt,
        }
      : {
          kind: 'bot',
          id: `srv-${t.turnIndex}`,
          turnIndex: t.turnIndex,
          content: t.content,
          createdAt: t.createdAt,
        },
  );
}

export default async function Page(): Promise<ReactElement> {
  // Bootstrap session and probe LLM health in parallel — neither blocks the
  // other. The health fetch has its own 2s timeout and returns null on any
  // failure, so we degrade gracefully if the backend is briefly slow.
  const [{ sessionId, initialMessages }, llmHealth] = await Promise.all([
    bootstrap(),
    fetchLlmHealth(),
  ]);
  const jar = await cookies();
  const cookieTheme = jar.get(THEME_COOKIE)?.value;
  const theme: Theme =
    cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : DEFAULT_THEME;

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col shadow-2xl">
      <header className="flex items-center gap-3 bg-wa-headerLight px-4 py-2.5 text-white dark:bg-wa-headerDark">
        <div
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 font-mono text-sm font-semibold tracking-tight"
        >
          TS
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-medium leading-tight">
            TypeScript Coding Expert
          </h1>
          <p
            className="truncate text-xs text-white/70"
            aria-label="Assistant status"
          >
            online · ask TS / JS — try{' '}
            <em className="not-italic">&ldquo;run console.log(2+2)&rdquo;</em>
          </p>
        </div>
        <span
          className="hidden text-[10px] text-white/50 sm:inline"
          title="Session ID"
        >
          <code className="font-mono">{sessionId.slice(0, 8)}</code>
        </span>
        <ThemeToggle initialTheme={theme} />
      </header>
      <ChatBox
        sessionId={sessionId}
        initialMessages={initialMessages}
        llmHealth={llmHealth}
      />
    </main>
  );
}
