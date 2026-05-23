# Chat Application — TypeScript Coding Expert

A streaming multi-turn chat app built around a TypeScript / JavaScript domain expert.

- **Backend** — NestJS, in-memory sessions with clock-injectable 30-min idle expiry, SSE token streaming, **provider-agnostic LLM layer** (Gemini, Anthropic Claude, and any OpenAI-compatible vendor — Groq / OpenAI / Cerebras / Together / OpenRouter / Mistral / Ollama / self-hosted gateways), tool calling round-trip, mock provider fallback, proactive `/chat/health/llm` probe that surfaces auth / quota / tools-unsupported / reasoning-leak issues to the UI.
- **Frontend** — Next.js 15 App Router, Server-Component cookie bootstrap, `useOptimistic`, BFF Route Handler that proxies the SSE stream so the NestJS URL and LLM API key never reach the browser. Persistent health banner + dedicated "Thinking..." indicator for reasoning models that emit `<think>` blocks.

## Quick start

### Option 1 — Docker (one command)

```bash
cp env.example .env       # optional: edit LLM_API_KEY / LLM_PROVIDER
docker compose up --build
```

Open <http://localhost:3000>. The backend exposes a health check at <http://localhost:3001/health>.

With the defaults (`LLM_PROVIDER=mock`) the app runs entirely offline against a deterministic mock LLM. To talk to a real model, set `LLM_PROVIDER` + `LLM_API_KEY` (+ `LLM_MODEL` if you don't want the per-vendor default) — see the full matrix below or [`env.example`](./env.example) for verified presets. The fastest free path is **Groq**:

```bash
LLM_PROVIDER=groq LLM_API_KEY=gsk_... LLM_MODEL=llama-3.3-70b-versatile \
  docker compose up --build
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

75 backend tests + 16 frontend tests, all green.

## Supported LLM providers

The backend has a single internal `LlmProvider` interface implemented four times:

| `LLM_PROVIDER` | Implementation | Default base URL | Notes |
|---|---|---|---|
| `mock` (or unset + no key) | `MockLlmProvider` | — | Offline, deterministic. Default in tests and demos. |
| `gemini` | `GeminiLlmProvider` | `https://generativelanguage.googleapis.com/v1beta` | Google AI Studio. Supports both `gemini-*` and `gemma-*` models. Auto-fallback when a model rejects `thinkingConfig`, retries on transient 5xx, filters `thought:true` parts. |
| `anthropic` (or `claude`) | `AnthropicLlmProvider` | `https://api.anthropic.com/v1` | Claude Messages API. `x-api-key` auth, content-block streaming, `tool_use` round-trip, retries on `529 overloaded`. |
| `openai`, `groq`, `cerebras`, `together`, `openrouter`, `mistral`, `ollama`, `openai-compatible` | `OpenAICompatibleLlmProvider` | per-alias (see [`env.example`](./env.example)) | OpenAI `/v1/chat/completions` shape. Bearer auth, OpenAI-style tools, `[DONE]` terminator. `LLM_BASE_URL` overrides for self-hosted gateways. |

If `LLM_PROVIDER` isn't set, the backend auto-detects from `LLM_MODEL` (`claude-*` → Anthropic) or `LLM_BASE_URL` (`*.anthropic.com` / `*.googleapis.com` → those providers, otherwise OpenAI-compatible).

### Vendors that need a gateway

**Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere native** use different wire formats (`api-key` headers, SigV4, OAuth) and are intentionally NOT implemented as native adapters. Route them through **OpenRouter** (cloud) or **LiteLLM** (self-hosted) and point `LLM_BASE_URL` at the gateway — both expose the OpenAI shape and `OpenAICompatibleLlmProvider` talks to them unchanged. Example presets are in [`env.example`](./env.example).

### Proactive health reporting (`GET /chat/health/llm`)

On first request after boot, the backend probes the configured model with two short streams (text ping + tool ping) and caches the result for 5 minutes. The Server Component reads it during SSR and the UI renders a persistent banner with actionable issues:

| Issue kind | Status | What the banner tells the user |
|---|---|---|
| `auth` | fail | API key is invalid — verify `LLM_API_KEY`. |
| `quota` | fail | API key has no available credits — add billing or switch to `LLM_PROVIDER=groq`. |
| `model_not_found` | fail | `LLM_MODEL` does not exist on this provider — check the spelling. |
| `unreachable` | fail | Provider currently down / overloaded. |
| `tools_unsupported` | degraded | Model doesn't invoke tools — `run_ts_snippet` won't work; suggests a tool-capable model. |
| `thinking_inline` | degraded | Model emits `<think>` blocks; the app filters them and shows a "Thinking..." indicator instead. |
| `rate_limit` | degraded | Transient — next request should succeed. |
| `empty_response` | degraded | Model returned no text on a trivial prompt (safety filter or misconfig). |

Reasoning models like DeepSeek-R1 work transparently: the streaming `<think>` tag is detected mid-stream, the chain-of-thought is suppressed, and the UI swaps the typing dots for a labelled "Thinking..." pill until `</think>` arrives.

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
    llm/         LlmService, LlmHealthService (proactive probe), provider interface,
                 providers/{gemini, anthropic, openai-compatible, mock}.provider.ts,
                 providers/thinking-filter.ts (suppresses <think> blocks),
                 tools/run-ts-snippet.tool.ts
    health/      /health endpoint (process uptime)
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
- `GET /chat/health/llm` proactive probe surfacing auth / quota / tool-support / reasoning-leak issues as a persistent banner
- WhatsApp-inspired UI with light/dark mode, asymmetric bubble tails, per-bubble `HH:MM` timestamps, and animated typing + "Thinking..." indicators
- Auto-scroll, Enter-to-submit, Send disabled while in-flight, blinking cursor on the streaming bubble, auto re-focus on the input after send
- Per-session BFF rate limit (≤ 20 / hour) with `Retry-After` header on 429
- Docker + docker-compose with health-check-gated startup of the frontend on the backend

## Troubleshooting per LLM error

| Symptom in the UI banner | Likely cause | Fix |
|---|---|---|
| `Auth: LLM API key is invalid or missing.` | Wrong / unset `LLM_API_KEY` | Re-check the env value. For Anthropic, ensure the key starts with `sk-ant-`; for Groq, `gsk_`. |
| `Quota: ... no available credits` | OpenAI / Anthropic account has no prepaid balance (the key is valid; the wallet is $0). | Add credits at the provider, or switch to a free-tier vendor: `LLM_PROVIDER=groq` with `LLM_MODEL=llama-3.3-70b-versatile`. |
| `Quota: ... daily quota is exhausted` | Gemini AI Studio free tier hit RPD limit. | Wait or switch to a model with a higher quota (`gemini-2.5-flash`) or another provider. |
| `Model: configured LLM_MODEL is not available` | Typo in model id, or model deprecated by the vendor. | Check the provider's models endpoint, update `LLM_MODEL`. |
| `Tools: model did not invoke the tool` | The chosen model doesn't support OpenAI/Anthropic-style tool calling (small open-source models, certain free models). | Use a tool-capable model: `llama-3.3-70b-versatile` (Groq), `gpt-4o-mini` (OpenAI), `claude-3-5-haiku-20241022` (Anthropic), `gemini-2.5-flash` (Google). |
| `Reasoning model: <think> blocks emitted inline` | DeepSeek-R1 / QwQ / similar reasoning model. | Nothing to do — the app filters them and shows the "Thinking..." indicator. |
| `Unreachable: provider overloaded` | Vendor outage. | Retry in a minute; the provider automatically retries 5xx (and Anthropic's 529) with exponential backoff. |
