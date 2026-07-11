// P1-a — pure ATOMIC multi-command executor.
//
// planMultiCommand (multi-command.ts) decides PER ID whether a command applies and
// hands back applyIds in document order with one hard contract: those ids must be
// consumed against a SINGLE logical edit, never as N sequential single-id edits,
// because every structural edit re-assigns e{N} ids (applyStructuralEdit re-parses
// and re-stamps on every call) — so applyIds[1..] are stale the moment applyIds[0]
// is applied.
//
// This module turns an accepted plan into one new source string. It is the layer a
// future canvas/host multi-select toolbar calls: give it the current source + the
// command + the selected ids, it re-plans against ONE parse, and either returns the
// resulting source (ok) or refuses with a reason (refused). The host then applies
// that single source as one WorkspaceEdit, which is what makes the batch atomic and
// a single undo step.
//
// HOW the id-reassignment problem is solved WITHOUT a src/cst batch primitive:
// applyStructuralEdit is single-op source->source and the only apply primitive
// available to this lane. For each target we compute, from the ORIGINAL parse, a
// stable STRUCTURAL LOCATOR (the path of child-element indices from the document
// root). We then delete in REVERSE document order: removing a later element never
// changes the path of an earlier, not-yet-deleted element, so before each step we
// re-index the current source and re-resolve the target by its invariant path to
// get its CURRENT id. The per-step result composes the next step's input.
//
// Scope: batch DELETE of p / li / row plus the whole-block deletes table / ul|ol / fig
// (family 'delete', or family 'structural' whose op is a delete op), and batch in-place
// transforms that replace the selected element at the same structural path. Transforms
// that move nodes and non-delete structural ops are refused as not-yet-batch-executable
// (see LIMITATIONS at the bottom) rather than applied unsafely.
//
// Purity: never mutates the DocIndex it builds; each applyStructuralEdit call is the
// same corpus-noop-safe single delete used in production, so unrelated content stays
// byte-exact.

import { applyStructuralEdit, applyTransform, type TransformSpec } from '../cst/structural';
import type { StructuralOp, StructuralResult } from '../cst/structural';
import { childElements } from '../cst/query';
import { listNameForStyle, listStyle, type ListStyle } from '../cst/list-style';
import type { ElementNode } from '../cst/types';
import { indexDocument } from './validity';
import type { DocIndex } from './validity';
import { elementPath, resolveByPath, idOf } from './doc-path';
import { planMultiCommand } from './multi-command';
import type { MultiCommand, MultiCommandPlan, MultiPlanItem } from './multi-command';

/** The only ops this executor can batch today (all are pure element removals): the
 *  per-kind block deletes (p/li/row) plus the whole-block deletes (table/ul|ol/fig).
 *  Each composes the same reverse-order structural-path locator, since removing a later
 *  element never shifts an earlier, not-yet-deleted target's path. */
const BATCH_DELETE_OPS: ReadonlySet<string> = new Set([
  'deletePara',
  'deleteItem',
  'deleteRow',
  'deleteTable',
  'deleteList',
  'deleteFig',
]);
type BatchInPlaceTransform = Exclude<TransformSpec['transform'], 'paragraphToItem' | 'itemToParagraph'>;
const BATCH_IN_PLACE_TRANSFORMS: ReadonlySet<string> = new Set([
  'toOrderedList',
  'toUnorderedList',
  'toAlphabeticList',
  'paragraphToOrderedList',
  'paragraphToUnorderedList',
  'paragraphToAlphabeticList',
  'paragraphToSection',
  'paragraphToNote',
  'paragraphToCodeblock',
  'linesToParagraph',
  'linesToUnorderedList',
  'linesToOrderedList',
  'linesToAlphabeticList',
  'linesToSection',
  'linesToNote',
  'linesToCodeblock',
  'entryToParagraph',
  'entryToUnorderedList',
  'entryToOrderedList',
  'entryToAlphabeticList',
  'entryToLines',
  'entryToNote',
  'entryToCodeblock',
]);

