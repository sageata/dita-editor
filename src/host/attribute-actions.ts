import { attrValueError } from '../commands/attr-validity';
import { removeAttrs, setAttr } from '../cst/edit';
import { findElementById } from '../cst/element-ids';
import { parse } from '../cst/parse';
import { serialize } from '../cst/serialize';
import { childrenNamed } from '../cst/query';
import type { Document, ElementNode } from '../cst/types';

export interface AttributeActionDocument {
  getText(): string;
}

export interface AttributeActionContext {
  document: AttributeActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  postError(message: string): void;
  clearDiagnostics(): void;
}

// Properties panel: set or clear one DITA attribute on the focused element. setAttr splices
// only the value span (byte-minimal); an empty value removes the attribute. Re-renders so the
// fresh attrMap re-populates the panel. Touches no block structure (structVersion unchanged).
export async function applyElementAttribute(
  ctx: AttributeActionContext,
  id: string,
  attrName: string,
  attrValue: string,
): Promise<void> {
  const reason = attrValueError(attrName, attrValue);
  if (reason) {
    ctx.announce(reason);
    ctx.postError(reason);
    return; // invalid -> no bytes change
  }

  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }

  const el = findElementById(doc, id);
  if (!el) {
    ctx.pushBody(null, null); // stale id -> resync
    return;
  }

  const has = el.attrs.some((a) => a.name === attrName);
  if (attrValue === '') {
    if (!has) return; // clearing an absent attribute is a no-op
    removeAttrs(el, [attrName], source);
  } else {
    setAttr(el, attrName, attrValue, source);
  }

  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(id, null);
    ctx.announce(`${attrName} ${attrValue === '' ? 'cleared' : 'updated'}.`);
  }
}

/** Apply one attribute set/clear to SEVERAL elements (a cell-rect selection) in
 *  ONE parse → mutate → applyMinimal round trip, so the edit is a single undo
 *  step. Stale/unknown ids are skipped; if none resolve the canvas is resynced. */
export async function applyElementAttributeToIds(
  ctx: AttributeActionContext,
  ids: string[],
  attrName: string,
  attrValue: string,
): Promise<void> {
  const reason = attrValueError(attrName, attrValue);
  if (reason) {
    ctx.announce(reason);
    ctx.postError(reason);
    return;
  }

  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }

  let touched = 0;
  let firstId: string | null = null;
  for (const id of ids) {
    const el = findElementById(doc, id);
    if (!el) continue;
    const has = el.attrs.some((a) => a.name === attrName);
    if (attrValue === '') {
      if (!has) continue;
      removeAttrs(el, [attrName], source);
    } else {
      setAttr(el, attrName, attrValue, source);
    }
    touched += 1;
    if (!firstId) firstId = id;
  }
  if (ids.length && touched === 0 && !ids.some((id) => findElementById(doc, id))) {
    ctx.pushBody(null, null); // every id was stale -> resync
    return;
  }
  if (touched === 0) return; // e.g. clearing an attr nothing carries

  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(firstId, null);
    ctx.announce(`${attrName} ${attrValue === '' ? 'cleared' : 'updated'} on ${touched} element${touched === 1 ? '' : 's'}.`);
  }
}

/** Set/clear attributes on a table's <tgroup> (table-wide colsep/rowsep defaults).
 *  The tgroup is deliberately unstamped (element-ids), so the message targets the
 *  TABLE id and the host descends one level. One applyMinimal for all attrs. */
export async function applyTgroupAttributes(
  ctx: AttributeActionContext,
  tableId: string,
  attrs: Array<{ name: string; value: string }>,
): Promise<void> {
  for (const a of attrs) {
    const reason = attrValueError(a.name, a.value);
    if (reason) {
      ctx.announce(reason);
      ctx.postError(reason);
      return;
    }
  }

  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }

  const table = findElementById(doc, tableId);
  const tgroup: ElementNode | undefined =
    table && table.name === 'table' ? childrenNamed(table, 'tgroup')[0] : undefined;
  if (!tgroup) {
    ctx.pushBody(null, null);
    return;
  }

  let touched = 0;
  for (const a of attrs) {
    const has = tgroup.attrs.some((x) => x.name === a.name);
    if (a.value === '') {
      if (!has) continue;
      removeAttrs(tgroup, [a.name], source);
    } else {
      setAttr(tgroup, a.name, a.value, source);
    }
    touched += 1;
  }
  if (touched === 0) return;

  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(tableId, null);
    ctx.announce('Table grid lines updated.');
  }
}
