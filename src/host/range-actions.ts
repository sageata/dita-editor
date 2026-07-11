import { executeCellClear, executeCellRectMerge, executeCellTextReplace, executeRangeDelete } from '../commands/range-executor';
import { planCellClear, planCellRectMerge, planRangeDelete, type RangeActionType } from '../commands/range-ops';
import { executeMultiCommand } from '../commands/multi-executor';
import { planMultiCommand, type MultiCommandPlan } from '../commands/multi-command';
import type { RangeActionAvailability, RangeSelectionPayload } from '../webview/canvas-messages';
import { childElements } from '../cst/query';
import type { ElementNode } from '../cst/types';
import { indexDocument, type DocIndex } from '../commands/validity';

export interface RangeActionDocument {
  getText(): string;
}

export interface RangeActionContext {
  document: RangeActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  clearDiagnostics(): void;
  postRangeAvailability(forIds: string[], actions: RangeActionAvailability[]): void;
}

type HostRangeActionResult =
  | { ok: true; action: RangeActionType; source: string }
  | { ok: false; action: RangeActionType; source: string; refusal: { code: string; reason: string } };

const RANGE_DELETE_FALLBACK_CODES = new Set(['mixed-kind', 'cross-parent']);

function reverseIds(idx: DocIndex): Map<ElementNode, string> {
  const rev = new Map<ElementNode, string>();
  for (const [id, el] of idx.byId) rev.set(el, id);
  return rev;
}

function orderPositions(idx: DocIndex): Map<string, number> {
  const pos = new Map<string, number>();
  let i = 0;
  for (const id of idx.byId.keys()) pos.set(id, i++);
  return pos;
}

