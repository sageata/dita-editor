import { applyTableColumnWidths } from '../cst/table-column-widths';
import type { ApplyMinimalHistory } from './action-contexts';

export interface TableColumnWidthActionDocument {
  getText(): string;
}

export interface TableColumnWidthActionContext {
  document: TableColumnWidthActionDocument;
  applyMinimal(newSource: string, history?: ApplyMinimalHistory): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  postError(message: string): void;
  clearDiagnostics(): void;
  getStructVersion(): number;
}

function isStale(ctx: TableColumnWidthActionContext, baseStructVersion: number | undefined): boolean {
  if (typeof baseStructVersion !== 'number') return false;
  if (baseStructVersion === ctx.getStructVersion()) return false;
  ctx.pushBody(null, null);
  return true;
}

export async function applyTableColumnWidthAction(
  ctx: TableColumnWidthActionContext,
  tableId: string,
  widths: number[],
  baseStructVersion?: number,
): Promise<void> {
  if (isStale(ctx, baseStructVersion)) return;

  const source = ctx.document.getText();
  let nextSource: string;
  try {
    nextSource = applyTableColumnWidths(source, tableId, widths);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Column widths could not be updated.';
    ctx.announce(message);
    ctx.postError(message);
    return;
  }

  if (nextSource === source) return;
  const ok = await ctx.applyMinimal(nextSource);
  if (!ok) return;
  ctx.clearDiagnostics();
  ctx.pushBody(null, null);
  ctx.announce('Column widths updated.');
}
