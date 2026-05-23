'use client';

import {
  FormEvent,
  KeyboardEvent,
  ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import { ChatMessage, BotMessage, UserMessage } from '@/lib/types';

interface ChatBoxProps {
  sessionId: string;
  initialMessages: ChatMessage[];
}

type OptimisticAction = { type: 'add-user'; message: UserMessage };

interface LiveBot {
  id: string;
  content: string;
  startedAt: number;
}

type Banner =
  | { kind: 'error'; text: string }
  | { kind: 'session-expired' }
  | null;

export function ChatBox({ sessionId, initialMessages }: ChatBoxProps): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [liveBot, setLiveBot] = useState<LiveBot | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();

  const [optimisticMessages, addOptimistic] = useOptimistic<
    ChatMessage[],
    OptimisticAction
  >(messages, (state, action) => {
    if (action.type === 'add-user') return [...state, action.message];
    return state;
  });

  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setBanner({ kind: 'error', text: 'Message cannot be empty.' });
        return;
      }
      setBanner(null);

      const nextIndex = messages.length;
      const userMessage: UserMessage = {
        kind: 'user',
        id: `u-${Date.now()}`,
        turnIndex: nextIndex,
        content: trimmed,
        createdAt: Date.now(),
        pending: true,
      };
      const liveBotId = `b-${Date.now()}`;

      startTransition(async () => {
        addOptimistic({ type: 'add-user', message: userMessage });
        setLiveBot({ id: liveBotId, content: '', startedAt: Date.now() });

        // Tracks whether the stream handler has already set a banner so the
        // outer catch (for unexpected throws) doesn't overwrite a specific
        // server error with a generic "Connection lost" message.
        let handledError = false;
        try {
          await streamChat(trimmed, {
            onToken: (tok) =>
              setLiveBot((prev) =>
                prev && prev.id === liveBotId
                  ? { ...prev, content: prev.content + tok }
                  : prev,
              ),
            onSessionExpired: async () => {
              handledError = true;
              await fetch('/api/session', { method: 'DELETE' });
              setBanner({ kind: 'session-expired' });
              setLiveBot(null);
              setTimeout(() => window.location.reload(), 800);
            },
            onDone: (turnIndex: number, finalText: string) => {
              const committedUser: UserMessage = {
                ...userMessage,
                turnIndex,
                pending: false,
              };
              const committedBot: BotMessage = {
                kind: 'bot',
                id: liveBotId,
                turnIndex,
                content: finalText,
                createdAt: Date.now(),
              };
              setMessages((prev) => [...prev, committedUser, committedBot]);
              setLiveBot(null);
            },
            onError: (msg) => {
              handledError = true;
              setBanner({ kind: 'error', text: msg });
              setLiveBot(null);
            },
          });
        } catch {
          // Optimistic state is automatically discarded when the action settles,
          // so the user bubble disappears unless we explicitly committed via
          // setMessages above. That gives us rollback for free on failure.
          if (!handledError) {
            setBanner({ kind: 'error', text: 'Connection lost, please retry.' });
            setLiveBot(null);
          }
        }
      });
    },
    [addOptimistic, messages.length],
  );

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (isPending) return;
    const text = input;
    setInput('');
    send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isPending) {
        const text = input;
        setInput('');
        send(text);
      }
    }
  };

  // Auto-scroll to bottom on new content.
  const renderList = useMemo<ChatMessage[]>(() => {
    if (!liveBot) return optimisticMessages;
    const botBubble: BotMessage = {
      kind: 'bot',
      id: liveBot.id,
      turnIndex: optimisticMessages.length,
      content: liveBot.content,
      createdAt: liveBot.startedAt,
      streaming: true,
    };
    return [...optimisticMessages, botBubble];
  }, [optimisticMessages, liveBot]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [renderList]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const turnCount = messages.length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {banner && <BannerView banner={banner} onDismiss={() => setBanner(null)} />}

      <div
        ref={scrollerRef}
        data-testid="chat-scroller"
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        <ul className="flex flex-col gap-3">
          {renderList.length === 0 && (
            <li className="text-center text-sm text-slate-400">
              Start the conversation. Ask anything about TypeScript.
            </li>
          )}
          {renderList.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </ul>
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-slate-200 bg-white p-3"
      >
        <input
          ref={inputRef}
          aria-label="Message"
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:opacity-50"
          placeholder="Ask a TypeScript question..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || input.trim().length === 0}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Sending…' : 'Send'}
        </button>
        <span className="ml-2 text-xs text-slate-500" aria-label="turn count">
          {turnCount} turn{turnCount === 1 ? '' : 's'}
        </span>
      </form>
    </div>
  );
}

