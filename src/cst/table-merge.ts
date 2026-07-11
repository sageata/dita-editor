// Interactive CALS cell merge/split over the grid model. All three ops refuse a
// malformed table (isGridValid) so they never turn a PDF-extraction artifact into
// worse XML. Merges are incremental (absorb ONE aligned neighbour) so they compose
// into larger spans; split fully un-merges a cell back to 1x1 squares.

import { computeGrid, cellAt, gridCellFor, isGridValid } from './table-grid';
import {
  markDirty,
  makeElement,
  makeRawText,
  makeText,
  insertNode,
  removeAttrs,
  removeNode,
  setAttr,
} from './edit';
import { childrenNamed } from './query';
import { isElement } from './types';
import type { CstNode, Document, ElementNode } from './types';

function isContentful(c: CstNode): boolean {
  if (isElement(c)) return true;
  return c.type === 'text' && (c.newText ?? c.raw).trim() !== '';
}

/** Nodes a merge must carry across so nothing is silently dropped: contentful
 *  nodes (elements + non-whitespace text) PLUS comments / PIs / CDATA (authored
 *  data that is not "contentful"). Whitespace-only text is left behind, as before. */
function isPreserved(c: CstNode): boolean {
  return isContentful(c) || c.type === 'comment' || c.type === 'pi' || c.type === 'cdata';
}

/** Move `source`'s meaningful content (text + images + comments/PIs/CDATA) into
 *  `target`, space-separated, so a merge never silently drops the absorbed cell's
 *  content. (CALS has no place to store the cell boundary, so split can't restore
 *  it — but nothing is lost.) */
function absorbContent(target: ElementNode, source: ElementNode): void {
  const moved = source.children.filter(isPreserved);
  if (moved.length === 0) return;
  if (target.children.some(isContentful)) {
    const sep = makeText(' ');
    sep.parent = target;
    target.children.push(sep);
  }
  for (const child of moved) {
    child.parent = target;
    target.children.push(child);
  }
  markDirty(target);
}

function attrOf(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function tgroupOf(entry: ElementNode): ElementNode {
  let n: ElementNode | null | undefined = entry.parent;
  while (n && n.name !== 'tgroup') n = n.parent;
  if (!n) throw new Error('entry is not inside a tgroup');
  return n;
}

function gridFor(entry: ElementNode) {
  const grid = computeGrid(tgroupOf(entry));
  if (!isGridValid(grid)) throw new Error('cannot edit cells of a malformed table');
  const cell = gridCellFor(grid, entry);
  if (!cell) throw new Error('cell not found in grid');
  return { grid, cell };
}

function colname(grid: { colnameByNum: Map<number, string> }, num: number): string {
  const name = grid.colnameByNum.get(num);
  if (!name) throw new Error(`no colspec for column ${num}`);
  return name;
}

/** Merge the cell with its immediate right neighbour (must span the same rows). */
export function mergeRight(doc: Document, entry: ElementNode): ElementNode {
  const { grid, cell } = gridFor(entry);
  const right = cellAt(grid, cell.section, cell.row, cell.colEnd + 1);
  if (!right) throw new Error('no cell to the right to merge');
  if (right.row !== cell.row || right.rowSpan !== cell.rowSpan) {
    throw new Error('right cell is not row-aligned');
  }
  if (attrOf(entry, 'namest')) {
    setAttr(entry, 'nameend', colname(grid, right.colEnd), doc.source);
  } else {
    setAttr(entry, 'namest', colname(grid, cell.colStart), doc.source);
    setAttr(entry, 'nameend', colname(grid, right.colEnd), doc.source);
  }
  absorbContent(entry, right.entry); // keep the absorbed cell's content (don't drop it)
  removeWithLeadingWs(right.entry);
  return entry;
}

/** Merge the cell with the cell directly below (must span the same columns). */
export function mergeDown(doc: Document, entry: ElementNode): ElementNode {
  const { grid, cell } = gridFor(entry);
  const below = cellAt(grid, cell.section, cell.row + cell.rowSpan, cell.colStart);
  if (!below) throw new Error('no cell below to merge');
  if (below.colStart !== cell.colStart || below.colEnd !== cell.colEnd) {
    throw new Error('cell below is not column-aligned');
  }
  setAttr(entry, 'morerows', String(cell.rowSpan + below.rowSpan - 1), doc.source);
  absorbContent(entry, below.entry); // keep the absorbed cell's content (don't drop it)
  removeWithLeadingWs(below.entry);
  return entry;
}

/** Merge the cell with its immediate left neighbour (must span the same rows).
 *  The LEFT cell absorbs — document order is preserved (left content first) —
 *  so this is exactly mergeRight issued from the left cell. */
export function mergeLeft(doc: Document, entry: ElementNode): ElementNode {
  const { grid, cell } = gridFor(entry);
  const left = cellAt(grid, cell.section, cell.row, cell.colStart - 1);
  if (!left) throw new Error('no cell to the left to merge');
  if (left.row !== cell.row || left.rowSpan !== cell.rowSpan) {
    throw new Error('left cell is not row-aligned');
  }
  return mergeRight(doc, left.entry);
}

/** Merge the cell with the cell directly above (must span the same columns).
 *  The TOP cell absorbs (document order preserved): mergeDown from above. */
export function mergeUp(doc: Document, entry: ElementNode): ElementNode {
  const { grid, cell } = gridFor(entry);
  const above = cellAt(grid, cell.section, cell.row - 1, cell.colStart);
  if (!above) throw new Error('no cell above to merge');
  if (above.colStart !== cell.colStart || above.colEnd !== cell.colEnd) {
    throw new Error('cell above is not column-aligned');
  }
  return mergeDown(doc, above.entry);
}

/** Un-merge a spanned cell back to 1x1 squares, re-adding empty cells. */
export function splitCell(doc: Document, entry: ElementNode): ElementNode {
  const { grid, cell } = gridFor(entry);
  if (cell.rowSpan === 1 && cell.colStart === cell.colEnd) {
    throw new Error('cell is not merged');
  }
  const width = cell.colEnd - cell.colStart + 1;
  removeAttrs(entry, ['namest', 'nameend', 'morerows'], doc.source);

  const rows = grid.rowsBySection[cell.section];
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    const leftCount = grid.cells.filter(
      (c) => c.section === cell.section && c.row === r && c.colStart < cell.colStart,
    ).length;
    if (r === cell.row) {
      insertEmptyEntries(rows[r], leftCount + 1, width - 1); // after the (now 1x1) original
    } else {
      insertEmptyEntries(rows[r], leftCount, width); // a full row of the rectangle
    }
  }
  return entry;
}

