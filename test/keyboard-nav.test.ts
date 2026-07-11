import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import { renderEditable } from '../src/render/to-html';
import { walk } from '../src/cst/query';
import { isElement, type Document } from '../src/cst/types';
import {
  NAV_BLOCK_NAMES,
  NAV_KEYS,
  buildNavigationMap,
  navBlocksInOrder,
  resolveNavigation,
  type NavReason,
  type NavResult,
} from '../src/keyboard/nav-model';

// --- helpers: address real parsed elements by their text or tag -------------

function doc(src: string): Document {
  return parse(src);
}

/** Id of the element whose first text-node child equals `text` (cells, paras,
 *  list items, titles all carry their label as a direct text child). */
function idOfText(d: Document, text: string): string {
  const ids = assignElementIds(d);
  for (const n of walk(d.children)) {
    if (!isElement(n)) continue;
    const t = n.children.find((c) => c.type === 'text');
    if (t && t.type === 'text' && t.raw === text) return ids.get(n)!;
  }
  throw new Error(`no element with text "${text}"`);
}

/** Id of the `occ`-th (0-based) element named `name` in document order. */
function idOfName(d: Document, name: string, occ = 0): string {
  const ids = assignElementIds(d);
  let i = 0;
  for (const n of walk(d.children)) {
    if (isElement(n) && n.name === name) {
      if (i === occ) return ids.get(n)!;
      i++;
    }
  }
  throw new Error(`no <${name}> #${occ}`);
}

function expectMove(r: NavResult, targetId: string, via: 'document' | 'grid'): void {
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.targetId).toBe(targetId);
    expect(r.via).toBe(via);
  }
}

function expectBlocked(r: NavResult, reason: NavReason): void {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe(reason);
    expect(r.message.length).toBeGreaterThan(0);
  }
}

// Flow fixture: title + two paragraphs + a two-item list.
const FLOW =
  '<topic><title>T</title><body>' +
  '<p>one</p><p>two</p>' +
  '<ul><li>a</li><li>b</li></ul>' +
  '</body></topic>';

// 2x2 body table with a header row.
const TABLE =
  '<table><tgroup cols="2">' +
  '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<thead><row><entry>h1</entry><entry>h2</entry></row></thead>' +
  '<tbody>' +
  '<row><entry>a</entry><entry>b</entry></row>' +
  '<row><entry>c</entry><entry>d</entry></row>' +
  '</tbody></tgroup></table>';

// Horizontal merge: row0 has a cell spanning c1..c2, then a c3 cell.
const HMERGE =
  '<table><tgroup cols="3">' +
  '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/><colspec colname="c3" colnum="3"/>' +
  '<tbody>' +
  '<row><entry namest="c1" nameend="c2">wide</entry><entry>c</entry></row>' +
  '<row><entry>x</entry><entry>y</entry><entry>z</entry></row>' +
  '</tbody></tgroup></table>';

// Vertical merge: a cell with morerows="1" spanning rows 0..1 in column 1.
const VMERGE =
  '<table><tgroup cols="2">' +
  '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody>' +
  '<row><entry morerows="1">tall</entry><entry>p</entry></row>' +
  '<row><entry>q</entry></row>' +
  '<row><entry>r</entry><entry>s</entry></row>' +
  '</tbody></tgroup></table>';

// Table with surrounding flow: a <p> before and after the 2x2+header table, so a
// cell at the top/bottom row can escape Up/Down into the paragraphs.
const ESCAPE =
  '<topic><title>T</title><body>' +
  '<p>before</p>' +
  TABLE +
  '<p>after</p>' +
  '</body></topic>';

// Table at document start, then a trailing paragraph: top-row Up has no preceding
// block (true edge), but bottom-row Down can escape to the paragraph.
const TABLE_THEN_P = '<topic><body>' + TABLE + '<p>tail</p></body></topic>';

// A paragraph then a table at document end: top-row Up escapes to the paragraph,
// but bottom-row Down has no following block (true edge).
const P_THEN_TABLE = '<topic><body><p>head</p>' + TABLE + '</body></topic>';

