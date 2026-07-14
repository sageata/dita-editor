// Identifies the editable elements in a topic and gives each a stable id (the
// element-id from element-ids.ts, so editing and structural ops share one id
// scheme). An element is editable when it is a text-bearing leaf type and has NO
// element children — i.e. it holds text only, OR is currently EMPTY. Empty ones
// matter: a freshly-added row cell / list item / paragraph has no text yet but
// must be typeable.
//
// Block-mixed elements (currently a <li> whose text coexists with a nested <ul>/<ol>)
// are handled separately: the WHOLE element is NOT editable (that would let setElementText
// nuke the child), but each text run becomes an independent editable target, addressed
// `<parentId>:t<childIndex>`, edited via setText. Inline-only mixed leaves, including
// table entries with image/xref/conref/phrase children, use one HTML-backed editable surface.

import type { Document, ElementNode } from './types';
import { isElement } from './types';
import { assignElementIds } from './element-ids';

const EDITABLE_PARENTS = new Set(['p', 'title', 'shortdesc', 'li', 'entry', 'cmd', 'codeblock', 'lines', 'note']);
const INLINE_HTML_EDITABLE_PARENTS = new Set(['p', 'title', 'shortdesc', 'li', 'entry', 'cmd', 'note']);

/** DITA inline/phrase elements that may sit inside a text-bearing leaf and that the inline-formatting
 *  ops (b/i/u/line-through/codeph/sub/sup) produce. When a block-mixed parent contains these
 *  as direct children, the phrase child can be edited through the same `eN:t<childIndex>` run
 *  id as a direct text run, while the phrase wrapper and sibling nested list round-trip verbatim. */
const INLINE_PHRASE = new Set(['b', 'i', 'u', 'codeph', 'sub', 'sup', 'tt', 'line-through', 'overline']);

/** True for an element name that is an inline/phrase wrapper handled by the formatting path. */
export function isInlinePhrase(name: string): boolean {
  return INLINE_PHRASE.has(name);
}

/** Inline elements that may sit beside text in an editable leaf without disqualifying it from
 *  mixed editing: the phrase wrappers above plus the inline-insert kinds (image / xref / conref'd
 *  phrase). Each renders verbatim while the surrounding text runs stay editable. */
function isInlineEditableSibling(name: string): boolean {
  return INLINE_PHRASE.has(name) || name === 'image' || name === 'xref' || name === 'ph';
}

function editableInlineRunText(el: ElementNode): string {
  if (!INLINE_PHRASE.has(el.name)) return '';
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') {
      out += child.newText ?? child.raw;
    } else if (child.type === 'element' && isInlineEditableSibling(child.name)) {
      out += INLINE_PHRASE.has(child.name) ? editableInlineRunText(child) : child.children.map((c) => (c.type === 'text' ? c.newText ?? c.raw : '')).join('');
    } else {
      return '';
    }
  }
  return out;
}

export function isEditableInlinePhraseRun(el: ElementNode): boolean {
  return editableInlineRunText(el).trim() !== '';
}

function isEditable(el: ElementNode): boolean {
  // Editable ONLY when every child is a text node (or empty): setElementText
  // rebuilds the leaf from decoded text alone, so a comment / PI / CDATA child
  // would be silently dropped. Such a leaf renders non-editable instead, so its
  // source is preserved verbatim (preserve-over-edit). Inline-rich leaves route through
  // applyInlineHtmlEdit, which preserves supported inline elements instead of flattening them.
  return EDITABLE_PARENTS.has(el.name) && (el.children.every((c) => c.type === 'text') || isInlineHtmlEditable(el));
}

export function isInlineHtmlEditable(el: ElementNode): boolean {
  const elementChildren = el.children.filter(isElement);
  if (elementChildren.length === 0) return false;
  return INLINE_HTML_EDITABLE_PARENTS.has(el.name) && elementChildren.every((c) => isInlineEditableSibling(c.name));
}

/** An element whose own text coexists with element children, where editing the text
 *  IN PLACE (per text-run, via the `:t` path → setText) preserves those children verbatim:
 *   - a <li> whose text sits alongside a nested <ul>/<ol> (created by indenting an item).
 *  Whole-element editing is impossible for these (setElementText would nuke the children),
 *  so each non-whitespace text run becomes its own editable span instead. */
function isMixedEditable(el: ElementNode): boolean {
  const elementChildren = el.children.filter(isElement);
  if (isInlineHtmlEditable(el)) return false;
  if (elementChildren.length === 0) return false; // plain text-only -> isEditable handles it
  const hasEditableRun = el.children.some((c) => {
    if (c.type === 'text') return (c.newText ?? c.raw).trim() !== '';
    return c.type === 'element' && isEditableInlinePhraseRun(c);
  });
  if (!hasEditableRun) return false;
  if (el.name === 'li') {
    // The canvas routes Enter in an <li>'s text run to addItemAfter (NOT split), so the
    // nested list is never destroyed — the reason this used to be entry-only.
    return elementChildren.every((c) => c.name === 'ul' || c.name === 'ol' || isInlineEditableSibling(c.name));
  }
  return false;
}

/** Editable element -> its stable edit id (shared element-id scheme). */
export function editableElementIds(doc: Document): Map<ElementNode, string> {
  const ids = assignElementIds(doc);
  const out = new Map<ElementNode, string>();
  for (const [el, id] of ids) {
    if (isEditable(el)) out.set(el, id);
  }
  return out;
}

/** Block-mixed parent -> its stable id. The renderer turns each direct text-run
 *  child into a `<parentId>:t<index>` editable span; applyTextEdit routes those to
 *  setText so nested block children round-trip byte-exact. */
export function mixedEditableParents(doc: Document): Map<ElementNode, string> {
  const ids = assignElementIds(doc);
  const out = new Map<ElementNode, string>();
  for (const [el, id] of ids) {
    if (isMixedEditable(el)) out.set(el, id);
  }
  return out;
}

export function findEditableById(doc: Document, id: string): ElementNode | undefined {
  for (const [el, eid] of editableElementIds(doc)) {
    if (eid === id) return el;
  }
  return undefined;
}
