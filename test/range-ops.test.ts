// Slice C — pure range-ops planning layer. Tests parse REAL DITA with the
// production parser and address elements by their real e{N} ids (via Slice B's
// indexDocument). No mock UI data; no document is mutated (byte-safe by design).

import { test, expect, describe } from 'bun:test';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import {
  planRangeDelete,
  planCellRectMerge,
  planCellClear,
  availableRangeActions,
} from '../src/commands/range-ops';

/** Real e{N} id of the first element matching name (+ optional trimmed text). */
function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

const THREE_P = '<body><p>p1</p><p>p2</p><p>p3</p></body>';
const TWO_LISTS = '<body><ul><li>a1</li><li>a2</li></ul><ul><li>b1</li><li>b2</li></ul></body>';

describe('block range delete', () => {
  test('contiguous same-parent paragraphs → deterministic deletePara intent in document order', () => {
    const idx = indexDocument(THREE_P);
    const p1 = idOf(idx, 'p', 'p1');
    const p2 = idOf(idx, 'p', 'p2');
    const r = planRangeDelete([p2, p1], idx); // pass out of order; intent must be ordered
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe('rangeDelete');
    expect(r.op).toBe('deletePara');
    expect(r.kind).toBe('p');
    expect(r.ids).toEqual([p1, p2]);
    expect(r.parentId).toBe(idOf(idx, 'body'));
  });

  test('non-contiguous block selection is rejected with a reason', () => {
    const idx = indexDocument(THREE_P);
    const r = planRangeDelete([idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p3')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('non-contiguous');
    expect(r.reason).toMatch(/contiguous/i);
  });

  test('same-kind paragraphs separated by another block are rejected as non-contiguous', () => {
    const idx = indexDocument('<body><p>p1</p><ul><li>a</li></ul><p>p2</p></body>');
    const r = planRangeDelete([idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p2')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('non-contiguous');
  });

  test('deleting every child of the container is rejected', () => {
    const idx = indexDocument(THREE_P);
    const all = ['p1', 'p2', 'p3'].map((t) => idOf(idx, 'p', t));
    const r = planRangeDelete(all, idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('deletes-whole-container');
  });

  test('cross-parent block selection is rejected', () => {
    const idx = indexDocument(TWO_LISTS);
    const r = planRangeDelete([idOf(idx, 'li', 'a1'), idOf(idx, 'li', 'b1')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('cross-parent');
  });

  test('a contiguous SUBSET of list items → deleteItem intent', () => {
    const idx = indexDocument('<body><ul><li>a1</li><li>a2</li><li>a3</li></ul></body>');
    const r = planRangeDelete([idOf(idx, 'li', 'a1'), idOf(idx, 'li', 'a2')], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe('deleteItem');
    expect(r.kind).toBe('li');
    expect(r.ids).toEqual([idOf(idx, 'li', 'a1'), idOf(idx, 'li', 'a2')]);
  });

  test('ALL list items of a list among sibling blocks → promotes to deleting the whole list', () => {
    // a1+a2 is the entire first <ul>; an empty <ul> is invalid DITA, so "delete every
    // <li>" PROMOTES to deleting the list itself (body still has the second <ul>).
    const idx = indexDocument(TWO_LISTS);
    const r = planRangeDelete([idOf(idx, 'li', 'a1'), idOf(idx, 'li', 'a2')], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe('deleteList');
    expect(r.kind).toBe('ul');
    expect(r.ids).toEqual([idOf(idx, 'ul')]); // the first <ul>
    expect(r.parentId).toBe(idOf(idx, 'body'));
  });

  test('ALL list items of a list that is the ONLY block → refused (cannot empty the body)', () => {
    const idx = indexDocument('<body><ul><li>x</li><li>y</li></ul></body>');
    const r = planRangeDelete([idOf(idx, 'li', 'x'), idOf(idx, 'li', 'y')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('deletes-whole-container');
  });

  test('empty selection is rejected', () => {
    const r = planRangeDelete([], indexDocument(THREE_P));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('empty');
  });
});

describe('whole-block range delete (table / list / figure)', () => {
  const tableXml =
    '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>e</entry></row></tbody></tgroup></table>';
  const P_AND_TABLE = `<body><p>p1</p>${tableXml}</body>`;
  const ONLY_TABLE = `<body>${tableXml}</body>`;
  const P_AND_LIST = '<body><p>p1</p><ul><li>a</li></ul></body>';

  test('a whole <table> among sibling blocks → deleteTable intent', () => {
    const idx = indexDocument(P_AND_TABLE);
    const r = planRangeDelete([idOf(idx, 'table')], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe('deleteTable');
    expect(r.kind).toBe('table');
    expect(r.parentId).toBe(idOf(idx, 'body'));
  });

  test('a whole <ul> among sibling blocks → deleteList intent', () => {
    const idx = indexDocument(P_AND_LIST);
    const r = planRangeDelete([idOf(idx, 'ul')], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe('deleteList');
    expect(r.kind).toBe('ul');
  });

  test('deleting the only block of a (block)+ container is rejected', () => {
    const idx = indexDocument(ONLY_TABLE);
    const r = planRangeDelete([idOf(idx, 'table')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('deletes-whole-container');
    expect(r.reason).toMatch(/only block/i);
  });

  test('availableRangeActions offers rangeDelete for a deletable whole table', () => {
    const idx = indexDocument(P_AND_TABLE);
    expect(availableRangeActions([idOf(idx, 'table')], idx)).toEqual(['rangeDelete']);
  });
});

describe('availableRangeActions', () => {
  test('a valid contiguous block range offers only rangeDelete', () => {
    const idx = indexDocument(THREE_P);
    const ids = [idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p2')];
    expect(availableRangeActions(ids, idx)).toEqual(['rangeDelete']);
  });

  test('a non-contiguous selection offers nothing', () => {
    const idx = indexDocument(THREE_P);
    const ids = [idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p3')];
    expect(availableRangeActions(ids, idx)).toEqual([]);
  });

  test('a clean cell rectangle offers clear and merge actions', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const ids = ['a', 'b', 'c', 'd'].map((t) => idOf(idx, 'entry', t));
    expect(availableRangeActions(ids, idx)).toEqual(['cellClear', 'cellRectMerge']);
  });

  test('a single table cell offers cellClear', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const ids = [idOf(idx, 'entry', 'a')];
    expect(availableRangeActions(ids, idx)).toEqual(['cellClear']);
  });
});

const TWO_BY_TWO =
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry>a</entry><entry>b</entry></row>' +
  '<row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';

describe('cell rectangle merge', () => {
  test('a full 2x2 selection → deterministic merge intent (anchor=top-left, doc-order cells)', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => idOf(idx, 'entry', t));
    const r = planCellRectMerge([d, b, a, c], idx); // unordered input
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchorCellId).toBe(a);
    expect(r.cellIds).toEqual([a, b, c, d]); // document order
    expect(r.rect).toEqual({ r0: 0, r1: 1, c0: 1, c1: 2 });
    expect(r.span).toEqual({ cols: 2, rows: 2 });
    expect(r.section).toBe('tbody');
    expect(r.tableId).toBe(idOf(idx, 'tgroup'));
  });

  test('a single-row pair → a 1x2 rectangle', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const r = planCellRectMerge([idOf(idx, 'entry', 'a'), idOf(idx, 'entry', 'b')], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.span).toEqual({ cols: 2, rows: 1 });
  });

  test('an L-shape (3 of 4) is rejected as not rectangular', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const ids = ['a', 'b', 'c'].map((t) => idOf(idx, 'entry', t));
    const r = planCellRectMerge(ids, idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not-rectangular');
  });

  test('a single cell is rejected (merge needs two)', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const r = planCellRectMerge([idOf(idx, 'entry', 'a')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('too-few-cells');
  });

  test('cells from two different tables are rejected', () => {
    const idx = indexDocument(
      '<body>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>t1</entry></row></tbody></tgroup></table>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>t2</entry></row></tbody></tgroup></table>' +
        '</body>',
    );
    const r = planCellRectMerge([idOf(idx, 'entry', 't1'), idOf(idx, 'entry', 't2')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('cross-table');
  });

  test('cells spanning thead and tbody are rejected', () => {
    const idx = indexDocument(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<thead><row><entry>h1</entry><entry>h2</entry></row></thead>' +
        '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
    );
    const r = planCellRectMerge([idOf(idx, 'entry', 'h1'), idOf(idx, 'entry', 'a')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('cross-section');
  });

  test('cells do not support rangeDelete', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const r = planRangeDelete([idOf(idx, 'entry', 'a'), idOf(idx, 'entry', 'b')], idx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not-deletable-kind');
  });

  test('selected cells can be cleared in document order without requiring a rectangle', () => {
    const idx = indexDocument(TWO_BY_TWO);
    const [a, , c, d] = ['a', 'b', 'c', 'd'].map((t) => idOf(idx, 'entry', t));
    const r = planCellClear([d, a, c], idx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cellIds).toEqual([a, c, d]);
  });
});

describe('mixed-kind selections', () => {
  test('a paragraph + a cell is rejected by both planners', () => {
    const idx = indexDocument(
      '<body><p>p1</p>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>a</entry></row></tbody></tgroup></table>' +
        '</body>',
    );
    const ids = [idOf(idx, 'p', 'p1'), idOf(idx, 'entry', 'a')];
    expect(planRangeDelete(ids, idx)).toMatchObject({ ok: false, code: 'mixed-kind' });
    expect(planCellRectMerge(ids, idx)).toMatchObject({ ok: false, code: 'mixed-kind' });
    expect(planCellClear(ids, idx)).toMatchObject({ ok: false, code: 'mixed-kind' });
    expect(availableRangeActions(ids, idx)).toEqual([]);
  });
});
