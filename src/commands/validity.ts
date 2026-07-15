// Slice B — pure command-validity predicate for DITA structural operations.
//
// A single headless function the canvas/host can consult BEFORE invoking
// applyStructuralEdit: it formalizes the guards that today are scattered across
// src/cst/{structural,table-merge}.ts and ADDS the destructive guards those ops
// are currently missing (delete-last-row / delete-only-item / delete-only-para —
// see structural.ts:129-133, which delete unconditionally).
//
// Purity & ownership: this module only READS the CST layer (parse + already-
// exported query/grid helpers). It never mutates a document and never serializes,
// so it cannot affect byte-exact round-tripping. No UI/host wiring lives here.
//
// Two independent signals are returned on purpose:
//   enabled   — can the command be invoked right now and succeed? (correct focus
//               kind + every guard the real op enforces passes). The UI binds to this.
//   ditaValid — is the document state relevant to this op DITA-conformant such that
//               the op keeps it valid? false only for genuine structural-constraint
//               violations (dropping a required-minimum child: CALS tbody/thead is
//               (row)+, ul/ol is (li)+; tgroup needs a column) or a malformed CALS
//               grid (isGridValid === false). An unsupported-but-well-formed case
//               (column edit on a merged table; a merge with no aligned neighbour)
//               is enabled:false with ditaValid:true — the document is fine, we just
//               refuse the action.
//
// Assumption made explicit: delete-only-paragraph is refused (enabled:false) as an
// authoring guard against emptying a container, but DITA permits an empty container
// in the general case, so it reports ditaValid:true — distinct from row/item, whose
// parents have a hard (child)+ occurrence rule.

import { parse } from '../cst/parse';
import { assignElementIds } from '../cst/element-ids';
import { childElements, childrenNamed } from '../cst/query';
import { computeGrid, cellAt, gridCellFor, isGridValid } from '../cst/table-grid';
import type { Document, ElementNode } from '../cst/types';
import { canDeleteElement, canJoinTextBlocks } from '../cst/structural';
import type { StructuralOp } from '../cst/structural';

export type { StructuralOp } from '../cst/structural';

export interface FocusState {
  /** Stable element id (e{N}, as stamped by element-ids) of the focused element,
   *  or null when nothing structural is focused. */
  id: string | null;
}

/** Parsed document plus an id→element lookup, built once so isValid stays O(1) on
 *  resolution. Build with indexDocument(source); rebuild after every host edit. */
export interface DocIndex {
  doc: Document;
  byId: Map<string, ElementNode>;
}

export interface Validity {
  enabled: boolean;
  reason?: string;
  ditaValid: boolean;
}

export function indexDocument(source: string): DocIndex {
  const doc = parse(source);
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  return { doc, byId };
}

// ---- small readers (mirror the helpers in structural.ts / table-merge.ts) ----