function isBatchInPlaceTransform(op: unknown): op is BatchInPlaceTransform {
  return typeof op === 'string' && BATCH_IN_PLACE_TRANSFORMS.has(op);
}

type ParagraphToListTransform = 'paragraphToOrderedList' | 'paragraphToUnorderedList' | 'paragraphToAlphabeticList';

function isParagraphToListTransform(op: unknown): op is ParagraphToListTransform {
  return op === 'paragraphToOrderedList' || op === 'paragraphToUnorderedList' || op === 'paragraphToAlphabeticList';
}

function batchTransformSpec(transform: BatchInPlaceTransform, id: string): TransformSpec {
  switch (transform) {
    case 'toOrderedList':
    case 'toUnorderedList':
    case 'toAlphabeticList':
      return { transform, targetId: id };
    case 'paragraphToOrderedList':
      return { transform, paragraphId: id, listKind: 'ol' };
    case 'paragraphToUnorderedList':
      return { transform, paragraphId: id, listKind: 'ul' };
    case 'paragraphToAlphabeticList':
      return { transform, paragraphId: id, listKind: 'ol', listStyle: 'alpha' };
    case 'paragraphToSection':
      return { transform, paragraphId: id, blockKind: 'section' };
    case 'paragraphToNote':
      return { transform, paragraphId: id, blockKind: 'note' };
    case 'paragraphToCodeblock':
      return { transform, paragraphId: id, blockKind: 'codeblock' };
    case 'linesToParagraph':
      return { transform, linesId: id, blockKind: 'p' };
    case 'linesToUnorderedList':
      return { transform, linesId: id, blockKind: 'ul' };
    case 'linesToOrderedList':
      return { transform, linesId: id, blockKind: 'ol' };
    case 'linesToAlphabeticList':
      return { transform, linesId: id, blockKind: 'ol', listStyle: 'alpha' };
    case 'linesToSection':
      return { transform, linesId: id, blockKind: 'section' };
    case 'linesToNote':
      return { transform, linesId: id, blockKind: 'note' };
    case 'linesToCodeblock':
      return { transform, linesId: id, blockKind: 'codeblock' };
    case 'entryToParagraph':
      return { transform, entryId: id, wrapperKind: 'p' };
    case 'entryToUnorderedList':
      return { transform, entryId: id, wrapperKind: 'ul' };
    case 'entryToOrderedList':
      return { transform, entryId: id, wrapperKind: 'ol' };
    case 'entryToAlphabeticList':
      return { transform, entryId: id, wrapperKind: 'ol', listStyle: 'alpha' };
    case 'entryToLines':
      return { transform, entryId: id, wrapperKind: 'lines' };
    case 'entryToNote':
      return { transform, entryId: id, wrapperKind: 'note' };
    case 'entryToCodeblock':
      return { transform, entryId: id, wrapperKind: 'codeblock' };
  }
}

interface BatchTarget {
  order: number;
  path: number[];
}

interface ParagraphRun {
  order: number;
  targets: BatchTarget[];
}

function paragraphListTransformFor(items: MultiPlanItem[]): ParagraphToListTransform | null {
  let transform: ParagraphToListTransform | null = null;
  for (const it of items) {
    if (it.decision !== 'apply' || !isParagraphToListTransform(it.op)) return null;
    if (transform !== null && it.op !== transform) return null;
    transform = it.op;
  }
  return transform;
}

function reverseIds(idx: DocIndex): Map<ElementNode, string> {
  const rev = new Map<ElementNode, string>();
  for (const [id, el] of idx.byId) rev.set(el, id);
  return rev;
}

