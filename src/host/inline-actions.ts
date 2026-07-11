import { applyInlineHtmlEdit, applyTextEdit } from '../cst/edit-bridge';
import {
  applyInlineFormat,
  applyInlineFormatBlocks,
  applyInlineInsert,
  removeInlineFormat,
  removeInlineFormatBlocks,
  type InlineInsertSpec,
} from '../cst/inline-edit';

export type { InlineInsertSpec } from '../cst/inline-edit';

export interface InlineActionDocument {
  getText(): string;
}

export interface InlineActionContext {
  document: InlineActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  clearDiagnostics(): void;
  getStructVersion(): number;
  bumpStructVersion(): void;
}

export interface InlineInsertResolution {
  spec: InlineInsertSpec;
  successAnnouncement?: string;
}

export type InlineInsertResolver = () => Promise<InlineInsertResolution | null>;

function isStale(ctx: InlineActionContext, baseStructVersion: number | undefined): boolean {
  if (typeof baseStructVersion !== 'number') return false;
  if (baseStructVersion === ctx.getStructVersion()) return false;
  ctx.pushBody(null, null);
  return true;
}

function caretAfterSelection(before: string, mid: string): number {
  return before.length + mid.length;
}

function restoreCaretOffset(before: string, mid: string, after: string, offset?: number): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return caretAfterSelection(before, mid);
  return Math.max(0, Math.min(offset, before.length + mid.length + after.length));
}

export async function editInlineText(
  ctx: InlineActionContext,
  id: string,
  text: string,
  html: string | null,
): Promise<void> {
  let newSource: string;
  try {
    newSource =
      html !== null
        ? applyInlineHtmlEdit(ctx.document.getText(), id, html)
        : applyTextEdit(ctx.document.getText(), id, text);
  } catch (err) {
    console.warn('dita-editor: stale text-edit id, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) ctx.clearDiagnostics();
}

export async function formatInlineBlocks(
  ctx: InlineActionContext,
  ids: string[],
  op: string,
  baseStructVersion: number | undefined,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  let newSource: string;
  try {
    newSource = applyInlineFormatBlocks(ctx.document.getText(), ids, op);
  } catch (err) {
    console.warn('dita-editor: inline-multi refused/stale, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(null, null);
  }
}

export async function removeInlineStylesFromBlocks(
  ctx: InlineActionContext,
  ids: string[],
  baseStructVersion: number | undefined,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  let newSource: string;
  try {
    newSource = removeInlineFormatBlocks(ctx.document.getText(), ids);
  } catch (err) {
    console.warn('dita-editor: remove-styles refused/stale, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(null, null);
  }
}

export async function formatInlineSelection(
  ctx: InlineActionContext,
  id: string,
  op: string,
  before: string,
  mid: string,
  after: string,
  baseStructVersion: number | undefined,
  caretOffset?: number,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  let newSource: string;
  try {
    newSource = applyInlineFormat(ctx.document.getText(), id, op, before, mid, after);
  } catch (err) {
    console.warn('dita-editor: inline-format refused/stale, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(id, restoreCaretOffset(before, mid, after, caretOffset));
  }
}

export async function removeInlineStylesFromSelection(
  ctx: InlineActionContext,
  id: string,
  before: string,
  mid: string,
  after: string,
  baseStructVersion: number | undefined,
  caretOffset?: number,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  let newSource: string;
  try {
    newSource = removeInlineFormat(ctx.document.getText(), id, before, mid, after);
  } catch (err) {
    console.warn('dita-editor: remove-styles refused/stale, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(id, restoreCaretOffset(before, mid, after, caretOffset));
  }
}

export async function insertInlineElement(
  ctx: InlineActionContext,
  id: string,
  before: string,
  after: string,
  baseStructVersion: number | undefined,
  resolveInsert: InlineInsertResolver,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  const resolved = await resolveInsert();
  if (!resolved) return;

  let newSource: string;
  try {
    newSource = applyInlineInsert(ctx.document.getText(), id, before, after, resolved.spec);
  } catch (err) {
    console.warn('dita-editor: inline-insert refused/stale, resyncing', err);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(newSource);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(id, null);
    if (resolved.successAnnouncement) ctx.announce(resolved.successAnnouncement);
  }
}
