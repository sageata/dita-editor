import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { findElement, firstTextChild } from '../src/cst/query';
import type { ElementNode } from '../src/cst/types';
import { renderWordDiff, WORD_DIFF_TOKEN_CAP } from '../src/compare/word-diff';

function el(src: string, name: string): ElementNode {
  const hit = findElement(parse(src), name);
  if (!hit) throw new Error(`no <${name}> in fixture`);
  return hit;
}

function p(inner: string): ElementNode {
  return el(`<topic id="t"><p>${inner}</p></topic>`, 'p');
}

describe('word-diff: word-level runs', () => {
  test('one-word edit yields exactly one del and one ins run, rest bare', () => {
    const html = renderWordDiff(p('The quick brown fox jumps'), p('The quick red fox jumps'));
    expect(html).toBe(
      'The quick <del class="redline">brown</del><ins class="redline">red</ins> fox jumps',
    );
  });

  test('edit beside inline markup keeps the markup html intact and unmarked', () => {
    const html = renderWordDiff(
      p('Press <b>Start</b> to begin now'),
      p('Press <b>Start</b> to begin immediately'),
    );
    expect(html).toBe(
      'Press <strong class="ph b">Start</strong> to begin '
      + '<del class="redline">now</del><ins class="redline">immediately</ins>',
    );
  });

  test('edit INSIDE <b> replaces the whole inline element as one atomic token', () => {
    const html = renderWordDiff(
      p('Press <b>Start Engine</b> now'),
      p('Press <b>Stop Engine</b> now'),
    );
    expect(html).toBe(
      'Press <del class="redline"><strong class="ph b">Start Engine</strong></del>'
      + '<ins class="redline"><strong class="ph b">Stop Engine</strong></ins> now',
    );
  });

  test('xref @href change with the same text replaces the atomic token', () => {
    const html = renderWordDiff(
      p('See <xref href="a.dita">the guide</xref> for details'),
      p('See <xref href="b.dita">the guide</xref> for details'),
    );
    expect(html).toBe(
      'See <del class="redline"><a class="xref">the guide</a></del>'
      + '<ins class="redline"><a class="xref">the guide</a></ins> for details',
    );
  });
});

describe('word-diff: entity handling', () => {
  test('raw &amp; in unchanged text appears once, never double-escaped', () => {
    const html = renderWordDiff(p('Fish &amp; chips daily'), p('Fish &amp; chips weekly'));
    expect(html).toBe(
      'Fish &amp; chips <del class="redline">daily</del><ins class="redline">weekly</ins>',
    );
    expect(((html ?? '').match(/&amp;/g) ?? []).length).toBe(1);
    expect(html).not.toContain('&amp;amp;');
  });

  test('edited text (newText) is escaped exactly like the renderer escapes it', () => {
    const oldP = p('Fish &amp; chips');
    const newP = p('Fish &amp; chips');
    const textNode = firstTextChild(newP)!;
    textNode.newText = 'Fish & chips today'; // decoded edit: & must re-escape once
    const html = renderWordDiff(oldP, newP);
    expect(html).toBe('Fish &amp; chips<ins class="redline"> today</ins>');
    expect(html).not.toContain('&amp;amp;');
  });
});

describe('word-diff: null gates', () => {
  test('a non-whitelisted (block-ish) element child aborts to null', () => {
    const oldNote = el('<topic id="t"><note><p>alpha text</p></note></topic>', 'note');
    const newNote = el('<topic id="t"><note><p>alpha text changed</p></note></topic>', 'note');
    expect(renderWordDiff(oldNote, newNote)).toBeNull();
  });

  test('xml:space="preserve" on either side aborts to null', () => {
    const preserved = el('<topic id="t"><p xml:space="preserve">a b</p></topic>', 'p');
    expect(renderWordDiff(preserved, p('a b c'))).toBeNull();
    expect(renderWordDiff(p('a b c'), preserved)).toBeNull();
  });

  test('identical sides return null (no visible change)', () => {
    expect(renderWordDiff(p('same text here'), p('same text here'))).toBeNull();
  });

  test('whitespace-only difference returns null (edge trim + whitespace-key collapse)', () => {
    expect(renderWordDiff(p('hello   world'), p(' hello world '))).toBeNull();
  });

  test('token count over the cap on either side aborts to null', () => {
    // N words + N-1 separators > cap when N = cap/2 + 1.
    const words = Array.from({ length: WORD_DIFF_TOKEN_CAP / 2 + 1 }, (_, i) => `w${i}`).join(' ');
    expect(renderWordDiff(p(words), p('short side'))).toBeNull();
    expect(renderWordDiff(p('short side'), p(words))).toBeNull();
  });
});
