# Chat Application — TypeScript Coding Expert

A streaming multi-turn chat app built around a TypeScript / JavaScript domain expert.

- **Backend** — NestJS, in-memory sessions with clock-injectable 30-min idle expiry, SSE token streaming, **provider-agnostic LLM layer** (Gemini, Anthropic Claude, and any OpenAI-compatible vendor — Groq / OpenAI / Cerebras / Together / OpenRouter / Mistral / Ollama / self-hosted gateways), tool calling round-trip, mock provider fallback, proactive `/chat/health/llm` probe that surfaces auth / quota / tools-unsupported / reasoning-leak issues to the UI, **`/chat/config` endpoint** so the persona / domain / UI copy is fully env-driven without code changes (see [Reconfigure the persona](#reconfigure-the-persona)).
- **Frontend** — Next.js 15 App Router, Server-Component cookie bootstrap, `useOptimistic`, BFF Route Handler that proxies the SSE stream so the NestJS URL and LLM API key never reach the browser. Persistent health banner for provider issues; the wire surface is a clean `token | done | error` so tool calling and reasoning blocks are invisible to the client.

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
| `openai`, `groq`, `cerebras`, `together`, `openrouter`, `mistral`, `ollama`, `openai-compatible` | `OpenAICompatibleLlmProvider` | per-alias (resolved internally from `LLM_PROVIDER`) | OpenAI `/v1/chat/completions` shape. Bearer auth, OpenAI-style tools, `[DONE]` terminator. `LLM_BASE_URL` overrides for self-hosted gateways. |

If `LLM_PROVIDER` isn't set, the backend auto-detects from `LLM_MODEL` (`claude-*` → Anthropic) or `LLM_BASE_URL` (`*.anthropic.com` / `*.googleapis.com` → those providers, otherwise OpenAI-compatible).

### Verified vendor recipes

Copy one of these blocks into `.env` to switch the active provider. The vendor alias alone is enough — the backend knows each vendor's default endpoint, so `LLM_BASE_URL` is only needed for self-hosted or proxied setups.

```env
# Groq — recommended for free-tier demos (14.4k req/day, ~300 tok/s)
LLM_PROVIDER=groq
LLM_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=llama-3.3-70b-versatile

# OpenAI — requires paid account or new-account credit
LLM_PROVIDER=openai
LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=gpt-4o-mini

# Cerebras — free tier, Llama family on dedicated inference chips
LLM_PROVIDER=cerebras
LLM_API_KEY=csk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=llama3.3-70b

# OpenRouter — proxy to ~100 models, free tier available
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=meta-llama/llama-3.3-70b-instruct

# Ollama — local, fully offline once the model is pulled
LLM_PROVIDER=ollama
LLM_API_KEY=ollama          # any non-empty string; ollama ignores auth
LLM_MODEL=llama3.1:8b

# Google AI Studio — Gemini family (fast, tight free-tier quota)
LLM_PROVIDER=gemini
LLM_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=gemini-2.5-flash
# LLM_BASE_URL not required; defaults to the v1beta endpoint.

# Google AI Studio — Gemma family (slower, 1.5k req/day free tier)
LLM_PROVIDER=gemini
LLM_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=gemma-3-27b-it

# Anthropic — Claude (requires prepaid credits)
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=claude-3-5-haiku-20241022
# LLM_BASE_URL not required; defaults to https://api.anthropic.com/v1

# Self-hosted OpenAI-compatible gateway (LiteLLM, vLLM, etc.)
LLM_PROVIDER=openai-compatible
LLM_API_KEY=whatever-your-gateway-expects
LLM_MODEL=your-deployed-model
LLM_BASE_URL=http://your-gateway:4000/v1     # required for custom hosts
```

### Vendors that need a gateway

**Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere native** use different wire formats (`api-key` headers, SigV4, OAuth) and are intentionally NOT implemented as native adapters. Route them through **OpenRouter** (cloud) or **LiteLLM** (self-hosted) and point `LLM_BASE_URL` at the gateway — both expose the OpenAI shape and `OpenAICompatibleLlmProvider` talks to them unchanged.

```env
# Anthropic Claude via OpenRouter (no x-api-key, no custom format)
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=anthropic/claude-3.5-sonnet

# Any model via a local LiteLLM gateway
LLM_PROVIDER=openai-compatible
LLM_API_KEY=anything-your-gateway-expects
LLM_MODEL=azure/gpt-4o     # whatever name your gateway exposes
LLM_BASE_URL=http://litellm:4000/v1
```

## Reconfigure the persona

The assistant isn't hardcoded to TypeScript. The persona, off-topic refusal, UI copy, and advertised tool name/description all come from env vars resolved through [`ExpertConfigService`](backend/src/config/expert-config.service.ts):

| Env var | Drives | Default |
|---|---|---|
| `EXPERT_DOMAIN` | "Only answer questions related to …" in the system prompt; empty-state placeholder in the UI | `TypeScript and JavaScript` |
| `EXPERT_DESCRIPTION` | Persona statement at the top of the system prompt; `<meta name="description">` | `You are a senior TypeScript engineer …` |
| `OFF_TOPIC_MESSAGE` | Verbatim refusal text used by the system prompt AND the mock provider | `I'm a TypeScript coding expert …` |
| `APP_TITLE` | `<title>`, header H1, derived avatar initials | `TypeScript Coding Expert` |
| `APP_SUBTITLE` | Header subtitle (the "online · ..." line) | `online · ask TS / JS — try `run console.log(2+2)`` |
| `EXPERT_TOOL_NAME` *(opt)* | Name advertised to the model for the bundled tool | `run_ts_snippet` |
| `EXPERT_TOOL_DESCRIPTION` *(opt)* | Tool description advertised to the model | TypeScript-snippet analyzer copy |

Backend exposes the resolved snapshot at `GET /chat/config`. The Next.js Server Component fetches it once at SSR — labels, page title, and empty-state hint all come from this endpoint with a static `DEFAULT_EXPERT_CONFIG` fallback when the backend is briefly unreachable.

**Validation runs at boot** ([`backend/src/config/env.validation.ts`](backend/src/config/env.validation.ts)) and Nest aborts startup with a single grouped error if any var is malformed:
- Empty strings are rejected (e.g. `EXPERT_DOMAIN=` fails fast instead of silently producing a broken prompt).
- `EXPERT_TOOL_NAME` must match `/^[a-zA-Z0-9_-]{1,64}$/` — every supported provider (Gemini, OpenAI, Anthropic) enforces this on function names, so we catch the violation at boot rather than as a 400 from upstream.
- In production (`NODE_ENV=production`), `EXPERT_DOMAIN` and `EXPERT_DESCRIPTION` are **required** so an operator can't forget to override the TypeScript defaults before going live.

**Worked example — switch to a sports expert:**

```env
EXPERT_DOMAIN="sports"
EXPERT_DESCRIPTION="You are a sports expert assistant with deep knowledge of major leagues, statistics, and history."
OFF_TOPIC_MESSAGE="I can only answer questions related to sports."
APP_TITLE="Sports Expert"
APP_SUBTITLE="online · ask anything about sports"
EXPERT_TOOL_NAME="lookup_sport_stats"
EXPERT_TOOL_DESCRIPTION="Look up athlete or team statistics."
```

Restart the backend (so `ConfigModule.forRoot({validate})` re-runs) and the next SSR render in the frontend picks up the new labels. No code changes required.

### Proactive health reporting (`GET /chat/health/llm`)

On first request after boot, the backend probes the configured model with two short streams (text ping + tool ping) and caches the result for 5 minutes. The Server Component reads it during SSR and the UI renders a persistent banner with actionable issues:

| Issue kind | Status | What the banner tells the user |
|---|---|---|
| `auth` | fail | API key is invalid — verify `LLM_API_KEY`. |
| `quota` | fail | API key has no available credits — add billing or switch to `LLM_PROVIDER=groq`. |
| `model_not_found` | fail | `LLM_MODEL` does not exist on this provider — check the spelling. |
| `unreachable` | fail | Provider currently down / overloaded. |
| `tools_unsupported` | degraded | Model doesn't invoke tools — `run_ts_snippet` won't work; suggests a tool-capable model. |
| `thinking_inline` | degraded | Model emits `<think>` blocks; the app filters them server-side so they never reach the client. |
| `rate_limit` | degraded | Transient — next request should succeed. |
| `empty_response` | degraded | Model returned no text on a trivial prompt (safety filter or misconfig). |

Reasoning models like DeepSeek-R1 work transparently: the streaming `<think>` tag is detected mid-stream by the `ThinkingFilter`, the chain-of-thought is suppressed at the provider layer, and the chat service swallows the resulting `thinking_start`/`thinking_end` events so nothing leaks to the SSE wire. The user just sees the typing dots until visible tokens arrive.

## Architecture

```
┌──────────┐ POST /api/session            ┌──────────────┐ POST /chat/session
│  Browser │ ──────────────────────────►  │ Next.js (BFF)│ ───────────────────► NestJS
│          │ ◄────── Set-Cookie sid=...   │ Route Handler│ ◄─── { sessionId }
│          │                              │              │
│          │ POST /api/chat               │              │ POST /chat/:id/message
│          │ ──────────────────────────►  │              │ ───────────────────► NestJS
│          │ ◄── text/event-stream ───────│ pipe SSE     │ ◄── text/event-stream
└──────────┘   (token | done | error)     └──────────────┘   (LLM tokens; tool_use →
                                                              handler → tool_result
                                                              cycle runs internally
                                                              before any token leaves)
```

**Wire contract** between Next.js BFF and the browser (and between NestJS and the BFF — they're piped verbatim) is intentionally minimal:

- `data: {"token":"..."}` — partial visible text
- `data: {"done":true,"turnIndex":N}` — terminal success
- `data: {"error":"..."}` — terminal failure

Tool calling round-trips and `<think>` reasoning blocks happen entirely inside [`ChatService.streamReply`](backend/src/chat/chat.service.ts); their internal events are swallowed before the SSE response is written. The stream is silent for the duration of any tool or reasoning phase and starts emitting once the model's first user-visible token is produced.

The browser **never** talks to NestJS directly. Both `NEST_API_URL` and `LLM_API_KEY` stay on the server.

### Why a BFF Route Handler instead of direct browser → NestJS

- **Secret containment.** `LLM_API_KEY` (and the internal NestJS URL) never appear in the browser network tab.
- **Cookie locality.** The HTTP-only `sid` cookie lives on the Next.js origin; the BFF reads it server-side and injects it into every NestJS call. The client just sends `{ message }` — it never knows or sees the session id.
- **One place to swap the wire format.** If we change NestJS from SSE to WebSockets or to a different streaming framing tomorrow, only the Route Handler changes.
- **Friendly auth surface.** Per-session rate limiting and request validation happen at the BFF tier, close to the user, before we burn an upstream LLM call. The backend mirrors the same limits as the authoritative gate (defense-in-depth), so direct calls to NestJS can't bypass them.

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

**2. Tool call (the `tool_use → handler → tool_result` cycle runs internally; the client just sees tokens once the round-trip completes)**

```
You: Run this snippet: console.log(2+2); console.log("hi")
  # [internal, swallowed by ChatService — never crosses the SSE wire]
  # [tool_call]   run_ts_snippet({ snippet: "console.log(2+2); console.log(\"hi\")" })
  # [tool_result] { ok: true, output: "[stubbed] console.log(2+2)\n[stubbed] console.log(\"hi\")", ... }
Bot: It would print:
       [stubbed] console.log(2+2)
       [stubbed] console.log("hi")
```

In the UI you'll see the user bubble appear instantly (optimistic), then a typing-dots indicator for the duration of the tool round-trip, then the bot bubble fills in token by token once round-2 streaming begins.

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
    api/chat/route.ts        BFF SSE proxy + per-session rate limit (20/hour + 5/min burst)
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
- **Per-session rate limit (defense-in-depth).** Two sliding windows per session — `20 / hour` sustained quota + `5 / minute` burst — are enforced at **both** the BFF (early-reject so we don't waste an upstream call) and the NestJS backend (authoritative, can't be bypassed). The closer-reset window wins on a deny, so `Retry-After` reflects the shorter wait. Both layers keep state in a process-local `Map<sessionId, { hourTs: number[]; minuteTs: number[] }>`; swap in Redis for horizontal scaling. See [`backend/src/chat/rate-limit.service.ts`](backend/src/chat/rate-limit.service.ts) and [`frontend/lib/rate-limit.ts`](frontend/lib/rate-limit.ts).

## Bonuses included

- `/health` endpoint with uptime + ISO timestamp, used as the docker-compose health check
- `GET /chat/health/llm` proactive probe surfacing auth / quota / tool-support / reasoning-leak issues as a persistent banner
- WhatsApp-inspired UI with light/dark mode, asymmetric bubble tails, per-bubble `HH:MM` timestamps, and an animated typing indicator
- Auto-scroll, Enter-to-submit, Send disabled while in-flight, blinking cursor on the streaming bubble, auto re-focus on the input after send
- Per-session rate limit (≤ 20 / hour sustained, ≤ 5 / minute burst) enforced at BFF and backend, with `Retry-After` header and a friendly "try again in Ns" message on 429
- Docker + docker-compose with health-check-gated startup of the frontend on the backend

## Troubleshooting per LLM error

| Symptom in the UI banner | Likely cause | Fix |
|---|---|---|
| `Auth: LLM API key is invalid or missing.` | Wrong / unset `LLM_API_KEY` | Re-check the env value. For Anthropic, ensure the key starts with `sk-ant-`; for Groq, `gsk_`. |
| `Quota: ... no available credits` | OpenAI / Anthropic account has no prepaid balance (the key is valid; the wallet is $0). | Add credits at the provider, or switch to a free-tier vendor: `LLM_PROVIDER=groq` with `LLM_MODEL=llama-3.3-70b-versatile`. |
| `Quota: ... daily quota is exhausted` | Gemini AI Studio free tier hit RPD limit. | Wait or switch to a model with a higher quota (`gemini-2.5-flash`) or another provider. |
| `Model: configured LLM_MODEL is not available` | Typo in model id, or model deprecated by the vendor. | Check the provider's models endpoint, update `LLM_MODEL`. |
| `Tools: model did not invoke the tool` | The chosen model doesn't support OpenAI/Anthropic-style tool calling (small open-source models, certain free models). | Use a tool-capable model: `llama-3.3-70b-versatile` (Groq), `gpt-4o-mini` (OpenAI), `claude-3-5-haiku-20241022` (Anthropic), `gemini-2.5-flash` (Google). |
| `Reasoning model: <think> blocks emitted inline` | DeepSeek-R1 / QwQ / similar reasoning model. | Nothing to do — the app suppresses the thinking blocks server-side; the SSE wire stays silent during reasoning and resumes when visible tokens arrive. |
| `Unreachable: provider overloaded` | Vendor outage. | Retry in a minute; the provider automatically retries 5xx (and Anthropic's 529) with exponential backoff. |
