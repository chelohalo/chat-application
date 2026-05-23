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