function attrOf(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function ancestorNamed(el: ElementNode, name: string): ElementNode | null {
  let n: ElementNode | null | undefined = el.parent;
  while (n && n.name !== name) n = n.parent;
  return n ?? null;
}

function tableRows(tgroup: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  for (const section of childElements(tgroup)) {
    if (section.name === 'thead' || section.name === 'tbody') {
      rows.push(...childrenNamed(section, 'row'));
    }
  }
  return rows;
}

/** Mirror of structural.ts hasMergedCells: any entry carrying a CALS span attr. */
function hasMergedCells(tgroup: ElementNode): boolean {
  return tableRows(tgroup).some((row) =>
    childrenNamed(row, 'entry').some(
      (e) => attrOf(e, 'namest') || attrOf(e, 'nameend') || attrOf(e, 'morerows'),
    ),
  );
}

// ---- op → required focus kind ----

// 'list' matches ul|ol (like 'textblock' matches p|li); whole-block deletes target the
// block element itself (table/ul|ol/fig), so the focus kind IS that block, not its children.
// 'element' is the universal target of deleteElement — it matches ANY element, so the
// category-driven canDeleteElement guard (not a fixed focus kind) decides availability.
type FocusKind =
  | 'row'
  | 'li'
  | 'p'
  | 'entry'
  | 'textblock'
  | 'table'
  | 'list'
  | 'fig'
  | 'image'
  | 'title'
  | 'element';

/** Topic-root elements whose <title> is REQUIRED (mirror of structural.ts TOPIC_ROOTS).
 *  A <title> inside table/fig/section is OPTIONAL and therefore deletable. */
const TOPIC_ROOTS = new Set(['topic', 'concept', 'task', 'reference', 'glossentry', 'glossgroup']);

const OP_TARGET: Record<StructuralOp, FocusKind> = {
  addRowAfter: 'row',
  addRowBefore: 'row',
  deleteRow: 'row',
  addItemAfter: 'li',
  deleteItem: 'li',
  addParaAfter: 'p',
  deletePara: 'p',
  addColumnAfter: 'entry',
  addColumnBefore: 'entry',
  deleteColumn: 'entry',
  mergeRight: 'entry',
  mergeDown: 'entry',
  mergeLeft: 'entry',
  mergeUp: 'entry',
  splitCell: 'entry',
  promoteRowToHeader: 'row',
  demoteRowFromHeader: 'row',
  moveColumnLeft: 'entry',
  moveColumnRight: 'entry',
  addTableTitle: 'table',
  split: 'textblock',
  pasteBlocks: 'textblock',
  join: 'textblock',
  deleteTable: 'table',
  deleteList: 'list',
  deleteFig: 'fig',
  deleteImage: 'image',
  deleteTitle: 'title',
  deleteElement: 'element',
  indentItem: 'li',
  outdentItem: 'li',
  moveBefore: 'element',
  moveAfter: 'element',
};

const KIND_NOUN: Record<FocusKind, string> = {
  row: 'a table row',
  li: 'a list item',
  p: 'a paragraph',
  entry: 'a table cell',
  textblock: 'a paragraph or list item',
  table: 'a table',
  list: 'a list',
  fig: 'a figure',
  image: 'an image',
  title: 'a title',
  element: 'an element',
};

function ok(): Validity {
  return { enabled: true, ditaValid: true };
}
function no(reason: string, ditaValid = true): Validity {
  return { enabled: false, reason, ditaValid };
}

function kindMatches(el: ElementNode, target: FocusKind): boolean {
  if (target === 'element') return true; // deleteElement accepts any element; the guard decides.
  if (target === 'textblock') return el.name === 'p' || el.name === 'li';
  if (target === 'list') return el.name === 'ul' || el.name === 'ol';
  return el.name === target;
}

/**
 * Is `op` valid for the element currently in focus, given the parsed document?
 * Pure: never mutates `idx` or its document.
 */
export function isValid(op: StructuralOp, focus: FocusState, idx: DocIndex): Validity {
  if (focus.id == null) return no('Nothing is in focus');
  const el = idx.byId.get(focus.id);
  if (!el) return no('Focused element was not found');

  const target = OP_TARGET[op];
  if (!kindMatches(el, target)) {
    return no(`This action needs ${KIND_NOUN[target]} in focus`);
  }

  switch (op) {
    // Adding a sibling never violates a structural constraint.
    case 'addRowAfter':
    case 'addRowBefore':
    case 'addItemAfter':
    case 'addParaAfter':
      return ok();

    // Same-parent reorders: legality depends on the REFERENCE sibling (payload),
    // which a focus-only predicate cannot see. The mutator enforces the
    // same-container constraint and refuses without writing.
    case 'moveBefore':
    case 'moveAfter':
      return ok();

    // Destructive deletes: refuse removing the sole required child. (These guards
    // do NOT exist in structural.ts yet — this predicate is the only gate.)
    case 'deleteRow': {
      const section = el.parent ?? null;
      const rows = section ? childrenNamed(section, 'row') : [el];
      if (rows.length <= 1) return no('Cannot delete the only row in the table section', false);
      return ok();
    }
    case 'deleteItem': {
      const list = el.parent ?? null;
      const items = list ? childrenNamed(list, 'li') : [el];
      if (items.length <= 1) {
        const check = canDeleteElement(el, list);
        if (!check.canDelete) return no('Cannot delete the only item because its list cannot be removed', false);
      }
      return ok();
    }
    case 'deletePara': {
      const parent = el.parent ?? null;
      const paras = parent ? childrenNamed(parent, 'p') : [el];
      // Authoring guard (ditaValid stays true: DITA tolerates an empty container).
      if (paras.length <= 1) return no('Cannot delete the only paragraph in its container');
      return ok();
    }

    // Whole-block deletes: refuse removing the sole block-level child of a (block)+
    // container (body/section/conbody) — mirrors structural.ts guardNotOnlyBlock and
    // range-ops' 'deletes-whole-container'. ditaValid:false: the occurrence rule is
    // violated, exactly like deleteRow/deleteItem (tbody is (row)+, ul is (li)+).
    case 'deleteTable':
    case 'deleteList':
    case 'deleteFig': {
      const parent = el.parent ?? null;
      const blocks = parent ? childElements(parent) : [el];
      if (blocks.length <= 1) return no('Cannot delete the only block in its container', false);
      return ok();
    }

    // <image> is OPTIONAL in every container it appears in (fig/entry/p/…), so there is
    // no required-child occurrence rule to enforce — deleting it always keeps the doc valid.
    case 'deleteImage':
      return ok();

    // <title> is REQUIRED in a topic root (refuse, ditaValid:false — the occurrence rule is
    // violated, like deleteRow on the only row) and OPTIONAL in table/fig/section (allowed).
    case 'deleteTitle': {
      const parent = el.parent ?? null;
      if (parent && TOPIC_ROOTS.has(parent.name)) {
        return no(`Cannot delete the required title of a ${parent.name}`, false);
      }
      return ok();
    }

    // Universal delete: defer entirely to the category-driven guard in structural.ts
    // so the availability reason matches what apply-time would throw (single source of
    // truth — no rules duplicated here). ditaValid tracks canDelete: a refusal means
    // removing this element now would leave the document non-conformant.
    case 'deleteElement': {
      const check = canDeleteElement(el, el.parent ?? null);
      return check.canDelete ? ok() : no(check.reason ?? 'Cannot delete this element', false);
    }

    case 'addColumnAfter':
    case 'addColumnBefore':
    case 'deleteColumn':
      return columnValidity(op, el);

    case 'mergeRight':
    case 'mergeDown':
    case 'mergeLeft':
    case 'mergeUp':
    case 'splitCell':
      return cellMergeValidity(op, el);

    case 'promoteRowToHeader':
    case 'demoteRowFromHeader':
      return headerToggleValidity(op, el);

    case 'moveColumnLeft':
    case 'moveColumnRight':
      return columnMoveValidity(op, el);

    case 'addTableTitle': {
      if (childrenNamed(el, 'title').length) return no('This table already has a title');
      return ok();
    }

    case 'split':
      // Splitting a text block always yields two valid same-kind siblings.
      return ok();
    case 'pasteBlocks':
      // Multi-block paste keeps the focused p/li valid and creates same-kind siblings.
      return ok();
    case 'join': {
      const parent = el.parent ?? null;
      const sibs = parent ? childElements(parent) : [];
      const prev = sibs[sibs.indexOf(el) - 1];
      const check = canJoinTextBlocks(el, prev ?? null);
      return check.canDelete ? ok() : no(check.reason ?? 'No compatible previous text element to join into');
    }

    // Indent: valid only when an item ABOVE it exists in the same list to nest under.
    case 'indentItem': {
      const list = el.parent ?? null;
      const items = list ? childrenNamed(list, 'li') : [el];
      if (items.indexOf(el) <= 0) {
        return no('Cannot indent the first item — there is no item above to nest it under');
      }
      return ok();
    }
    // Outdent: valid only when the item's list is itself nested inside another <li>.
    case 'outdentItem': {
      const parentLi = el.parent?.parent ?? null;
      if (!parentLi || parentLi.name !== 'li') {
        return no('Already at the top level — nothing to outdent');
      }
      return ok();
    }
  }
}

// ---- toolbar command-availability map (P0-2 gating) ----
// The visual toolbar exposes exactly these structural ops, grouped by the focus kind they target
// (split/join are keyboard-only — Enter/Backspace — so they are intentionally excluded). The host
// builds an availability map from this + isValid and ships it to the webview, which looks it up
// synchronously to enable/disable controls. This keeps validity.ts the SINGLE SOURCE OF TRUTH —
// canvas.js stops re-deriving merge/column/delete rules from the DOM.
const TOOLBAR_OPS_BY_KIND: Record<string, StructuralOp[]> = {
  row: ['addRowAfter', 'addRowBefore', 'deleteRow', 'promoteRowToHeader', 'demoteRowFromHeader'],
  li: ['addItemAfter', 'deleteItem', 'indentItem', 'outdentItem'],
  p: ['addParaAfter', 'deletePara'],
  entry: [
    'addColumnAfter', 'addColumnBefore', 'deleteColumn',
    'mergeRight', 'mergeDown', 'mergeLeft', 'mergeUp', 'splitCell',
    'moveColumnLeft', 'moveColumnRight',
  ],
  table: ['addTableTitle', 'deleteTable'],
  title: ['deleteTitle'],
  shortdesc: ['deleteElement'],
  lines: ['deleteElement'],
  codeblock: ['deleteElement'],
  note: ['deleteElement'],
  section: ['deleteElement'],
};

export interface CommandAvailability {
  enabled: boolean;
  reason?: string;
}
/** elementId (e{N}) -> op -> availability. Only structural/cell elements that have toolbar ops
 *  appear; other elements are absent (the webview falls back to "enabled" for an unmapped id). */
export type AvailabilityMap = Record<string, Record<string, CommandAvailability>>;

/** Availability of every toolbar-exposed op for every addressable element, keyed by the SAME e{N}
 *  id the renderer stamps (data-struct-id for row/li/p, data-cell-id for entries). Pure: reads
 *  only; never mutates/serializes, so it cannot affect byte-exact round-tripping. */
export function buildAvailabilityMap(idx: DocIndex): AvailabilityMap {
  const map: AvailabilityMap = {};
  for (const [id, el] of idx.byId) {
    const ops = TOOLBAR_OPS_BY_KIND[el.name];
    if (!ops) continue;
    const entry: Record<string, CommandAvailability> = {};
    for (const op of ops) {
      const v = isValid(op, { id }, idx);
      entry[op] = v.enabled ? { enabled: true } : { enabled: false, reason: v.reason };
    }
    map[id] = entry;
  }
  return map;
}

// Mirrors structural.ts addColumnAt/deleteColumn guards. Column INSERTS are
// per-boundary span-aware: only a namest/nameend span CROSSING the target
// boundary refuses (a vertically-merged table can still gain columns at safe
// boundaries). deleteColumn keeps the blanket merged-table refusal.
function columnValidity(
  op: 'addColumnAfter' | 'addColumnBefore' | 'deleteColumn',
  entry: ElementNode,
): Validity {
  const tgroup = ancestorNamed(entry, 'tgroup');
  if (!tgroup) return no('Cell is not inside a table', false);

  if (op === 'deleteColumn') {
    if (hasMergedCells(tgroup)) {
      return no('Column editing is unsupported on tables with merged cells');
    }
    const row = entry.parent ?? null;
    const colIdx = row ? childrenNamed(row, 'entry').indexOf(entry) : -1;
    if (colIdx < 0) return no('Cell is not a direct child of its row', false);
    const cols = Number(attrOf(tgroup, 'cols') ?? '0');
    if (cols <= 1) return no('Cannot delete the only column', false);
    return ok();
  }

  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) return no('Table grid is malformed', false);
  const cell = gridCellFor(grid, entry);
  if (!cell) return no('Cell not found in the table grid', false);
  const k = op === 'addColumnAfter' ? cell.colEnd : cell.colStart - 1;
  if (grid.cells.some((c) => c.colStart <= k && c.colEnd > k)) {
    return no('A merged cell spans across this boundary — split it first');
  }
  return ok();
}

