import {
  applyStructuralEdit,
  applyTransform,
  type StructuralOp,
  type StructuralPayload,
  type StructuralResult,
  type TransformSpec,
} from '../cst/structural';
import { indexDocument } from '../commands/validity';
import { planTransform, type TransformIntent, type TransformType } from '../commands/transform-ops';
import { executeMultiCommand } from '../commands/multi-executor';
import { resolveTransformFocus } from '../webview/state-maps';
import type { ApplyMinimalHistory } from './action-contexts';

export interface StructuralActionDocument {
  getText(): string;
}

export interface StructuralActionContext {
  document: StructuralActionDocument;
  applyMinimal(newSource: string, history?: ApplyMinimalHistory): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  postError(message: string): void;
  clearDiagnostics(): void;
  setRefusedDiagnostic(op: string): void;
  getStructVersion(): number;
  bumpStructVersion(): void;
}

function isStale(ctx: StructuralActionContext, baseStructVersion: number | undefined): boolean {
  if (typeof baseStructVersion !== 'number') return false;
  if (baseStructVersion === ctx.getStructVersion()) return false;
  ctx.pushBody(null, null);
  return true;
}

const TRANSFORM_SUCCESS: Record<TransformType, string> = {
  toOrderedList: 'List converted to numbered list.',
  toUnorderedList: 'List converted to bulleted list.',
  toAlphabeticList: 'List converted to alphabetic list.',
  paragraphToOrderedList: 'Paragraph converted to numbered list.',
  paragraphToUnorderedList: 'Paragraph converted to bulleted list.',
  paragraphToAlphabeticList: 'Paragraph converted to alphabetic list.',
  paragraphToSection: 'Paragraph converted to section.',
  paragraphToNote: 'Paragraph converted to note.',
  paragraphToCodeblock: 'Paragraph converted to code block.',
  linesToParagraph: 'Lines converted to paragraph.',
  linesToUnorderedList: 'Lines converted to bulleted list.',
  linesToOrderedList: 'Lines converted to numbered list.',
  linesToAlphabeticList: 'Lines converted to alphabetic list.',
  linesToSection: 'Lines converted to section.',
  linesToNote: 'Lines converted to note.',
  linesToCodeblock: 'Lines converted to code block.',
  entryToParagraph: 'Cell content converted to paragraph.',
  entryToUnorderedList: 'Cell content converted to bulleted list.',
  entryToOrderedList: 'Cell content converted to numbered list.',
  entryToAlphabeticList: 'Cell content converted to alphabetic list.',
  entryToLines: 'Cell content converted to lines.',
  entryToNote: 'Cell content converted to note.',
  entryToCodeblock: 'Cell content converted to code block.',
  paragraphToItem: 'Paragraph converted to list item.',
  itemToParagraph: 'List item converted to paragraph.',
};

export function transformIntentSpec(intent: TransformIntent, sourceFocusId?: string): TransformSpec {
  switch (intent.transform) {
    case 'toOrderedList':
    case 'toUnorderedList':
    case 'toAlphabeticList':
      return { transform: intent.transform, targetId: intent.targetId, focusId: sourceFocusId, listStyle: intent.listStyle };
    case 'paragraphToItem':
      return {
        transform: 'paragraphToItem',
        paragraphId: intent.paragraphId,
        listId: intent.listId,
        mergeListId: intent.mergeListId,
        position: intent.position,
      };
    case 'paragraphToOrderedList':
    case 'paragraphToUnorderedList':
    case 'paragraphToAlphabeticList':
      return { transform: intent.transform, paragraphId: intent.paragraphId, listKind: intent.listKind, listStyle: intent.listStyle };
    case 'paragraphToSection':
    case 'paragraphToNote':
    case 'paragraphToCodeblock':
      return { transform: intent.transform, paragraphId: intent.paragraphId, blockKind: intent.blockKind };
    case 'linesToParagraph':
    case 'linesToUnorderedList':
    case 'linesToOrderedList':
    case 'linesToAlphabeticList':
    case 'linesToSection':
    case 'linesToNote':
    case 'linesToCodeblock':
      return { transform: intent.transform, linesId: intent.linesId, blockKind: intent.blockKind, listStyle: intent.listStyle };
    case 'entryToParagraph':
    case 'entryToUnorderedList':
    case 'entryToOrderedList':
    case 'entryToAlphabeticList':
    case 'entryToLines':
    case 'entryToNote':
    case 'entryToCodeblock':
      return { transform: intent.transform, entryId: intent.entryId, wrapperKind: intent.wrapperKind, listStyle: intent.listStyle };
    case 'itemToParagraph':
      return { transform: 'itemToParagraph', itemId: intent.itemId, mode: intent.mode };
  }
}

