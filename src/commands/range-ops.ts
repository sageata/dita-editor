// Slice C — pure range-ops planning/validation over selected element ids.
//
// Given multi-selection ids plus a parsed DocIndex (src/commands/validity.ts), decide
// which RANGE actions are legal and emit a deterministic operation INTENT that later
// canvas/host wiring can apply. This slice only PLANS: it never mutates the document
// or serializes, so it cannot affect byte-exact round-tripping.
//
// Two range actions, mutually exclusive by selection kind:
//   • rangeDelete   — a contiguous run of same-parent, same-kind block siblings
//                     (p / li / row). Mirrors validity.ts's occurrence rule:
//                     deleting EVERY same-kind child of the container is refused.
//   • cellRectMerge — a set of <entry> cells that EXACTLY tile a clean rectangle
//                     within one section of one tgroup. Geometry mirrors the
//                     canvas buildCellRect (media/canvas.js) and reuses the same
//                     computeGrid/cellAt/gridCellFor/isGridValid the runtime uses,
//                     so a planned merge agrees with what the table grid permits.
//
// Strictness: a selection can be an arbitrary toggled set, so non-contiguous,
// cross-parent, cross-kind, cross-table, cross-section and non-rectangular sets are
// REJECTED with an explicit code+reason rather than silently coerced.
//
// Apply-time note for the consumer: ids are e{N} render-order ids that the host
// REASSIGNS on every structural edit. A rangeDelete intent therefore lists its ids
// in document order to be applied ATOMICALLY against a single parse (a future
// range-delete primitive) — NOT as N sequential single-id applyStructuralEdit calls,
// which would invalidate every later id.

import { childElements, childrenNamed } from '../cst/query';
import { computeGrid, cellAt, gridCellFor, isGridValid } from '../cst/table-grid';
import { canDeleteElement } from '../cst/structural';
import type { ElementNode } from '../cst/types';
import type { DocIndex } from './validity';

export type RangeActionType = 'rangeDelete' | 'cellRectMerge' | 'cellClear' | 'cellTextReplace';

export type RangeRejectCode =
  | 'empty'
  | 'unknown-id'
  | 'mixed-kind'
  | 'not-deletable-kind'
  | 'not-a-cell'
  | 'cross-parent'
  | 'non-contiguous'
  | 'deletes-whole-container'
  | 'too-few-cells'
  | 'cross-table'
  | 'cross-section'
  | 'malformed-grid'
  | 'not-rectangular'
  | 'not-clearable-cell';

export interface RangeReject {
  ok: false;
  action: RangeActionType;
  code: RangeRejectCode;
  reason: string;
}

export interface RangeDeleteIntent {
  ok: true;
  action: 'rangeDelete';
  unit: 'block';
  op: 'deletePara' | 'deleteItem' | 'deleteRow' | 'deleteTable' | 'deleteList' | 'deleteFig';
  kind: 'p' | 'li' | 'row' | 'table' | 'ul' | 'ol' | 'fig';
  parentId: string;
  /** Contiguous members in document order — apply atomically (see header note). */
  ids: string[];
}

export interface CellRectMergeIntent {
  ok: true;
  action: 'cellRectMerge';
  tableId: string;
  section: 'thead' | 'tbody';
  /** Top-left cell that absorbs the rest. */
  anchorCellId: string;
  /** All member cells in document order (includes the anchor). */
  cellIds: string[];
  rect: { r0: number; r1: number; c0: number; c1: number };
  span: { cols: number; rows: number };
}

export interface CellClearIntent {
  ok: true;
  action: 'cellClear';
  cellIds: string[];
}

export type RangeDeleteResult = RangeDeleteIntent | RangeReject;
export type CellRectMergeResult = CellRectMergeIntent | RangeReject;
export type CellClearResult = CellClearIntent | RangeReject;

const DELETABLE: Record<string, RangeDeleteIntent['op']> = {
  p: 'deletePara',
  li: 'deleteItem',
  row: 'deleteRow',
  table: 'deleteTable',
  ul: 'deleteList',
  ol: 'deleteList',
  fig: 'deleteFig',
};

// Whole-block kinds live in (block)+ containers (body/section/conbody): "would empty"
// is measured against ALL block-level children, not just same-kind siblings. p/li/row
// keep their homogeneous-container by-kind rule (ul is (li)+, tbody is (row)+).
const BLOCK_KINDS: ReadonlySet<string> = new Set(['table', 'ul', 'ol', 'fig']);

