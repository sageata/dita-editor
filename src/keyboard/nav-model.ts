// Slice A — pure keyboard navigation resolver for the WYSIWYG DITA canvas.
//
// Given a parsed CST Document, the id of the currently-focused element (in the
// assignElementIds scheme the canvas already stamps via element-ids.ts), and an
// arrow / Home / End key, this returns either the id of the element to focus
// next, or an explicit no-target reason the UI can announce (aria-live) later.
//
// PURE: it only READS the CST layer (parse output + the already-exported
// query/grid helpers). It never mutates a document, never serializes, and never
// touches the DOM or the VS Code API — so it cannot affect byte-exact
// round-tripping and is fully unit-testable headless.
//
// Two navigation axes, dispatched by the focused element's tag:
//   • Flow blocks (title / p / li / entry) — Up/Down walk DOCUMENT ORDER. Entries
//     are included so a table is reachable from surrounding flow: Down from the
//     <p> before a table lands on its first cell.
//   • Table cells (entry)                  — Up/Down walk the CALS GRID vertically
//     (merge/rowspan-aware, crossing the thead↔tbody boundary); Left/Right walk
//     the row horizontally (colspan-aware). Home/End hit the row's first/last cell.
//   Non-cell blocks have no horizontal axis (Left/Right report not-a-cell); their
//   Home/End hit the document's first/last block.
//
// Merged cells are respected via the existing grid helpers (computeGrid / cellAt /
// gridCellFor / isGridValid) — the same geometry src/commands/validity.ts uses,
// so navigation and command-validity agree on what a cell's neighbours are.
//
// Boundary policy (see the INTEGRATION CONTRACT at the bottom): a cell at the
// top/bottom row of its table escapes Up/Down into surrounding flow — Up lands on
// the navigable block immediately before the table, Down on the one immediately
// after. Only a table with no preceding / following block (a true document edge)
// reports table-top / table-bottom.