function multiTransformSuccess(transform: TransformType, count: number): string {
  if (count === 1) return TRANSFORM_SUCCESS[transform];
  switch (transform) {
    case 'toOrderedList':
      return `${count} lists converted to numbered lists.`;
    case 'toUnorderedList':
      return `${count} lists converted to bulleted lists.`;
    case 'toAlphabeticList':
      return `${count} lists converted to alphabetic lists.`;
    case 'paragraphToOrderedList':
      return `${count} paragraphs converted to numbered lists.`;
    case 'paragraphToUnorderedList':
      return `${count} paragraphs converted to bulleted lists.`;
    case 'paragraphToAlphabeticList':
      return `${count} paragraphs converted to alphabetic lists.`;
    case 'paragraphToSection':
      return `${count} paragraphs converted to sections.`;
    case 'paragraphToNote':
      return `${count} paragraphs converted to notes.`;
    case 'paragraphToCodeblock':
      return `${count} paragraphs converted to code blocks.`;
    case 'linesToParagraph':
      return `${count} lines blocks converted to paragraphs.`;
    case 'linesToUnorderedList':
      return `${count} lines blocks converted to bulleted lists.`;
    case 'linesToOrderedList':
      return `${count} lines blocks converted to numbered lists.`;
    case 'linesToAlphabeticList':
      return `${count} lines blocks converted to alphabetic lists.`;
    case 'linesToSection':
      return `${count} lines blocks converted to sections.`;
    case 'linesToNote':
      return `${count} lines blocks converted to notes.`;
    case 'linesToCodeblock':
      return `${count} lines blocks converted to code blocks.`;
    case 'entryToParagraph':
      return `${count} cells converted to paragraphs.`;
    case 'entryToUnorderedList':
      return `${count} cells converted to bulleted lists.`;
    case 'entryToOrderedList':
      return `${count} cells converted to numbered lists.`;
    case 'entryToAlphabeticList':
      return `${count} cells converted to alphabetic lists.`;
    case 'entryToLines':
      return `${count} cells converted to lines.`;
    case 'entryToNote':
      return `${count} cells converted to notes.`;
    case 'entryToCodeblock':
      return `${count} cells converted to code blocks.`;
    case 'paragraphToItem':
    case 'itemToParagraph':
      return `${count} selected elements transformed.`;
  }
}

function multiTransformRefusalMessage(
  transform: TransformType,
  result: Extract<ReturnType<typeof executeMultiCommand>, { ok: false }>,
): string {
  if (result.refusal.code === 'all-skipped') {
    if (result.plan.items.length > 0 && result.plan.items.every((item) => item.code === 'noop')) {
      return transform === 'toOrderedList'
        ? 'Selected lists are already numbered.'
        : transform === 'toUnorderedList'
          ? 'Selected lists are already bulleted.'
          : transform === 'toAlphabeticList'
            ? 'Selected lists are already alphabetic.'
          : 'The selected elements are already in that form.';
    }
    const firstReason = result.plan.items.find((item) => item.reason)?.reason;
    if (firstReason) return firstReason;
  }
  if (result.refusal.code === 'internal') return "Couldn't complete that edit; nothing was changed.";
  if (result.refusal.code === 'unsupported-family') return 'That transform is not available for multi-selection yet.';
  return result.refusal.reason || 'That transform is not available for this selection.';
}

export async function applyStructuralAction(
  ctx: StructuralActionContext,
  op: StructuralOp,
  id: string,
  payload: StructuralPayload,
  baseStructVersion: number | undefined,
  announceOnSuccess?: string,
): Promise<void> {
  // Reject a structural op built against a superseded render cycle: its positional
  // ids no longer match the document. Resync instead so the next gesture is fresh.
  if (isStale(ctx, baseStructVersion)) return;

  let result: StructuralResult;
  try {
    result = applyStructuralEdit(ctx.document.getText(), op, id, payload);
  } catch (err) {
    console.warn('dita-editor: structural op refused/stale, resyncing', err);
    ctx.setRefusedDiagnostic(op);
    const reason = err instanceof Error && err.message ? err.message : "That action isn't available here.";
    ctx.announce(reason);
    ctx.postError(reason);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(result.source, {
    beforeFocusId: id,
    beforeCaretOffset: null,
    afterFocusId: result.focusId,
    afterCaretOffset: result.caretOffset,
  });
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(result.focusId, result.caretOffset);
    if (announceOnSuccess) ctx.announce(announceOnSuccess);
  }
}

export async function applyTransformAction(
  ctx: StructuralActionContext,
  transform: TransformType,
  id: string,
): Promise<void> {
  const before = ctx.document.getText();
  const idx = indexDocument(before);
  const focus = resolveTransformFocus(transform, id, idx);
  const intent = planTransform(transform, focus, idx);
  if (intent.status !== 'ok') {
    ctx.setRefusedDiagnostic(transform);
    ctx.announce(intent.reason ?? 'That transform is not available in this position.');
    ctx.pushBody(null, null);
    return;
  }

  let result: StructuralResult;
  try {
    result = applyTransform(before, transformIntentSpec(intent, id));
  } catch (err) {
    console.warn('dita-editor: transform refused/stale, resyncing', err);
    ctx.setRefusedDiagnostic(transform);
    ctx.announce('That transform is not available in this position.');
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(result.source, {
    beforeFocusId: id,
    beforeCaretOffset: null,
    afterFocusId: result.focusId,
    afterCaretOffset: result.caretOffset,
  });
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(result.focusId, result.caretOffset);
    ctx.announce(TRANSFORM_SUCCESS[transform]);
  }
}

export async function applyMultiTransformAction(
  ctx: StructuralActionContext,
  transform: TransformType,
  ids: string[],
  baseStructVersion: number | undefined,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  const before = ctx.document.getText();
  const idx = indexDocument(before);
  const targetIds = ids
    .map((id) => resolveTransformFocus(transform, id, idx).id)
    .filter((id): id is string => typeof id === 'string');
  const result = executeMultiCommand(before, { family: 'transform', transform }, targetIds);

  if (!result.ok) {
    ctx.setRefusedDiagnostic(transform);
    ctx.announce(multiTransformRefusalMessage(transform, result));
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(result.source);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(null, null);
    ctx.announce(multiTransformSuccess(transform, result.appliedIds.length));
  }
}
