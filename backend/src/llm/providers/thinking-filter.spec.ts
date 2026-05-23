import { ThinkingFilter } from './thinking-filter';
import { LlmStreamChunk } from '../llm.types';

function feed(filter: ThinkingFilter, ...parts: string[]): LlmStreamChunk[] {
  const out: LlmStreamChunk[] = [];
  for (const p of parts) out.push(...filter.push(p));
  out.push(...filter.flush());
  return out;
}

describe('ThinkingFilter', () => {
  it('passes through tokens unchanged when no <think> markers are present', () => {
    const filter = new ThinkingFilter();
    const out = feed(filter, 'Hello, ', 'world!');
    expect(out).toEqual([
      { type: 'token', token: 'Hello, ' },
      { type: 'token', token: 'world!' },
    ]);
  });

  it('emits thinking_start/end markers and SUPPRESSES the reasoning text in between', () => {
    const filter = new ThinkingFilter();
    const out = feed(
      filter,
      'Before. <think>secret reasoning that should be hidden</think> After.',
    );
    const types = out.map((c) => c.type);
    expect(types).toContain('thinking_start');
    expect(types).toContain('thinking_end');
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('Before.  After.');
    expect(tokenText).not.toContain('secret reasoning');
  });

  it('handles <think> tags split across multiple upstream chunks', () => {
    const filter = new ThinkingFilter();
    // Worst case: tag broken at every byte boundary.
    const out = feed(
      filter,
      'A',
      '<',
      'thi',
      'nk',
      '>',
      'hidden',
      '</thi',
      'nk>',
      'B',
    );
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('AB');
    expect(out.filter((c) => c.type === 'thinking_start')).toHaveLength(1);
    expect(out.filter((c) => c.type === 'thinking_end')).toHaveLength(1);
  });

  it('supports the alternate <thinking>...</thinking> form', () => {
    const filter = new ThinkingFilter();
    const out = feed(filter, 'Hi <thinking>nope</thinking> there');
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('Hi  there');
    expect(out.some((c) => c.type === 'thinking_start')).toBe(true);
  });

  it('emits a final thinking_end if the stream ends inside a thinking block', () => {
    const filter = new ThinkingFilter();
    const out = feed(filter, 'before <think>truncated mid-thought');
    expect(out.at(-1)?.type).toBe('thinking_end');
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('before ');
  });

  it('flushes trailing visible text even when it equals the carry buffer limit', () => {
    const filter = new ThinkingFilter();
    const out = feed(filter, 'short tail.');
    const tokenText = out
      .filter((c) => c.type === 'token')
      .map((c) => (c as { token: string }).token)
      .join('');
    expect(tokenText).toBe('short tail.');
  });
});