import { assignElementIds } from '../cst/element-ids';
import { childElements, walk } from '../cst/query';
import {
  cellAt,
  computeGrid,
  gridCellFor,
  isGridValid,
  type GridCell,
  type TableGrid,
} from '../cst/table-grid';
import type { Document, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
export const NAV_KEYS: readonly NavKey[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

/** Tags that participate in keyboard navigation: the editable text blocks plus
 *  table cells (so a table is reachable from / re-enterable on the document-order
 *  axis). Mirrors the FocusKind set in src/commands/validity.ts (p/li/entry) plus
 *  <title>, which is an editable text block but carries no structural op. */
export const NAV_BLOCK_NAMES: ReadonlySet<string> = new Set(['title', 'p', 'li', 'entry']);

export type NavReason =
  | 'no-focus' // focusId was null
  | 'unknown-focus' // focusId resolves to no element in the document
  | 'not-navigable' // focusId is a real element but not a navigable block
  | 'document-start' // Up/Home: already at the first block
  | 'document-end' // Down/End: already at the last block
  | 'not-a-cell' // Left/Right pressed outside a table cell
  | 'row-start' // Left/Home: already at the first cell in the row
  | 'row-end' // Right/End: already at the last cell in the row
  | 'table-top' // Up: already at the top row of the table
  | 'table-bottom' // Down: already at the bottom row of the table
  | 'malformed-grid'; // the cell's table geometry cannot be trusted

export interface NavMove {
  ok: true;
  /** Stable element id (assignElementIds scheme) the host should focus next. */
  targetId: string;
  /** Which axis produced the move — lets the host log/announce context. */
  via: 'document' | 'grid';
}

export interface NavBlocked {
  ok: false;
  reason: NavReason;
  /** Human-readable text for a later aria-live announcement. */
  message: string;
}

export type NavResult = NavMove | NavBlocked;
export type NavigationMap = Record<string, Record<NavKey, NavResult>>;

const MESSAGES: Record<NavReason, string> = {
  'no-focus': 'Nothing is focused',
  'unknown-focus': 'The focused element was not found',
  'not-navigable': 'This element is not keyboard-navigable',
  'document-start': 'Already at the first block',
  'document-end': 'Already at the last block',
  'not-a-cell': 'Left and right move between table cells only',
  'row-start': 'Already at the first cell in the row',
  'row-end': 'Already at the last cell in the row',
  'table-top': 'Already at the top row of the table',
  'table-bottom': 'Already at the bottom row of the table',
  'malformed-grid': 'The table layout is malformed',
};

function blocked(reason: NavReason): NavBlocked {
  return { ok: false, reason, message: MESSAGES[reason] };
}
function moved(targetId: string, via: 'document' | 'grid'): NavMove {
  return { ok: true, targetId, via };
}

interface NavBlockEntry {
  id: string;
  name: string;
  el: ElementNode;
}

function buildBlocks(doc: Document): {
  blocks: NavBlockEntry[];
  idByEl: Map<ElementNode, string>;
} {
  const idByEl = assignElementIds(doc);
  const blocks: NavBlockEntry[] = [];
  for (const node of walk(doc.children)) {
    if (isElement(node) && NAV_BLOCK_NAMES.has(node.name)) {
      blocks.push({ id: idByEl.get(node)!, name: node.name, el: node });
    }
  }
  return { blocks, idByEl };
}

/** The document-order sequence of navigable blocks (id + tag). The host can use
 *  this for canvas tab-order; tests use it to assert ordering. */
export function navBlocksInOrder(doc: Document): { id: string; name: string }[] {
  return buildBlocks(doc).blocks.map((b) => ({ id: b.id, name: b.name }));
}

function ancestorNamed(el: ElementNode, name: string): ElementNode | null {
  let n: ElementNode | null | undefined = el.parent;
  while (n && n.name !== name) n = n.parent;
  return n ?? null;
}

/** Grid cell directly above `cell`, crossing tbody→thead at the section top. */
function cellAbove(grid: TableGrid, cell: GridCell): GridCell | undefined {
  if (cell.row > 0) return cellAt(grid, cell.section, cell.row - 1, cell.colStart);
  if (cell.section === 'tbody') {
    const headRows = grid.rowsBySection.thead.length;
    if (headRows > 0) return cellAt(grid, 'thead', headRows - 1, cell.colStart);
  }
  return undefined;
}

/** Grid cell directly below `cell`, crossing thead→tbody at the section bottom.
 *  Uses row + rowSpan so a vertically-merged cell steps past its whole span. */
function cellBelow(grid: TableGrid, cell: GridCell): GridCell | undefined {
  const within = cellAt(grid, cell.section, cell.row + cell.rowSpan, cell.colStart);
  if (within) return within;
  if (cell.section === 'thead' && cell.row + cell.rowSpan >= grid.rowsBySection.thead.length) {
    if (grid.rowsBySection.tbody.length > 0) return cellAt(grid, 'tbody', 0, cell.colStart);
  }
  return undefined;
}

/** True iff `el` is `ancestor` or nested anywhere inside it. */
function isWithin(el: ElementNode, ancestor: ElementNode): boolean {
  let n: ElementNode | null | undefined = el;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

/** The [first, last] index span, in the document-order `blocks` list, of the
 *  navigable blocks that live inside `container` (the table's tgroup). null when
 *  the container holds no navigable block. Lets a cell at the table edge find the
 *  flow block immediately before / after the whole table for Up/Down escape. */
function blockRangeWithin(
  container: ElementNode,
  blocks: NavBlockEntry[],
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (isWithin(blocks[i].el, container)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : { first, last };
}

interface CachedTableNav {
  grid: TableGrid;
  valid: boolean;
  range: { first: number; last: number } | null;
}

type TableNavCache = Map<ElementNode, CachedTableNav>;

function cachedTableNav(tgroup: ElementNode, blocks: NavBlockEntry[], cache?: TableNavCache): CachedTableNav {
  const hit = cache?.get(tgroup);
  if (hit) return hit;
  const grid = computeGrid(tgroup);
  const cached = {
    grid,
    valid: isGridValid(grid),
    range: blockRangeWithin(tgroup, blocks),
  };
  cache?.set(tgroup, cached);
  return cached;
}

function resolveCell(
  entry: ElementNode,
  key: NavKey,
  idByEl: Map<ElementNode, string>,
  blocks: NavBlockEntry[],
  tableCache?: TableNavCache,
): NavResult {
  const tgroup = ancestorNamed(entry, 'tgroup');
  if (!tgroup) return blocked('malformed-grid'); // an <entry> with no <tgroup> is malformed
  const table = cachedTableNav(tgroup, blocks, tableCache);
  const grid = table.grid;
  if (!table.valid) return resolveMalformedCell(entry, key, blocks);
  const cell = gridCellFor(grid, entry);
  if (!cell) return blocked('malformed-grid');

  switch (key) {
    case 'ArrowLeft': {
      const left = cellAt(grid, cell.section, cell.row, cell.colStart - 1);
      return left ? moved(idByEl.get(left.entry)!, 'grid') : blocked('row-start');
    }
    case 'ArrowRight': {
      const right = cellAt(grid, cell.section, cell.row, cell.colEnd + 1);
      return right ? moved(idByEl.get(right.entry)!, 'grid') : blocked('row-end');
    }
    case 'ArrowUp': {
      const up = cellAbove(grid, cell);
      if (up) return moved(idByEl.get(up.entry)!, 'grid');
      // Top row: escape Up to the flow block immediately before the table.
      const range = table.range;
      if (range && range.first > 0) return moved(blocks[range.first - 1].id, 'document');
      return blocked('table-top'); // no preceding block: true document edge
    }
    case 'ArrowDown': {
      const down = cellBelow(grid, cell);
      if (down) return moved(idByEl.get(down.entry)!, 'grid');
      // Bottom row: escape Down to the flow block immediately after the table.
      const range = table.range;
      if (range && range.last < blocks.length - 1) return moved(blocks[range.last + 1].id, 'document');
      return blocked('table-bottom'); // no following block: true document edge
    }
    case 'Home': {
      const first = cellAt(grid, cell.section, cell.row, 1);
      return first && first.entry !== cell.entry
        ? moved(idByEl.get(first.entry)!, 'grid')
        : blocked('row-start');
    }
    case 'End': {
      const last = cellAt(grid, cell.section, cell.row, grid.cols);
      return last && last.entry !== cell.entry
        ? moved(idByEl.get(last.entry)!, 'grid')
        : blocked('row-end');
    }
  }
}

function siblingEntry(entry: ElementNode, dir: -1 | 1): ElementNode | undefined {
  const parent = entry.parent;
  if (!parent) return undefined;
  const entries = childElements(parent).filter((el) => el.name === 'entry');
  const index = entries.indexOf(entry);
  if (index < 0) return undefined;
  return entries[index + dir];
}

function rowEndpoint(entry: ElementNode, dir: -1 | 1): ElementNode | undefined {
  const parent = entry.parent;
  if (!parent) return undefined;
  const entries = childElements(parent).filter((el) => el.name === 'entry');
  return dir < 0 ? entries[0] : entries[entries.length - 1];
}

function resolveMalformedCell(entry: ElementNode, key: NavKey, blocks: NavBlockEntry[]): NavResult {
  const index = blocks.findIndex((b) => b.el === entry);
  if (index < 0) return blocked('malformed-grid');
  switch (key) {
    case 'ArrowLeft': {
      const left = siblingEntry(entry, -1);
      return left ? moved(blocks.find((b) => b.el === left)!.id, 'document') : blocked('row-start');
    }
    case 'ArrowRight': {
      const right = siblingEntry(entry, 1);
      return right ? moved(blocks.find((b) => b.el === right)!.id, 'document') : blocked('row-end');
    }
    case 'Home': {
      const first = rowEndpoint(entry, -1);
      return first && first !== entry ? moved(blocks.find((b) => b.el === first)!.id, 'document') : blocked('row-start');
    }
    case 'End': {
      const last = rowEndpoint(entry, 1);
      return last && last !== entry ? moved(blocks.find((b) => b.el === last)!.id, 'document') : blocked('row-end');
    }
    case 'ArrowUp': {
      const prev = blocks[index - 1];
      return prev ? moved(prev.id, 'document') : blocked('table-top');
    }
    case 'ArrowDown': {
      const next = blocks[index + 1];
      return next ? moved(next.id, 'document') : blocked('table-bottom');
    }
  }
}

function resolveBlock(index: number, blocks: NavBlockEntry[], key: NavKey): NavResult {
  switch (key) {
    case 'ArrowUp': {
      const prev = blocks[index - 1];
      return prev ? moved(prev.id, 'document') : blocked('document-start');
    }
    case 'ArrowDown': {
      const next = blocks[index + 1];
      return next ? moved(next.id, 'document') : blocked('document-end');
    }
    case 'Home': {
      const first = blocks[0];
      return first.id !== blocks[index].id ? moved(first.id, 'document') : blocked('document-start');
    }
    case 'End': {
      const last = blocks[blocks.length - 1];
      return last.id !== blocks[index].id ? moved(last.id, 'document') : blocked('document-end');
    }
    case 'ArrowLeft':
    case 'ArrowRight':
      return blocked('not-a-cell');
  }
}

function idExists(idByEl: Map<ElementNode, string>, focusId: string): boolean {
  for (const id of idByEl.values()) if (id === focusId) return true;
  return false;
}

function resolveNavigationFromBlocks(
  blocks: NavBlockEntry[],
  idByEl: Map<ElementNode, string>,
  focusId: string | null,
  key: NavKey,
  tableCache?: TableNavCache,
): NavResult {
  if (focusId == null) return blocked('no-focus');
  const index = blocks.findIndex((b) => b.id === focusId);
  if (index < 0) {
    return blocked(idExists(idByEl, focusId) ? 'not-navigable' : 'unknown-focus');
  }
  const block = blocks[index];
  if (block.name === 'entry') return resolveCell(block.el, key, idByEl, blocks, tableCache);
  return resolveBlock(index, blocks, key);
}

/**
 * Resolve one keyboard navigation step.
 *
 * @param doc      Parsed CST document (read-only; never mutated).
 * @param focusId  Stable id of the focused element, or null when nothing is focused.
 * @param key      The navigation key pressed.
 * @returns        A move (targetId to focus) or an explicit blocked reason.
 */
export function resolveNavigation(doc: Document, focusId: string | null, key: NavKey): NavResult {
  const { blocks, idByEl } = buildBlocks(doc);
  return resolveNavigationFromBlocks(blocks, idByEl, focusId, key);
}

/**
 * Build the complete navigation map for one render cycle.
 *
 * This is behavior-equivalent to calling resolveNavigation(doc, id, key) for
 * every navigable block and key, but it reuses the document-order block list,
 * element ids, and per-table grids. The webview host calls this once per render
 * before pushing navMap to the canvas.
 */
export function buildNavigationMap(doc: Document): NavigationMap {
  const { blocks, idByEl } = buildBlocks(doc);
  const tableCache: TableNavCache = new Map();
  const map: NavigationMap = {};
  for (const block of blocks) {
    const perKey = {} as Record<NavKey, NavResult>;
    for (const key of NAV_KEYS) {
      perKey[key] = resolveNavigationFromBlocks(blocks, idByEl, block.id, key, tableCache);
    }
    map[block.id] = perKey;
  }
  return map;
}

// ---------------------------------------------------------------------------
// INTEGRATION CONTRACT for media/canvas.js (owned by the main lane — NOT wired here)
// ---------------------------------------------------------------------------
// 1. FOCUS IDS. The canvas must focus elements by the assignElementIds id scheme
//    (the same `e{N}` ids structuralIds()/tableCellIds() already stamp as
//    data-* attributes). Pass that id as `focusId`; on an ok result, move focus
//    to the element bearing `targetId`. assignElementIds is recomputed here per
//    call, so ids stay consistent only WITHIN a render cycle — call after the
//    same re-render the canvas used to stamp them.
// 2. FOCUS GRANULARITY (open question). If a cell contains its own <p>/<li>, both
//    the <entry> and the inner block are navigable. Focus the <entry> (data-cell-id)
//    to get grid cell navigation; focus an inner block to get document-flow
//    navigation. Codex to decide which granularity the canvas focuses for cells.
// 3. TABLE ESCAPE. Up from the top row / Down from the bottom row leaves the table
//    and focuses the document-order navigable block just before / after the table
//    (via 'document'). table-top / table-bottom now fire only at a true document
//    edge (no such neighbour). This is reversible: Down into the table's first cell
//    and Up into its last cell already fall out of the document-order block axis.
// 4. THEAD↔TBODY is crossed automatically on Up/Down; Left/Right never cross
//    rows. Malformed CALS grids (isGridValid === false) report malformed-grid —
//    the canvas should surface that rather than move focus blindly.
// 5. KEY MAPPING. The host maps DOM KeyboardEvent.key to NavKey and is responsible
//    for preventDefault only when the result is ok (so unhandled keys still type).
