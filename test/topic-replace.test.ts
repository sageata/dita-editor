import { describe, expect, test } from 'bun:test';
import { escapeXmlText, planReplaceAll, planReplaceOne } from '../src/search/topic-replace';

// One paragraph with an entity, one with an inline element: covers the three
// replace shapes (plain span, entity-containing span, markup-crossing span).
const source =
  '<topic id="t"><title>T</title><body>' +
  '<p>Fish &amp; chips daily</p>' +
  '<p>Try <b>fish</b> tacos</p>' +
  '</body></topic>';

const fishStart = source.indexOf('Fish');
const fishEnd = fishStart + 'Fish'.length;
const boldFishStart = source.indexOf('fish</b>');
const boldFishEnd = boldFishStart + 'fish'.length;

describe('escapeXmlText', () => {
  test('escapes the three markup-significant characters and nothing else', () => {
    expect(escapeXmlText('a<b>& "quoted"')).toBe('a&lt;b&gt;&amp; "quoted"');
    expect(escapeXmlText('plain')).toBe('plain');
    expect(escapeXmlText('')).toBe('');
  });
});

describe('planReplaceOne', () => {
  test('replaces a plain match at its exact source range', () => {
    const result = planReplaceOne(source, 'Fish', fishStart, fishEnd, 'Cod');
    expect(result).toEqual({ ok: true, edit: { start: fishStart, end: fishEnd, text: 'Cod' } });
  });

  test('replaces a span containing an entity, escaping the replacement', () => {
    const start = source.indexOf('&amp;');
    const end = source.indexOf(' chips') + ' chips'.length;
    const result = planReplaceOne(source, '& chips', start, end, 'and <fries>');
    expect(result).toEqual({
      ok: true,
      edit: { start, end, text: 'and &lt;fries&gt;' },
    });
  });

  test('a match wholly inside an inline element is plain and replaceable', () => {
    const result = planReplaceOne(source, 'fish', boldFishStart, boldFishEnd, 'cod');
    expect(result).toEqual({
      ok: true,
      edit: { start: boldFishStart, end: boldFishEnd, text: 'cod' },
    });
  });

  test('refuses a match whose source span crosses markup', () => {
    const start = boldFishStart;
    const end = source.indexOf(' tacos') + ' tacos'.length;
    const result = planReplaceOne(source, 'fish tacos', start, end, 'x');
    expect(result).toEqual({ ok: false, reason: 'styled' });
  });

  test('reports stale when the offsets no longer mark that rendered text', () => {
    expect(planReplaceOne(source, 'Fish', fishStart + 1, fishEnd, 'Cod')).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(planReplaceOne(source, 'Nope', fishStart, fishEnd, 'Cod')).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(planReplaceOne(source, '', fishStart, fishEnd, 'Cod')).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('planReplaceAll', () => {
  test('plans one edit per plain match, ascending by offset', () => {
    const plan = planReplaceAll(source, 'fish', false, 'cod');
    expect(plan.replaced).toBe(2);
    expect(plan.skippedStyled).toBe(0);
    expect(plan.edits).toEqual([
      { start: fishStart, end: fishEnd, text: 'cod' },
      { start: boldFishStart, end: boldFishEnd, text: 'cod' },
    ]);
  });

  test('honors match case', () => {
    const plan = planReplaceAll(source, 'fish', true, 'cod');
    expect(plan.replaced).toBe(1);
    expect(plan.edits).toEqual([{ start: boldFishStart, end: boldFishEnd, text: 'cod' }]);
  });

  test('skips markup-crossing matches and counts them', () => {
    const plan = planReplaceAll(source, 'fish tacos', false, 'x');
    expect(plan.replaced).toBe(0);
    expect(plan.edits).toEqual([]);
    expect(plan.skippedStyled).toBe(1);
  });

  test('escapes the replacement text', () => {
    const plan = planReplaceAll(source, 'daily', false, 'a<b>&');
    expect(plan.edits).toEqual([
      {
        start: source.indexOf('daily'),
        end: source.indexOf('daily') + 'daily'.length,
        text: 'a&lt;b&gt;&amp;',
      },
    ]);
  });

  test('a match wrapped across source whitespace replaces the whole span', () => {
    const wrapped =
      '<topic id="w"><title>W</title><body><p>beverage\n      pairing</p></body></topic>';
    const plan = planReplaceAll(wrapped, 'beverage pairing', false, 'menu');
    expect(plan.replaced).toBe(1);
    const [edit] = plan.edits;
    expect(wrapped.slice(edit.start, edit.end)).toBe('beverage\n      pairing');
    expect(edit.text).toBe('menu');
  });

  test('an empty query plans nothing', () => {
    const plan = planReplaceAll(source, '   ', false, 'x');
    expect(plan.replaced).toBe(0);
    expect(plan.edits).toEqual([]);
  });
});
