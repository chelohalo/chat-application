export interface Session {
  id: string;
}

export interface UserMessage {
  kind: 'user';
  id: string;
  turnIndex: number;
  content: string;
  createdAt: number;
  pending?: boolean;
}

export interface BotMessage {
  kind: 'bot';
  id: string;
  turnIndex: number;
  content: string;
  createdAt: number;
  streaming?: boolean;
  errored?: boolean;
}

export type ChatMessage = UserMessage | BotMessage;

export interface BackendTurn {
  turnIndex: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export const SESSION_COOKIE = 'sid';
export const THEME_COOKIE = 'theme';
export type Theme = 'dark' | 'light';
export const DEFAULT_THEME: Theme = 'light';

/**
 * Shape returned by GET /chat/health/llm. Mirrors backend's LlmHealth so the
 * UI can render persistent banners describing what does or doesn't work
 * with the configured LLM_PROVIDER + LLM_MODEL combination.
 */
export type LlmIssueKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'tools_unsupported'
  | 'thinking_inline'
  | 'model_not_found'
  | 'empty_response'
  | 'unreachable';

export interface LlmIssue {
  kind: LlmIssueKind;
  message: string;
  suggestion?: string;
}

export interface LlmHealth {
  status: 'ok' | 'degraded' | 'fail';
  provider: string;
  model: string;
  issues: LlmIssue[];
  lastChecked: number | null;
}

/**
 * Shape returned by GET /chat/config. Mirrors the backend's
 * ExpertConfigSnapshot — the assistant persona, UI copy, and advertised
 * tool metadata — so the frontend never has to duplicate domain-specific
 * strings.
 */
export interface ExpertConfig {
  domain: string;
  description: string;
  offTopicMessage: string;
  appTitle: string;
  appSubtitle: string;
  tool: {
    name: string;
    description: string;
  };
}

/**
 * Static fallback used when the backend is unreachable at SSR time so the
 * page still renders meaningful labels. Must stay in sync with the
 * defaults in backend/src/config/expert-config.service.ts.
 */
export const DEFAULT_EXPERT_CONFIG: ExpertConfig = {
  domain: 'TypeScript and JavaScript',
  description: 'You are a senior TypeScript engineer acting as a domain expert.',
  offTopicMessage:
    "I'm a TypeScript coding expert and can only help with TypeScript/JavaScript questions. Could you ask me something in that area?",
  appTitle: 'TypeScript Coding Expert',
  appSubtitle: 'online \u00b7 ask TS / JS \u2014 try `run console.log(2+2)`',
  tool: {
    name: 'run_ts_snippet',
    description:
      'Statically analyze a short TypeScript snippet and return what it would print. ' +
      'Use ONLY for snippets the user explicitly asks you to "run" or "evaluate". ' +
      'Do not invoke for general explanation requests.',
  },
};
