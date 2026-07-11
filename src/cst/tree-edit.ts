import { insertNode, makeRawText, markDirty, removeNode } from './edit';
import type { CstNode, ElementNode } from './types';

export function setElementChildren(el: ElementNode, children: CstNode[]): void {
  el.children = children;
  for (const child of children) child.parent = el;
  markDirty(el);
}

/** Insert newEl right after ref, mirroring ref's leading indentation. */
export function insertAfter(ref: ElementNode, newEl: ElementNode): void {
  const parent = ref.parent;
  if (!parent) throw new Error('cannot insert next to a top-level node');
  const idx = parent.children.indexOf(ref);
  const ws = leadingWs(parent.children, idx);
  insertNode(parent, idx + 1, makeRawText(ws));
  insertNode(parent, idx + 2, newEl);
}

/** Insert newEl immediately before ref, mirroring ref's leading indentation. */
export function insertBefore(ref: ElementNode, newEl: ElementNode): void {
  const parent = ref.parent;
  if (!parent) throw new Error('cannot insert before a top-level node');
  const idx = parent.children.indexOf(ref);
  const ws = leadingWs(parent.children, idx);
  insertNode(parent, idx, newEl);
  insertNode(parent, idx + 1, makeRawText(ws));
}

/** Remove el plus its immediately-preceding whitespace text, for a clean delete. */
export function removeWithLeadingWs(el: ElementNode): void {
  const parent = el.parent;
  if (!parent) throw new Error('cannot remove a top-level node');
  const idx = parent.children.indexOf(el);
  const prev = parent.children[idx - 1];
  removeNode(el);
  if (prev && prev.type === 'text' && prev.raw.trim() === '') removeNode(prev);
}

export function leadingWs(children: CstNode[], idx: number): string {
  const prev = children[idx - 1];
  return prev && prev.type === 'text' ? prev.raw : '\n';
}

export function leadingWsOfFirstNamed(parent: ElementNode, name: string): string {
  const first = parent.children.find((c) => c.type === 'element' && c.name === name);
  if (!first) return '\n';
  return leadingWs(parent.children, parent.children.indexOf(first));
}

export function trailingWs(parent: ElementNode): string {
  const last = parent.children[parent.children.length - 1];
  return last && last.type === 'text' ? last.raw : '\n';
}

/** Append `child` as the last node of `parent`, preceded by a `ws` text node. */
export function appendChild(parent: ElementNode, ws: string, child: CstNode): void {
  insertNode(parent, parent.children.length, makeRawText(ws));
  insertNode(parent, parent.children.length, child);
}
