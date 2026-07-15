import { makeElement, makeText, setElementText } from './edit';
import { htmlInlineToCst } from './html-inline';
import { decodeEntities } from './inline-marks';
import { insertAfter, removeWithLeadingWs, setElementChildren } from './tree-edit';
import type { CstNode, ElementNode } from './types';

export interface TextBlockStructuralPayload {
  prefix?: string;
  suffix?: string;
  prefixHtml?: string;
  suffixHtml?: string;
  merged?: string;
  mergedHtml?: string;
  boundary?: number;
  blocks?: string[];
}

export function splitTextBlock(
  el: ElementNode,
  payload: TextBlockStructuralPayload,
): { focusEl: ElementNode; caretOffset: number } {
  const sib = makeElement(el.name, [], []);
  if (payload.prefixHtml !== undefined || payload.suffixHtml !== undefined) {
    setElementChildren(el, htmlInlineToCst(payload.prefixHtml ?? ''));
    setElementChildren(sib, htmlInlineToCst(payload.suffixHtml ?? ''));
  } else {
    setElementText(el, payload.prefix ?? '');
    if (payload.suffix) setElementText(sib, payload.suffix);
  }
  insertAfter(el, sib);
  return { focusEl: sib, caretOffset: 0 };
}

export function joinTextBlocks(
  el: ElementNode,
  target: ElementNode,
  _payload: TextBlockStructuralPayload,
  removalTarget: ElementNode = el,
): { focusEl: ElementNode; caretOffset: number } {
  // The host owns the merge bytes. Never trust merged/mergedHtml from the
  // WebView: valid adjacent ids paired with forged content must not overwrite
  // either element. The source nodes already include every acknowledged edit.
  const isNestedList = (child: CstNode): boolean =>
    child.type === 'element' && (child.name === 'ul' || child.name === 'ol');
  const targetInline = target.children.filter((child) => !isNestedList(child));
  const currentInline = el.children.filter((child) => !isNestedList(child));
  const nestedLists = target.name === 'li' && el.name === 'li'
    ? [...target.children, ...el.children].filter(isNestedList)
    : [];
  const caretOffset = inlineTextLength(targetInline);
  setElementChildren(target, [...targetInline, ...currentInline, ...nestedLists]);
  removeWithLeadingWs(removalTarget);
  return { focusEl: target, caretOffset };
}

export function pasteBlocksIntoTextBlock(
  el: ElementNode,
  payload: TextBlockStructuralPayload,
): { focusEl: ElementNode; caretOffset: number } {
  if (el.name !== 'p' && el.name !== 'li') {
    throw new Error(`pasteBlocks target is <${el.name}>, not a paragraph or list item`);
  }
  const blocks = payload.blocks ?? [];
  if (blocks.length === 0) throw new Error('pasteBlocks needs at least one block');

  const prefixNodes = payload.prefixHtml !== undefined ? htmlInlineToCst(payload.prefixHtml) : textNodes(payload.prefix ?? '');
  const suffixNodes = payload.suffixHtml !== undefined ? htmlInlineToCst(payload.suffixHtml) : textNodes(payload.suffix ?? '');
  const first = inlineChildrenForBlock(blocks[0], prefixNodes, blocks.length === 1 ? suffixNodes : []);
  setElementChildren(el, first.children);

  if (blocks.length === 1) {
    return { focusEl: el, caretOffset: inlineTextLength(prefixNodes) + first.pastedLength };
  }

  let prev = el;
  let focusEl = el;
  let caretOffset = first.pastedLength;
  for (let i = 1; i < blocks.length; i++) {
    const block = inlineChildrenForBlock(blocks[i], [], i === blocks.length - 1 ? suffixNodes : []);
    const sib = makeElement(el.name, [], block.children);
    insertAfter(prev, sib);
    prev = sib;
    focusEl = sib;
    caretOffset = block.pastedLength;
  }
  return { focusEl, caretOffset };
}

function inlineChildrenForBlock(
  html: string,
  prefix: CstNode[],
  suffix: CstNode[],
): { children: CstNode[]; pastedLength: number } {
  const pasted = htmlInlineToCst(html);
  const children: CstNode[] = [];
  children.push(...prefix);
  children.push(...pasted);
  children.push(...suffix);
  return { children, pastedLength: inlineTextLength(pasted) };
}

function textNodes(text: string): CstNode[] {
  return text === '' ? [] : [makeText(text)];
}

function inlineTextLength(nodes: CstNode[]): number {
  let length = 0;
  for (const node of nodes) {
    if (node.type === 'text') length += (node.newText ?? decodeEntities(node.raw)).length;
    else if (node.type === 'element') length += inlineTextLength(node.children);
  }
  return length;
}
