# Chat Application

A streaming multi-turn chat app with a configurable domain expert persona. NestJS backend (SSE, tool calling, multi-provider LLM layer) + Next.js 15 frontend (Server Components, `useOptimistic`, BFF proxy).

## Run it (Docker, one command)

```bash
cp env.example .env
# edit .env: set LLM_PROVIDER + LLM_API_KEY + LLM_MODEL (see next section)
docker compose up --build
```

Open <http://localhost:3000>.

That's it. The first run takes ~1 min to build both images; subsequent runs use cache. The backend container is health-checked, so the frontend waits until it's ready.

## Configure the LLM (`.env`)

The minimum you need to point the app at a real LLM is three vars in `.env`:

```env
LLM_PROVIDER=groq                          # see table below
LLM_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx   # get one at the provider's console
LLM_MODEL=llama-3.3-70b-versatile          # pick a model that supports tool calling
```

If you leave `LLM_API_KEY` empty, the backend falls back to a deterministic **mock provider** — useful for offline demos but won't give natural responses.

### Supported providers

| `LLM_PROVIDER` | Where to get a key | Recommended `LLM_MODEL` | Free tier? |
|---|---|---|---|
| `groq` | [console.groq.com](https://console.groq.com) | `llama-3.3-70b-versatile` | Yes — fast, generous |
| `gemini` | [aistudio.google.com](https://aistudio.google.com) | `gemini-2.5-flash` | Yes — tight RPD limit |
| `openai` | [platform.openai.com](https://platform.openai.com) | `gpt-4o-mini` | No (paid only) |
| `anthropic` | [console.anthropic.com](https://console.anthropic.com) | `claude-3-5-haiku-20241022` | No (paid only) |
| `cerebras` | [cloud.cerebras.ai](https://cloud.cerebras.ai) | `llama3.3-70b` | Yes |
| `openrouter` | [openrouter.ai](https://openrouter.ai) | `meta-llama/llama-3.3-70b-instruct` | Yes (some models) |
| `ollama` | run locally with [ollama.com](https://ollama.com) | `llama3.1:8b` | Yes — fully offline |
| `mock` | — | — | No LLM, deterministic stub |

> **Tip:** Groq is the easiest path — free key, no credit card, and the response speed feels real-time.

After editing `.env`, recreate the backend container so it picks up the changes:

```bash
docker compose up -d --force-recreate backend
```

### Other vendors (Azure / Bedrock / Vertex)

Route them through OpenRouter (cloud) or LiteLLM (self-hosted) and point `LLM_BASE_URL` at the gateway:

```env
LLM_PROVIDER=openai-compatible
LLM_API_KEY=anything-your-gateway-expects
LLM_MODEL=azure/gpt-4o
LLM_BASE_URL=http://litellm:4000/v1
```

## Configure the persona (optional)

The app ships as a "TypeScript Coding Expert" but the domain is fully env-driven. Override any of these in `.env` to repurpose it:

```env
EXPERT_DOMAIN=sports
EXPERT_DESCRIPTION=You are a sports expert assistant with deep knowledge of major leagues.
OFF_TOPIC_MESSAGE=I can only answer questions related to sports.
APP_TITLE=Sports Expert
APP_SUBTITLE=online · ask anything about sports
```

The frontend reads these from `GET /chat/config` at SSR, so the page title, header, and empty-state copy follow whatever you configure. Defaults preserve the TypeScript persona, so you can leave them all unset and it just works.

> The bundled tool (`run_ts_snippet`, a stub TypeScript analyzer) stays the same regardless of persona. If you need a different tool for your domain, edit `backend/src/llm/tools/run-ts-snippet.tool.ts` directly.

## Local dev (no Docker)

```bash
# Terminal 1
cd backend && npm install && npm run start:dev

# Terminal 2
cd frontend && npm install && NEST_API_URL=http://localhost:3001 npm run dev
```

## Tests

```bash
cd backend && npm test     # 103 tests (sessions, LLM providers, rate limit, persona, e2e)
cd frontend && npm test    # 17 tests  (ChatBox optimistic UI + streaming, BFF route)
```

## Troubleshooting

| What you see | Most likely cause | Fix |
|---|---|---|
| Banner: `LLM API key is invalid or missing.` | Wrong / unset `LLM_API_KEY` | Re-check the value. Common prefixes: `gsk_` (Groq), `sk-` (OpenAI), `sk-ant-` (Anthropic), `AIza` (Gemini). |
| Banner: `No available credits` | OpenAI / Anthropic account has $0 balance | Add credits at the provider, or switch to a free vendor (Groq, Cerebras). |
| Banner: `configured LLM_MODEL is not available` | Typo in the model name, or model deprecated | Check the provider's models endpoint, update `LLM_MODEL`. |
| Banner: `model did not invoke the tool` | Model doesn't support OpenAI/Anthropic-style tool calling | Use a tool-capable model — see "Recommended LLM_MODEL" in the table above. |
| App starts but says "Sports Expert" instead of "TypeScript" | You have an `EXPERT_DOMAIN` / `APP_TITLE` override in `.env` | Comment them out and `docker compose up -d --force-recreate backend`. |

## What's inside

- **Backend (NestJS)** — In-memory sessions with 30-min idle expiry; SSE token streaming; provider-agnostic LLM layer (Gemini / Anthropic / any OpenAI-compatible vendor); tool calling round-trip; proactive `/chat/health/llm` probe that surfaces auth/quota/tools-unsupported issues to the UI; `/chat/config` endpoint exposing the persona snapshot; per-session rate limit (20/hour + 5/min burst).
- **Frontend (Next.js 15)** — App Router with Server Components, `useOptimistic` for instant user bubbles, BFF Route Handler that proxies the SSE stream so the LLM key and internal NestJS URL never reach the browser. WhatsApp-style UI, light/dark mode, blinking cursor on streaming, typing indicator during tool round-trips.

**Wire contract** between the BFF and the browser is intentionally minimal: `token | done | error`. Tool calls and `<think>` reasoning blocks happen entirely server-side before any visible token leaves NestJS — the UI just shows the typing indicator during that phase.

```
Browser ──► Next.js BFF ──► NestJS ──► LLM provider
            (cookies,         (sessions,
             rate limit,       tool loop,
             SSE proxy)        SSE)
```
