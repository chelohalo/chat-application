import { LlmStreamChunk } from '../llm.types';

/**
 * Stateful streaming filter that splits visible tokens from `<think>...</think>`
 * reasoning blocks emitted inline by some LLMs (DeepSeek-R1, QwQ, certain
 * OpenRouter passthroughs).
 *
 * Usage:
 *   const filter = new ThinkingFilter();
 *   for (const chunk of filter.push(rawTokenText)) yield chunk;
 *   for (const chunk of filter.flush()) yield chunk;
 *
 * Why it has to be stateful:
 *   The `<think>` / `</think>` markers may be split across upstream chunks
 *   (e.g. one chunk ends with `<thi` and the next starts with `nk>`). We
 *   maintain a small carry buffer (longer than the longest tag we look for)
 *   and only emit visible tokens once we've confirmed the prefix is safe.
 *
 * Why we don't just regex the buffered text:
 *   Buffering the entire response would defeat streaming. The filter is
 *   designed so non-thinking models pay near-zero overhead (the carry buffer
 *   is flushed as soon as we know the byte can't be the start of a tag).
 */
export class ThinkingFilter {
  private inside = false;
  private carry = '';
  private static readonly OPEN_TAGS = ['<think>', '<thinking>'];
  private static readonly CLOSE_TAGS = ['</think>', '</thinking>'];
  private static readonly MAX_LOOKAHEAD = 10;

  /**
   * Feeds an upstream text fragment through the filter and returns whatever
   * LlmStreamChunks (visible tokens and/or thinking markers) are safe to
   * emit right now. Tokens that might still be the start of a tag are held
   * back in the carry buffer until disambiguated.
   */
  push(text: string): LlmStreamChunk[] {
    if (!text) return [];
    // Move the carry into `work` and clear it. Any iteration that ends without
    // re-populating `this.carry` MUST leave it empty — otherwise the stale
    // prefix gets prepended to the next chunk and leaks reasoning text.
    let work = this.carry + text;
    this.carry = '';
    const out: LlmStreamChunk[] = [];

    while (work.length > 0) {
      if (this.inside) {
        const closeIdx = this.findEarliestTag(work, ThinkingFilter.CLOSE_TAGS);
        if (closeIdx === null) {
          // No complete close tag found. Suppress everything except a
          // possible *partial* close tag at the very end.
          this.carry = this.extractAmbiguousTail(work, ThinkingFilter.CLOSE_TAGS);
          work = '';
          break;
        }
        out.push({ type: 'thinking_end' });
        this.inside = false;
        work = work.slice(closeIdx.index + closeIdx.length);
      } else {
        const openIdx = this.findEarliestTag(work, ThinkingFilter.OPEN_TAGS);
        if (openIdx === null) {
          // No complete open tag. Emit everything except a possible *partial*
          // open tag at the end. Non-thinking models pay zero overhead here
          // because their content never ends with a `<` plus prefix chars,
          // so `extractAmbiguousTail` returns '' and we flush the full chunk.
          const heldTail = this.extractAmbiguousTail(work, ThinkingFilter.OPEN_TAGS);
          const safe = work.slice(0, work.length - heldTail.length);
          if (safe.length > 0) out.push({ type: 'token', token: safe });
          this.carry = heldTail;
          work = '';
          break;
        }
        const before = work.slice(0, openIdx.index);
        if (before.length > 0) out.push({ type: 'token', token: before });
        out.push({ type: 'thinking_start' });
        this.inside = true;
        work = work.slice(openIdx.index + openIdx.length);
      }
    }

    return out;
  }

  /**
   * Returns the longest suffix of `s` that is a strict prefix of some tag
   * (and could therefore complete the tag once more bytes arrive). Returns
   * '' if no such suffix exists, meaning the entire `s` is safe to emit.
   *
   * Example: `extractAmbiguousTail("foo <thi", OPEN_TAGS)` returns `"<thi"`
   * because that's a strict prefix of `<think>`. `extractAmbiguousTail("foo bar")`
   * returns `""` — nothing could become a tag.
   */
  private extractAmbiguousTail(s: string, tags: readonly string[]): string {
    const maxLen = Math.min(s.length, ThinkingFilter.MAX_LOOKAHEAD);
    for (let len = maxLen; len > 0; len--) {
      const tail = s.slice(s.length - len);
      for (const tag of tags) {
        if (tag.length > tail.length && tag.startsWith(tail)) {
          return tail;
        }
      }
    }
    return '';
  }

  /**
   * Call once after the upstream stream ends. Flushes any held-back text
   * that we know now can't be a tag (because no more bytes are coming).
   * If we ended mid-thinking we emit a `thinking_end` so the UI returns to
   * normal state.
   */
  flush(): LlmStreamChunk[] {
    const out: LlmStreamChunk[] = [];
    if (this.carry.length > 0) {
      if (!this.inside) out.push({ type: 'token', token: this.carry });
      // If we ended inside a thinking block, the carry is reasoning text that
      // we deliberately suppress.
      this.carry = '';
    }
    if (this.inside) {
      out.push({ type: 'thinking_end' });
      this.inside = false;
    }
    return out;
  }

  /** Cheapest tag finder: scan for the earliest occurrence of any tag. */
  private findEarliestTag(
    haystack: string,
    tags: readonly string[],
  ): { index: number; length: number } | null {
    let best: { index: number; length: number } | null = null;
    for (const tag of tags) {
      const idx = haystack.indexOf(tag);
      if (idx === -1) continue;
      if (best === null || idx < best.index) {
        best = { index: idx, length: tag.length };
      }
    }
    return best;
  }
}
