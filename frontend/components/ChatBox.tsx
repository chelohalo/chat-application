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
import {
  ChatMessage,
  BotMessage,
  UserMessage,
  LlmHealth,
  LlmIssue,
} from '@/lib/types';

interface ChatBoxProps {
  sessionId: string;
  initialMessages: ChatMessage[];
  /**
   * Result of the backend's proactive LLM health probe. When non-null and
   * status !== 'ok', we render a persistent banner describing what won't
   * work (e.g. tool calling unsupported, API key invalid, model unknown).
   * `null` means the SSR fetch failed/timed out — we hide the banner in
   * that case to avoid showing a misleading "everything is broken" message.
   */
  llmHealth: LlmHealth | null;
}

type OptimisticAction = { type: 'add-user'; message: UserMessage };

interface LiveBot {
  id: string;
  content: string;
  startedAt: number;
  /**
   * True between `thinking:true` and `thinking:false` SSE events. While
   * thinking we render a distinct "Thinking..." indicator instead of the
   * typing dots so the user knows the model is reasoning, not waiting.
   */
  thinking: boolean;
}

type Banner =
  | { kind: 'error'; text: string }
  | { kind: 'session-expired' }
  | { kind: 'health-warning'; health: LlmHealth }
  | null;

export function ChatBox({
  sessionId,
  initialMessages,
  llmHealth,
}: ChatBoxProps): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [liveBot, setLiveBot] = useState<LiveBot | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();

  // Health banner is persistent (not dismissed = always shown when present).
  // Transient banners (error / session-expired) override it because they're
  // about the current action; the health banner reappears when they clear.
  const activeBanner: Banner =
    banner ??
    (llmHealth && llmHealth.status !== 'ok' && !healthDismissed
      ? { kind: 'health-warning', health: llmHealth }
      : null);

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

      // setLiveBot lives OUTSIDE the transition: React defers any state
      // update inside startTransition until the transition settles, but the
      // transition only settles when streamChat resolves — which can take
      // 10-30s on slow models. Setting it eagerly lets the typing indicator
      // (and any pending UI) commit on the next paint instead of waiting.
      setLiveBot({
        id: liveBotId,
        content: '',
        startedAt: Date.now(),
        thinking: false,
      });

      startTransition(async () => {
        addOptimistic({ type: 'add-user', message: userMessage });

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
            onThinking: (active: boolean) =>
              setLiveBot((prev) =>
                prev && prev.id === liveBotId
                  ? { ...prev, thinking: active }
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

  // Auto-scroll to bottom on new content. The live bot bubble is only added
  // to the render list ONCE the first token arrives; before that, the
  // TypingIndicator takes its place so we don't render an empty bubble.
  const renderList = useMemo<ChatMessage[]>(() => {
    if (!liveBot || liveBot.content.length === 0) return optimisticMessages;
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
  }, [renderList, liveBot]);

  // Re-focus the input whenever we transition out of a pending send. Disabling
  // the input while streaming forces a blur (HTML spec), so without this the
  // user has to manually click the field to send a second message.
  useEffect(() => {
    if (!isPending) inputRef.current?.focus();
  }, [isPending]);

  const turnCount = messages.length;

  // The typing indicator shows while we're waiting for the FIRST token from
  // the bot. While the backend signals that the model is in a <think> block,
  // we swap dots for a labelled "Thinking..." pill so the user knows the
  // model is reasoning (not just slow). Once a real token arrives, the
  // indicator is replaced by the streaming bubble (with blinking cursor).
  const showTypingIndicator =
    liveBot !== null && liveBot.content.length === 0 && !liveBot.thinking;
  const showThinkingIndicator =
    liveBot !== null && liveBot.thinking && liveBot.content.length === 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {activeBanner && (
        <BannerView
          banner={activeBanner}
          onDismiss={() => {
            if (activeBanner.kind === 'health-warning') {
              setHealthDismissed(true);
            } else {
              setBanner(null);
            }
          }}
        />
      )}

      <div
        ref={scrollerRef}
        data-testid="chat-scroller"
        className="wa-wallpaper flex-1 overflow-y-auto px-3 py-4 sm:px-6"
      >
        <ul className="flex flex-col gap-1.5">
          {renderList.length === 0 && !showTypingIndicator && (
            <li className="mx-auto mt-8 max-w-sm rounded-md bg-amber-50/90 px-4 py-3 text-center text-xs leading-relaxed text-amber-900 shadow-sm dark:bg-amber-950/40 dark:text-amber-200">
              Start the conversation. Ask anything about TypeScript.
            </li>
          )}
          {renderList.map((m, i) => {
            const prev = i > 0 ? renderList[i - 1] : null;
            const sameAuthorAsPrev = prev !== null && prev.kind === m.kind;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                groupedWithPrev={sameAuthorAsPrev}
              />
            );
          })}
          {showTypingIndicator && <TypingIndicator />}
          {showThinkingIndicator && <ThinkingIndicator />}
        </ul>
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 bg-wa-inputLight p-2 dark:bg-wa-headerDark sm:gap-3 sm:p-3"
      >
        <input
          ref={inputRef}
          aria-label="Message"
          className="flex-1 rounded-full bg-white px-4 py-2.5 text-sm text-slate-900 shadow-inner placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-wa-accent/40 disabled:opacity-50 dark:bg-wa-inputDark dark:text-slate-100 dark:placeholder:text-slate-500"
          placeholder="Type a message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || input.trim().length === 0}
          aria-label={isPending ? 'Sending' : 'Send message'}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-wa-accent text-white shadow-md transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? <SpinnerIcon /> : <SendIcon />}
        </button>
        <span
          className="ml-1 hidden text-xs text-wa-metaLight dark:text-wa-metaDark sm:inline"
          aria-label="turn count"
        >
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
        className="bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
      >
        Session expired — refreshing…
      </div>
    );
  }
  if (banner.kind === 'health-warning') {
    return <HealthBanner health={banner.health} onDismiss={onDismiss} />;
  }
  return (
    <div
      role="alert"
      className="flex items-center justify-between bg-rose-100 px-4 py-2 text-xs text-rose-900 dark:bg-rose-900/40 dark:text-rose-100"
    >
      <span>{banner.text}</span>
      <button
        onClick={onDismiss}
        className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-700 hover:bg-rose-200 dark:text-rose-200 dark:hover:bg-rose-900/60"
      >
        dismiss
      </button>
    </div>
  );
}