function reject(action: RangeActionType, code: RangeRejectCode, reason: string): RangeReject {
  return { ok: false, action, code, reason };
}

function reverseIds(idx: DocIndex): Map<ElementNode, string> {
  const rev = new Map<ElementNode, string>();
  for (const [id, el] of idx.byId) rev.set(el, id);
  return rev;
}

/** Document-order position of each id (byId is depth-first insertion order). */
function orderPositions(idx: DocIndex): Map<string, number> {
  const pos = new Map<string, number>();
  let i = 0;
  for (const id of idx.byId.keys()) pos.set(id, i++);
  return pos;
}

function ancestorNamed(el: ElementNode, name: string): ElementNode | null {
  let n: ElementNode | null | undefined = el.parent;
  while (n && n.name !== name) n = n.parent;
  return n ?? null;
}

function resolve(ids: string[], idx: DocIndex): { uniq: string[]; els: ElementNode[] } | null {
  const uniq = [...new Set(ids)];
  const els: ElementNode[] = [];
  for (const id of uniq) {
    const el = idx.byId.get(id);
    if (!el) return null;
    els.push(el);
  }
  return { uniq, els };
}

export function planRangeDelete(ids: string[], idx: DocIndex): RangeDeleteResult {
  if (ids.length === 0) return reject('rangeDelete', 'empty', 'Nothing is selected');
  const r = resolve(ids, idx);
  if (!r) return reject('rangeDelete', 'unknown-id', 'A selected id is not in the document');
  const { uniq, els } = r;

  const names = new Set(els.map((e) => e.name));
  if (names.size > 1) {
    return reject('rangeDelete', 'mixed-kind', 'Selection mixes different element kinds');
  }
  const kind = els[0].name;
  const op = DELETABLE[kind];
  if (!op) return reject('rangeDelete', 'not-deletable-kind', `<${kind}> is not a deletable block`);

  const rev = reverseIds(idx);
  const parent = els[0].parent ?? null;
  if (!parent || els.some((e) => e.parent !== parent)) {
    return reject('rangeDelete', 'cross-parent', 'Selected blocks are not siblings of one parent');
  }

  const allSiblings = childElements(parent); // document order
  const siblings = childrenNamed(parent, kind);
  const selected = new Set(uniq);
  const positions = allSiblings
    .map((el, i) => (selected.has(rev.get(el) as string) ? i : -1))
    .filter((i) => i >= 0);
  const min = positions[0];
  const max = positions[positions.length - 1];
  if (max - min + 1 !== positions.length) {
    return reject('rangeDelete', 'non-contiguous', 'Selected blocks are not contiguous');
  }
  const emptiesContainer = BLOCK_KINDS.has(kind)
    ? positions.length === childElements(parent).length
    : positions.length === siblings.length;
  if (emptiesContainer) {
    // Selecting every <li> of a list would leave an empty <ul>/<ol> — invalid DITA. Rather
    // than refuse, PROMOTE the action to deleting the list itself (matches WYSIWYG: "delete
    // all items" = "delete the list"). Gated by the universal canDeleteElement guard, so a
    // list that is itself the sole block of its container still refuses — but now with a real
    // reason the canvas surfaces visibly. Other kinds keep the plain refusal (we never silently
    // promote a whole-table delete from a row selection — too surprising).
    if (kind === 'li') {
      const list = parent; // <li> lives only in <ul>/<ol>
      const check = canDeleteElement(list, list.parent ?? null);
      const listOp = DELETABLE[list.name];
      if (check.canDelete && listOp && list.parent) {
        return {
          ok: true,
          action: 'rangeDelete',
          unit: 'block',
          op: listOp,
          kind: list.name as RangeDeleteIntent['kind'],
          parentId: rev.get(list.parent) as string,
          ids: [rev.get(list) as string],
        };
      }
      return reject('rangeDelete', 'deletes-whole-container', check.reason ?? `Cannot delete this <${list.name}>`);
    }
    return reject(
      'rangeDelete',
      'deletes-whole-container',
      BLOCK_KINDS.has(kind)
        ? 'Cannot delete the only block in its container'
        : `Cannot delete every <${kind}> in its container`,
    );
  }

  const ordered = allSiblings.slice(min, max + 1).map((el) => rev.get(el) as string);
  return {
    ok: true,
    action: 'rangeDelete',
    unit: 'block',
    op,
    kind: kind as RangeDeleteIntent['kind'],
    parentId: rev.get(parent) as string,
    ids: ordered,
  };
}