function paragraphRuns(items: MultiPlanItem[], idx: DocIndex): ParagraphRun[] {
  const rev = reverseIds(idx);
  const parents = new Set<ElementNode>();
  const targets = new Map<string, BatchTarget>();

  for (const it of items) {
    const el = idx.byId.get(it.id);
    if (!el) throw new Error(`selected target disappeared before execution: ${it.id}`);
    if (el.name !== 'p') throw new Error(`paragraph list batch target is <${el.name}>, not <p>`);
    if (!el.parent) throw new Error(`paragraph list batch target has no parent: ${it.id}`);
    parents.add(el.parent);
    targets.set(it.id, { order: it.order, path: elementPath(el, idx.doc) });
  }

  const runs: ParagraphRun[] = [];
  for (const parent of parents) {
    let run: BatchTarget[] = [];
    const flush = () => {
      if (run.length > 0) {
        runs.push({ order: Math.max(...run.map((target) => target.order)), targets: run });
        run = [];
      }
    };

    for (const child of childElements(parent)) {
      const id = rev.get(child);
      const target = id ? targets.get(id) : undefined;
      if (target) {
        run.push(target);
      } else {
        flush();
      }
    }
    flush();
  }

  return runs.sort((a, b) => b.order - a.order);
}

function nextListIdForParagraph(idx: DocIndex, p: ElementNode, style: ListStyle, path: number[]): string {
  if (p.name !== 'p') throw new Error(`resolved paragraph target is <${p.name}>, not <p>`);
  const parent = p.parent;
  if (!parent) throw new Error(`resolved paragraph target has no parent at path [${path.join(',')}]`);
  const siblings = childElements(parent);
  const next = siblings[siblings.indexOf(p) + 1];
  const kind = listNameForStyle(style);
  if (!next || next.name !== kind) {
    throw new Error(`expected following <${kind}> for paragraph target at path [${path.join(',')}]`);
  }
  if (listStyle(next) !== style) {
    throw new Error(`expected following ${style} list for paragraph target at path [${path.join(',')}]`);
  }
  const listId = idOf(idx, next);
  if (!listId) throw new Error(`no id for following <${kind}> at path [${path.join(',')}]`);
  return listId;
}

function paragraphListStyleForTransform(transform: ParagraphToListTransform): ListStyle {
  if (transform === 'paragraphToUnorderedList') return 'unordered';
  if (transform === 'paragraphToAlphabeticList') return 'alpha';
  return 'ordered';
}

function executeParagraphRunsAsLists(
  source: string,
  transform: ParagraphToListTransform,
  runs: ParagraphRun[],
): string {
  const style = paragraphListStyleForTransform(transform);
  let current = source;

  for (const run of runs) {
    for (let i = run.targets.length - 1; i >= 0; i--) {
      const target = run.targets[i];
      const idx = indexDocument(current);
      const el = resolveByPath(idx.doc, target.path);
      if (!el) throw new Error(`lost target at path [${target.path.join(',')}]`);
      const curId = idOf(idx, el);
      if (!curId) throw new Error(`no id for resolved target at path [${target.path.join(',')}]`);

      const res: StructuralResult = i === run.targets.length - 1
        ? applyTransform(current, batchTransformSpec(transform, curId))
        : applyTransform(current, {
          transform: 'paragraphToItem',
          paragraphId: curId,
          listId: nextListIdForParagraph(idx, el, style, target.path),
          position: 'prepend',
        });
      current = res.source;
    }
  }

  return current;
}

export type MultiExecRefusalCode =
  | 'empty' // nothing usable was selected
  | 'all-skipped' // the planner refused every id (stale / invalid / would-empty-container)
  | 'unsupported-family' // a supported plan, but its op(s) are not batch-executable yet
  | 'internal'; // a path target was lost mid-fold (invariant violation; original source kept)

export type MultiExecResult =
  | {
      ok: true;
      /** New document source after the batch. */
      source: string;
      /** The plan that drove execution (per-id apply/skip reasons). */
      plan: MultiCommandPlan;
      /** The original (pre-edit) ids that were deleted, in document order. */
      appliedIds: string[];
    }
  | {
      ok: false;
      /** The original source, unchanged — callers can treat ok/refused uniformly. */
      source: string;
      plan: MultiCommandPlan;
      refusal: { code: MultiExecRefusalCode; reason: string };
    };

/**
 * Plan and execute one command family across a multi-selection, returning a single
 * new source (ok) or a refusal. Pure: builds its own DocIndex from `source` and
 * never mutates caller state. See the module header for the reverse-order /
 * structural-path strategy.
 */
