// Pure executor bridge for range-ops.ts.
//
// range-ops.ts PLANS two coalesced range actions but emits no source — it was
// always paired with "a future range-delete primitive" (range-ops.ts header). This
// module is that primitive, built without any src/cst change: it composes the
// existing single-op applyStructuralEdit black box, re-resolving each target by its
// stable structural path (doc-path.ts) between steps because e{N} ids re-stamp on
// every edit. The host applies the single returned source as one WorkspaceEdit, so
// the whole range action is atomic and one undo step.
//
//   • executeRangeDelete   — delete a contiguous same-parent block run (p/li/row, or
//                            a whole table/ul|ol/fig — the op is whatever planRangeDelete
//                            resolved for the selected kind; this executor is op-agnostic).
//                            Folds the deletes in REVERSE document order so each
//                            deletion leaves every earlier target's path intact.
//   • executeCellRectMerge — merge a clean cell rectangle into its top-left anchor by
//                            composing mergeRight/mergeDown (which table-merge.ts
//                            documents as designed to "compose into larger spans"):
//                            merge each rect row horizontally, then merge the anchor
//                            down over the pre-merged rows. SCOPE: every selected cell
//                            must be 1x1 — a rectangle whose interior already contains
//                            a spanned cell is refused 'unsupported-prespanned', since
//                            mergeRight/mergeDown's alignment guards do not hold for a
//                            mixed-span interior and a correct merge there needs a
//                            single-parse rectangle primitive in src/cst/table-merge.ts
//                            (out of this lane's scope).
//
// Purity: builds its own DocIndex from `source`, never mutates caller state; every
// step is the corpus-noop-safe single op, so unrelated content stays byte-exact.

import { applyStructuralEdit } from '../cst/structural';
import { setElementText } from '../cst/edit';
import { serialize } from '../cst/serialize';
import type { StructuralOp } from '../cst/structural';
import { computeGrid, cellAt } from '../cst/table-grid';
import { indexDocument } from './validity';
import { elementPath, resolveByPath, idOf } from './doc-path';
import { planRangeDelete, planCellRectMerge, planCellClear } from './range-ops';
import type {
  RangeActionType,
  RangeRejectCode,
  RangeDeleteIntent,
  CellRectMergeIntent,
  CellClearIntent,
} from './range-ops';

export type RangeExecRefusalCode =
  | RangeRejectCode // forwarded verbatim from the planner's reject
  | 'unsupported-prespanned' // merge: a selected cell is already spanned (needs src/cst primitive)
  | 'value-count-mismatch' // cellTextReplace: caller did not provide exactly one replacement per cell
  | 'internal'; // a path target was lost mid-fold (invariant violation; original source kept)

export type RangeExecResult =
  | { ok: true; action: 'rangeDelete'; source: string; plan: RangeDeleteIntent }
  | { ok: true; action: 'cellRectMerge'; source: string; plan: CellRectMergeIntent }
  | { ok: true; action: 'cellClear'; source: string; plan: CellClearIntent }
  | { ok: true; action: 'cellTextReplace'; source: string; plan: CellClearIntent }
  | {
      ok: false;
      action: RangeActionType;
      /** The original source, unchanged — callers can treat ok/refused uniformly. */
      source: string;
      refusal: { code: RangeExecRefusalCode; reason: string };
    };

/** One precomputed sub-op: an op plus the structural path of its (re-resolved) target. */
interface Step {
  op: StructuralOp;
  path: number[];
}

/** Apply a fixed sequence of single ops, re-resolving each target by structural path
 *  against the current source (ids re-stamp every step). Returns the final source, or
 *  null if a target was lost (caller maps that to an 'internal' refusal). */
function foldSteps(source: string, steps: Step[]): string | null {
  let current = source;
  for (const step of steps) {
    const idx = indexDocument(current);
    const el = resolveByPath(idx.doc, step.path);
    if (!el) return null;
    const curId = idOf(idx, el);
    if (!curId) return null;
    current = applyStructuralEdit(current, step.op, curId).source;
  }
  return current;
}

function replaceCellContent(source: string, path: number[], value: string): string {
  const idx = indexDocument(source);
  const el = resolveByPath(idx.doc, path);
  if (!el || el.name !== 'entry') throw new Error('cell target lost mid-replace');
  setElementText(el, value);
  return serialize(idx.doc);
}

/**
 * Plan and execute a contiguous block-range delete. Pure. Returns the new source
 * (ok) or a refusal forwarding the planner's reject code/reason.
 */
export function executeRangeDelete(source: string, ids: string[]): RangeExecResult {
  const idx0 = indexDocument(source);
  const plan = planRangeDelete(ids, idx0);
  if (!plan.ok) {
    return { ok: false, action: 'rangeDelete', source, refusal: { code: plan.code, reason: plan.reason } };
  }

  // plan.ids are in document order; delete LAST-first so each remaining target's
  // precomputed path stays valid (removing a later element never shifts an earlier one).
  const paths = plan.ids.map((id) => elementPath(idx0.byId.get(id)!, idx0.doc));
  const steps: Step[] = [];
  for (let i = paths.length - 1; i >= 0; i--) steps.push({ op: plan.op, path: paths[i] });

  const out = foldSteps(source, steps);
  if (out === null) {
    return { ok: false, action: 'rangeDelete', source, refusal: { code: 'internal', reason: 'delete target lost mid-fold' } };
  }
  return { ok: true, action: 'rangeDelete', source: out, plan };
}