/**
 * Persistent banner that reports what's wrong (or merely degraded) with the
 * configured LLM_PROVIDER + LLM_MODEL pair. Fatal issues (auth, quota,
 * unreachable) render in red; non-fatal degradations (tool calls won't work,
 * model leaks <think>) render in amber.
 *
 * Each LlmIssue is rendered as a short line with optional suggestion so the
 * user knows exactly what won't work AND what to do about it.
 */
function HealthBanner({
  health,
  onDismiss,
}: {
  health: LlmHealth;
  onDismiss: () => void;
}): ReactElement {
  const isFatal = health.status === 'fail';
  const palette = isFatal
    ? 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100'
    : 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100';
  return (
    <div role="alert" className={`px-4 py-2 text-xs ${palette}`} data-testid="health-banner">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {isFatal ? 'LLM cannot respond' : 'LLM is partially degraded'}{' '}
            <span className="font-normal opacity-70">
              ({health.provider} · {health.model})
            </span>
          </div>
          <ul className="mt-1 space-y-1">
            {health.issues.map((iss, i) => (
              <IssueLine key={`${iss.kind}-${i}`} issue={iss} />
            ))}
          </ul>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 self-start rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-black/10 dark:hover:bg-white/10"
        >
          dismiss
        </button>
      </div>
    </div>
  );
}

function IssueLine({ issue }: { issue: LlmIssue }): ReactElement {
  return (
    <li className="leading-snug">
      <span className="font-medium">{labelForIssue(issue.kind)}:</span>{' '}
      <span>{issue.message}</span>
      {issue.suggestion && (
        <span className="block pl-3 opacity-80">{issue.suggestion}</span>
      )}
    </li>
  );
}

function labelForIssue(kind: LlmIssue['kind']): string {
  switch (kind) {
    case 'auth':
      return 'Auth';
    case 'quota':
      return 'Quota';
    case 'rate_limit':
      return 'Rate limit';
    case 'tools_unsupported':
      return 'Tools';
    case 'thinking_inline':
      return 'Reasoning model';
    case 'model_not_found':
      return 'Model';
    case 'empty_response':
      return 'Empty response';
    case 'unreachable':
      return 'Unreachable';
  }
}

