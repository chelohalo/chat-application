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
