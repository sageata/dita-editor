import { applyLineBreakEdit } from '../cst/line-break-edit';

export interface LineBreakActionDocument {
  getText(): string;
}

export interface LineBreakActionContext {
  document: LineBreakActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  clearDiagnostics(): void;
  setRefusedDiagnostic(op: string): void;
  announce(message: string): void;
  bumpStructVersion(): void;
}

export async function applyLineBreakAction(
  ctx: LineBreakActionContext,
  id: string,
  text: string,
  caretOffset: number | undefined,
): Promise<void> {
  let result;
  try {
    result = applyLineBreakEdit(ctx.document.getText(), id, text, caretOffset);
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : 'That line break is not available here.';
    ctx.setRefusedDiagnostic('lineBreak');
    ctx.announce(reason);
    ctx.pushBody(null, null);
    return;
  }

  const ok = await ctx.applyMinimal(result.source);
  if (ok) {
    ctx.clearDiagnostics();
    ctx.bumpStructVersion();
    ctx.pushBody(result.focusId, result.caretOffset);
  }
}
