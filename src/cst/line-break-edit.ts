import { assignElementIds, findElementById } from './element-ids';
import { makeElement, makeText, markDirty, setElementText } from './edit';
import { htmlInlineToCst } from './html-inline';
import { parse } from './parse';
import { serialize } from './serialize';
import { findEditableById, isEditableInlinePhraseRun } from './text-targets';
import type { CstNode, Document, ElementNode } from './types';

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

function wrapNoteContentInLines(
  note: ElementNode,
  decodedText: string,
  runIndex: number | null,
  inlineHtml?: string,
): ElementNode {
  let payload: CstNode[] = inlineHtml !== undefined
    ? htmlInlineToCst(inlineHtml)
    : decodedText ? [makeText(decodedText)] : [];
  if (runIndex !== null) {
    const child = note.children[runIndex];
    if (!child) throw new Error(`note text-run target not found at child ${runIndex}`);
    if (child.type === 'element') {
      if (!isEditableInlinePhraseRun(child)) {
        throw new Error(`note text-run target at child ${runIndex} is not editable`);
      }
      if (inlineHtml !== undefined) {
        child.children = htmlInlineToCst(inlineHtml);
        for (const nested of child.children) nested.parent = child;
        child.selfClosing = false;
        markDirty(child);
      } else {
        setElementText(child, decodedText);
      }
      payload = [child];
    } else if (child.type !== 'text' || (child.newText ?? child.raw).trim() === '') {
      throw new Error(`note text-run target at child ${runIndex} is not editable`);
    }
  }

  const lines = makeElement('lines', [], payload);
  lines.parent = note;
  if (runIndex === null) note.children = [lines];
  else note.children.splice(runIndex, 1, lines);
  note.selfClosing = false;
  markDirty(note);
  return lines;
}

export function applyLineBreakEdit(
  source: string,
  editId: string,
  decodedText: string,
  caretOffset = inferredCaretOffset(decodedText),
  inlineHtml?: string,
): LineBreakResult {
  const doc = parse(source);
  const separator = editId.indexOf(':t');
  const runIndex = separator === -1 ? null : Number(editId.slice(separator + 2));
  const baseId = separator === -1 ? editId : editId.slice(0, separator);
  const el = findEditableById(doc, editId) ?? findElementById(doc, baseId);
  if (!el) throw new Error(`line-break target not found: ${editId}`);

  let focusEl: ElementNode;
  if (el.name === 'note') {
    if (runIndex !== null && !Number.isInteger(runIndex)) {
      throw new Error(`note text-run target not found: ${editId}`);
    }
    focusEl = wrapNoteContentInLines(el, decodedText, runIndex, inlineHtml);
  } else if (separator !== -1) {
    throw new Error(`line-break target not found: ${editId}`);
  } else if (el.name === 'lines' || el.name === 'codeblock') {
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
