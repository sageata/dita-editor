// Pure host-side bridge between a webview edit and a minimal document edit.
// Kept free of vscode so it is unit-testable; the extension turns the returned
// span into a vscode.WorkspaceEdit.

import { parse } from './parse';
import { serialize } from './serialize';
import { markDirty, setElementText, setText } from './edit';
import { findEditableById, isInlinePhrase } from './text-targets';
import { findElementById } from './element-ids';
import { htmlInlineToCst } from './html-inline';

/** Apply a text edit (by stable id) and return the full new source. The
 *  serializer slices every untouched node verbatim, so only the edited leaf's
 *  bytes change. Throws if the id no longer resolves (caller should re-render).
 *
 *  Two id shapes:
 *   - `eN`         — a whole text-only/empty editable element (setElementText).
 *   - `eN:t<idx>`  — one direct text/phrase run inside a block-mixed parent: edit only
 *                    that child run so nested block children survive verbatim. */
export function applyTextEdit(source: string, editId: string, newDecodedText: string): string {
  const doc = parse(source);
  const sep = editId.indexOf(':t');
  if (sep !== -1) {
    const parent = findElementById(doc, editId.slice(0, sep));
    const child = parent?.children[Number(editId.slice(sep + 2))];
    if (!parent || !child) {
      throw new Error(`text-run target not found: ${editId}`);
    }
    if (child.type === 'text') {
      setText(child, newDecodedText);
    } else if (child.type === 'element' && isInlinePhrase(child.name) && child.children.every((c) => c.type === 'text')) {
      setElementText(child, newDecodedText);
    } else {
      throw new Error(`text-run target not found: ${editId}`);
    }
    return serialize(doc);
  }
  const el = findEditableById(doc, editId);
  if (!el) throw new Error(`edit target not found: ${editId}`);
  setElementText(el, newDecodedText);
  return serialize(doc);
}

export function applyInlineHtmlEdit(source: string, editId: string, html: string): string {
  const doc = parse(source);
  const sep = editId.indexOf(':t');
  let el = findEditableById(doc, editId);
  if (!el && sep !== -1) {
    const parent = findElementById(doc, editId.slice(0, sep));
    const child = parent?.children[Number(editId.slice(sep + 2))];
    if (child?.type === 'element' && isInlinePhrase(child.name)) el = child;
  }
  if (!el) throw new Error(`html edit target not found: ${editId}`);
  const children = htmlInlineToCst(html);
  for (const child of children) child.parent = el;
  el.children = children;
  el.selfClosing = false;
  markDirty(el);
  return serialize(doc);
}

export interface SpanEdit {
  /** Replace source[start, end) with text. Offsets into the OLD source. */
  start: number;
  end: number;
  text: string;
}

/** Smallest single-span edit transforming oldStr into newStr: strip the common
 *  prefix and suffix. Yields clean diffs and granular undo. Null if unchanged. */
export function minimalEdit(oldStr: string, newStr: string): SpanEdit | null {
  if (oldStr === newStr) return null;
  const max = Math.min(oldStr.length, newStr.length);
  let start = 0;
  while (start < max && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { start, end: endOld, text: newStr.slice(start, endNew) };
}
