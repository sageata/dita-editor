// P1 — pure MULTI-SELECTION command planner.
//
// Given a parsed DocIndex (src/commands/validity.ts), a set of selected element ids,
// and one requested command family, decide PER ID — in stable document order —
// whether the command applies to that element or is skipped (with a machine code +
// human reason). This is the foundation a future multi-select toolbar consumes; it
// only PLANS — it never mutates a document and never serializes, so it cannot affect
// byte-exact round-tripping.
//
// Relationship to range-ops.ts: range-ops COALESCES a selection into one atomic
// intent (a contiguous same-parent block run -> a single rangeDelete; a clean cell
// rectangle -> one cellRectMerge). THIS planner is the general PER-ID fan-out: an
// arbitrary, possibly non-contiguous / multi-container / multi-kind selection put
// through ONE command family, yielding an independent verdict per id. Different
// output shape, different use case — they do not overlap.
//
// Decisions reuse the existing single-element cores so this planner agrees with them:
//   • structural ops  -> isValid()      (src/commands/validity.ts)
//   • transforms      -> planTransform() (src/commands/transform-ops.ts)
//
// Safety: a delete that would remove EVERY required child of a container (CALS tbody
// is (row)+, ul/ol is (li)+) is refused as a group, mirroring range-ops'
// 'deletes-whole-container' occurrence rule — so the plan never describes an edit
// that yields invalid DITA, even though each id is individually deletable.

import { childElements, childrenNamed } from '../cst/query';
import type { ElementNode } from '../cst/types';
import { isValid } from './validity';
import type { DocIndex, StructuralOp } from './validity';
import { planTransform } from './transform-ops';
import type { TransformType } from './transform-ops';
import { canDeleteElement } from '../cst/structural';

/** A single command family applied across the whole selection. */
export type MultiCommand =
  | { family: 'delete' } // per element: p->deletePara, li->deleteItem, row->deleteRow
  | { family: 'structural'; op: StructuralOp } // one concrete structural op for every id
  | { family: 'transform'; transform: TransformType }; // one transform for every id

export type MultiSkipCode =
  | 'stale-id' // id no longer resolves to an element (pruned)
  | 'unsupported-kind' // the family has no operation for this element's kind
  | 'invalid' // the per-element validator refused (carries its reason)
  | 'noop' // a transform that is already satisfied for this element
  | 'would-empty-container'; // delete refused: it would remove the container's last required child

export interface MultiPlanItem {
  id: string;
  /** Document-order index of this id (−1 for a stale id). Deterministic ordering key. */
  order: number;
  decision: 'apply' | 'skip';
  /** The concrete op/transform resolved for this id (apply only). */
  op?: StructuralOp | TransformType;
  /** Skip reason (human-readable); present on every skip. */
  reason?: string;
  /** Skip reason (machine code); present on every skip. */
  code?: MultiSkipCode;
}

export interface MultiCommandPlan {
  command: MultiCommand;
  /** Every (deduped) input id, in document order, each with an apply/skip verdict. */
  items: MultiPlanItem[];
  /** Ids to apply, in document order. Apply ATOMICALLY against a single parse — ids
   *  are reassigned on every structural edit, so these cannot be applied as N
   *  sequential single-id edits (same contract as range-ops). */
  applyIds: string[];
  /** True when every known (non-stale) selected element shares one tag kind. */
  homogeneous: boolean;
  summary: 'ok' | 'empty' | 'all-skipped';
}

const DELETE_OP: Record<string, StructuralOp> = {
  p: 'deletePara',
  li: 'deleteItem',
  row: 'deleteRow',
  table: 'deleteTable',
  ul: 'deleteList',
  ol: 'deleteList',
  fig: 'deleteFig',
};
const DELETE_OPS: ReadonlySet<string> = new Set(['deletePara', 'deleteItem', 'deleteRow']);
// Whole-block deletes are validated by the (block)+ group guard below, not by isValid()
// (validity.ts has no focus-kind/predicate for them).
const BLOCK_DELETE_OPS: ReadonlySet<string> = new Set(['deleteTable', 'deleteList', 'deleteFig']);
const OPTIONAL_BLOCK_PARENTS: ReadonlySet<string> = new Set(['li', 'entry']);
const BLOCK_LEVEL: ReadonlySet<string> = new Set([
  'p',
  'ul',
  'ol',
  'dl',
  'sl',
  'table',
  'simpletable',
  'fig',
  'section',
  'lines',
  'pre',
  'note',
  'codeblock',
]);
const BLOCK_LEVEL_DELETE_OPS: ReadonlySet<string> = new Set(['deletePara', 'deleteTable', 'deleteList', 'deleteFig']);

/** Document-order position of every id (byId is depth-first insertion order). */
function orderPositions(idx: DocIndex): Map<string, number> {
  const pos = new Map<string, number>();
  let i = 0;
  for (const id of idx.byId.keys()) pos.set(id, i++);
  return pos;
}

function apply(id: string, order: number, op: StructuralOp | TransformType): MultiPlanItem {
  return { id, order, decision: 'apply', op };
}
function skip(id: string, order: number, code: MultiSkipCode, reason: string): MultiPlanItem {
  return { id, order, decision: 'skip', code, reason };
}

