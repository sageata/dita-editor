import { describe, expect, test } from 'bun:test';
import { createInspectorHub, type InspectorSidecar } from '../src/host/inspector-hub';
import type { StyleTargetState } from '../src/webview/inspector-view-messages';

function makeSidecar() {
  const toCanvas: unknown[] = [];
  const applied: unknown[] = [];
  const sidecar: InspectorSidecar = {
    postToCanvas: (message) => toCanvas.push(message),
    applyViewMessage: (message) => applied.push(message),
  };
  return { sidecar, toCanvas, applied };
}

function targetState(structVersion: number): StyleTargetState {
  return {
    type: 'styleTargetState',
    structVersion,
    target: { ids: ['e3'], kind: 'p', label: 'Paragraph', outputclass: '', ancestorClasses: [] },
    computed: [{ key: 'fontSize', cssProp: 'font-size', label: 'Size', value: '14px' }],
    inherited: {},
    hasConfiguredStylesheet: false,
  };
}

describe('inspector-hub', () => {
  test('inactive hub reports empty snapshots and refuses dispatch', () => {
    const hub = createInspectorHub();
    expect(hub.stylesSnapshot()).toEqual({
      type: 'stylesViewState',
      active: false,
      docLabel: '',
      styleState: null,
      targetState: null,
    });
    expect(hub.propertiesSnapshot()).toEqual({
      type: 'propertiesViewState',
      active: false,
      docLabel: '',
      docProps: null,
      taxonomy: null,
      structVersion: 0,
    });
    expect(hub.dispatchStyles({ type: 'applyStyle' })).toBe(false);
  });

  test('activation emits the active document snapshots to both listeners', () => {
    const hub = createInspectorHub();
    const { sidecar } = makeSidecar();
    hub.registerDocument('doc-a', 'a.dita', sidecar);
    hub.update('doc-a', {
      docProps: { id: 'topic1', kind: 'topic', attrs: [{ name: 'xml:lang', value: 'en-US' }] },
      structVersion: 4,
    });
    const styles: unknown[] = [];
    const properties: unknown[] = [];
    hub.onStyles((message) => styles.push(message));
    hub.onProperties((message) => properties.push(message));

    hub.noteActive('doc-a');
    expect(styles).toHaveLength(1);
    expect(properties).toEqual([
      {
        type: 'propertiesViewState',
        active: true,
        docLabel: 'a.dita',
        docProps: { id: 'topic1', kind: 'topic', attrs: [{ name: 'xml:lang', value: 'en-US' }] },
        taxonomy: null,
        structVersion: 4,
      },
    ]);
  });

  test('updates for a non-active document do not emit', () => {
    const hub = createInspectorHub();
    hub.registerDocument('doc-a', 'a.dita', makeSidecar().sidecar);
    hub.registerDocument('doc-b', 'b.dita', makeSidecar().sidecar);
    hub.noteActive('doc-a');
    const emitted: unknown[] = [];
    hub.onProperties((message) => emitted.push(message));

    hub.update('doc-b', { structVersion: 9 });
    expect(emitted).toHaveLength(0);
    hub.update('doc-a', { structVersion: 5 });
    expect(emitted).toHaveLength(1);
  });

  test('noteActive latches: an unknown key and a repeat activation are no-ops', () => {
    const hub = createInspectorHub();
    hub.registerDocument('doc-a', 'a.dita', makeSidecar().sidecar);
    const emitted: unknown[] = [];
    hub.onStyles((message) => emitted.push(message));

    hub.noteActive('doc-a');
    hub.noteActive('doc-a');
    hub.noteActive('never-registered');
    expect(emitted).toHaveLength(1);
    // There is no deactivation API at all: blurring the canvas (e.g. focusing
    // an inspector view) must not blank the views.
    const snapshot = hub.stylesSnapshot();
    expect(snapshot.type === 'stylesViewState' && snapshot.active).toBe(true);
  });

  test('disposing the active document empties the views; stale dispose is inert', () => {
    const hub = createInspectorHub();
    const first = makeSidecar();
    const disposeFirst = hub.registerDocument('doc-a', 'a.dita', first.sidecar);
    hub.noteActive('doc-a');
    // Same key re-registered (editor reopened) before the old dispose ran.
    const second = makeSidecar();
    hub.registerDocument('doc-a', 'a.dita', second.sidecar);
    hub.noteActive('doc-a');
    disposeFirst();
    expect(hub.dispatchStyles({ type: 'applyStyle' })).toBe(true);
    expect(second.applied).toHaveLength(1);

    const empties: Array<{ active?: boolean }> = [];
    hub.onProperties((message) => empties.push(message as { active?: boolean }));
    const disposeSecond = hub.registerDocument('doc-b', 'b.dita', makeSidecar().sidecar);
    hub.noteActive('doc-b');
    disposeSecond();
    expect(empties.at(-1)?.active).toBe(false);
    expect(hub.dispatchStyles({ type: 'applyStyle' })).toBe(false);
  });

  test('dispatch allow-lists ops per view and routes to the active document', () => {
    const hub = createInspectorHub();
    const { sidecar, applied } = makeSidecar();
    hub.registerDocument('doc-a', 'a.dita', sidecar);
    hub.noteActive('doc-a');

    expect(hub.dispatchStyles({ type: 'applyStyle', ids: ['e3'] })).toBe(true);
    expect(hub.dispatchStyles({ type: 'initializeAuthorStylesheet', targetToken: 'target-a' })).toBe(true);
    expect(hub.dispatchStyles({ type: 'setTaxonomyAttr' })).toBe(false);
    expect(hub.dispatchStyles({ type: 'deleteElement' })).toBe(false);
    expect(hub.dispatchProperties({ type: 'setExistingPropertyAttr' })).toBe(true);
    expect(hub.dispatchProperties({ type: 'applyStyle' })).toBe(false);
    expect(hub.dispatchProperties(null)).toBe(false);
    expect(applied).toEqual([
      { type: 'applyStyle', ids: ['e3'] },
      { type: 'initializeAuthorStylesheet', targetToken: 'target-a' },
      { type: 'setExistingPropertyAttr' },
    ]);
  });

  test('styleSaveResult always reaches styles listeners, even after a doc switch', () => {
    const hub = createInspectorHub();
    hub.registerDocument('doc-a', 'a.dita', makeSidecar().sidecar);
    hub.registerDocument('doc-b', 'b.dita', makeSidecar().sidecar);
    hub.noteActive('doc-a');
    const received: unknown[] = [];
    hub.onStyles((message) => received.push(message));
    hub.noteActive('doc-b');

    hub.routeStyleSaveResult({ requestId: 'r1', ok: true });
    expect(received.at(-1)).toEqual({ type: 'styleSaveResult', requestId: 'r1', ok: true });
  });

  test('errors route to both views only for the active document', () => {
    const hub = createInspectorHub();
    hub.registerDocument('doc-a', 'a.dita', makeSidecar().sidecar);
    hub.registerDocument('doc-b', 'b.dita', makeSidecar().sidecar);
    hub.noteActive('doc-a');
    const styles: unknown[] = [];
    const properties: unknown[] = [];
    hub.onStyles((message) => styles.push(message));
    hub.onProperties((message) => properties.push(message));

    hub.routeError('doc-b', 'stale');
    expect(styles).toHaveLength(0);
    hub.routeError('doc-a', 'The attribute request was created from a stale render.');
    expect(styles.at(-1)).toEqual({
      type: 'error',
      message: 'The attribute request was created from a stale render.',
    });
    expect(properties).toHaveLength(1);
  });

  test('targetState updates feed styles and bump the properties structVersion', () => {
    const hub = createInspectorHub();
    const { sidecar, toCanvas } = makeSidecar();
    hub.registerDocument('doc-a', 'a.dita', sidecar);
    hub.noteActive('doc-a');

    hub.update('doc-a', { targetState: targetState(7) });
    const styles = hub.stylesSnapshot();
    expect(styles.type === 'stylesViewState' && styles.targetState?.structVersion).toBe(7);
    const properties = hub.propertiesSnapshot();
    expect(properties.type === 'propertiesViewState' && properties.structVersion).toBe(7);

    hub.requestTargetState();
    expect(toCanvas).toEqual([{ type: 'requestStyleTargetState' }]);
  });
});