// Mirrors structural.ts promoteRowToHeader/demoteRowFromHeader guards.
function headerToggleValidity(
  op: 'promoteRowToHeader' | 'demoteRowFromHeader',
  row: ElementNode,
): Validity {
  const section = row.parent ?? null;
  if (!section || (section.name !== 'thead' && section.name !== 'tbody')) {
    return no('Row is not inside a table section', false);
  }
  const rows = childrenNamed(section, 'row');
  const hasVSpan = childrenNamed(row, 'entry').some((e) => attrOf(e, 'morerows'));

  if (op === 'promoteRowToHeader') {
    if (section.name !== 'tbody') return no('This row is already a header row');
    if (rows[0] !== row) return no('Only the first body row can become the header row');
    if (rows.length <= 1) {
      return no('Cannot make the only body row a header — the table body needs at least one row', false);
    }
    if (hasVSpan) return no("Can't move a row with vertical spans across the header boundary");
    return ok();
  }

  if (section.name !== 'thead') return no('This row is not a header row');
  if (rows[rows.length - 1] !== row) return no('Only the last header row can move into the body');
  if (hasVSpan) return no("Can't move a row with vertical spans across the header boundary");
  const idx = rows.indexOf(row);
  for (let r = 0; r < idx; r++) {
    for (const e of childrenNamed(rows[r], 'entry')) {
      const mr = Number(attrOf(e, 'morerows') ?? '0');
      if (Number.isFinite(mr) && r + mr >= idx) {
        return no("Can't move this row — a merged cell above spans into it");
      }
    }
  }
  const tgroup = section.parent ?? null;
  const tbody = tgroup ? childrenNamed(tgroup, 'tbody')[0] : undefined;
  if (!tbody || childrenNamed(tbody, 'row').length === 0) return no('Table has no body rows', false);
  return ok();
}