/** Insert n empty <entry> at entry-position `pos` (0-based among the row's
 *  entries), mirroring sibling indentation. */
function insertEmptyEntries(rowEl: ElementNode, pos: number, n: number): void {
  if (n <= 0) return;
  const entries = childrenNamed(rowEl, 'entry');

  if (entries.length === 0) {
    const last = rowEl.children[rowEl.children.length - 1];
    const trailing = last && last.type === 'text';
    const ws = trailing ? (last as { raw: string }).raw : '\n        ';
    let idx = trailing ? rowEl.children.length - 1 : rowEl.children.length;
    for (let i = 0; i < n; i++) {
      insertNode(rowEl, idx++, makeRawText(ws));
      insertNode(rowEl, idx++, makeElement('entry', [], []));
    }
    return;
  }

  if (pos > 0) {
    let anchor: ElementNode = entries[pos - 1];
    for (let i = 0; i < n; i++) {
      const e = makeElement('entry', [], []);
      insertAfter(anchor, e);
      anchor = e;
    }
    return;
  }

  // pos === 0: before the first entry, keeping its leading whitespace in front.
  const first = entries[0];
  const firstIdx = rowEl.children.indexOf(first);
  const prev = rowEl.children[firstIdx - 1];
  const ws = prev && prev.type === 'text' ? prev.raw : '\n        ';
  let idx = firstIdx;
  for (let i = 0; i < n; i++) {
    insertNode(rowEl, idx++, makeElement('entry', [], []));
    insertNode(rowEl, idx++, makeRawText(ws));
  }
}

function insertAfter(ref: ElementNode, newEl: ElementNode): void {
  const parent = ref.parent;
  if (!parent) throw new Error('cannot insert next to a top-level node');
  const idx = parent.children.indexOf(ref);
  const prev = parent.children[idx - 1];
  const ws = prev && prev.type === 'text' ? prev.raw : '\n';
  insertNode(parent, idx + 1, makeRawText(ws));
  insertNode(parent, idx + 2, newEl);
}

function removeWithLeadingWs(el: ElementNode): void {
  const parent = el.parent;
  if (!parent) throw new Error('cannot remove a top-level node');
  const idx = parent.children.indexOf(el);
  const prev: CstNode | undefined = parent.children[idx - 1];
  removeNode(el);
  if (prev && prev.type === 'text' && prev.raw.trim() === '') removeNode(prev);
}
