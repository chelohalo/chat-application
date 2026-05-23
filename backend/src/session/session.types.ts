export type Role = 'user' | 'assistant';

export interface Turn {
  turnIndex: number;
  role: Role;
  content: string;
  createdAt: number;
}

export interface Session {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  turns: Turn[];
}
