// Stable structural locators over a parsed document.
//
// Element e{N} ids are re-stamped on every structural edit, so they cannot identify
// a target across a sequence of edits. A node's STRUCTURAL PATH — the list of
// child-element indices from the document root — is stable under any edit that does
// not reorder the ancestors/preceding-siblings on that path (e.g. deleting a LATER
// element, or absorbing cells to the right/below an anchor). The command executors
// (multi-executor.ts, range-executor.ts) use these to re-resolve a target's CURRENT
// id between black-box applyStructuralEdit calls.

import { childElements } from '../cst/query';
import { isElement } from '../cst/types';
import type { Document, ElementNode } from '../cst/types';
import type { DocIndex } from './validity';

/** Top-level elements (the document root has no ElementNode parent). */
export function topElements(doc: Document): ElementNode[] {
  return doc.children.filter(isElement);
}

/** Path of child-element indices from the document root to `el`. */
export function elementPath(el: ElementNode, doc: Document): number[] {
  const chain: ElementNode[] = [];
  let n: ElementNode | null | undefined = el;
  while (n) {
    chain.push(n);
    n = n.parent;
  }
  chain.reverse(); // root-most first
  const path: number[] = [];
  for (let i = 0; i < chain.length; i++) {
    const siblings = i === 0 ? topElements(doc) : childElements(chain[i - 1]);
    path.push(siblings.indexOf(chain[i]));
  }
  return path;
}

/** Re-resolve a structural locator against a freshly parsed document. */
export function resolveByPath(doc: Document, path: number[]): ElementNode | undefined {
  let level = topElements(doc);
  let node: ElementNode | undefined;
  for (const idx of path) {
    node = level[idx];
    if (!node) return undefined;
    level = childElements(node);
  }
  return node;
}

/** Current e{N} id of a resolved element in `idx`. */
export function idOf(idx: DocIndex, el: ElementNode): string | undefined {
  for (const [id, e] of idx.byId) if (e === el) return id;
  return undefined;
}
