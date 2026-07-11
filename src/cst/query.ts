// Read-only navigation helpers over the CST.

import type { CstNode, Document, ElementNode, TextNode } from './types';
import { isElement } from './types';

/** Direct child elements of an element. */
export function childElements(el: ElementNode): ElementNode[] {
  return el.children.filter(isElement);
}

/** Direct child elements with a given name. */
export function childrenNamed(el: ElementNode, name: string): ElementNode[] {
  return childElements(el).filter((c) => c.name === name);
}

export function firstChildNamed(el: ElementNode, name: string): ElementNode | undefined {
  return childElements(el).find((c) => c.name === name);
}

/** Depth-first walk over every node. */
export function* walk(nodes: CstNode[]): Generator<CstNode> {
  for (const node of nodes) {
    yield node;
    if (isElement(node)) yield* walk(node.children);
  }
}

/** First element (depth-first) matching name. */
export function findElement(doc: Document, name: string): ElementNode | undefined {
  for (const node of walk(doc.children)) {
    if (isElement(node) && node.name === name) return node;
  }
  return undefined;
}

/** All elements (depth-first) matching name. */
export function findElements(doc: Document, name: string): ElementNode[] {
  const out: ElementNode[] = [];
  for (const node of walk(doc.children)) {
    if (isElement(node) && node.name === name) out.push(node);
  }
  return out;
}

/** The first text-node child of an element, if any. */
export function firstTextChild(el: ElementNode): TextNode | undefined {
  return el.children.find((c): c is TextNode => c.type === 'text');
}
