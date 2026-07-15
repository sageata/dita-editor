// Stable depth-first ids for *elements* (distinct from the text-node ids in
// text-targets.ts). Structural edits always re-render afterward, so ids only
// need to be stable within a single render cycle — the depth-first index is.

import type { CstNode, Document, ElementNode } from './types';
import { isElement } from './types';

// Block-level structural elements that are independently selectable/deletable in
// the editing canvas. UNIVERSAL: every kind here becomes addressable via
// data-struct-id/data-struct-kind, so the canvas can target ANY of them (delete,
// insert-after, etc.) without a brittle per-feature allowlist. The struct-kind is
// always the tag name, so the host can categorize generically.
//
// DELIBERATELY EXCLUDED (they have their own, separate addressing — keep it that way):
//   • entry / table cells — addressed via data-cell-id (the table-grid path);
//   • codeph and other inline phrases — not independently removable structural units;
//   • topic/concept/task/reference roots + body/conbody/… containers + tgroup/
//     thead/tbody/colspec table scaffolding — deleting one orphans the document/table,
//     so they are not standalone delete targets;
//   • mixed-cell text-run spans — synthetic edit-only ids, kept separate from struct-ids.
const DELETABLE_STRUCT_KINDS = new Set<string>([
  'p',
  'li',
  'title',
  'shortdesc',
  'section',
  'lines',
  'codeblock',
  'note',
  // <cmd> is inline-rendered but is an independently editable task text element.
  // It is addressable specifically so Backspace can join compatible sibling cmds.
  'cmd',
  'ul',
  'ol',
  'row',
  'fig',
  'image',
  'table',
]);

export function assignElementIds(doc: Document): Map<ElementNode, string> {
  const ids = new Map<ElementNode, string>();
  let index = 0;
  const walk = (nodes: CstNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      ids.set(node, `e${index++}`);
      walk(node.children);
    }
  };
  walk(doc.children);
  return ids;
}

export function findElementById(doc: Document, id: string): ElementNode | undefined {
  for (const [el, eid] of assignElementIds(doc)) {
    if (eid === id) return el;
  }
  return undefined;
}

/** Every block-level structural element (see DELETABLE_STRUCT_KINDS) -> { id, kind }
 *  for the renderer to stamp. kind === the tag name so the host can categorize ANY
 *  stamped element generically (delete/insert-after), with no per-kind allowlist. */
export function structuralIds(doc: Document): Map<ElementNode, { id: string; kind: string }> {
  const out = new Map<ElementNode, { id: string; kind: string }>();
  for (const [el, id] of assignElementIds(doc)) {
    if (DELETABLE_STRUCT_KINDS.has(el.name)) out.set(el, { id, kind: el.name });
  }
  return out;
}

/** Every table cell (<entry>) -> its stable id, so the renderer can stamp
 *  data-cell-id and the client can address ANY cell (incl. image-only / merged)
 *  for merge/split. */
export function tableCellIds(doc: Document): Map<ElementNode, string> {
  const out = new Map<ElementNode, string>();
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === 'entry') out.set(el, id);
  }
  return out;
}
