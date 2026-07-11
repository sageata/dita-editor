// Pure document-order builder for selectable ids used by host-side selection helpers.
//
// Mirrors nav-model.navBlocksInOrder (title/p/li/entry) but ADDS <image>, closing the
// image support gap in nav-model.navBlocksInOrder. A single document-order walk keeps
// nav blocks and images interleaved correctly (an image between two paragraphs sorts
// between them, not after all of them).
//
// PURE: reads the CST only (parse output + assignElementIds), never mutates/serializes
// /touches the DOM or VS Code — headless-testable. The e{N} ids are the same scheme the
// renderer stamps as data-struct-id (p/li/image), data-cell-id (entry) and data-edit-id,
// so this `order` lines up with the DOM ids the canvas reports on click/keystroke.

import { assignElementIds } from '../cst/element-ids';
import { walk } from '../cst/query';
import type { Document } from '../cst/types';
import { isElement } from '../cst/types';

export type SelectableKind = 'block' | 'cell' | 'image';

export interface Selectable {
  /** Stable element id (assignElementIds e{N} scheme). */
  id: string;
  kind: SelectableKind;
}

// Element tag -> selection kind. title/p/li are editable text blocks; <entry> is a
// table cell; <image> is the 4th selectable unit (IMG-1). The block set mirrors
// nav-model.NAV_BLOCK_NAMES (minus the grid-only specifics) so navigation order and
// selection order agree on the text/cell axis.
const KIND_BY_NAME: Record<string, SelectableKind> = {
  title: 'block',
  p: 'block',
  li: 'block',
  entry: 'cell',
  image: 'image',
};

/** Every selectable element, in document order, with its selection kind. */
export function selectablesInOrder(doc: Document): Selectable[] {
  const idByEl = assignElementIds(doc);
  const out: Selectable[] = [];
  for (const node of walk(doc.children)) {
    if (isElement(node)) {
      const kind = KIND_BY_NAME[node.name];
      if (kind) out.push({ id: idByEl.get(node)!, kind });
    }
  }
  return out;
}

/** Bare id list in document order. */
export function selectableOrderIds(doc: Document): string[] {
  return selectablesInOrder(doc).map((s) => s.id);
}

/** id -> kind lookup, for the announcement text in selection-announce.ts. */
export function selectableKinds(doc: Document): Map<string, SelectableKind> {
  return new Map(selectablesInOrder(doc).map((s) => [s.id, s.kind]));
}