function MessageBubble({
  message,
  groupedWithPrev,
}: {
  message: ChatMessage;
  groupedWithPrev: boolean;
}): ReactElement {
  const isUser = message.kind === 'user';
  // WhatsApp shows a "tail" on the FIRST bubble of a contiguous run by the
  // same author and drops it from subsequent ones in the same group. We
  // mirror that with an asymmetric corner: rounded-tr-sm for the user's
  // first bubble, rounded-tl-sm for the bot's first bubble.
  const tail =
    !groupedWithPrev && (isUser ? 'rounded-tr-sm' : 'rounded-tl-sm');
  const baseColor = isUser
    ? 'bg-wa-bubbleOutLight text-slate-900 dark:bg-wa-bubbleOutDark dark:text-slate-100'
    : 'bg-wa-bubbleInLight text-slate-900 dark:bg-wa-bubbleInDark dark:text-slate-100';
  return (
    <li
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${
        groupedWithPrev ? 'mt-0.5' : 'mt-2'
      }`}
    >
      <div
        data-testid={isUser ? 'user-bubble' : 'bot-bubble'}
        className={`max-w-[78%] rounded-lg px-2.5 py-1.5 text-sm leading-snug shadow-sm sm:max-w-[72%] ${baseColor} ${tail || ''}`}
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.kind === 'bot' && message.streaming && (
            <span
              aria-hidden
              className="ml-0.5 inline-block w-[1ch] animate-blink align-baseline"
            >
              |
            </span>
          )}
        </div>
        <ClockTime ts={message.createdAt} alignRight={isUser} />
      </div>
    </li>
  );
}

/**
 * Distinct indicator for the case where the model is actively in a
 * `<think>...</think>` reasoning block (DeepSeek-R1 and friends). The dots
 * are paired with a "Thinking..." label so the user understands the delay is
 * deliberate reasoning, not the network stalling. Reverts to TypingIndicator
 * once the model emits </think>.
 */
function ThinkingIndicator(): ReactElement {
  return (
    <li
      className="mt-2 flex justify-start"
      data-testid="thinking-indicator"
      aria-live="polite"
      aria-label="Assistant is thinking"
    >
      <div className="rounded-lg rounded-tl-sm bg-wa-bubbleInLight px-3 py-2.5 shadow-sm dark:bg-wa-bubbleInDark">
        <div className="flex items-center gap-2">
          <span className="text-xs italic text-wa-metaLight dark:text-wa-metaDark">
            Thinking
          </span>
          <span className="flex items-center gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                aria-hidden
                className="inline-block h-1 w-1 rounded-full bg-wa-metaLight animate-typingDot dark:bg-wa-metaDark"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * Animated "•••" shown in a bot-styled bubble while the model is "thinking"
 * (no tokens have streamed yet). Three dots stagger their bounce via inline
 * animation-delay so the visual rhythm matches WhatsApp's typing indicator.
 */
function TypingIndicator(): ReactElement {
  return (
    <li
      className="mt-2 flex justify-start"
      data-testid="typing-indicator"
      aria-live="polite"
      aria-label="Assistant is typing"
    >
      <div className="rounded-lg rounded-tl-sm bg-wa-bubbleInLight px-3 py-2.5 shadow-sm dark:bg-wa-bubbleInDark">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-wa-metaLight animate-typingDot dark:bg-wa-metaDark"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    </li>
  );
}

/**
 * Compact "HH:MM" timestamp in the bottom corner of each bubble, the way
 * WhatsApp renders it. Uses locale-aware formatting via Intl.DateTimeFormat
 * and re-renders once a minute so 23:59 → 00:00 doesn't get stuck.
 */
function ClockTime({
  ts,
  alignRight,
}: {
  ts: number;
  alignRight: boolean;
}): ReactElement | null {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return null;
  const label = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
  return (
    <div
      className={`mt-0.5 text-[10px] leading-none text-wa-metaLight dark:text-wa-metaDark ${
        alignRight ? 'text-right' : 'text-left'
      }`}
    >
      {label}
    </div>
  );
}

function SendIcon(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
    >
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function SpinnerIcon(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="18"
      height="18"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeDasharray="40 60"
      />
    </svg>
  );
}

interface StreamHandlers {
  onToken: (token: string) => void;
  onThinking: (active: boolean) => void;
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
        if (typeof parsed.thinking === 'boolean') {
          handlers.onThinking(parsed.thinking);
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
