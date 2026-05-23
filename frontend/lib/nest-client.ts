import { BackendTurn } from './types';

/**
 * Server-only NestJS URL. Never imported from a Client Component — the BFF
 * keeps this off the browser network tab entirely.
 */
export function nestBaseUrl(): string {
  return process.env.NEST_API_URL ?? 'http://localhost:3001';
}

export async function createNestSession(): Promise<string> {
  const res = await fetch(`${nestBaseUrl()}/chat/session`, {
    method: 'POST',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Backend session create failed: ${res.status}`);
  }
  const json = (await res.json()) as { sessionId: string };
  return json.sessionId;
}

export async function fetchNestHistory(
  sessionId: string,
): Promise<{ status: number; turns: BackendTurn[] }> {
  const res = await fetch(
    `${nestBaseUrl()}/chat/${sessionId}/history`,
    { cache: 'no-store' },
  );
  if (res.status === 404 || res.status === 410) {
    return { status: res.status, turns: [] };
  }
  if (!res.ok) {
    throw new Error(`Backend history fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as { sessionId: string; turns: BackendTurn[] };
  return { status: 200, turns: json.turns };
}

export async function deleteNestSession(sessionId: string): Promise<void> {
  await fetch(`${nestBaseUrl()}/chat/${sessionId}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
}
