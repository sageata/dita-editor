import { describe, expect, test } from 'bun:test';
import { extractRenderedText } from '../src/search/rendered-text';
import { findMatches, normalizeQuery, occurrenceWithin } from '../src/search/topic-search';

const source = [
  '<topic id="t"><title>Fish &amp; Chips</title><body>',
  '<p>The quick brown fox jumps over the lazy dog near the river bank today</p>',
  '<p>fox Fox FOX</p>',
  '<p>alpha fox omega</p>',
  '</body></topic>',
].join('');
const index = extractRenderedText(source);

describe('normalizeQuery', () => {
  test('collapses internal whitespace runs and trims', () => {
    expect(normalizeQuery('  foo \t\n  bar ')).toBe('foo bar');
  });
});

describe('findMatches', () => {
  test('is case-insensitive by default', () => {
    const { matches } = findMatches(index, 'fox', false, 100);
    expect(matches.length).toBe(5);
  });

  test('respects the match-case toggle', () => {
    const { matches } = findMatches(index, 'FOX', true, 100);
    expect(matches.length).toBe(1);
  });

  test('maps a match through entities to correct source offsets', () => {
    const { matches } = findMatches(index, 'Fish & Chips', false, 100);
    expect(matches.length).toBe(1);
    const start = matches[0].sourceStart;
    const end = matches[0].sourceEnd;
    expect(source.slice(start, end)).toBe('Fish &amp; Chips');
  });

  test('builds snippets clipped at block separators', () => {
    const { matches } = findMatches(index, 'alpha fox', false, 100);
    expect(matches.length).toBe(1);
    expect(matches[0].matchText).toBe('alpha fox');
    expect(matches[0].snippetBefore).toBe('');
    expect(matches[0].snippetAfter).toBe(' omega');
    expect(matches[0].snippetBefore).not.toContain('\n');
    expect(matches[0].snippetAfter).not.toContain('\n');
  });

  test('caps matches and reports the overflow count', () => {
    const { matches, overflow } = findMatches(index, 'fox', false, 2);
    expect(matches.length).toBe(2);
    expect(overflow).toBe(3);
  });

  test('returns nothing for a query that only matches across a block boundary', () => {
    const { matches } = findMatches(index, 'today fox', false, 100);
    expect(matches.length).toBe(0);
  });
});

describe('occurrenceWithin', () => {
  test('counts equal matches before the target inside the element range', () => {
    const p2Start = source.indexOf('<p>fox Fox FOX</p>');
    const p2End = p2Start + '<p>fox Fox FOX</p>'.length;
    const { matches } = findMatches(index, 'fox', false, 100);
    const inP2 = matches.filter((m) => m.sourceStart >= p2Start && m.sourceStart < p2End);
    expect(inP2.length).toBe(3);
    expect(occurrenceWithin(index, 'fox', false, inP2[0].sourceStart, { start: p2Start, end: p2End })).toBe(0);
    expect(occurrenceWithin(index, 'fox', false, inP2[2].sourceStart, { start: p2Start, end: p2End })).toBe(2);
  });

  test('returns 0 when the source offset no longer matches', () => {
    expect(occurrenceWithin(index, 'fox', false, 1, { start: 0, end: source.length })).toBe(0);
  });
});
