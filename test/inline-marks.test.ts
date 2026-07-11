import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import type { ElementNode } from '../src/cst/types';
import {
  applyInlineMark,
  decodeEntities,
  expandWordRange,
  removeInlineStyles,
} from '../src/cst/inline-marks';

const TOPIC = (body: string) => `<topic id="t"><title>T</title><body>${body}</body></topic>`;

function firstId(src: string, name: string): string {
  for (const [el, id] of assignElementIds(parse(src))) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no <${name}>`);
}

describe('inline mark range engine', () => {
  test('adds bold to an exact sub-range', () => {
    const src = TOPIC('<p>foo bar baz</p>');
    const out = applyInlineMark(src, firstId(src, 'p'), 4, 7, 'b', 'add');
    expect(out).toContain('<p>foo <b>bar</b> baz</p>');
  });

  test('removes bold from an exact sub-range and splits the styled run', () => {
    const src = TOPIC('<p><b>foobar</b></p>');
    const out = applyInlineMark(src, firstId(src, 'p'), 1, 4, 'b', 'remove');
    expect(out).toContain('<p><b>f</b>oob<b>ar</b></p>');
  });

  test('toggle adds first, then removes when the full range already has the mark', () => {
    const src = TOPIC('<p>foo bar</p>');
    const once = applyInlineMark(src, firstId(src, 'p'), 4, 7, 'b');
    expect(once).toContain('<p>foo <b>bar</b></p>');
    const twice = applyInlineMark(once, firstId(once, 'p'), 4, 7, 'b');
    expect(twice).toBe(src);
  });

  test('mixed selection first becomes uniformly styled, then toggles off', () => {
    const src = TOPIC('<p><b>bold</b> plain</p>');
    const once = applyInlineMark(src, firstId(src, 'p'), 0, 10, 'b');
    expect(once).toContain('<p><b>bold plain</b></p>');
    const twice = applyInlineMark(once, firstId(once, 'p'), 0, 10, 'b');
    expect(twice).toContain('<p>bold plain</p>');
  });

  test('overlapping marks rebuild in canonical order regardless of operation order', () => {
    const src = TOPIC('<p>x</p>');
    const boldFirst = applyInlineMark(src, firstId(src, 'p'), 0, 1, 'b', 'add');
    const boldThenItalic = applyInlineMark(boldFirst, firstId(boldFirst, 'p'), 0, 1, 'i', 'add');
    const italicFirst = applyInlineMark(src, firstId(src, 'p'), 0, 1, 'i', 'add');
    const italicThenBold = applyInlineMark(italicFirst, firstId(italicFirst, 'p'), 0, 1, 'b', 'add');
    expect(boldThenItalic).toContain('<p><b><i>x</i></b></p>');
    expect(italicThenBold).toContain('<p><b><i>x</i></b></p>');
  });

  test('remove all strips highlight marks and preserves inline atoms with attributes', () => {
    const src = TOPIC(
      '<p><b>see <xref href="topic.dita#t/x">label</xref> <image href="seat.jpg"/><ph conref="warn.dita#w/e"/> now</b></p>',
    );
    const out = removeInlineStyles(src, firstId(src, 'p'), 0, 14);
    expect(out).toContain(
      '<p>see <xref href="topic.dita#t/x">label</xref> <image href="seat.jpg"/><ph conref="warn.dita#w/e"/> now</p>',
    );
    expect(out).not.toContain('<b>');
  });

  test('atom attributes survive styling across the atom', () => {
    const src = TOPIC('<p>see <xref href="a&amp;b.dita#t/x">label</xref> now</p>');
    const out = applyInlineMark(src, firstId(src, 'p'), 0, 13, 'b', 'add');
    expect(out).toContain('<p><b>see <xref href="a&amp;b.dita#t/x">label</xref> now</b></p>');
  });

  test('entities decode for offsets and re-escape on rebuild', () => {
    expect(decodeEntities('a &amp; b &#38; &#x26; &lt;')).toBe('a & b & & <');
    const src = TOPIC('<p>a &amp; b</p>');
    const out = applyInlineMark(src, firstId(src, 'p'), 2, 3, 'codeph', 'add');
    expect(out).toContain('<p>a <codeph>&amp;</codeph> b</p>');
    const roundTrip = applyInlineMark(out, firstId(out, 'p'), 2, 3, 'codeph');
    expect(roundTrip).toBe(src);
  });
});

describe('whole-word expansion', () => {
  test('expands a caret inside a word', () => {
    expect(expandWordRange('alpha beta', 8)).toEqual({ start: 6, end: 10 });
  });

  test('expands from the end boundary of a word', () => {
    expect(expandWordRange('alpha beta', 5)).toEqual({ start: 0, end: 5 });
  });

  test('returns a collapsed range on punctuation between words', () => {
    expect(expandWordRange('alpha, beta', 5)).toEqual({ start: 0, end: 5 });
    expect(expandWordRange('alpha, beta', 6)).toEqual({ start: 6, end: 6 });
  });
});