// Mirrors structural.ts moveColumn guards.
function columnMoveValidity(op: 'moveColumnLeft' | 'moveColumnRight', entry: ElementNode): Validity {
  const tgroup = ancestorNamed(entry, 'tgroup');
  if (!tgroup) return no('Cell is not inside a table', false);
  if (hasMergedCells(tgroup)) {
    return no('Column editing is unsupported on tables with merged cells');
  }
  const cols = Number(attrOf(tgroup, 'cols') ?? '0');
  for (const section of childElements(tgroup)) {
    if (section.name !== 'thead' && section.name !== 'tbody') continue;
    for (const r of childrenNamed(section, 'row')) {
      const cells = childrenNamed(r, 'entry');
      if (cells.length !== cols) return no('Table rows are inconsistent with the declared columns', false);
      if (cells.some((e) => attrOf(e, 'colname'))) {
        return no('Column reorder is unsupported when cells are pinned to named columns');
      }
    }
  }
  const row = entry.parent ?? null;
  const colIdx = row ? childrenNamed(row, 'entry').indexOf(entry) : -1;
  if (colIdx < 0) return no('Cell is not a direct child of its row', false);
  if (op === 'moveColumnLeft' && colIdx === 0) return no('Already the first column');
  if (op === 'moveColumnRight' && colIdx === cols - 1) return no('Already the last column');
  return ok();
}