describe('navigation map builder', () => {
  for (const [label, src] of [
    ['flow', FLOW],
    ['table', TABLE],
    ['hmerge', HMERGE],
    ['vmerge', VMERGE],
    ['escape', ESCAPE],
  ] as const) {
    test(`${label}: batched map matches single-step resolver for every id/key`, () => {
      const d = doc(src);
      const blocks = navBlocksInOrder(d);
      const map = buildNavigationMap(d);

      expect(Object.keys(map).sort()).toEqual(blocks.map((b) => b.id).sort());
      for (const block of blocks) {
        for (const key of NAV_KEYS) {
          expect(map[block.id][key]).toEqual(resolveNavigation(d, block.id, key));
        }
      }
    });
  }
});

describe('document-order block navigation', () => {
  test('navBlocksInOrder lists title, paras, items in document order', () => {
    const d = doc(FLOW);
    expect(navBlocksInOrder(d).map((b) => b.name)).toEqual(['title', 'p', 'p', 'li', 'li']);
  });

  test('Down/Up moves between adjacent paragraphs', () => {
    const d = doc(FLOW);
    expectMove(resolveNavigation(d, idOfText(d, 'one'), 'ArrowDown'), idOfText(d, 'two'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'two'), 'ArrowUp'), idOfText(d, 'one'), 'document');
  });

  test('Up from first paragraph reaches the title', () => {
    const d = doc(FLOW);
    expectMove(resolveNavigation(d, idOfText(d, 'one'), 'ArrowUp'), idOfText(d, 'T'), 'document');
  });

  test('Down flows from paragraph into list items', () => {
    const d = doc(FLOW);
    expectMove(resolveNavigation(d, idOfText(d, 'two'), 'ArrowDown'), idOfText(d, 'a'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowDown'), idOfText(d, 'b'), 'document');
  });

  test('boundaries: Up at first block and Down at last block are blocked', () => {
    const d = doc(FLOW);
    expectBlocked(resolveNavigation(d, idOfText(d, 'T'), 'ArrowUp'), 'document-start');
    expectBlocked(resolveNavigation(d, idOfText(d, 'b'), 'ArrowDown'), 'document-end');
  });

  test('Home/End jump to document boundaries, blocked when already there', () => {
    const d = doc(FLOW);
    expectMove(resolveNavigation(d, idOfText(d, 'two'), 'Home'), idOfText(d, 'T'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'one'), 'End'), idOfText(d, 'b'), 'document');
    expectBlocked(resolveNavigation(d, idOfText(d, 'T'), 'Home'), 'document-start');
    expectBlocked(resolveNavigation(d, idOfText(d, 'b'), 'End'), 'document-end');
  });

  test('Left/Right on a non-cell block report not-a-cell', () => {
    const d = doc(FLOW);
    expectBlocked(resolveNavigation(d, idOfText(d, 'one'), 'ArrowLeft'), 'not-a-cell');
    expectBlocked(resolveNavigation(d, idOfText(d, 'a'), 'ArrowRight'), 'not-a-cell');
  });
});

describe('table cell navigation (no spans)', () => {
  test('Left/Right move horizontally within a row', () => {
    const d = doc(TABLE);
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowRight'), idOfText(d, 'b'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'b'), 'ArrowLeft'), idOfText(d, 'a'), 'grid');
  });

  test('Left/Right at the row edges are blocked', () => {
    const d = doc(TABLE);
    expectBlocked(resolveNavigation(d, idOfText(d, 'a'), 'ArrowLeft'), 'row-start');
    expectBlocked(resolveNavigation(d, idOfText(d, 'b'), 'ArrowRight'), 'row-end');
  });

  test('Up/Down move vertically within the tbody', () => {
    const d = doc(TABLE);
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowDown'), idOfText(d, 'c'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'c'), 'ArrowUp'), idOfText(d, 'a'), 'grid');
  });

  test('Up crosses tbody→thead and Down crosses thead→tbody', () => {
    const d = doc(TABLE);
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowUp'), idOfText(d, 'h1'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'h1'), 'ArrowDown'), idOfText(d, 'a'), 'grid');
  });

  test('vertical boundaries: top header row Up and bottom body row Down are blocked', () => {
    const d = doc(TABLE);
    expectBlocked(resolveNavigation(d, idOfText(d, 'h1'), 'ArrowUp'), 'table-top');
    expectBlocked(resolveNavigation(d, idOfText(d, 'c'), 'ArrowDown'), 'table-bottom');
  });

  test('Home/End move to the row edges, blocked when already there', () => {
    const d = doc(TABLE);
    expectMove(resolveNavigation(d, idOfText(d, 'b'), 'Home'), idOfText(d, 'a'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'End'), idOfText(d, 'b'), 'grid');
    expectBlocked(resolveNavigation(d, idOfText(d, 'a'), 'Home'), 'row-start');
    expectBlocked(resolveNavigation(d, idOfText(d, 'b'), 'End'), 'row-end');
  });
});

