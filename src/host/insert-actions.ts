import {
  applyInsert,
  type InsertKind,
  type InsertResult,
} from '../commands/insert-ops';
import type { InsertPayload } from '../webview/canvas-messages';

export interface InsertActionDocument {
  getText(): string;
}

export interface InsertActionContext {
  document: InsertActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  clearDiagnostics(): void;
  setRefusedDiagnostic(op: string): void;
  bumpStructVersion(): void;
}

const INSERT_SUCCESS: Record<InsertKind, string> = {
  paragraph: 'Paragraph inserted.',
  lines: 'Lines block inserted.',
  unorderedList: 'Bulleted list inserted.',
  alphabeticList: 'Alphabetic list inserted.',
  orderedList: 'Numbered list inserted.',
  listItem: 'List item inserted.',
  table: 'Table inserted.',
  note: 'Note inserted.',
  codeblock: 'Code block inserted.',
  section: 'Section inserted.',
};

function insertRefusalMessage(err: unknown): string {
  const reason = err instanceof Error && err.message ? err.message : 'That insert is not available in this position.';
  if (/^insert (reference|container) (not found|has no container):/.test(reason)) {
    return 'That insert target is no longer available. Select the element again and retry.';
  }
  return reason;
}

export async function applyInsertAction(
  ctx: InsertActionContext,
  op: InsertKind,
  payload: InsertPayload,
): Promise<void> {
  let result: InsertResult;
  try {
    result = applyInsert(ctx.document.getText(), op, payload, { table: payload.table });
  } catch (err) {
    console.warn('dita-editor: insert refused/stale, resyncing', err);
    ctx.setRefusedDiagnostic(op);
    ctx.announce(insertRefusalMessage(err));
    ctx.pushBody(null, null); // stale id or content-model refusal -> resync, no write
    return;
  }

  const ok = await ctx.applyMinimal(result.source);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(result.focusId, result.caretOffset);
    ctx.announce(INSERT_SUCCESS[op]);
  }
}
