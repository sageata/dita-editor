// Per-document state fan-out for the Secondary Side Bar inspector views.
//
// Pure module (no vscode import). The visual-editor provider registers one
// sidecar per open document and feeds it snapshots at its existing post sites;
// the hub latches the ACTIVE document and pushes that document's state to the
// Styles/Properties view listeners. View-originated ops are routed back into
// the active document's canvas-message handler, so authorization, structVersion
// staleness, and the saveStyles replay cache are reused unchanged.
//
// The active key is latched on activation and deliberately NOT cleared on
// blur: focusing the inspector view itself deactivates the canvas panel, and
// clearing then would blank the very view the user just clicked into. The
// latch clears only when the latched document's editor disposes.

import type { AuthorStyleState } from '../styles/author-styles';
import type { TaxonomyConfig } from '../config/taxonomy';
import type { DocProps } from '../webview/state-maps';
import {
  PROPERTIES_VIEW_OP_TYPES,
  STYLES_VIEW_OP_TYPES,
  type PropertiesViewHostMessage,
  type StylesViewHostMessage,
  type StyleTargetState,
} from '../webview/inspector-view-messages';

export interface InspectorSidecar {
  postToCanvas(message: unknown): void;
  /** The document's canvas-message handler; runs the same authorized path a
   *  canvas-originated message would. */
  applyViewMessage(message: unknown): void;
}

export interface InspectorSnapshotUpdate {
  styleState?: AuthorStyleState;
  docProps?: DocProps;
  taxonomy?: TaxonomyConfig | null;
  structVersion?: number;
  targetState?: StyleTargetState;
}

interface DocumentEntry {
  docLabel: string;
  sidecar: InspectorSidecar;
  styleState: AuthorStyleState | null;
  docProps: DocProps;
  taxonomy: TaxonomyConfig | null;
  structVersion: number;
  targetState: StyleTargetState | null;
}

export interface InspectorHub {
  registerDocument(key: string, docLabel: string, sidecar: InspectorSidecar): () => void;
  noteActive(key: string): void;
  update(key: string, partial: InspectorSnapshotUpdate): void;
  onStyles(listener: (message: StylesViewHostMessage) => void): () => void;
  onProperties(listener: (message: PropertiesViewHostMessage) => void): () => void;
  /** Current snapshots for a freshly-resolved view's ready handshake. */
  stylesSnapshot(): StylesViewHostMessage;
  propertiesSnapshot(): PropertiesViewHostMessage;
  /** Route a view-posted op to the active document. False when no active doc
   *  or the op type is not allow-listed for that view. */
  dispatchStyles(message: unknown): boolean;
  dispatchProperties(message: unknown): boolean;
  /** Deliver a styleSaveResult to the Styles view regardless of which document
   *  produced it — the view's save controller validates requestId/session, so
   *  stray deliveries are inert and mid-save document switches still resolve. */
  routeStyleSaveResult(message: Record<string, unknown>): void;
  /** Echo a refusal/error into the views when it concerns the active doc. */
  routeError(key: string, message: string): void;
  /** Ask the active document's canvas to (re-)emit styleTargetState. */
  requestTargetState(): void;
}

export function createInspectorHub(): InspectorHub {
  const documents = new Map<string, DocumentEntry>();
  let activeKey: string | null = null;
  const stylesListeners = new Set<(message: StylesViewHostMessage) => void>();
  const propertiesListeners = new Set<(message: PropertiesViewHostMessage) => void>();

  const active = (): DocumentEntry | null => (activeKey ? documents.get(activeKey) ?? null : null);

  function stylesSnapshot(): StylesViewHostMessage {
    const entry = active();
    return {
      type: 'stylesViewState',
      active: entry !== null,
      docLabel: entry?.docLabel ?? '',
      styleState: entry?.styleState ?? null,
      targetState: entry?.targetState ?? null,
    };
  }

  function propertiesSnapshot(): PropertiesViewHostMessage {
    const entry = active();
    return {
      type: 'propertiesViewState',
      active: entry !== null,
      docLabel: entry?.docLabel ?? '',
      docProps: entry?.docProps ?? null,
      taxonomy: entry?.taxonomy ?? null,
      structVersion: entry?.structVersion ?? 0,
    };
  }

  function emitStyles(): void {
    const message = stylesSnapshot();
    for (const listener of stylesListeners) listener(message);
  }

  function emitProperties(): void {
    const message = propertiesSnapshot();
    for (const listener of propertiesListeners) listener(message);
  }

  return {
    registerDocument(key, docLabel, sidecar) {
      documents.set(key, {
        docLabel,
        sidecar,
        styleState: null,
        docProps: null,
        taxonomy: null,
        structVersion: 0,
        targetState: null,
      });
      return () => {
        const entry = documents.get(key);
        if (entry?.sidecar !== sidecar) return; // a newer registration took the key
        documents.delete(key);
        if (activeKey === key) {
          activeKey = null;
          emitStyles();
          emitProperties();
        }
      };
    },

    noteActive(key) {
      if (!documents.has(key) || activeKey === key) return;
      activeKey = key;
      emitStyles();
      emitProperties();
    },

    update(key, partial) {
      const entry = documents.get(key);
      if (!entry) return;
      let stylesChanged = false;
      let propertiesChanged = false;
      if (partial.styleState !== undefined) {
        entry.styleState = partial.styleState;
        stylesChanged = true;
      }
      if (partial.targetState !== undefined) {
        entry.targetState = partial.targetState;
        entry.structVersion = partial.targetState.structVersion;
        stylesChanged = true;
        propertiesChanged = true;
      }
      if (partial.docProps !== undefined) {
        entry.docProps = partial.docProps;
        propertiesChanged = true;
      }
      if (partial.taxonomy !== undefined) {
        entry.taxonomy = partial.taxonomy;
        propertiesChanged = true;
      }
      if (partial.structVersion !== undefined) {
        entry.structVersion = partial.structVersion;
        propertiesChanged = true;
      }
      if (key !== activeKey) return;
      if (stylesChanged) emitStyles();
      if (propertiesChanged) emitProperties();
    },

    onStyles(listener) {
      stylesListeners.add(listener);
      return () => stylesListeners.delete(listener);
    },

    onProperties(listener) {
      propertiesListeners.add(listener);
      return () => propertiesListeners.delete(listener);
    },

    stylesSnapshot,
    propertiesSnapshot,

    dispatchStyles(message) {
      const entry = active();
      const type = (message as { type?: unknown } | null)?.type;
      if (!entry || typeof type !== 'string' || !STYLES_VIEW_OP_TYPES.has(type)) return false;
      entry.sidecar.applyViewMessage(message);
      return true;
    },

    dispatchProperties(message) {
      const entry = active();
      const type = (message as { type?: unknown } | null)?.type;
      if (!entry || typeof type !== 'string' || !PROPERTIES_VIEW_OP_TYPES.has(type)) return false;
      entry.sidecar.applyViewMessage(message);
      return true;
    },

    routeStyleSaveResult(message) {
      const forwarded = { ...message, type: 'styleSaveResult' } as StylesViewHostMessage;
      for (const listener of stylesListeners) listener(forwarded);
    },

    routeError(key, message) {
      if (key !== activeKey) return;
      const error = { type: 'error', message } as const;
      for (const listener of stylesListeners) listener(error);
      for (const listener of propertiesListeners) listener(error);
    },

    requestTargetState() {
      active()?.sidecar.postToCanvas({ type: 'requestStyleTargetState' });
    },
  };
}