// Mirrors table-merge.ts merge/split guards via the grid model.
function cellMergeValidity(
  op: 'mergeRight' | 'mergeDown' | 'mergeLeft' | 'mergeUp' | 'splitCell',
  entry: ElementNode,
): Validity {
  const tgroup = ancestorNamed(entry, 'tgroup');
  if (!tgroup) return no('Cell is not inside a table', false);
  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) return no('Table grid is malformed', false);
  const cell = gridCellFor(grid, entry);
  if (!cell) return no('Cell not found in the table grid', false);

  if (op === 'mergeRight') {
    const right = cellAt(grid, cell.section, cell.row, cell.colEnd + 1);
    if (!right) return no('No cell to the right to merge');
    if (right.row !== cell.row || right.rowSpan !== cell.rowSpan) {
      return no('Right cell is not row-aligned');
    }
    return ok();
  }
  if (op === 'mergeDown') {
    const below = cellAt(grid, cell.section, cell.row + cell.rowSpan, cell.colStart);
    if (!below) return no('No cell below to merge');
    if (below.colStart !== cell.colStart || below.colEnd !== cell.colEnd) {
      return no('Cell below is not column-aligned');
    }
    return ok();
  }
  if (op === 'mergeLeft') {
    const left = cellAt(grid, cell.section, cell.row, cell.colStart - 1);
    if (!left) return no('No cell to the left to merge');
    if (left.row !== cell.row || left.rowSpan !== cell.rowSpan) {
      return no('Left cell is not row-aligned');
    }
    return ok();
  }
  if (op === 'mergeUp') {
    const above = cellAt(grid, cell.section, cell.row - 1, cell.colStart);
    if (!above) return no('No cell above to merge');
    if (above.colStart !== cell.colStart || above.colEnd !== cell.colEnd) {
      return no('Cell above is not column-aligned');
    }
    return ok();
  }
  // splitCell
  if (cell.rowSpan === 1 && cell.colStart === cell.colEnd) {
    return no('Cell is not merged');
  }
  return ok();
}
