// Pure matching over a RenderedTextIndex: literal substring with a match-case
// toggle (same semantics as the in-canvas find bar), snippets clipped at block
// separators, and occurrence counting for the exact-highlight handoff.

import type { RenderedTextIndex } from './rendered-text';

export interface TopicSearchMatch {
  /** Absolute source offset of the first char of the match. */
  sourceStart: number;
  /** Absolute source offset just past the last char of the match. */
  sourceEnd: number;
  snippetBefore: string;
  matchText: string;
  snippetAfter: string;
}

export interface FindMatchesResult {
  matches: TopicSearchMatch[];
  /** Matches beyond maxMatches that were counted but not built. */
  overflow: number;
}

const SNIPPET_CONTEXT = 48;

/** Collapse whitespace runs to single spaces and trim — queries typed with
 *  plain spaces then match text however it wraps in the source. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function haystackFor(index: RenderedTextIndex, matchCase: boolean): string {
  return matchCase ? index.text : index.text.toLowerCase();
}

export function findMatches(
  index: RenderedTextIndex,
  query: string,
  matchCase: boolean,
  maxMatches: number,
): FindMatchesResult {
  const needleRaw = normalizeQuery(query);
  if (needleRaw === '') return { matches: [], overflow: 0 };
  const needle = matchCase ? needleRaw : needleRaw.toLowerCase();
  const haystack = haystackFor(index, matchCase);
  const matches: TopicSearchMatch[] = [];
  let overflow = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    from = at + Math.max(1, needle.length);
    if (matches.length >= maxMatches) {
      overflow += 1;
      continue;
    }
    const end = at + needle.length;
    const blockStart = index.text.lastIndexOf('\n', at) + 1;
    const blockEndAt = index.text.indexOf('\n', end);
    const blockEnd = blockEndAt < 0 ? index.text.length : blockEndAt;
    matches.push({
      sourceStart: index.sourceStarts[at],
      sourceEnd: index.sourceEnds[end - 1],
      snippetBefore: index.text.slice(Math.max(blockStart, at - SNIPPET_CONTEXT), at),
      matchText: index.text.slice(at, end),
      snippetAfter: index.text.slice(end, Math.min(blockEnd, end + SNIPPET_CONTEXT)),
    });
  }
  return { matches, overflow };
}

/** 0-based occurrence index, within the element's source range, of the match
 *  starting at sourceStart. Lets the canvas find the same instance by counting
 *  occurrences in its own DOM text. Returns 0 when the offset no longer marks
 *  a match (stale index) — callers fall back to the first occurrence. */
export function occurrenceWithin(
  index: RenderedTextIndex,
  query: string,
  matchCase: boolean,
  sourceStart: number,
  elementRange: { start: number; end: number },
): number {
  const needleRaw = normalizeQuery(query);
  if (needleRaw === '') return 0;
  const needle = matchCase ? needleRaw : needleRaw.toLowerCase();
  const haystack = haystackFor(index, matchCase);
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return 0;
    from = at + Math.max(1, needle.length);
    const start = index.sourceStarts[at];
    if (start === sourceStart) return count;
    if (start >= elementRange.start && start < elementRange.end) count += 1;
  }
}