export function planCellRectMerge(ids: string[], idx: DocIndex): CellRectMergeResult {
  if (ids.length === 0) return reject('cellRectMerge', 'empty', 'Nothing is selected');
  const r = resolve(ids, idx);
  if (!r) return reject('cellRectMerge', 'unknown-id', 'A selected id is not in the document');
  const { uniq, els } = r;

  const names = new Set(els.map((e) => e.name));
  if (names.size > 1) return reject('cellRectMerge', 'mixed-kind', 'Selection mixes different element kinds');
  if (els[0].name !== 'entry') return reject('cellRectMerge', 'not-a-cell', 'Selection is not table cells');
  if (uniq.length < 2) return reject('cellRectMerge', 'too-few-cells', 'Merge needs at least two cells');

  const tgroup = ancestorNamed(els[0], 'tgroup');
  if (!tgroup || els.some((e) => ancestorNamed(e, 'tgroup') !== tgroup)) {
    return reject('cellRectMerge', 'cross-table', 'Cells are not in the same table');
  }
  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) return reject('cellRectMerge', 'malformed-grid', 'Table grid is malformed');

  const cells = els.map((e) => gridCellFor(grid, e));
  if (cells.some((c) => !c)) return reject('cellRectMerge', 'malformed-grid', 'A cell is not in the grid');
  const sections = new Set(cells.map((c) => c!.section));
  if (sections.size > 1) return reject('cellRectMerge', 'cross-section', 'Cells span thead and tbody');
  const section = cells[0]!.section;

  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const c of cells) {
    r0 = Math.min(r0, c!.row);
    r1 = Math.max(r1, c!.row + c!.rowSpan - 1);
    c0 = Math.min(c0, c!.colStart);
    c1 = Math.max(c1, c!.colEnd);
  }

  // Strict tiling: every position in the bounding box must be covered by a SELECTED
  // cell. A hole (no cell) or a cell crossing the boundary (a span partly outside the
  // selection) means the set is not a clean rectangle.
  const selectedEls = new Set(els);
  const covered = new Set<ElementNode>();
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const g = cellAt(grid, section, row, col);
      if (!g || !selectedEls.has(g.entry)) {
        return reject('cellRectMerge', 'not-rectangular', 'Selection is not a complete rectangle');
      }
      covered.add(g.entry);
    }
  }
  if (covered.size !== uniq.length) {
    return reject('cellRectMerge', 'not-rectangular', 'Selection is not a complete rectangle');
  }

  const rev = reverseIds(idx);
  const pos = orderPositions(idx);
  const anchor = cellAt(grid, section, r0, c0)!;
  const cellIds = uniq.slice().sort((a, b) => (pos.get(a) as number) - (pos.get(b) as number));
  return {
    ok: true,
    action: 'cellRectMerge',
    tableId: rev.get(tgroup) as string,
    section,
    anchorCellId: rev.get(anchor.entry) as string,
    cellIds,
    rect: { r0, r1, c0, c1 },
    span: { cols: c1 - c0 + 1, rows: r1 - r0 + 1 },
  };
}

export function planCellClear(ids: string[], idx: DocIndex): CellClearResult {
  if (ids.length === 0) return reject('cellClear', 'empty', 'Nothing is selected');
  const uniq = Array.from(new Set(ids));
  const els = uniq.map((id) => idx.byId.get(id));
  if (els.some((e) => !e)) return reject('cellClear', 'unknown-id', 'A selected id is not in the document');
  const names = new Set(els.map((e) => e!.name));
  if (names.size > 1) return reject('cellClear', 'mixed-kind', 'Selection mixes different element kinds');
  if (els[0]!.name !== 'entry') return reject('cellClear', 'not-a-cell', 'Selection is not table cells');
  const pos = orderPositions(idx);
  return {
    ok: true,
    action: 'cellClear',
    cellIds: uniq.slice().sort((a, b) => (pos.get(a) as number) - (pos.get(b) as number)),
  };
}

/** Which range actions are legal for this selection (deterministic, possibly empty). */
export function availableRangeActions(ids: string[], idx: DocIndex): RangeActionType[] {
  const out: RangeActionType[] = [];
  if (planRangeDelete(ids, idx).ok) out.push('rangeDelete');
  if (planCellClear(ids, idx).ok) out.push('cellClear');
  if (planCellRectMerge(ids, idx).ok) out.push('cellRectMerge');
  return out;
}