describe('table escape — Up/Down leave the table into surrounding flow', () => {
  test('Up at the top row escapes to the block before the table', () => {
    const d = doc(ESCAPE);
    expectMove(resolveNavigation(d, idOfText(d, 'h1'), 'ArrowUp'), idOfText(d, 'before'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'h2'), 'ArrowUp'), idOfText(d, 'before'), 'document');
  });

  test('Down at the bottom row escapes to the block after the table', () => {
    const d = doc(ESCAPE);
    expectMove(resolveNavigation(d, idOfText(d, 'c'), 'ArrowDown'), idOfText(d, 'after'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'd'), 'ArrowDown'), idOfText(d, 'after'), 'document');
  });

  test('escape is reversible: Down/Up from the flow blocks re-enter the table', () => {
    const d = doc(ESCAPE);
    // Down from the preceding paragraph lands on the table's first cell.
    expectMove(resolveNavigation(d, idOfText(d, 'before'), 'ArrowDown'), idOfText(d, 'h1'), 'document');
    // Up from the following paragraph lands on the table's last cell.
    expectMove(resolveNavigation(d, idOfText(d, 'after'), 'ArrowUp'), idOfText(d, 'd'), 'document');
  });

  test('interior rows still navigate the grid, not escape', () => {
    const d = doc(ESCAPE);
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowUp'), idOfText(d, 'h1'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowDown'), idOfText(d, 'c'), 'grid');
  });

  test('table at document start: top-row Up is blocked, bottom-row Down escapes', () => {
    const d = doc(TABLE_THEN_P);
    expectBlocked(resolveNavigation(d, idOfText(d, 'h1'), 'ArrowUp'), 'table-top');
    expectMove(resolveNavigation(d, idOfText(d, 'c'), 'ArrowDown'), idOfText(d, 'tail'), 'document');
  });

  test('table at document end: top-row Up escapes, bottom-row Down is blocked', () => {
    const d = doc(P_THEN_TABLE);
    expectMove(resolveNavigation(d, idOfText(d, 'h1'), 'ArrowUp'), idOfText(d, 'head'), 'document');
    expectBlocked(resolveNavigation(d, idOfText(d, 'c'), 'ArrowDown'), 'table-bottom');
  });
});

describe('merged cell navigation — horizontal span (namest/nameend)', () => {
  test('Right from the wide cell skips its span to the next column', () => {
    const d = doc(HMERGE);
    expectMove(resolveNavigation(d, idOfText(d, 'wide'), 'ArrowRight'), idOfText(d, 'c'), 'grid');
  });

  test('Left from the trailing cell lands back on the wide cell', () => {
    const d = doc(HMERGE);
    expectMove(resolveNavigation(d, idOfText(d, 'c'), 'ArrowLeft'), idOfText(d, 'wide'), 'grid');
  });

  test('Down from the wide cell anchors on its start column', () => {
    const d = doc(HMERGE);
    expectMove(resolveNavigation(d, idOfText(d, 'wide'), 'ArrowDown'), idOfText(d, 'x'), 'grid');
  });

  test('Up from two different columns both reach the same wide cell', () => {
    const d = doc(HMERGE);
    expectMove(resolveNavigation(d, idOfText(d, 'x'), 'ArrowUp'), idOfText(d, 'wide'), 'grid');
    expectMove(resolveNavigation(d, idOfText(d, 'y'), 'ArrowUp'), idOfText(d, 'wide'), 'grid');
  });
});

