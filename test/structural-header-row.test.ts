// F6 — header row toggle: promoteRowToHeader / demoteRowFromHeader move a row
// across the thead/tbody boundary as a CLEAN node (verbatim bytes, new seams
// only). Real parser + real ops; byte-stability asserted via serialize(parse(x)).

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { findElements, childrenNamed } from '../src/cst/query';
import { isValid, indexDocument } from '../src/commands/validity';
import type { ElementNode } from '../src/cst/types';

const stable = (s: string) => serialize(parse(s)) === s;

function rowId(src: string, section: 'thead' | 'tbody', nth = 0): string {
  const doc = parse(src);
  let seen = 0;
  for (const [el, id] of assignElementIds(doc)) {
    const e = el as ElementNode;
    if (e.name === 'row' && e.parent?.name === section) {
      if (seen === nth) return id;
      seen += 1;
    }
  }
  throw new Error(`no <row> #${nth} in <${section}>`);
}

function sectionRows(src: string, section: 'thead' | 'tbody'): ElementNode[] {
  const sec = findElements(parse(src), section)[0];
  return sec ? childrenNamed(sec, 'row') : [];
}

const cellTexts = (row: ElementNode): string[] =>
  childrenNamed(row, 'entry').map((e) =>
    e.children.map((c) => (c.type === 'text' ? c.raw : '')).join(''),
  );

// Body-only table (no thead yet): promote must CREATE the thead.
const BODY_ONLY =
  '<topic><body>\n' +
  '  <table><tgroup cols="2">\n' +
  '    <colspec colname="c1" colnum="1"/>\n' +
  '    <colspec colname="c2" colnum="2"/>\n' +
  '    <tbody>\n' +
  '      <row>\n        <entry>h1</entry>\n        <entry>h2</entry>\n      </row>\n' +
  '      <row>\n        <entry>a</entry>\n        <entry>b</entry>\n      </row>\n' +
  '    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

// Table that already has a thead.
const WITH_THEAD =
  '<topic><body>\n' +
  '  <table><tgroup cols="2">\n' +
  '    <colspec colname="c1" colnum="1"/>\n' +
  '    <colspec colname="c2" colnum="2"/>\n' +
  '    <thead>\n' +
  '      <row>\n        <entry>H1</entry>\n        <entry>H2</entry>\n      </row>\n' +
  '    </thead>\n' +
  '    <tbody>\n' +
  '      <row>\n        <entry>a</entry>\n        <entry>b</entry>\n      </row>\n' +
  '      <row>\n        <entry>c</entry>\n        <entry>d</entry>\n      </row>\n' +
  '    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

describe('promoteRowToHeader', () => {
  test('creates <thead> before <tbody> when absent; row moves verbatim', () => {
    const res = applyStructuralEdit(BODY_ONLY, 'promoteRowToHeader', rowId(BODY_ONLY, 'tbody', 0));
    const out = res.source;
    expect(sectionRows(out, 'thead').length).toBe(1);
    expect(sectionRows(out, 'tbody').length).toBe(1);
    expect(cellTexts(sectionRows(out, 'thead')[0])).toEqual(['h1', 'h2']);
    expect(cellTexts(sectionRows(out, 'tbody')[0])).toEqual(['a', 'b']);
    expect(out.indexOf('<thead>')).toBeLessThan(out.indexOf('<tbody>')); // CALS order
    expect(res.focusId).toBeTruthy();
    expect(stable(out)).toBe(true);
  });

  test('appends to an EXISTING thead (after its last row)', () => {
    const res = applyStructuralEdit(WITH_THEAD, 'promoteRowToHeader', rowId(WITH_THEAD, 'tbody', 0));
    const out = res.source;
    expect(sectionRows(out, 'thead').length).toBe(2);
    expect(sectionRows(out, 'tbody').length).toBe(1);
    expect(cellTexts(sectionRows(out, 'thead')[1])).toEqual(['a', 'b']); // moved row is LAST in thead
    expect(stable(out)).toBe(true);
  });

  test('refuses on the only body row (tbody is (row)+), writing nothing', () => {
    const res = applyStructuralEdit(WITH_THEAD, 'promoteRowToHeader', rowId(WITH_THEAD, 'tbody', 0));
    // Take the result down to a 1-body-row table, then try to promote again.
    const one = res.source;
    expect(() =>
      applyStructuralEdit(one, 'promoteRowToHeader', rowId(one, 'tbody', 0)),
    ).toThrow(/only body row/i);
  });

  test('refuses on a non-first body row', () => {
    expect(() =>
      applyStructuralEdit(WITH_THEAD, 'promoteRowToHeader', rowId(WITH_THEAD, 'tbody', 1)),
    ).toThrow(/first body row/i);
  });

  test('refuses when the row carries a vertical span (morerows)', () => {
    const spanned = WITH_THEAD.replace('<entry>a</entry>', '<entry morerows="1">a</entry>');
    expect(() =>
      applyStructuralEdit(spanned, 'promoteRowToHeader', rowId(spanned, 'tbody', 0)),
    ).toThrow(/vertical span/i);
  });
});

describe('demoteRowFromHeader', () => {
  test('moves the last thead row to the FRONT of the tbody; sole-row thead is removed', () => {
    const res = applyStructuralEdit(WITH_THEAD, 'demoteRowFromHeader', rowId(WITH_THEAD, 'thead', 0));
    const out = res.source;
    expect(findElements(parse(out), 'thead').length).toBe(0); // row-empty thead removed entirely
    expect(sectionRows(out, 'tbody').length).toBe(3);
    expect(cellTexts(sectionRows(out, 'tbody')[0])).toEqual(['H1', 'H2']); // demoted row first
    expect(stable(out)).toBe(true);
  });

  test('promote then demote round-trips the grid shape (byte-stable both ways)', () => {
    const promoted = applyStructuralEdit(BODY_ONLY, 'promoteRowToHeader', rowId(BODY_ONLY, 'tbody', 0)).source;
    expect(stable(promoted)).toBe(true);
    const demoted = applyStructuralEdit(promoted, 'demoteRowFromHeader', rowId(promoted, 'thead', 0)).source;
    expect(stable(demoted)).toBe(true);
    expect(sectionRows(demoted, 'tbody').length).toBe(2);
    expect(findElements(parse(demoted), 'thead').length).toBe(0);
    expect(cellTexts(sectionRows(demoted, 'tbody')[0])).toEqual(['h1', 'h2']);
  });

  test('refuses on a tbody row', () => {
    expect(() =>
      applyStructuralEdit(WITH_THEAD, 'demoteRowFromHeader', rowId(WITH_THEAD, 'tbody', 0)),
    ).toThrow(/not a header row/i);
  });
});

describe('validity mirrors the ops', () => {
  test('promote enabled on first tbody row, disabled with reasons elsewhere', () => {
    const idx = indexDocument(WITH_THEAD);
    const first = rowId(WITH_THEAD, 'tbody', 0);
    const second = rowId(WITH_THEAD, 'tbody', 1);
    const head = rowId(WITH_THEAD, 'thead', 0);
    expect(isValid('promoteRowToHeader', { id: first }, idx).enabled).toBe(true);
    expect(isValid('promoteRowToHeader', { id: second }, idx).reason).toMatch(/first body row/i);
    expect(isValid('promoteRowToHeader', { id: head }, idx).reason).toMatch(/already a header/i);
    expect(isValid('demoteRowFromHeader', { id: head }, idx).enabled).toBe(true);
    expect(isValid('demoteRowFromHeader', { id: first }, idx).reason).toMatch(/not a header/i);
  });
});