/**
 * Plan and execute a clean cell-rectangle merge. Pure. Returns the new source (ok),
 * forwards the planner's reject, or refuses 'unsupported-prespanned' when the
 * rectangle's interior already contains a spanned cell (see module header).
 */
export function executeCellRectMerge(source: string, ids: string[]): RangeExecResult {
  const idx0 = indexDocument(source);
  const plan = planCellRectMerge(ids, idx0);
  if (!plan.ok) {
    return { ok: false, action: 'cellRectMerge', source, refusal: { code: plan.code, reason: plan.reason } };
  }

  const { cols, rows } = plan.span;
  // A clean all-1x1 rectangle has exactly cols*rows cells; fewer ⇒ an interior span.
  if (plan.cellIds.length !== cols * rows) {
    return {
      ok: false,
      action: 'cellRectMerge',
      source,
      refusal: {
        code: 'unsupported-prespanned',
        reason: 'Rectangle contains an already-merged cell; not batch-mergeable without an src/cst primitive',
      },
    };
  }

  const tgroup = idx0.byId.get(plan.tableId);
  if (!tgroup) {
    return { ok: false, action: 'cellRectMerge', source, refusal: { code: 'internal', reason: 'tgroup not found' } };
  }
  const grid = computeGrid(tgroup);
  const { r0, r1, c0 } = plan.rect;

  // Merge each rect row horizontally (the row's left-of-rect cell stays at its entry
  // index as it absorbs rightward), then merge the anchor down over the pre-merged
  // rows. Paths are taken from the ORIGINAL parse; horizontal merges touch only their
  // own row, and downward merges remove only lower rows' cells, so none disturbs a
  // path used later in the sequence.
  const steps: Step[] = [];
  for (let r = r0; r <= r1; r++) {
    const left = cellAt(grid, plan.section, r, c0);
    if (!left) {
      return { ok: false, action: 'cellRectMerge', source, refusal: { code: 'internal', reason: `no cell at (${r},${c0})` } };
    }
    const path = elementPath(left.entry, idx0.doc);
    for (let k = 0; k < cols - 1; k++) steps.push({ op: 'mergeRight', path });
  }
  const anchorPath = elementPath(cellAt(grid, plan.section, r0, c0)!.entry, idx0.doc);
  for (let k = 0; k < rows - 1; k++) steps.push({ op: 'mergeDown', path: anchorPath });

  const out = foldSteps(source, steps);
  if (out === null) {
    return { ok: false, action: 'cellRectMerge', source, refusal: { code: 'internal', reason: 'merge target lost mid-fold' } };
  }
  return { ok: true, action: 'cellRectMerge', source: out, plan };
}

export function executeCellClear(source: string, ids: string[]): RangeExecResult {
  const idx0 = indexDocument(source);
  const plan = planCellClear(ids, idx0);
  if (!plan.ok) {
    return { ok: false, action: 'cellClear', source, refusal: { code: plan.code, reason: plan.reason } };
  }

  const paths = plan.cellIds.map((id) => elementPath(idx0.byId.get(id)!, idx0.doc));
  let current = source;
  for (const path of paths) {
    try {
      current = replaceCellContent(current, path, '');
    } catch (_err) {
      return {
        ok: false,
        action: 'cellClear',
        source,
        refusal: {
          code: 'not-clearable-cell',
          reason: 'One selected cell contains source content that cannot be cleared safely.',
        },
      };
    }
  }
  return { ok: true, action: 'cellClear', source: current, plan };
}

export function executeCellTextReplace(source: string, ids: string[], values: string[]): RangeExecResult {
  const idx0 = indexDocument(source);
  const plan = planCellClear(ids, idx0);
  if (!plan.ok) {
    return { ok: false, action: 'cellTextReplace', source, refusal: { code: plan.code, reason: plan.reason } };
  }
  if (values.length !== ids.length) {
    return {
      ok: false,
      action: 'cellTextReplace',
      source,
      refusal: {
        code: 'value-count-mismatch',
        reason: 'Cell paste did not provide exactly one replacement value for each selected cell.',
      },
    };
  }

  const valuesById = new Map<string, string>();
  ids.forEach((id, i) => {
    if (!valuesById.has(id)) valuesById.set(id, values[i] ?? '');
  });
  if (valuesById.size !== plan.cellIds.length) {
    return {
      ok: false,
      action: 'cellTextReplace',
      source,
      refusal: {
        code: 'value-count-mismatch',
        reason: 'Cell paste did not provide exactly one replacement value for each selected cell.',
      },
    };
  }

  const targets = plan.cellIds.map((id) => ({
    path: elementPath(idx0.byId.get(id)!, idx0.doc),
    value: valuesById.get(id) ?? '',
  }));
  let current = source;
  for (const target of targets) {
    try {
      current = replaceCellContent(current, target.path, target.value);
    } catch (_err) {
      return {
        ok: false,
        action: 'cellTextReplace',
        source,
        refusal: {
          code: 'not-clearable-cell',
          reason: 'One selected cell contains source content that cannot be replaced safely.',
        },
      };
    }
  }
  return { ok: true, action: 'cellTextReplace', source: current, plan };
}