function decideOne(command: MultiCommand, id: string, idx: DocIndex, order: number): MultiPlanItem {
  const el = idx.byId.get(id);
  if (!el) return skip(id, order, 'stale-id', 'Selected element is no longer in the document');

  if (command.family === 'transform') {
    const r = planTransform(command.transform, { id }, idx);
    if (r.status === 'ok') return apply(id, order, command.transform);
    return skip(
      id,
      order,
      r.status === 'noop' ? 'noop' : 'invalid',
      r.reason ?? 'This transform does not apply here',
    );
  }

  // 'delete' resolves a concrete op per kind; 'structural' uses the given op for all.
  let op: StructuralOp;
  if (command.family === 'delete') {
    const resolved = DELETE_OP[el.name];
    if (!resolved) return skip(id, order, 'unsupported-kind', `<${el.name}> cannot be deleted as a block`);
    op = resolved;
    // Whole-block deletes (kind resolved from el, so always kind-correct) are gated only
    // by the group guardWholeContainer; isValid() can't validate them.
    if (BLOCK_DELETE_OPS.has(op)) {
      const check = canDeleteElement(el, el.parent ?? null);
      return check.canDelete
        ? apply(id, order, op)
        : skip(id, order, 'would-empty-container', check.reason ?? `Cannot delete this <${el.name}>`);
    }
  } else {
    op = command.op;
  }
  const v = isValid(op, { id }, idx);
  if (!v.enabled) return skip(id, order, 'invalid', v.reason ?? 'This operation is not valid here');
  return apply(id, order, op);
}

/** Refuse, as a group, any delete that would remove every required child of a
 *  container (occurrence rule). Mutates the items in place: an over-complete group
 *  flips to skip 'would-empty-container'. */
function guardWholeContainer(items: MultiPlanItem[], idx: DocIndex): void {
  const rev = new Map<ElementNode, string>();
  for (const [id, el] of idx.byId) rev.set(el, id);

  // Mixed block deletions can still empty a (block)+ parent even when no single
  // kind is complete, for example selecting <p> + <ul> + <p> in a body.
  const blockByParent = new Map<ElementNode, MultiPlanItem[]>();
  for (const it of items) {
    if (it.decision !== 'apply' || it.op === undefined || !BLOCK_LEVEL_DELETE_OPS.has(it.op)) continue;
    const el = idx.byId.get(it.id);
    const parent = el?.parent;
    if (!el || !parent || !BLOCK_LEVEL.has(el.name) || OPTIONAL_BLOCK_PARENTS.has(parent.name)) continue;
    const arr = blockByParent.get(parent) ?? [];
    arr.push(it);
    blockByParent.set(parent, arr);
  }
  for (const [parent, group] of blockByParent) {
    const selected = new Set(group.map((it) => it.id));
    const blocks = childElements(parent).filter((el) => BLOCK_LEVEL.has(el.name));
    if (blocks.length > 0 && blocks.every((el) => selected.has(rev.get(el) as string))) {
      for (const it of group) {
        it.decision = 'skip';
        it.code = 'would-empty-container';
        it.reason = 'Cannot delete every block in its container';
        it.op = undefined;
      }
    }
  }

  // Group apply-delete items by their parent element, then by kind within that parent.
  const byParent = new Map<ElementNode, MultiPlanItem[]>();
  for (const it of items) {
    if (it.decision !== 'apply' || it.op === undefined || !DELETE_OPS.has(it.op)) continue;
    const parent = idx.byId.get(it.id)?.parent;
    if (!parent) continue;
    const arr = byParent.get(parent) ?? [];
    arr.push(it);
    byParent.set(parent, arr);
  }
  for (const [parent, groupItems] of byParent) {
    const byKind = new Map<string, MultiPlanItem[]>();
    for (const it of groupItems) {
      const kind = idx.byId.get(it.id)!.name;
      const arr = byKind.get(kind) ?? [];
      arr.push(it);
      byKind.set(kind, arr);
    }
    for (const [kind, kindItems] of byKind) {
      const total = childrenNamed(parent, kind).length;
      if (total > 0 && kindItems.length >= total) {
        for (const it of kindItems) {
          it.decision = 'skip';
          it.code = 'would-empty-container';
          it.reason = `Cannot delete every <${kind}> in its container`;
          it.op = undefined;
        }
      }
    }
  }

  // Individual whole-block sole-child checks are handled in decideOne via canDeleteElement.
}

/**
 * Plan one command family across a multi-selection. Pure: never mutates `idx`.
 * Ids are deduped, processed in stable document order; stale and unsupported ids
 * are skipped with a reason; the result lists every input id's verdict plus the
 * ordered apply set.
 */
export function planMultiCommand(
  command: MultiCommand,
  ids: string[],
  idx: DocIndex,
): MultiCommandPlan {
  const order = orderPositions(idx);
  const uniq = [...new Set(ids)];
  const sorted = uniq.slice().sort((a, b) => {
    const oa = order.get(a) ?? Infinity;
    const ob = order.get(b) ?? Infinity;
    if (oa !== ob) return oa < ob ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0; // stable tie-break for stale ids
  });

  const items = sorted.map((id) => decideOne(command, id, idx, order.get(id) ?? -1));
  guardWholeContainer(items, idx);

  const applyIds = items.filter((it) => it.decision === 'apply').map((it) => it.id);
  const knownNames = sorted
    .map((id) => idx.byId.get(id)?.name)
    .filter((n): n is string => n != null);
  const homogeneous = knownNames.length > 0 && knownNames.every((n) => n === knownNames[0]);
  const summary: MultiCommandPlan['summary'] =
    items.length === 0 ? 'empty' : applyIds.length === 0 ? 'all-skipped' : 'ok';

  return { command, items, applyIds, homogeneous, summary };
}
