// F7 — column reorder (moveColumnLeft/moveColumnRight): adjacent column swap.
// Colspecs move as clean nodes (colwidth rides along, renumber restores c1..cN);
// every row swaps its two cells, thead included. Refuses merged/pinned tables.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { findElements, childrenNamed } from '../src/cst/query';
import { isValid, indexDocument } from '../src/commands/validity';
import type { ElementNode } from '../src/cst/types';

const stable = (s: string) => serialize(parse(s)) === s;

function entryIdByText(src: string, text: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    const e = el as ElementNode;
    if (e.name !== 'entry') continue;
    const t = e.children.map((c) => (c.type === 'text' ? c.raw : '')).join('');
    if (t === text) return id;
  }
  throw new Error(`no <entry>${text}</entry>`);
}

const rowTexts = (src: string): string[][] =>
  findElements(parse(src), 'row').map((r) =>
    childrenNamed(r, 'entry').map((e) =>
      e.children.map((c) => (c.type === 'text' ? c.raw : '')).join(''),
    ),
  );

const colAttr = (src: string, name: 'colname' | 'colnum' | 'colwidth'): Array<string | undefined> =>
  childrenNamed(findElements(parse(src), 'tgroup')[0], 'colspec').map(
    (c) => c.attrs.find((a) => a.name === name)?.value,
  );

const T =
  '<topic><body>\n' +
  '  <table><tgroup cols="3">\n' +
  '    <colspec colname="c1" colnum="1" colwidth="1*"/>\n' +
  '    <colspec colname="c2" colnum="2" colwidth="2*"/>\n' +
  '    <colspec colname="c3" colnum="3" colwidth="3*"/>\n' +
  '    <thead>\n' +
  '      <row>\n        <entry>H1</entry>\n        <entry>H2</entry>\n        <entry>H3</entry>\n      </row>\n' +
  '    </thead>\n' +
  '    <tbody>\n' +
  '      <row>\n        <entry>a</entry>\n        <entry>b</entry>\n        <entry>c</entry>\n      </row>\n' +
  '    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

describe('moveColumnLeft / moveColumnRight', () => {
  test('moveColumnRight swaps the column in EVERY row (thead included); widths ride along', () => {
    const res = applyStructuralEdit(T, 'moveColumnRight', entryIdByText(T, 'a'));
    const out = res.source;
    expect(rowTexts(out)).toEqual([
      ['H2', 'H1', 'H3'],
      ['b', 'a', 'c'],
    ]);
    // colnames stay canonical c1..cN while the WIDTHS follow the moved columns.
    expect(colAttr(out, 'colname')).toEqual(['c1', 'c2', 'c3']);
    expect(colAttr(out, 'colnum')).toEqual(['1', '2', '3']);
    expect(colAttr(out, 'colwidth')).toEqual(['2*', '1*', '3*']);
    expect(res.focusId).toBe(entryIdByText(out, 'a')); // focus follows the anchor cell
    expect(stable(out)).toBe(true);
  });

  test('moveColumnLeft is the exact inverse', () => {
    const moved = applyStructuralEdit(T, 'moveColumnRight', entryIdByText(T, 'a')).source;
    const back = applyStructuralEdit(moved, 'moveColumnLeft', entryIdByText(moved, 'a')).source;
    expect(rowTexts(back)).toEqual(rowTexts(T));
    expect(colAttr(back, 'colwidth')).toEqual(['1*', '2*', '3*']);
    expect(stable(back)).toBe(true);
  });

  test('boundary refusals: first column left, last column right', () => {
    expect(() => applyStructuralEdit(T, 'moveColumnLeft', entryIdByText(T, 'a'))).toThrow(/first column/i);
    expect(() => applyStructuralEdit(T, 'moveColumnRight', entryIdByText(T, 'c'))).toThrow(/last column/i);
  });

  test('refuses merged-cell tables', () => {
    const spanned = T.replace('<entry>b</entry>', '<entry morerows="0" namest="c2" nameend="c3">b</entry>')
      .replace('        <entry>c</entry>\n', '');
    expect(() => applyStructuralEdit(spanned, 'moveColumnRight', entryIdByText(spanned, 'a'))).toThrow(/merged/i);
  });

  test('refuses colname-pinned cells (a positional swap would silently re-map them)', () => {
    const pinned = T.replace('<entry>b</entry>', '<entry colname="c2">b</entry>');
    expect(() => applyStructuralEdit(pinned, 'moveColumnRight', entryIdByText(pinned, 'a'))).toThrow(/named column/i);
  });

  test('validity mirrors the guards', () => {
    const idx = indexDocument(T);
    expect(isValid('moveColumnRight', { id: entryIdByText(T, 'a') }, idx).enabled).toBe(true);
    expect(isValid('moveColumnLeft', { id: entryIdByText(T, 'a') }, idx).reason).toMatch(/first column/i);
    expect(isValid('moveColumnRight', { id: entryIdByText(T, 'c') }, idx).reason).toMatch(/last column/i);
  });
});