describe('merged cell navigation — vertical span (morerows)', () => {
  test('Down from the tall cell steps past its whole rowspan', () => {
    const d = doc(VMERGE);
    expectMove(resolveNavigation(d, idOfText(d, 'tall'), 'ArrowDown'), idOfText(d, 'r'), 'grid');
  });

  test('the tall cell is reachable from rows it spans', () => {
    const d = doc(VMERGE);
    // column-2 cell `q` sits in row 1; Left enters the tall cell that covers (1,1).
    expectMove(resolveNavigation(d, idOfText(d, 'q'), 'ArrowLeft'), idOfText(d, 'tall'), 'grid');
    // the row-2 cell `r` sits below the span; Up lands on the tall cell at (1,1).
    expectMove(resolveNavigation(d, idOfText(d, 'r'), 'ArrowUp'), idOfText(d, 'tall'), 'grid');
  });

  test('Up from the tall cell (top row) is blocked', () => {
    const d = doc(VMERGE);
    expectBlocked(resolveNavigation(d, idOfText(d, 'tall'), 'ArrowUp'), 'table-top');
  });
});

describe('error and edge cases', () => {
  test('null focus reports no-focus', () => {
    expectBlocked(resolveNavigation(doc(FLOW), null, 'ArrowDown'), 'no-focus');
  });

  test('unknown id reports unknown-focus', () => {
    expectBlocked(resolveNavigation(doc(FLOW), 'e9999', 'ArrowDown'), 'unknown-focus');
  });

  test('a real but non-navigable element (ul) reports not-navigable', () => {
    const d = doc(FLOW);
    expectBlocked(resolveNavigation(d, idOfName(d, 'ul'), 'ArrowDown'), 'not-navigable');
  });

  test('a malformed CALS grid falls back to visible cell order for navigation', () => {
    // cols="2" but row 1 has one entry → column 2 is uncovered. Editing/merge
    // operations still refuse this table elsewhere; navigation should not strand
    // the user in the visible cells.
    const d = doc(
      '<table><tgroup cols="2">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>a</entry></row><row><entry>b</entry><entry>c</entry></row></tbody></tgroup></table>',
    );
    expectMove(resolveNavigation(d, idOfText(d, 'a'), 'ArrowDown'), idOfText(d, 'b'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'b'), 'ArrowRight'), idOfText(d, 'c'), 'document');
    expectMove(resolveNavigation(d, idOfText(d, 'c'), 'ArrowUp'), idOfText(d, 'b'), 'document');
  });

  test('NAV_BLOCK_NAMES is the documented set', () => {
    expect([...NAV_BLOCK_NAMES].sort()).toEqual(['entry', 'li', 'p', 'title']);
  });
});

// The host ships navMap KEYED on navBlocksInOrder ids; the canvas looks each focus up by the
// data-cell-id / data-edit-id / data-struct-id the renderer stamped. If those two id spaces ever
// diverged, every navMap[focusId] lookup would silently MISS and keys would fall through to native
// (the End-jumps-to-doc-bottom failure mode). assignElementIds is the single source for both, so
// this asserts it stays that way across the full editable render, not just in theory.
describe('navMap key namespace == DOM data-* namespace', () => {
  function dataAttrValues(html: string, attr: string): Set<string> {
    const out = new Set<string>();
    const re = new RegExp(`${attr}="([^"]+)"`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) out.add(m[1]);
    return out;
  }

  for (const [label, src] of [
    ['flow', FLOW],
    ['table', TABLE],
    ['hmerge', HMERGE],
    ['vmerge', VMERGE],
  ] as const) {
    test(`${label}: every navBlock id is a DOM data-* id, and entries match data-cell-id`, () => {
      const d = doc(src);
      const html = renderEditable(d, null, 'v');
      const cellIds = dataAttrValues(html, 'data-cell-id');
      const editIds = dataAttrValues(html, 'data-edit-id');
      const structIds = dataAttrValues(html, 'data-struct-id');
      const domIds = new Set([...cellIds, ...editIds, ...structIds]);

      const blocks = navBlocksInOrder(d);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        // The client resolves focusId off one of these three attributes — the navMap key MUST be
        // addressable, or navMap[focusId] is undefined and the key escapes to the browser default.
        expect(domIds.has(b.id)).toBe(true);
        // A cell navigates the grid axis, so the client keys it on data-cell-id specifically.
        if (b.name === 'entry') expect(cellIds.has(b.id)).toBe(true);
      }
    });
  }
});