function isDescendantOf(el: ElementNode, ancestor: ElementNode): boolean {
  let cur: ElementNode | null | undefined = el.parent;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function normalizeRangeDeleteIds(ids: string[], idx: DocIndex): string[] {
  const rev = reverseIds(idx);
  const order = orderPositions(idx);
  const selected = new Set(ids.filter((id) => idx.byId.has(id)));

  for (const [listId, list] of idx.byId) {
    if (list.name !== 'ul' && list.name !== 'ol') continue;
    const items = childElements(list).filter((child) => child.name === 'li');
    if (items.length === 0) continue;
    if (items.every((item) => selected.has(rev.get(item) as string))) {
      for (const item of items) selected.delete(rev.get(item) as string);
      selected.add(listId);
    }
  }

  const sorted = [...selected].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
  const kept: string[] = [];
  for (const id of sorted) {
    const el = idx.byId.get(id);
    if (!el) continue;
    if (kept.some((ancestorId) => isDescendantOf(el, idx.byId.get(ancestorId)!))) continue;
    kept.push(id);
  }
  return kept;
}

function rangeDeleteFallbackRefusal(
  plan: MultiCommandPlan,
  expectedIds: string[],
): { code: 'empty' | 'deletes-whole-container' | 'not-deletable-kind'; reason: string } | null {
  if (expectedIds.length === 0 || plan.summary === 'empty') {
    return { code: 'empty', reason: 'Nothing is selected' };
  }
  const skipped = plan.items.find((item) => item.decision !== 'apply');
  if (!skipped && plan.applyIds.length === expectedIds.length) return null;
  if (skipped?.code === 'would-empty-container') {
    return {
      code: 'deletes-whole-container',
      reason: skipped.reason ?? 'Cannot delete every item in its container',
    };
  }
  return {
    code: 'not-deletable-kind',
    reason: skipped?.reason ?? 'One selected element cannot be deleted safely',
  };
}

function rangeDeleteAvailability(ids: string[], idx: DocIndex): RangeActionAvailability {
  const strict = planRangeDelete(ids, idx);
  if (strict.ok) return { action: 'rangeDelete', enabled: true };
  if (!RANGE_DELETE_FALLBACK_CODES.has(strict.code)) {
    return { action: 'rangeDelete', enabled: false, code: strict.code, reason: strict.reason };
  }

  const normalized = normalizeRangeDeleteIds(ids, idx);
  const plan = planMultiCommand({ family: 'delete' }, normalized, idx);
  const refusal = rangeDeleteFallbackRefusal(plan, normalized);
  return refusal
    ? { action: 'rangeDelete', enabled: false, code: refusal.code, reason: refusal.reason }
    : { action: 'rangeDelete', enabled: true };
}

export function queryRangeActions(ctx: RangeActionContext, selection: RangeSelectionPayload): void {
  try {
    const idx = indexDocument(ctx.document.getText());
    const actions: RangeActionAvailability[] = [];
    actions.push(rangeDeleteAvailability(selection.ids, idx));
    const m = planCellRectMerge(selection.ids, idx);
    if (!m.ok) {
      actions.push({ action: 'cellRectMerge', enabled: false, code: m.code, reason: m.reason });
    } else if (m.cellIds.length !== m.span.cols * m.span.rows) {
      // Mirror executeCellRectMerge's prespanned guard, so availability never enables a button
      // the executor would refuse (an interior already-merged cell).
      actions.push({
        action: 'cellRectMerge',
        enabled: false,
        code: 'unsupported-prespanned',
        reason: 'Rectangle contains an already-merged cell',
      });
    } else {
      actions.push({ action: 'cellRectMerge', enabled: true });
    }
    const c = planCellClear(selection.ids, idx);
    actions.push(
      c.ok
        ? { action: 'cellClear', enabled: true }
        : { action: 'cellClear', enabled: false, code: c.code, reason: c.reason },
    );
    ctx.postRangeAvailability(selection.ids, actions);
  } catch (err) {
    console.warn('dita-editor: rangeQuery failed', err); // no reply -> canvas keeps "checking…"
  }
}

export async function executeRangeAction(
  ctx: RangeActionContext,
  action: RangeActionType,
  ids: string[],
  values?: string[],
): Promise<void> {
  const source = ctx.document.getText();
  const result: HostRangeActionResult = action === 'rangeDelete'
    ? executeHostRangeDelete(source, ids)
    : action === 'cellClear'
        ? executeCellClear(source, ids)
        : action === 'cellTextReplace'
          ? executeCellTextReplace(source, ids, values ?? [])
          : executeCellRectMerge(source, ids);
  if (result.ok) {
    // The executor composed every sub-op into one source; apply it as ONE WorkspaceEdit
    // (atomic, single undo), then rerender + push the fresh navMap/cmdMap.
    if (await ctx.applyMinimal(result.source)) {
      ctx.clearDiagnostics();
      ctx.pushBody(null, null);
      ctx.announce(rangeSuccessMessage(result.action, ids.length));
    }
  } else {
    // Refused -> executor returned the ORIGINAL source, nothing applied (byte-noop);
    // announce the reason. The DOM is unchanged, so no rerender.
    ctx.announce(rangeRefusalMessage(result.refusal));
  }
}

function executeHostRangeDelete(source: string, ids: string[]): HostRangeActionResult {
  const strict = executeRangeDelete(source, ids);
  if (strict.ok || !RANGE_DELETE_FALLBACK_CODES.has(strict.refusal.code)) return strict;
  const idx = indexDocument(source);
  const normalized = normalizeRangeDeleteIds(ids, idx);
  const plan = planMultiCommand({ family: 'delete' }, normalized, idx);
  const refusal = rangeDeleteFallbackRefusal(plan, normalized);
  if (refusal) {
    return {
      ok: false,
      action: 'rangeDelete',
      source,
      refusal,
    };
  }
  const multi = executeMultiCommand(source, { family: 'delete' }, normalized);
  if (multi.ok) {
    return { ok: true, action: 'rangeDelete', source: multi.source };
  }
  return {
    ok: false,
    action: 'rangeDelete',
    source,
    refusal: { code: strict.refusal.code, reason: strict.refusal.reason },
  };
}

export function rangeSuccessMessage(action: RangeActionType, count: number): string {
  const n = Math.max(1, count);
  switch (action) {
    case 'rangeDelete':
      return n === 1 ? 'Item deleted.' : `${n} items deleted.`;
    case 'cellRectMerge':
      return 'Cells merged.';
    case 'cellClear':
      return n === 1 ? 'Cell cleared.' : `${n} cells cleared.`;
    case 'cellTextReplace':
      return n === 1 ? 'Cell updated.' : `${n} cells updated.`;
  }
}

// P1-1: a readable AT announcement for a refused range action. Most codes are pre-filtered by the
// canvas (it only forms a clean contiguous run / rectangle), so the realistic refusals at execute
// time are deletes-whole-container, unsupported-prespanned and stale-id races. Falls back to the
// planner's own `reason` for any other code.
export function rangeRefusalMessage(refusal: { code: string; reason: string }): string {
  switch (refusal.code) {
    case 'deletes-whole-container':
      return "Can't delete every item in its container.";
    case 'unsupported-prespanned':
      return 'This selection includes an already-merged cell.';
    case 'not-rectangular':
      return 'Select a complete rectangle to merge.';
    case 'too-few-cells':
      return 'Select at least two cells to merge.';
    case 'not-clearable-cell':
      return 'One selected cell cannot be changed safely.';
    case 'value-count-mismatch':
      return 'The pasted cell data did not match the selected cells.';
    case 'internal':
      return "Couldn't complete that edit; nothing was changed.";
    default:
      return refusal.reason || "That action isn't available for this selection.";
  }
}
