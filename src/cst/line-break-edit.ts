import { assignElementIds, findElementById } from './element-ids';
import { makeElement, makeText, markDirty, setElementText } from './edit';
import { parse } from './parse';
import { serialize } from './serialize';
import { findEditableById } from './text-targets';
import type { Document, ElementNode } from './types';

export interface LineBreakResult {
  source: string;
  focusId: string | null;
  caretOffset: number | null;
}

const WRAP_IN_LINES = new Set(['entry', 'li']);

function inferredCaretOffset(text: string): number {
  const at = text.indexOf('\n');
  return at === -1 ? text.length : at + 1;
}

function focusIdFor(doc: Document, el: ElementNode): string | null {
  return assignElementIds(doc).get(el) ?? null;
}

function renameElement(doc: Document, el: ElementNode, name: string): void {
  const open = el.newOpenTag ?? doc.source.slice(el.openTagRange.start, el.openTagRange.end);
  el.newOpenTag = open.replace(/^<[^\s/>]+/, `<${name}`);
  el.name = name;
  el.closeTagRange = null;
  markDirty(el);
}

export function applyLineBreakEdit(
  source: string,
  editId: string,
  decodedText: string,
  caretOffset = inferredCaretOffset(decodedText),
): LineBreakResult {
  const doc = parse(source);
  const el = findEditableById(doc, editId) ?? findElementById(doc, editId);
  if (!el) throw new Error(`line-break target not found: ${editId}`);

  let focusEl: ElementNode;
  if (el.name === 'lines' || el.name === 'codeblock') {
    setElementText(el, decodedText);
    focusEl = el;
  } else if (el.name === 'p') {
    renameElement(doc, el, 'lines');
    setElementText(el, decodedText);
    focusEl = el;
  } else if (WRAP_IN_LINES.has(el.name)) {
    const lines = makeElement('lines', [], decodedText ? [makeText(decodedText)] : []);
    lines.parent = el;
    el.children = [lines];
    el.selfClosing = false;
    markDirty(el);
    focusEl = lines;
  } else {
    throw new Error(`Shift+Enter is not supported inside <${el.name}>; use <lines> for hard line breaks`);
  }

  return { source: serialize(doc), focusId: focusIdFor(doc, focusEl), caretOffset };
}