function BannerView({
  banner,
  onDismiss,
}: {
  banner: NonNullable<Banner>;
  onDismiss: () => void;
}): ReactElement {
  if (banner.kind === 'session-expired') {
    return (
      <div
        role="alert"
        className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
      >
        Session expired — refreshing…
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex items-center justify-between border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900"
    >
      <span>{banner.text}</span>
      <button
        onClick={onDismiss}
        className="rounded px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-100"
      >
        dismiss
      </button>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): ReactElement {
  const isUser = message.kind === 'user';
  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-testid={isUser ? 'user-bubble' : 'bot-bubble'}
        className={
          'max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ' +
          (isUser
            ? 'rounded-br-sm bg-slate-900 text-white'
            : 'rounded-bl-sm bg-white text-slate-900 border border-slate-200')
        }
      >
        {message.content || (message.kind === 'bot' && message.streaming ? '' : '')}
        {message.kind === 'bot' && message.streaming && (
          <span
            aria-hidden
            className="ml-0.5 inline-block w-[1ch] animate-blink align-baseline"
          >
            |
          </span>
        )}
        <RelativeTime ts={message.createdAt} />
      </div>
    </li>
  );
}

function RelativeTime({ ts }: { ts: number }): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return null;
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(diffSec);
  let label: string;
  if (abs < 60) label = fmt.format(diffSec, 'second');
  else if (abs < 3600) label = fmt.format(Math.round(diffSec / 60), 'minute');
  else label = fmt.format(Math.round(diffSec / 3600), 'hour');
  return (
    <div className="mt-1 text-[10px] uppercase tracking-wide opacity-60">
      {label}
    </div>
  );
}

interface StreamHandlers {
  onToken: (token: string) => void;
  onDone: (turnIndex: number, finalText: string) => void;
  onError: (message: string) => void;
  onSessionExpired: () => Promise<void> | void;
}

async function streamChat(
  message: string,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  // Route Handler returns JSON for non-stream cases (400, 429, 502, sessionExpired).
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const json = (await res.json().catch(() => ({}))) as {
      sessionExpired?: boolean;
      error?: string;
    };
    if (json.sessionExpired) {
      await handlers.onSessionExpired();
      return;
    }
    handlers.onError(json.error ?? `Request failed (${res.status})`);
    return;
  }

  if (!res.body) {
    handlers.onError('Connection lost, please retry.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  let doneTurnIndex: number | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof parsed.token === 'string') {
          finalText += parsed.token;
          handlers.onToken(parsed.token);
          continue;
        }
        if (parsed.error) {
          handlers.onError(String(parsed.error));
          return;
        }
        if (parsed.done === true && typeof parsed.turnIndex === 'number') {
          doneTurnIndex = parsed.turnIndex;
        }
        // tool_call / tool_result are surfaced silently here; the live bubble
        // remains empty until real tokens arrive in round 2.
      }
    }
  } catch {
    handlers.onError('Connection lost, please retry.');
    return;
  }

  if (doneTurnIndex !== null) {
    handlers.onDone(doneTurnIndex, finalText);
  } else {
    handlers.onError('Connection lost, please retry.');
  }
}
