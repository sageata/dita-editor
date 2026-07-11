// Serializer: clean nodes slice the original source (byte-identical); dirty or
// synthetic nodes are reconstructed from their parts. Because clean subtrees are
// emitted verbatim, an untouched document round-trips byte-for-byte, and an edit
// only changes the bytes of the nodes it actually touched.

import type { Attr, CstNode, Document, ElementNode } from './types';

/** Escape text node content. The editor supplies decoded text; we re-introduce
 *  the three entities that are significant in element content. `&` first. */
export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape an attribute value, including the quote character in use. */
export function escapeAttr(value: string, quote: '"' | "'"): string {
  let out = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  out = quote === '"' ? out.replace(/"/g, '&quot;') : out.replace(/'/g, '&apos;');
  return out;
}

function serializeNode(node: CstNode, source: string): string {
  if (!node.synthetic && !node.dirty) {
    return source.slice(node.range.start, node.range.end);
  }

  switch (node.type) {
    case 'text':
      if (node.newText !== undefined) return escapeText(node.newText);
      // Synthetic raw text (e.g. indentation from makeRawText) emits its raw
      // verbatim; a real node slices the source. (makeText sets newText above.)
      if (node.synthetic) return node.raw;
      return source.slice(node.range.start, node.range.end);

    case 'element':
      return serializeElement(node, source);

    // Markup that the editor never mutates: a dirty flag here only means a
    // descendant changed, which is impossible for these leaf kinds, so slicing
    // the original is always correct.
    default:
      return source.slice(node.range.start, node.range.end);
  }
}

function serializeElement(el: ElementNode, source: string): string {
  const open = openTag(el, source);
  const inner = el.children.map((child) => serializeNode(child, source)).join('');
  if (inner === '') {
    // No content. A self-closing element stays self-closing. A SYNTHETIC paired-empty
    // element (e.g. a split-added <entry></entry>) keeps its paired form. But a PARSED
    // element edited empty (a cleared cell/paragraph) canonicalizes to the corpus
    // self-closing form `<tag/>` — so type-then-clear returns to the original bytes and
    // an emptied cell matches the corpus convention (empty cells are <entry/>).
    if (el.selfClosing) return open;
    if (el.synthetic) return `${open}</${el.name}>`;
    return open.replace(/>$/, '/>');
  }
  // Has content: a self-closing element that GAINED children (e.g. typing into an empty
  // <entry/>) is promoted to <tag>…</tag> — drop the trailing "/>" and add a close tag.
  const openNorm = el.selfClosing ? open.replace(/\s*\/>$/, '>') : open;
  const close =
    el.synthetic || el.selfClosing
      ? `</${el.name}>`
      : el.closeTagRange
        ? source.slice(el.closeTagRange.start, el.closeTagRange.end)
        : `</${el.name}>`;
  return openNorm + inner + close;
}

function openTag(el: ElementNode, source: string): string {
  if (el.newOpenTag !== undefined) return el.newOpenTag;
  if (!el.synthetic) return source.slice(el.openTagRange.start, el.openTagRange.end);
  // Synthetic element: build from parts with single-space attribute separation.
  const attrs = el.attrs.map((a) => ` ${serializeAttr(a)}`).join('');
  return el.selfClosing ? `<${el.name}${attrs}/>` : `<${el.name}${attrs}>`;
}

export function serializeAttr(attr: Attr): string {
  return `${attr.name}=${attr.quote}${attr.value}${attr.quote}`;
}

export function serialize(doc: Document): string {
  return doc.children.map((node) => serializeNode(node, doc.source)).join('');
}
