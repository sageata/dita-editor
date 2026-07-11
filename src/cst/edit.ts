// Surgical edit primitives over the CST. Every mutation marks the touched node
// dirty and propagates dirtiness to ancestors so that serialize() reconstructs
// only the changed subtree and slices everything else verbatim.

import type { Attr, CstNode, ElementNode, Range, TextNode } from './types';
import { escapeAttr } from './serialize';

const ZERO: Range = { start: -1, end: -1 };

export function markDirty(node: CstNode): void {
  let current: CstNode | null | undefined = node;
  while (current) {
    current.dirty = true;
    current = current.parent;
  }
}

/** Replace a text node's content with new *decoded* text (re-escaped on serialize). */
export function setText(node: TextNode, decoded: string): void {
  node.newText = decoded;
  markDirty(node);
}

/** Set the text content of a text-only/empty element: replace any text children
 *  with a single new text node (or none when cleared). Used for editable leaves,
 *  including freshly-added empty ones that have no text node yet. */
export function setElementText(el: ElementNode, decoded: string): void {
  el.children = [];
  if (decoded !== '') {
    const text = makeText(decoded);
    text.parent = el;
    el.children.push(text);
  }
  markDirty(el);
}

/** Set or replace an attribute value, splicing only the value span of the open
 *  tag so every other byte of the tag is preserved. Adds the attribute before
 *  `>`/`/>` when absent. */
export function setAttr(el: ElementNode, name: string, value: string, source: string): void {
  const existing = el.attrs.find((a) => a.name === name);
  const openTag = el.newOpenTag ?? source.slice(el.openTagRange.start, el.openTagRange.end);
  if (existing) {
    // Offsets relative to the open tag start.
    const base = el.openTagRange.start;
    const vStart = existing.valueRange.start - base;
    const vEnd = existing.valueRange.end - base;
    el.newOpenTag = openTag.slice(0, vStart) + escapeAttr(value, existing.quote) + openTag.slice(vEnd);
    existing.value = value;
  } else {
    const closeLen = el.selfClosing ? 2 : 1; // '/>' or '>'
    const insertAt = openTag.length - closeLen;
    const attr: Attr = {
      name,
      value,
      quote: '"',
      valueRange: ZERO,
      range: ZERO,
    };
    el.attrs.push(attr);
    el.newOpenTag = openTag.slice(0, insertAt) + ` ${name}="${escapeAttr(value, '"')}"` + openTag.slice(insertAt);
  }
  markDirty(el);
}

/** Remove one or more attributes from an element's open tag, splicing out exactly
 *  ` name="value"` (with its leading space) so every other byte is preserved. Used
 *  by cell split to drop namest/nameend/morerows. Operates on the (possibly
 *  already-edited) open-tag string, so multiple removals compose safely. */
export function removeAttrs(el: ElementNode, names: string[], source: string): void {
  let openTag = el.newOpenTag ?? source.slice(el.openTagRange.start, el.openTagRange.end);
  let changed = false;
  for (const name of names) {
    const attr = el.attrs.find((a) => a.name === name);
    if (!attr) continue;
    const needle = ` ${name}=${attr.quote}${attr.value}${attr.quote}`;
    const i = openTag.indexOf(needle);
    if (i === -1) continue;
    openTag = openTag.slice(0, i) + openTag.slice(i + needle.length);
    changed = true;
  }
  if (!changed) return;
  el.newOpenTag = openTag;
  el.attrs = el.attrs.filter((a) => !names.includes(a.name));
  markDirty(el);
}

export function removeNode(node: CstNode): void {
  const parent = node.parent;
  if (!parent) throw new Error('cannot remove a top-level node via removeNode');
  const idx = parent.children.indexOf(node);
  if (idx === -1) throw new Error('node is not a child of its parent');
  parent.children.splice(idx, 1);
  markDirty(parent);
}

export function insertNode(parent: ElementNode, index: number, node: CstNode): void {
  node.parent = parent;
  parent.children.splice(index, 0, node);
  markDirty(parent);
}

// --- Synthetic node builders (always reconstructed; no source range) ---

export function makeText(decoded: string): TextNode {
  return { type: 'text', raw: '', newText: decoded, range: ZERO, synthetic: true, dirty: true };
}

/** Verbatim text (e.g. indentation whitespace) inserted without escaping. */
export function makeRawText(raw: string): TextNode {
  return { type: 'text', raw, range: ZERO, synthetic: true, dirty: true };
}

export function makeElement(
  name: string,
  attrs: Array<{ name: string; value: string; quote?: '"' | "'" }>,
  children: CstNode[] = [],
  selfClosing = false,
): ElementNode {
  const el: ElementNode = {
    type: 'element',
    name,
    attrs: attrs.map((a) => ({
      name: a.name,
      value: a.value,
      quote: a.quote ?? '"',
      valueRange: ZERO,
      range: ZERO,
    })),
    selfClosing,
    openTagRange: ZERO,
    closeTagRange: null,
    children,
    range: ZERO,
    synthetic: true,
    dirty: true,
  };
  for (const child of children) child.parent = el;
  return el;
}
