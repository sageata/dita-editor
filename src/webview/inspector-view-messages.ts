// Message protocol between the extension host and the two Secondary Side Bar
// inspector views (Styles, Properties). Pure types — no vscode import — so the
// contract is unit-testable headlessly (same discipline as
// topic-search-messages.ts).

import type { AuthorStyleState } from '../styles/author-styles';
import type { TaxonomyConfig } from '../config/taxonomy';
import type { DocProps } from './state-maps';

/** Live selection/computed-style snapshot emitted by the canvas style bridge. */
export interface StyleTargetState {
  type: 'styleTargetState';
  structVersion: number;
  target: {
    ids: string[];
    kind: string;
    label: string;
    outputclass: string;
    ancestorClasses: string[];
  } | null;
  /** INSPECT_FIELDS of the single selected element; null for multi/no selection. */
  computed: Array<{ key: string; cssProp: string; label: string; value: string }> | null;
  /** Per-target-kind inherited "(default)" editor values, lazily filled. */
  inherited: Record<string, Record<string, string>>;
  hasConfiguredStylesheet: boolean;
}

/** Host → Styles view. */
export interface StylesViewStateMessage {
  type: 'stylesViewState';
  active: boolean;
  docLabel: string;
  styleState: AuthorStyleState | null;
  targetState: StyleTargetState | null;
}

/** Host → Properties view. */
export interface PropertiesViewStateMessage {
  type: 'propertiesViewState';
  active: boolean;
  docLabel: string;
  docProps: DocProps;
  taxonomy: TaxonomyConfig | null;
  structVersion: number;
}

export interface InspectorErrorMessage {
  type: 'error';
  message: string;
}

export interface InspectorFocusMessage {
  type: 'focusView';
}

/** styleSaveResult keeps the exact shape managed-style-actions.ts already
 *  emits; the hub forwards it verbatim, so it stays untyped here on purpose. */
export type StylesViewHostMessage =
  | StylesViewStateMessage
  | InspectorErrorMessage
  | InspectorFocusMessage
  | { type: 'styleSaveResult'; [key: string]: unknown };

export type PropertiesViewHostMessage =
  | PropertiesViewStateMessage
  | InspectorErrorMessage
  | InspectorFocusMessage;

/** View → host op types each view may inject into the active document's
 *  canvas-message handler. Everything else a view posts is dropped by the hub
 *  before it reaches authorization (defense in depth — the real gate stays
 *  attribute-authorization.ts). */
export const STYLES_VIEW_OP_TYPES = new Set([
  'initializeAuthorStylesheet',
  'applyStyle',
  'clearStyle',
  'saveStyles',
  'styleSaveResultAck',
  'resumeStyleSave',
]);

export const PROPERTIES_VIEW_OP_TYPES = new Set([
  'setTaxonomyAttr',
  'setExistingPropertyAttr',
]);
