# Chat Application — TypeScript Coding Expert

A streaming multi-turn chat app built around a TypeScript / JavaScript domain expert.

- **Backend** — NestJS, in-memory sessions with clock-injectable 30-min idle expiry, SSE token streaming, Gemini provider with tool calling, mock provider fallback.
- **Frontend** — Next.js 15 App Router, Server-Component cookie bootstrap, `useOptimistic`, BFF Route Handler that proxies the SSE stream so the NestJS URL and LLM API key never reach the browser.

## Quick start

### Option 1 — Docker (one command)

```bash
cp env.example .env       # optional: edit LLM_API_KEY / LLM_PROVIDER
docker compose up --build
```

Open <http://localhost:3000>. The backend exposes a health check at <http://localhost:3001/health>.

With the defaults (`LLM_PROVIDER=mock`) the app runs entirely offline against a deterministic mock LLM. To talk to real Gemini:

```bash
LLM_PROVIDER=gemini LLM_API_KEY=your_key docker compose up --build
```

### Option 2 — local dev

```bash
# terminal 1
cd backend
npm install
LLM_PROVIDER=mock npm run start:dev      # or LLM_PROVIDER=gemini LLM_API_KEY=...

# terminal 2
cd frontend
npm install
NEST_API_URL=http://localhost:3001 npm run dev
```

## Tests

```bash
# Backend: SessionService (clock-driven expiry), LlmService + Gemini tool loop, ChatController e2e
cd backend && npm test

# Frontend: ChatBox optimistic + rollback + streaming, /api/chat route handler
cd frontend && npm test
```

19 backend tests + 12 frontend tests, all green.

## Architecture

```
┌──────────┐ POST /api/session            ┌──────────────┐ POST /chat/session
│  Browser │ ──────────────────────────►  │ Next.js (BFF)│ ───────────────────► NestJS
│          │ ◄────── Set-Cookie sid=...   │ Route Handler│ ◄─── { sessionId }
│          │                              │              │
│          │ POST /api/chat               │              │ POST /chat/:id/message
│          │ ──────────────────────────►  │              │ ───────────────────► NestJS
│          │ ◄── text/event-stream ───────│ pipe SSE     │ ◄── text/event-stream
└──────────┘                              └──────────────┘   (Gemini streams tokens,
                                                              tool_use → handler →
                                                              tool_result → tokens)
```

The browser **never** talks to NestJS directly. Both `NEST_API_URL` and `LLM_API_KEY` stay on the server.

### Why a BFF Route Handler instead of direct browser → NestJS

- **Secret containment.** `LLM_API_KEY` (and the internal NestJS URL) never appear in the browser network tab.
- **Cookie locality.** The HTTP-only `sid` cookie lives on the Next.js origin; the BFF reads it server-side and injects it into every NestJS call. The client just sends `{ message }` — it never knows or sees the session id.
- **One place to swap the wire format.** If we change NestJS from SSE to WebSockets or to a different streaming framing tomorrow, only the Route Handler changes.
- **Friendly auth surface.** Per-session rate limiting and request validation happen at the BFF tier, close to the user, before we burn an upstream LLM call.

### Tool calling loop

The model has one tool, `run_ts_snippet`. The Gemini provider:

1. Sends the conversation + tool schema to `streamGenerateContent`.
2. If the model emits a `functionCall` part instead of text, accumulates the call and finishes round 1 without yielding any tokens to the caller.
3. Invokes the local handler, appends both the `functionCall` and a `functionResponse` to the history.
4. Re-issues `streamGenerateContent` and streams round-2 text tokens to the caller.

This guarantees the spec invariant that "the `tool_use → handler → tool_result → final response` cycle must complete before the first token is streamed to the client". Off-topic refusals are enforced by the system prompt and double-checked via `finish_reason` inspection.

## Sample Q&As (run against the mock provider — replace with real Gemini for natural language)

> The mock provider in this repo is deterministic and only intended to demonstrate the wiring. Patterns the real Gemini-backed deployment would handle are shown below. The "tool call" example works under both providers because the mock provider detects "run/evaluate" keywords and invokes the tool, exactly mirroring what Gemini does via function calling.

**1. Concept question (in-scope)**

```
You: What is the difference between `unknown` and `any` in TypeScript?
Bot: `any` opts out of type-checking entirely — you can dereference, call, or assign it to
     anything without complaint. `unknown` is the type-safe counterpart: you must narrow it
     (typeof guards, type predicates, or an `as` assertion) before the compiler will let
     you use it. Use `unknown` for boundaries where you don't yet trust the value.
```

**2. Tool call (the streamed `tool_call`/`tool_result` events fire before tokens)**

```
You: Run this snippet: console.log(2+2); console.log("hi")
Bot: [tool_call] run_ts_snippet({ snippet: "console.log(2+2); console.log(\"hi\")" })
     [tool_result] { ok: true, output: "[stubbed] console.log(2+2)\n[stubbed] console.log(\"hi\")", ... }
     Bot: It would print:
       [stubbed] console.log(2+2)
       [stubbed] console.log("hi")
```

In the UI you'll see the user bubble appear instantly (optimistic), then the bot bubble fill in token by token with a blinking cursor. The tool round-trip happens upstream before round-2 streaming begins, so visually there is a short "thinking" pause and then tokens start flowing.

**3. Off-topic refusal (enforced by system prompt + mock heuristic)**

```
You: What's a good recipe for chocolate chip cookies?
Bot: I'm a TypeScript coding expert and can only help with TypeScript/JavaScript questions.
     Could you ask me something in that area?
```

The mock provider mirrors the system prompt's refusal heuristic so the off-topic path is testable offline.

## Project layout

```
backend/
  src/
    chat/        controllers + DTOs + service that orchestrates sessions and LLM stream
    session/     SessionService with injectable Clock and 30-min idle expiry
    llm/         LlmService, provider interface, Gemini provider, mock provider, run_ts_snippet tool
    health/      /health endpoint
    common/      AllExceptionsFilter, SessionExpiredException (410 Gone)
  Dockerfile
frontend/
  app/
    page.tsx                 Server Component: reads cookie, fetches initial history
    api/session/route.ts     Cookie bootstrap (POST + DELETE)
    api/chat/route.ts        BFF SSE proxy + per-session rate limit (20/hour)
  components/ChatBox.tsx     'use client' — useOptimistic + streaming UI with blinking cursor
  lib/                       types, NestJS client, rate-limit store
  __tests__/                 Jest tests (components project + route project)
  Dockerfile
docker-compose.yml
env.example
```

## What's intentionally simple

- **Mock tool sandbox.** `run_ts_snippet`'s "execution" is a deterministic stub (string-matching `console.log` calls) so the tool loop is verifiable end-to-end without exposing arbitrary code execution. Swap in `isolated-vm` or a `tsx`-based runner in production.
- **In-memory sessions.** Sessions live in a `Map<string, Session>` keyed by uuid, with idle eviction on access. Plug in Redis behind the `SessionService` interface to scale horizontally.
- **Per-session BFF rate limit** uses a module-level `Map<sessionId, number[]>` sliding window. It's correct for a single Node.js worker; Redis would be needed if the BFF runs behind a multi-instance load balancer.

## Bonuses included

- `/health` endpoint with uptime + ISO timestamp, used as the docker-compose health check
- Auto-scroll, Enter-to-submit, Send disabled while in-flight, relative timestamps (`Intl.RelativeTimeFormat`), blinking cursor on the streaming bubble
- Per-session BFF rate limit (≤ 20 / hour) with `Retry-After` header on 429
- Docker + docker-compose with health-check-gated startup of the frontend on the backend
