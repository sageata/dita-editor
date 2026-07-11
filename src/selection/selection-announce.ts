// Pure accessible-announcement + command-availability text for the canvas selection.
// Given selected ids (and each id's SelectableKind for phrasing), it produces the
// aria-live string the canvas speaks ("3 cells selected") and the disabled-with-reason
// text the toolbar shows when a structural op can't apply to a multi-selection.
//
// PURE: no DOM, no CST, no VS Code. Kinds are injected (a `kindOf` lookup the caller
// builds from selectable-order.ts selectableKinds), so this stays decoupled from the
// renderer. The raw webview mirror in media/canvas-selection-announce.js uses the same
// contract.

import type { SelectableKind } from './selectable-order';

export interface SelectionState {
  anchorId?: string | null;
  focusId?: string | null;
  ids: string[];
}

export interface SelectionEditability {
  enabled: boolean;
  reason?: string;
}

// Singular / plural noun per kind, for "N cells selected".
const NOUN: Record<SelectableKind, { one: string; many: string }> = {
  block: { one: 'item', many: 'items' },
  cell: { one: 'cell', many: 'cells' },
  image: { one: 'image', many: 'images' },
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Accessible announcement for the current selection:
 *   0 ids                  -> "Selection cleared"
 *   1 id, uniform kind     -> "Cell selected" / "Item selected" / "Image selected"
 *   N ids, uniform kind    -> "3 cells selected"
 *   N ids, mixed kinds     -> "N items selected" (generic fallback)
 * `kindOf` returns each id's SelectableKind; an unknown id reads as a generic item.
 * The model knows COUNT + KIND only — geometric qualifiers like "(rectangle)" are the
 * canvas's to append, since rectangularity isn't part of the linear selection model.
 */
export function describeSelection(
  state: SelectionState,
  kindOf: (id: string) => SelectableKind | undefined,
): string {
  const n = state.ids.length;
  if (n === 0) return 'Selection cleared';
  const kinds = new Set(state.ids.map((id) => kindOf(id)));
  const uniform = kinds.size === 1 ? [...kinds][0] : undefined;
  if (uniform) {
    if (uniform === 'image' && n === 1) return 'Image selected';
    const noun = NOUN[uniform];
    return n === 1 ? `${cap(noun.one)} selected` : `${n} ${noun.many} selected`;
  }
  return n === 1 ? 'Item selected' : `${n} items selected`;
}

/**
 * Whether single-target structural editing applies to the CURRENT selection size.
 * Multi-selection has its own range/list commands, so single-target buttons use this
 * reason instead of implying the click did nothing. A single (or empty) selection is
 * editable as far as count goes — the per-op DITA validity in src/commands/validity.ts
 * still governs the individual button.
 */
export function selectionEditability(state: SelectionState): SelectionEditability {
  if (state.ids.length > 1) {
    return {
      enabled: false,
      reason: 'Multiple items selected — select one item for single-target structural edits',
    };
  }
  return { enabled: true };
}
