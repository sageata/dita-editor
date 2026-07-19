// Pure replace planning for the Search DITA Topics view. A match carries the
// exact source range its rendered text maps to, so a replace is a single span
// substitution — but only when that span is markup-free: a match whose rendered
// text crosses an element boundary (e.g. "foo bar" over `foo <b>bar</b>`) would
// destroy tags if rewritten, so it is refused (canvas find-replace parity).
// Entities inside the span are fine — the whole span is replaced and the
// replacement is entity-escaped.

import { extractRenderedText } from './rendered-text';
import { findMatches, normalizeQuery } from './topic-search';

export interface ReplaceEdit {
  /** Absolute source offset of the first replaced char. */
  start: number;
  /** Absolute source offset just past the last replaced char. */
  end: number;
  /** Escaped replacement text to substitute for the span. */
  text: string;
}

export interface ReplaceAllPlan {
  /** Non-overlapping edits in ascending source order. */
  edits: ReplaceEdit[];
  replaced: number;
  /** Matches skipped because their source span crosses markup. */
  skippedStyled: number;
}

export type ReplaceOnePlan =
  | { ok: true; edit: ReplaceEdit }
  | { ok: false; reason: 'stale' | 'styled' };

/** Escape text for use as XML character data. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function spanCrossesMarkup(source: string, start: number, end: number): boolean {
  return source.slice(start, end).includes('<');
}

/** Plan the replacement of one previously-found match. The (renderedText,
 *  sourceStart, sourceEnd) triple is re-verified against the CURRENT source:
 *  if it no longer maps to that exact rendered occurrence the file changed
 *  since the search and the plan reports 'stale' instead of guessing.
 *  Throws ParseError when the source is not well-formed. */
export function planReplaceOne(
  source: string,
  renderedText: string,
  sourceStart: number,
  sourceEnd: number,
  replacement: string,
): ReplaceOnePlan {
  if (renderedText === '') return { ok: false, reason: 'stale' };
  const index = extractRenderedText(source);
  let from = 0;
  for (;;) {
    const at = index.text.indexOf(renderedText, from);
    if (at < 0) return { ok: false, reason: 'stale' };
    from = at + 1;
    const end = at + renderedText.length;
    if (index.sourceStarts[at] !== sourceStart) continue;
    if (index.sourceEnds[end - 1] !== sourceEnd) continue;
    if (spanCrossesMarkup(source, sourceStart, sourceEnd)) return { ok: false, reason: 'styled' };
    return { ok: true, edit: { start: sourceStart, end: sourceEnd, text: escapeXmlText(replacement) } };
  }
}

/** Plan replacing every match of the query in the source (no display caps —
 *  this is the Replace All path). Throws ParseError on malformed source. */
export function planReplaceAll(
  source: string,
  query: string,
  matchCase: boolean,
  replacement: string,
): ReplaceAllPlan {
  const plan: ReplaceAllPlan = { edits: [], replaced: 0, skippedStyled: 0 };
  if (normalizeQuery(query) === '') return plan;
  const index = extractRenderedText(source);
  const { matches } = findMatches(index, query, matchCase, Number.POSITIVE_INFINITY);
  const text = escapeXmlText(replacement);
  for (const match of matches) {
    if (spanCrossesMarkup(source, match.sourceStart, match.sourceEnd)) {
      plan.skippedStyled += 1;
      continue;
    }
    plan.edits.push({ start: match.sourceStart, end: match.sourceEnd, text });
    plan.replaced += 1;
  }
  return plan;
}