export function executeMultiCommand(
  source: string,
  command: MultiCommand,
  ids: string[],
): MultiExecResult {
  const idx0 = indexDocument(source);
  const plan = planMultiCommand(command, ids, idx0);

  if (plan.summary === 'empty') {
    return { ok: false, source, plan, refusal: { code: 'empty', reason: 'No elements selected' } };
  }
  if (plan.summary === 'all-skipped') {
    return {
      ok: false,
      source,
      plan,
      refusal: { code: 'all-skipped', reason: 'Every selected element was skipped (see plan items)' },
    };
  }

  const applyItems = plan.items.filter((it) => it.decision === 'apply');
  const allDelete = applyItems.length > 0 && applyItems.every((it) => BATCH_DELETE_OPS.has(String(it.op)));
  const allInPlaceTransform =
    applyItems.length > 0 && applyItems.every((it) => isBatchInPlaceTransform(it.op));
  if (!allDelete && !allInPlaceTransform) {
    return {
      ok: false,
      source,
      plan,
      refusal: {
        code: 'unsupported-family',
        reason:
          'Only batch deletion of blocks (<p>/<li>/<row>/<table>/<ul>/<ol>/<fig>) and in-place transforms are supported; transforms that move content and non-delete structural ops are not yet batch-executable',
      },
    };
  }

  const paragraphToListTransform = paragraphListTransformFor(applyItems);
  if (paragraphToListTransform) {
    try {
      return {
        ok: true,
        source: executeParagraphRunsAsLists(source, paragraphToListTransform, paragraphRuns(applyItems, idx0)),
        plan,
        appliedIds: plan.applyIds,
      };
    } catch (err) {
      return {
        ok: false,
        source,
        plan,
        refusal: { code: 'internal', reason: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // Stable locators from the ORIGINAL parse. Deletes fold in REVERSE document order
  // so each deletion leaves every earlier target's path intact. In-place transforms keep
  // the selected element at the same structural path, so document order is stable.
  const targets = applyItems.map((it) => ({
    order: it.order,
    op: it.op as StructuralOp | BatchInPlaceTransform,
    path: elementPath(idx0.byId.get(it.id)!, idx0.doc),
  }));
  targets.sort((a, b) => (allDelete ? b.order - a.order : a.order - b.order));

  let current = source;
  try {
    for (const t of targets) {
      const idx = indexDocument(current);
      const el = resolveByPath(idx.doc, t.path);
      if (!el) throw new Error(`lost target at path [${t.path.join(',')}]`);
      const curId = idOf(idx, el);
      if (!curId) throw new Error(`no id for resolved target at path [${t.path.join(',')}]`);
      const res: StructuralResult = allDelete
        ? applyStructuralEdit(current, t.op as StructuralOp, curId)
        : applyTransform(current, batchTransformSpec(t.op as BatchInPlaceTransform, curId));
      current = res.source;
    }
  } catch (err) {
    // Invariant violation: discard the partial fold, keep the original source.
    return {
      ok: false,
      source,
      plan,
      refusal: { code: 'internal', reason: err instanceof Error ? err.message : String(err) },
    };
  }

  return { ok: true, source: current, plan, appliedIds: plan.applyIds };
}

// LIMITATIONS (deliberate, documented for the future canvas/PM lane):
//   • Batch transforms are limited to in-place replacements. paragraphToItem /
//     itemToParagraph and non-delete structural ops (addRowAfter, merge*, split/join,
//     column edits) are refused 'unsupported-family'. Those transforms restructure the
//     tree (absorb a <p> into a list, lift a <li> out), so the reverse-order /
//     structural-path invariant used for deletes does not transfer unchanged — they need
//     their own executor design.
//   • applyIds are honoured exactly as planned; the would-empty-container guard lives
//     in planMultiCommand, so the executor never has to re-derive occurrence rules.
//   • This composes applyStructuralEdit N times (N = selection size), one parse per
//     step. Correct and unrelated-content-preserving, but O(N parses). A true single-
//     parse batch mutator would belong in src/cst/structural.ts (out of this lane's
//     scope) and is a perf-only optimization, not a correctness need.
