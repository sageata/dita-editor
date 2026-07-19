// The native Styles view bootstrap (media/styles-view.js) drives the ported
// panel engine through injected adapters. The engine is stubbed here so the
// bootstrap contract (cache feeding, mount/unmount, save-result forwarding)
// is pinned independently of the engine's internals.

import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument } from './canvas-test-dom';

const bootstrapSource = readFileSync(new URL('../media/styles-view.js', import.meta.url), 'utf8');

interface EngineInstall {
  options: Record<string, unknown>;
  refreshCalls: boolean[];
  saveResults: unknown[];
}

function boot(extraWindow: Record<string, unknown> = {}) {
  const doc = new TestDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'inspector-root');
  const status = doc.createElement('div');
  status.setAttribute('id', 'inspector-status');
  doc.body.append(root, status);

  const posted: Array<Record<string, unknown>> = [];
  const installs: EngineInstall[] = [];
  const windowListeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const windowObj = {
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    DitaEditorStylesPanel: {
      installStylesPanel(options: Record<string, unknown>) {
        const install: EngineInstall = { options, refreshCalls: [], saveResults: [] };
        installs.push(install);
        return {
          refresh: (force: boolean) => install.refreshCalls.push(force === true),
          acceptSaveResult: (result: unknown) => install.saveResults.push(result),
          panel: doc.createElement('aside'),
        };
      },
    },
    ...extraWindow,
  } as Record<string, unknown>;
  const vscode = {
    getState: () => null,
    setState: () => undefined,
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
    },
  };
  new Function('window', 'document', 'acquireVsCodeApi', bootstrapSource)(windowObj, doc, () => vscode);
  return {
    doc,
    root,
    status,
    posted,
    installs,
    deliver(message: Record<string, unknown>) {
      for (const listener of windowListeners.get('message') ?? []) listener({ data: message });
    },
  };
}

function targetState(structVersion: number) {
  return {
    type: 'styleTargetState',
    structVersion,
    target: { ids: ['e5'], kind: 'p', label: 'Paragraph', outputclass: '', ancestorClasses: [] },
    computed: [{ key: 'fontSize', cssProp: 'font-size', label: 'Size', value: '14px' }],
    inherited: {},
    hasConfiguredStylesheet: true,
  };
}

function viewState(overrides: Record<string, unknown> = {}) {
  return {
    type: 'stylesViewState',
    active: true,
    docLabel: 'topic.dita',
    styleState: { styles: [], cssText: '', writable: true, sourceHash: 'h', targetToken: 't' },
    targetState: targetState(4),
    ...overrides,
  };
}

describe('styles-view bootstrap', () => {
  test('boots into the empty state and announces readiness', () => {
    const h = boot();
    expect(h.posted).toEqual([{ type: 'stylesReady' }]);
    expect(h.root.textContent).toContain('Open a DITA topic in the visual editor');
    expect(h.installs).toHaveLength(0);
  });

  test('an active snapshot mounts the engine with cache-backed adapters', () => {
    const h = boot();
    h.deliver(viewState());
    expect(h.installs).toHaveLength(1);
    const options = h.installs[0].options as {
      getStyleState(): unknown;
      getCurrentTarget(): unknown;
      getStructVersion(): number;
      getInspectorState(): unknown;
      saveRequestSessionId: string;
    };
    expect((options.getStyleState() as { targetToken: string }).targetToken).toBe('t');
    expect((options.getCurrentTarget() as { ids: string[] }).ids).toEqual(['e5']);
    expect(options.getStructVersion()).toBe(4);
    expect((options.getInspectorState() as { hasConfiguredStylesheet: boolean }).hasConfiguredStylesheet).toBe(true);
    expect(options.saveRequestSessionId.length).toBeGreaterThan(0);

    // A later snapshot refreshes without remounting, and the adapters see it.
    // The first snapshot forces (doc label changed from empty), updates do not.
    h.deliver(viewState({ targetState: targetState(9) }));
    expect(h.installs).toHaveLength(1);
    expect(options.getStructVersion()).toBe(9);
    expect(h.installs[0].refreshCalls).toEqual([true, false]);
  });

  test('installs the preview popup from its global and hands the manager to the engine', () => {
    const installOptions: Array<Record<string, unknown>> = [];
    const manager = { scheduleOpen() {}, scheduleClose() {}, closeNow() {}, isOpen: () => false };
    const h = boot({
      DitaEditorStylesPreviewPopup: {
        installPreviewPopup(opts: Record<string, unknown>) {
          installOptions.push(opts);
          return manager;
        },
      },
    });
    h.deliver(viewState({ styleState: { styles: [], cssText: '.body p.p.p{color:#123}', writable: true, sourceHash: 'h', targetToken: 't' } }));

    expect(installOptions).toHaveLength(1);
    expect(h.installs[0].options.previewPopup).toBe(manager);
    // getCssText reads the live snapshot cache, so the popup always renders
    // against the current managed stylesheet.
    const getCssText = (installOptions[0] as { getCssText(): string }).getCssText;
    expect(getCssText()).toBe('.body p.p.p{color:#123}');
  });

  test('the engine mounts without a preview popup when the module is absent', () => {
    const h = boot();
    h.deliver(viewState());
    expect(h.installs[0].options.previewPopup).toBeNull();
  });

  test('a document switch forces the refresh', () => {
    const h = boot();
    h.deliver(viewState());
    h.deliver(viewState({ docLabel: 'other.dita' }));
    expect(h.installs[0].refreshCalls).toEqual([true, true]);
  });

  test('save results forward to the engine and errors reach the status region', () => {
    const h = boot();
    h.deliver(viewState());
    h.deliver({ type: 'styleSaveResult', requestId: 'r9', ok: true });
    expect(h.installs[0].saveResults).toEqual([{ type: 'styleSaveResult', requestId: 'r9', ok: true }]);
    h.deliver({ type: 'error', message: 'The registered style is incompatible with the selected element.' });
    expect(h.status.textContent).toBe('The registered style is incompatible with the selected element.');
  });

  test('an inactive snapshot unmounts back to the empty state', () => {
    const h = boot();
    h.deliver(viewState());
    h.deliver({ type: 'stylesViewState', active: false, docLabel: '', styleState: null, targetState: null });
    expect(h.root.textContent).toContain('Open a DITA topic in the visual editor');
  });
});
