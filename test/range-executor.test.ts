// Pure range executor. Every test parses REAL DITA and selects elements by their
// real e{N} ids (via indexDocument). No mock data. Delete cases (no inter-element
// whitespace) assert exact bytes; merge cases assert structure + a VALID CALS grid
// on the result + byte-exact round-trip (the real risk of composing merges is
// producing a malformed grid, so that is checked explicitly).

import { test, expect, describe } from 'bun:test';
import { serialize } from '../src/cst/serialize';
import { computeGrid, isGridValid } from '../src/cst/table-grid';
import { findElements, findElement } from '../src/cst/query';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { executeRangeDelete, executeCellRectMerge } from '../src/commands/range-executor';

function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

const THREE_P = '<body><p>p1</p><p>p2</p><p>p3</p></body>';
const TWO_BY_TWO =
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry>a</entry><entry>b</entry></row>' +
  '<row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';

/** Re-parse a result and confirm its CALS grid is well-formed. */
function gridValid(source: string): boolean {
  const tgroup = findElement(indexDocument(source).doc, 'tgroup');
  if (!tgroup) throw new Error('no tgroup');
  return isGridValid(computeGrid(tgroup));
}

describe('executeRangeDelete', () => {
  test('deletes a contiguous block run atomically (exact bytes)', () => {
    const idx = indexDocument(THREE_P);
    const p1 = idOf(idx, 'p', 'p1');
    const p2 = idOf(idx, 'p', 'p2');
    const r = executeRangeDelete(THREE_P, [p2, p1]); // unordered input
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><p>p3</p></body>');
  });

  test('forwards the planner reject for a non-contiguous selection', () => {
    const idx = indexDocument(THREE_P);
    const r = executeRangeDelete(THREE_P, [idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p3')]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('non-contiguous');
    expect(r.source).toBe(THREE_P);
  });

  test('forwards deletes-whole-container', () => {
    const idx = indexDocument(THREE_P);
    const all = ['p1', 'p2', 'p3'].map((t) => idOf(idx, 'p', t));
    const r = executeRangeDelete(THREE_P, all);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('deletes-whole-container');
  });

  test('unrelated content (whitespace + siblings) stays byte-exact + round-trips', () => {
    const DOC = '<body>\n  <p>one</p>\n  <p>two</p>\n  <p>three</p>\n  <p>four</p>\n</body>';
    const idx = indexDocument(DOC);
    const two = idOf(idx, 'p', 'two');
    const three = idOf(idx, 'p', 'three');
    const r = executeRangeDelete(DOC, [two, three]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toContain('<p>one</p>');
    expect(r.source).toContain('<p>four</p>');
    expect(r.source).not.toContain('two');
    expect(r.source).not.toContain('three');
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });
});

describe('executeRangeDelete — whole blocks (table / list / fig)', () => {
  const BLOCKS =
    '<body>' +
    '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table>' +
    '<p>keep</p></body>';

  test('deletes a single whole <table> (op resolves to deleteTable)', () => {
    const idx = indexDocument(BLOCKS);
    const r = executeRangeDelete(BLOCKS, [idOf(idx, 'table')]);
    expect(r.ok).toBe(true);
    if (!r.ok || r.action !== 'rangeDelete') throw new Error('expected ok rangeDelete');
    expect(r.source).toBe('<body><p>keep</p></body>');
    expect(r.plan.op).toBe('deleteTable');
  });

  test('deletes a contiguous run of two <ul> (deleteList) atomically', () => {
    const TWO_LISTS = '<body><ul><li>a</li></ul><ul><li>b</li></ul><p>keep</p></body>';
    const idx = indexDocument(TWO_LISTS);
    const ulIds: string[] = [];
    for (const [id, el] of idx.byId) if (el.name === 'ul') ulIds.push(id);
    expect(ulIds.length).toBe(2);
    const r = executeRangeDelete(TWO_LISTS, [ulIds[1], ulIds[0]]); // unordered
    expect(r.ok).toBe(true);
    if (!r.ok || r.action !== 'rangeDelete') throw new Error('expected ok rangeDelete');
    expect(r.source).toBe('<body><p>keep</p></body>');
    expect(r.plan.op).toBe('deleteList');
  });

  test('selecting EVERY <li> of a list deletes the whole list (promoted to deleteList)', () => {
    const DOC = '<body><p>keep</p><ul><li>a1</li><li>a2</li><li>a3</li></ul></body>';
    const idx = indexDocument(DOC);
    const liIds = ['a1', 'a2', 'a3'].map((t) => idOf(idx, 'li', t));
    const r = executeRangeDelete(DOC, liIds);
    expect(r.ok).toBe(true);
    if (!r.ok || r.action !== 'rangeDelete') throw new Error('expected ok rangeDelete');
    expect(r.source).toBe('<body><p>keep</p></body>'); // the <ul> is gone, sibling <p> intact
    expect(r.plan.op).toBe('deleteList');
  });
});

describe('executeCellRectMerge', () => {
  test('merges a full 2x2 into the anchor → valid grid, one contentful cell', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const ids = ['a', 'b', 'c', 'd'].map((t) => idOf(idx, 'entry', t));
    const r = executeCellRectMerge(TWO_BY_TWO, ids);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toContain('namest="c1"');
    expect(r.source).toContain('nameend="c2"');
    expect(r.source).toContain('morerows="1"');
    expect(r.source).toContain('a b c d'); // absorbed content preserved
    // exactly one <entry> survives (the merged anchor); b/c/d removed.
    expect(findElements(indexDocument(r.source).doc, 'entry').length).toBe(1);
    expect(gridValid(r.source)).toBe(true);
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });

  test('merges a 1x2 horizontal pair → spanning cell, lower row intact', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const r = executeCellRectMerge(TWO_BY_TWO, [idOf(idx, 'entry', 'a'), idOf(idx, 'entry', 'b')]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toContain('namest="c1"');
    expect(r.source).toContain('nameend="c2"');
    expect(r.source).not.toContain('morerows');
    expect(r.source).toContain('a b');
    // merged a+b (1) + c + d = 3 entries.
    expect(findElements(indexDocument(r.source).doc, 'entry').length).toBe(3);
    expect(gridValid(r.source)).toBe(true);
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });

  test('merges a 2x1 vertical pair → morerows span, other column intact', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const r = executeCellRectMerge(TWO_BY_TWO, [idOf(idx, 'entry', 'a'), idOf(idx, 'entry', 'c')]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toContain('morerows="1"');
    expect(r.source).toContain('a c');
    // merged a+c (1) + b + d = 3 entries.
    expect(findElements(indexDocument(r.source).doc, 'entry').length).toBe(3);
    expect(gridValid(r.source)).toBe(true);
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });

  test('forwards not-rectangular for an L-shape', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const ids = ['a', 'b', 'c'].map((t) => idOf(idx, 'entry', t));
    const r = executeCellRectMerge(TWO_BY_TWO, ids);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('not-rectangular');
    expect(r.source).toBe(TWO_BY_TWO);
  });

  test('refuses unsupported-prespanned when an interior cell is already merged', () => {
    const PRESPANNED =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry namest="c1" nameend="c2">top</entry></row>' +
      '<row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';
    const idx = indexDocument(PRESPANNED);
    const ids = [idOf(idx, 'entry', 'top'), idOf(idx, 'entry', 'c'), idOf(idx, 'entry', 'd')];
    const r = executeCellRectMerge(PRESPANNED, ids);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('unsupported-prespanned');
    expect(r.source).toBe(PRESPANNED);
  });
});

describe('purity', () => {
  test('executing never mutates the caller-visible source', () => {
    const idx = indexDocument(TWO_BY_TWO);
    executeCellRectMerge(TWO_BY_TWO, [idOf(idx, 'entry', 'a'), idOf(idx, 'entry', 'b')]);
    expect(serialize(indexDocument(TWO_BY_TWO).doc)).toBe(TWO_BY_TWO);
  });
});
