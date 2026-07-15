// Redline renderer: block diff -> Word-style merged HTML. Fixtures are inline
// XML (never corpus paths); expected markup is asserted against the REAL
// renderFragment output, since the redline promises verbatim rendering for
// unchanged blocks and real container shells around interleaved changes.
//
// Fixtures are written compact (no whitespace between blocks) where exact
// equality is asserted: the interleaved view drops inter-block whitespace text
// nodes, so a whitespace-formatted fixture would differ by collapsed spaces.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { findElement } from '../src/cst/query';
import type { Document, ElementNode } from '../src/cst/types';
import { renderFragment } from '../src/render/to-html';
import { renderRedline, type RedlineOptions } from '../src/compare/render-redline';

function redline(
  oldSrc: string,
  newSrc: string,
  options?: RedlineOptions,
): { html: string; changeCount: number } {
  return renderRedline(parse(oldSrc), parse(newSrc), options);
}

function el(doc: Document, name: string): ElementNode {
  const hit = findElement(doc, name);
  if (!hit) throw new Error(`fixture has no <${name}>`);
  return hit;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const ins = (inner: string): string => `<div class="redline-block redline-block-ins">${inner}</div>`;
const del = (inner: string): string => `<div class="redline-block redline-block-del">${inner}</div>`;

describe('renderRedline', () => {
  test('identical docs: no redline classes, changeCount 0, html === renderFragment(root)', () => {
    const src =
      '<topic id="t"><title>T</title><body>' +
      '<p>One</p><ul><li>a</li><li>b</li></ul></body></topic>';
    const { html, changeCount } = redline(src, src);

    expect(changeCount).toBe(0);
    expect(html).not.toContain('redline-');
    const doc = parse(src);
    expect(html).toBe(renderFragment([el(doc, 'topic')]));
  });

  test('topic root metadata changes are visible and included in the count', () => {
    const oldSrc = '<topic id="old"><title>T</title><body><p>Same</p></body></topic>';
    const newSrc = '<topic id="new"><title>T</title><body><p>Same</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(html).toContain('Topic metadata changed');
    expect(html).toContain('redline-block-fmt');
  });

  test('an otherwise empty added topic is visible and included in the count', () => {
    const { html, changeCount } = redline('', '<topic id="new"/>');

    expect(changeCount).toBe(1);
    expect(html).toContain('Topic added');
    expect(html).toContain('redline-block-ins');
    expect(html).toContain('<article role="article" class="nested0 topic">');
  });

  test('inserted paragraph: one ins wrapper around the new p, siblings unwrapped', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>One</p><p>Three</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>One</p><p>Two</p><p>Three</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(count(html, 'redline-block-ins')).toBe(1);
    expect(html).not.toContain('redline-block-del');
    // Positioned between its real siblings, which render unwrapped.
    expect(html).toContain(
      `<p class="p">One</p>${ins('<p class="p">Two</p>')}<p class="p">Three</p>`,
    );
  });

  test('deleted paragraph: del wrapper carries the OLD text between the right siblings', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>One</p><p>Two</p><p>Three</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>One</p><p>Three</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(count(html, 'redline-block-del')).toBe(1);
    expect(html).not.toContain('redline-block-ins');
    expect(html).toContain(
      `<p class="p">One</p>${del('<p class="p">Two</p>')}<p class="p">Three</p>`,
    );
  });

  test('edited paragraph (word-diffable leaf): ONE merged mod block, only the word marked', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Old wording</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>New wording</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(count(html, 'redline-block-mod')).toBe(1);
    expect(html).not.toContain('redline-block-del');
    expect(html).not.toContain('redline-block-ins');
    // Real <p> shell, merged inner: del/ins spans on the changed word only.
    expect(html).toContain(
      '<div class="redline-block redline-block-mod"><p class="p">'
        + '<del class="redline">Old</del><ins class="redline">New</ins> wording'
        + '</p></div>',
    );
  });

  test('appended codeblock line marks only the new preserved text', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><codeblock>const tile = \'blue\';\n\nplace(tile)\n</codeblock></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><codeblock>const tile = \'blue\';\n\nplace(tile)\n\nthere is something new here.</codeblock></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(count(html, '<pre class="pre codeblock">')).toBe(1);
    expect(html).not.toContain('redline-block-del');
    expect(html).not.toContain('redline-block-ins');
    expect(html).toContain(
      '<div class="redline-block redline-block-mod"><pre class="pre codeblock">'
        + 'const tile = \'blue\';\n\nplace(tile)'
        + '<ins class="redline">\n\nthere is something new here.</ins>'
        + '</pre></div>',
    );
  });

  test('modified leaf with a non-inline child: stacked del-then-ins fallback preserved', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Alpha <note>n</note> beta</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>Alpha <note>n</note> gamma</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(html).not.toContain('redline-block-mod');
    expect(count(html, 'redline-block-del')).toBe(1);
    expect(count(html, 'redline-block-ins')).toBe(1);
    expect(html).toContain('beta');
    expect(html).toContain('gamma');
  });

  test('li added in a ul: real ul shell preserved, only the new li wrapped', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><ul><li>a</li><li>c</li></ul></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><ul><li>a</li><li>b</li><li>c</li></ul></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    // The shell is the ACTUAL rendered <ul> open/close, not hardcoded markup.
    expect(html).toContain(
      '<ul class="ul">' +
        `<li class="li">a</li>${ins('<li class="li">b</li>')}<li class="li">c</li>` +
      '</ul>',
    );
  });

  test('formatChanged table: single fmt wrapper, table-specific label, table rendered once', () => {
    // The table sits directly under the diffed root children: the diff detects
    // formatChanged from the element's OWN attribute fingerprint at the level it
    // is compared, and an attribute-only change inside a text-unchanged <body>
    // does not surface (body is reported same) — a diff-contract property, not a
    // renderer one.
    const oldSrc =
      '<topic id="t"><title>T</title>' +
      '<table><tgroup cols="1"><tbody><row><entry>A</entry></row></tbody></tgroup></table></topic>';
    const newSrc =
      '<topic id="t"><title>T</title>' +
      '<table frame="all"><tgroup cols="1"><tbody><row><entry>A</entry></row></tbody></tgroup></table></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    expect(count(html, 'redline-block-fmt')).toBe(1);
    expect(html).toContain('<span class="redline-fmt-label">Table layout changed</span>');
    expect(count(html, '<table')).toBe(1);
    // The NEW table renders (frame-all class comes from the real renderer).
    expect(html).toContain('class="table frame-all"');
  });

  test('moved paragraph: content ONCE in the movedTo block, slim movedFrom marker, count 1', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Move me</p><p>Stay</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>Stay</p><p>Move me</p></body></topic>';
    const { html, changeCount } = redline(oldSrc, newSrc);

    expect(changeCount).toBe(1);
    // The relocated text renders exactly once, inside the movedTo block.
    expect(count(html, 'Move me')).toBe(1);
    expect(count(html, 'class="redline-block redline-block-moved"')).toBe(1);
    expect(html).toContain(
      '<div class="redline-block redline-block-moved"><span class="redline-move-label">Moved</span><p class="p">Move me</p></div>',
    );
    // The origin is a marker only: label, no content.
    expect(html).toContain(
      '<div class="redline-block redline-block-moved-from"><span class="redline-move-label">Moved from here</span></div>',
    );
    expect(html).not.toContain('redline-block-del');
    expect(html).not.toContain('redline-block-ins');
    // The unchanged sibling renders unwrapped.
    expect(html).toContain('<p class="p">Stay</p>');
  });

  test('formatLabel: applied style named via styleNames map', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Same</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p outputclass="gold-header">Same</p></body></topic>';
    const styleNames = new Map([['gold-header', 'Gold header']]);
    const { html, changeCount } = redline(oldSrc, newSrc, { styleNames });

    expect(changeCount).toBe(1);
    expect(html).toContain(
      '<span class="redline-fmt-label">Formatting: Gold header applied</span>',
    );
  });

  test('formatLabel: removed style named via styleNames map', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p outputclass="gold-header">Same</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>Same</p></body></topic>';
    const styleNames = new Map([['gold-header', 'Gold header']]);
    const { html } = redline(oldSrc, newSrc, { styleNames });

    expect(html).toContain(
      '<span class="redline-fmt-label">Formatting: Gold header removed</span>',
    );
  });

  test('formatLabel: multiple deltas joined, unmapped tokens fall back to the raw class', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p outputclass="old-style">Same</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p outputclass="gold-header zebra">Same</p></body></topic>';
    const styleNames = new Map([['gold-header', 'Gold header']]);
    const { html } = redline(oldSrc, newSrc, { styleNames });

    // Mapped name for gold-header; zebra and old-style fall back to raw tokens.
    expect(html).toContain(
      '<span class="redline-fmt-label">Formatting: Gold header applied, zebra applied, old-style removed</span>',
    );
  });

  test('formatLabel: outputclass delta without options uses raw tokens', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Same</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p outputclass="gold-header">Same</p></body></topic>';
    const { html } = redline(oldSrc, newSrc);

    expect(html).toContain(
      '<span class="redline-fmt-label">Formatting: gold-header applied</span>',
    );
  });

  test('formatLabel: non-outputclass attr change keeps the generic label', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>Same</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p otherprops="review">Same</p></body></topic>';
    const styleNames = new Map([['gold-header', 'Gold header']]);
    const { html } = redline(oldSrc, newSrc, { styleNames });

    expect(html).toContain('<span class="redline-fmt-label">Formatting changed</span>');
  });

  test('DITA-OT classes stay intact on unchanged blocks (asserted from real render output)', () => {
    const oldSrc =
      '<topic id="t"><title>Kept title</title><body>' +
      '<p>Kept paragraph</p><p>Old</p></body></topic>';
    const newSrc =
      '<topic id="t"><title>Kept title</title><body>' +
      '<p>Kept paragraph</p><p>New</p></body></topic>';
    const { html } = redline(oldSrc, newSrc);

    expect(html).toContain('<h1 class="title topictitle1">Kept title</h1>');
    expect(html).toContain('<p class="p">Kept paragraph</p>');
    expect(html).toContain('<div class="body">');
    // The unchanged paragraph is NOT wrapped.
    expect(html).not.toContain(ins('<p class="p">Kept paragraph</p>'));
    expect(html).not.toContain(del('<p class="p">Kept paragraph</p>'));
  });

  describe('merged table (modified table renders ONCE, never stacked)', () => {
    const table = (rows: string): string =>
      '<topic id="t"><title>T</title><body>' +
      '<table><tgroup cols="2">' +
      '<colspec colname="c1" colnum="1" colwidth="1*"/>' +
      '<colspec colname="c2" colnum="2" colwidth="1*"/>' +
      '<tbody>' + rows + '</tbody>' +
      '</tgroup></table></body></topic>';
    const row = (a: string, b: string): string =>
      '<row><entry>' + a + '</entry><entry>' + b + '</entry></row>';

    test('edited cell: one table, word-level marks INSIDE that cell only', () => {
      const { html, changeCount } = redline(
        table(row('alpha', 'bravo') + row('gamma', 'delta')),
        table(row('alpha', 'bravo edited') + row('gamma', 'delta')),
      );
      expect(changeCount).toBe(1);
      expect(count(html, '<table')).toBe(1);
      expect(html).not.toContain('redline-block-del');
      expect(html).not.toContain('redline-block-ins');
      // Inline word-diff INSIDE the cell: unchanged word bare, added words ins.
      expect(html).toContain('<td class="entry">bravo<ins class="redline"> edited</ins></td>');
      expect(html).not.toContain('redline-cell-del'); // no stacked fallback needed
      // Unchanged cells render plain (no marks anywhere near them).
      expect(html).toContain('>alpha</td>');
      expect(html).toContain('>delta</td>');
      // The whole merged table is flagged as containing modifications.
      expect(count(html, 'redline-block-mod')).toBe(1);
    });

    test('one-word edit inside bold within a cell paragraph: only the bold atom marked', () => {
      // Live regression: this used to strike the WHOLE cell content and stack
      // the new paragraph under it.
      const { html, changeCount } = redline(
        table(row('keep', '<p>Overall <b>in-charge</b> of guests</p>')),
        table(row('keep', '<p>Overall <b>boss</b> of guests</p>')),
      );
      expect(changeCount).toBe(1);
      expect(count(html, '<table')).toBe(1);
      expect(html).not.toContain('redline-cell-del'); // whole cell is NOT stacked
      expect(html).toContain(
        '<del class="redline"><strong class="ph b">in-charge</strong></del>'
        + '<ins class="redline"><strong class="ph b">boss</strong></ins>',
      );
      // The surrounding paragraph text stays bare (not struck).
      expect(html).toContain('Overall <del');
      expect(html).toContain(' of guests');
    });

    test('deleted row: one table, the old row spliced back in struck', () => {
      const { html, changeCount } = redline(
        table(row('a', 'b') + row('doomed', 'row') + row('e', 'f')),
        table(row('a', 'b') + row('e', 'f')),
      );
      expect(changeCount).toBe(1);
      expect(count(html, '<table')).toBe(1);
      expect(count(html, 'redline-row-del')).toBe(1);
      expect(html).toContain('class="row redline-row-del"');
      expect(html).toContain('doomed'); // the deleted content is still visible (struck)
      expect(html).not.toContain('redline-block-del');
      // Position: between the surviving rows.
      const struck = html.indexOf('redline-row-del');
      expect(struck).toBeGreaterThan(html.indexOf('>b</td>'));
      expect(html.indexOf('>e</td>')).toBeGreaterThan(struck);
    });

    test('inserted row: one table, the new row tinted in place', () => {
      const { html, changeCount } = redline(
        table(row('a', 'b') + row('e', 'f')),
        table(row('a', 'b') + row('brand', 'new') + row('e', 'f')),
      );
      expect(changeCount).toBe(1);
      expect(count(html, '<table')).toBe(1);
      expect(count(html, 'redline-row-ins')).toBe(1);
      expect(html).toContain('class="row redline-row-ins"');
      expect(html).not.toContain('redline-block-ins');
    });

    test('column widths and structure survive the merge (real colgroup, real widths)', () => {
      const { html } = redline(
        table(row('alpha', 'bravo')),
        table(row('alpha', 'bravo edited')),
      );
      // The merged table still renders through the real table path.
      expect(html).toContain('<colgroup>');
      expect(count(html, '<col ')).toBe(2);
      expect(count(html, '<tr class="row"')).toBe(1);
    });

    test('cell text turned into a list (identical visible text) is VISIBLY marked', () => {
      // Live regression: this used to diff as formatChanged and render the new
      // row completely unmarked inside the merged table — an invisible change.
      const { html, changeCount } = redline(
        table(row('keep', 'Galley operator Cabin appearance') + row('other', 'row')),
        table(row('keep', '<ul><li>Galley operator </li><li>Cabin appearance</li></ul>') + row('other', 'row')),
      );
      expect(changeCount).toBe(1);
      expect(count(html, '<table')).toBe(1);
      expect(count(html, 'redline-cell-del')).toBe(1);
      expect(count(html, 'redline-cell-ins')).toBe(1);
      // Old plain text struck, new real <ul> tinted, inside the SAME cell.
      expect(html).toContain('<span class="redline-cell-del">Galley operator Cabin appearance</span>');
      expect(html).toContain('<span class="redline-cell-ins"><ul class="ul">');
    });

    test('attr-only row change inside a content-modified table is flagged amber, not dropped', () => {
      const { html } = redline(
        table(row('a', 'b') + row('c', 'd')),
        table(row('a', 'b edited') + '<row outputclass="hl"><entry>c</entry><entry>d</entry></row>'),
      );
      expect(count(html, '<table')).toBe(1);
      expect(html).toContain('class="row hl redline-row-fmt"');
    });
  });

  test('shell-split self-check: open + children + close reassembles renderFragment([ul])', () => {
    const doc = parse('<topic id="t"><title>T</title><body><ul><li>a</li><li>b</li></ul></body></topic>');
    const ul = el(doc, 'ul');

    const containerHtml = renderFragment([ul]);
    const innerJoin = renderFragment(ul.children);
    const at = containerHtml.indexOf(innerJoin);

    expect(at).toBeGreaterThanOrEqual(0);
    const open = containerHtml.slice(0, at);
    const close = containerHtml.slice(at + innerJoin.length);
    expect(open + innerJoin + close).toBe(containerHtml);
    expect(open).toBe('<ul class="ul">');
    expect(close).toBe('</ul>');
  });
});
