import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { ChatBox } from '@/components/ChatBox';
import {
  createNestSession,
  fetchNestHistory,
} from '@/lib/nest-client';
import { SESSION_COOKIE, BackendTurn, ChatMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface BootstrapResult {
  sessionId: string;
  initialMessages: ChatMessage[];
}

/**
 * Read the session cookie planted by middleware.ts and load history server-side.
 * If the cookie still references a backend session that 404s or 410s (e.g.
 * because the backend restarted between page loads), fall back to a fresh
 * session — the next navigation will trigger middleware to update the cookie.
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
  const { sessionId, initialMessages } = await bootstrap();

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">TypeScript Coding Expert</h1>
        <p className="text-xs text-slate-500">
          Session <code className="font-mono">{sessionId.slice(0, 8)}</code> · Ask TS / JS
          questions. Try <em>&ldquo;run console.log(2+2)&rdquo;</em> to trigger the tool.
        </p>
      </header>
      <ChatBox sessionId={sessionId} initialMessages={initialMessages} />
    </main>
  );
}
