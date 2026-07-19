import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

interface StyleBridge {
  emitTargetState(): void;
  applyStyleState(): void;
  noteRerender(): void;
}

interface StyleTargetStateMessage {
  type: 'styleTargetState';
  structVersion: number;
  target: unknown;
  computed: Array<{ key: string; cssProp: string; label: string; value: string }> | null;
  inherited: Record<string, Record<string, string>>;
  hasConfiguredStylesheet: boolean;
}

interface StyleState {
  styles: unknown[];
  cssText: string;
  stylesheetHref?: string;
  writable: boolean;
}

interface BridgeOverrides {
  currentTarget?: { ids: string[]; kind: string; label: string; outputclass: string } | null;
  windowExtras?: Record<string, unknown>;
  embedded?: unknown;
  parseProbeMarkup?: boolean;
}

// The real webview parses probe markup via innerHTML; the fake DOM does not.
// This patch gives created elements a naive innerHTML "parser" that appends
// one child per opening tag, which is enough for wrap.querySelector(probeTag).
function enableInnerHtmlParsing(doc: TestDocument): void {
  const original = doc.createElement.bind(doc);
  doc.createElement = ((tag: string) => {
    const el = original(tag);
    let raw = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => raw,
      set: (value: string) => {
        raw = String(value);
        for (const match of raw.matchAll(/<([a-z][a-z0-9]*)/gi)) {
          el.appendChild(original(match[1]));
        }
      },
    });
    return el;
  }) as TestDocument['createElement'];
}

function fireDoc(doc: TestDocument, type: string): void {
  for (const listener of doc.listeners.get(type) ?? []) {
    listener({});
  }
}

function makeDeferredTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    windowExtras: {
      setTimeout(callback: () => void) {
        const id = nextId++;
        pending.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        pending.delete(id);
      },
    },
    pendingCount: () => pending.size,
    runAll() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function loadBridge(overrides: BridgeOverrides = {}) {
  const source = readFileSync(new URL('../media/canvas-style-bridge.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasStyleBridge: {
      installStyleBridge(opts: Record<string, unknown>): StyleBridge;
    };
  };
  const doc = new TestDocument();
  if (overrides.parseProbeMarkup) enableInnerHtmlParsing(doc);
  const liveStyle = doc.createElement('style');
  liveStyle.id = 'ditaeditor-author-styles-live';
  doc.body.appendChild(liveStyle);
  const managedStyleData = doc.createElement('script');
  managedStyleData.id = 'ditaeditor-managed-style-data';
  managedStyleData.textContent = JSON.stringify(
    overrides.embedded ?? { consumer: 'canvas', cssText: '.dc-embedded-first-paint { color: #123456; }' },
  );
  doc.body.appendChild(managedStyleData);
  const messages: unknown[] = [];
  let styleState: StyleState = { styles: [], cssText: '.dc-host-state { color: red; }', writable: true };
  let currentTarget = 'currentTarget' in overrides
    ? overrides.currentTarget ?? null
    : { ids: ['e1'], kind: 'title', label: 'title', outputclass: '' };
  const windowObj = Object.assign({}, overrides.windowExtras || {});
  new Function('window', source)(win);
  const bridge = win.DitaEditorCanvasStyleBridge.installStyleBridge({
    document: doc,
    window: windowObj,
    vscode: { postMessage: (msg: unknown) => messages.push(msg) },
    getStyleState: () => styleState,
    getCurrentTarget: () => currentTarget,
    getStructVersion: () => 7,
  });
  return {
    doc,
    liveStyle,
    bridge,
    messages,
    posts: () => messages as StyleTargetStateMessage[],
    setStyleState: (next: StyleState) => {
      styleState = next;
    },
    setCurrentTarget: (next: typeof currentTarget) => {
      currentTarget = next;
    },
  };
}

describe('canvas-style-bridge', () => {
  test('uses the pre-existing live slot and applies the embedded first paint without appending a style', () => {
    const { doc, liveStyle } = loadBridge();

    expect(doc.body.querySelectorAll('style')).toEqual([liveStyle]);
    expect(liveStyle.textContent).toContain('.dc-embedded-first-paint');
  });

  test('rejects managed style data that does not target the canvas', () => {
    expect(() => loadBridge({ embedded: { consumer: 'preview', cssText: '.x { color: red; }' } }))
      .toThrow('does not target the canvas');
    expect(() => loadBridge({ embedded: { consumer: 'canvas' } }))
      .toThrow('does not target the canvas');
  });

  test('applyStyleState bridges link refreshes with generated CSS, then clears and removes the live layer', () => {
    const { doc, liveStyle, bridge, messages, setStyleState } = loadBridge();

    setStyleState({
      styles: [],
      cssText: '.dc-live-refresh { color: red; }',
      stylesheetHref: 'author.css?v=one',
      writable: true,
    });
    bridge.applyStyleState();

    const link = doc.querySelector('link[data-ditaeditor-style-origin="author"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('author.css?v=one');
    expect(link!.parentNode).toBe(liveStyle.parentNode);
    expect(doc.body.children.indexOf(link!)).toBeLessThan(doc.body.children.indexOf(liveStyle));
    expect(liveStyle.textContent).toBe('.dc-live-refresh { color: red; }');

    link!.dispatch('load', {});
    expect(liveStyle.textContent).toBe('');

    setStyleState({
      styles: [],
      cssText: '.dc-second-refresh { color: blue; }',
      stylesheetHref: 'author.css?v=two',
      writable: true,
    });
    bridge.applyStyleState();
    expect(doc.querySelectorAll('link[data-ditaeditor-style-origin="author"]')).toEqual([link!]);
    expect(link!.getAttribute('href')).toBe('author.css?v=two');
    expect(liveStyle.textContent).toBe('.dc-second-refresh { color: blue; }');

    link!.dispatch('error', {});
    expect(messages).toContainEqual({
      type: 'authorStylesheetLoadError',
      href: 'author.css?v=two',
    });

    setStyleState({ styles: [], cssText: '', writable: false });
    bridge.applyStyleState();
    expect(liveStyle.textContent).toBe('');
    expect(doc.querySelector('link[data-ditaeditor-style-origin="author"]')).toBeNull();
  });

  test('emitTargetState posts the snapshot shape with computed styles for the selected element', () => {
    const computedValues: Record<string, string> = {
      'font-size': '34px',
      'font-weight': '700',
      'color': 'rgb(27, 41, 50)',
      'margin-bottom': '18px',
    };
    const helper = loadBridge({
      windowExtras: {
        getComputedStyle: (el: unknown) => ({
          getPropertyValue: (prop: string) =>
            (el as TestElement).getAttribute?.('data-struct-id') === 'e1' ? computedValues[prop] ?? '' : '',
        }),
      },
    });
    const target = helper.doc.createElement('h1');
    target.setAttribute('data-struct-id', 'e1');
    helper.doc.body.appendChild(target);

    helper.bridge.emitTargetState();

    expect(helper.messages).toHaveLength(1);
    const msg = helper.posts()[0];
    expect(msg.type).toBe('styleTargetState');
    expect(msg.structVersion).toBe(7);
    expect(msg.target).toEqual({ ids: ['e1'], kind: 'title', label: 'title', outputclass: '' });
    expect(msg.hasConfiguredStylesheet).toBe(false);
    expect(msg.inherited).toBeInstanceOf(Object);
    expect(msg.computed).toHaveLength(11);
    expect(msg.computed![0]).toEqual({ key: 'fontSize', cssProp: 'font-size', label: 'Size', value: '34px' });
    expect(msg.computed!.find((entry) => entry.key === 'spacingAfter'))
      .toEqual({ key: 'spacingAfter', cssProp: 'margin-bottom', label: 'After', value: '18px' });
    // The bridge posts the raw computed values for the inspector; the row for
    // an unavailable property is present with an empty value.
    expect(msg.computed!.find((entry) => entry.key === 'lineHeight')?.value).toBe('');
  });

  test('table accent inspection follows the applied edge for both color and width', () => {
    const requested: string[] = [];
    const helper = loadBridge({
      currentTarget: {
        ids: ['table-1'],
        kind: 'table',
        label: 'table',
        outputclass: 'dc-right-rule',
      },
      windowExtras: {
        getComputedStyle: () => ({
          getPropertyValue(prop: string) {
            requested.push(prop);
            if (prop === 'border-right-color') return 'rgb(18, 52, 86)';
            if (prop === 'border-right-width') return '5px';
            return '';
          },
        }),
      },
    });
    helper.setStyleState({
      styles: [{
        className: 'dc-right-rule',
        name: 'Right rule',
        target: 'table',
        borderColor: '#123456',
        borderEdge: 'right',
        borderWidth: '5px',
      }],
      cssText: '',
      writable: true,
    });
    const table = helper.doc.createElement('table');
    table.setAttribute('data-struct-id', 'table-1');
    helper.doc.body.appendChild(table);

    helper.bridge.emitTargetState();

    const computed = helper.posts().at(-1)?.computed ?? [];
    expect(computed.find((entry) => entry.key === 'borderColor')).toEqual({
      key: 'borderColor',
      cssProp: 'border-right-color',
      label: 'Accent',
      value: 'rgb(18, 52, 86)',
    });
    expect(computed.find((entry) => entry.key === 'borderWidth')).toEqual({
      key: 'borderWidth',
      cssProp: 'border-right-width',
      label: 'Accent width',
      value: '5px',
    });
    expect(requested).toContain('border-right-color');
    expect(requested).toContain('border-right-width');
  });

  test('cell ids resolve through data-cell-id as well', () => {
    const helper = loadBridge({
      currentTarget: { ids: ['c3'], kind: 'entry', label: 'cell', outputclass: '' },
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop === 'font-size' ? '13px' : '') }),
      },
    });
    const cell = helper.doc.createElement('td');
    cell.setAttribute('data-cell-id', 'c3');
    helper.doc.body.appendChild(cell);

    helper.bridge.emitTargetState();

    expect(helper.posts()[0].computed![0].value).toBe('13px');
  });

  test('a null target or missing getComputedStyle degrades to a null computed snapshot', () => {
    const noTarget = loadBridge({
      currentTarget: null,
      windowExtras: { getComputedStyle: () => ({ getPropertyValue: () => '12px' }) },
    });
    noTarget.bridge.emitTargetState();
    expect(noTarget.posts()[0].target).toBeNull();
    expect(noTarget.posts()[0].computed).toBeNull();

    const noCompute = loadBridge(); // windowObj has no getComputedStyle
    noCompute.bridge.emitTargetState();
    expect(noCompute.posts()[0].computed).toBeNull();
    expect(noCompute.posts()[0].inherited).toEqual(expect.any(Object));
  });

  test('flags a configured workspace stylesheet only for the explicit origin marker', () => {
    const helper = loadBridge({ currentTarget: null });
    const builtIn = helper.doc.createElement('link');
    builtIn.setAttribute('rel', 'stylesheet');
    builtIn.setAttribute('href', 'content-theme.css');
    helper.doc.body.appendChild(builtIn);

    helper.bridge.emitTargetState();
    expect(helper.posts().at(-1)!.hasConfiguredStylesheet).toBe(false);

    const configured = helper.doc.createElement('link');
    configured.setAttribute('rel', 'stylesheet');
    configured.setAttribute('href', 'content-theme.css');
    configured.setAttribute('data-ditaeditor-style-origin', 'configured');
    helper.doc.body.appendChild(configured);

    helper.bridge.emitTargetState();
    expect(helper.posts().at(-1)!.hasConfiguredStylesheet).toBe(true);
  });

  test('the probe path supplies inherited values (formatted) for kinds with no sample element', () => {
    const computedValues: Record<string, string> = {
      'font-size': '16px',
      'color': 'rgb(37, 50, 58)',
      'background-color': 'rgba(0, 0, 0, 0)',
    };
    const helper = loadBridge({
      currentTarget: null,
      parseProbeMarkup: true,
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => computedValues[prop] ?? '' }),
      },
    });

    helper.bridge.emitTargetState();

    const inherited = helper.posts()[0].inherited;
    // The corpus has no section heading; its values come from a mounted probe.
    expect(inherited.heading).toMatchObject({
      fontSize: '16px',
      color: '#25323a', // rgb() formatted as compact hex
      backgroundColor: 'transparent', // fully transparent rgba() named
    });
    // Probes are removed synchronously after the read.
    expect(helper.doc.main.children).toHaveLength(0);
  });

  test('a missing sample element degrades through the probe path without crashing', () => {
    // Without innerHTML parsing the probe mounts nothing, so mountProbe bails
    // out cleanly and that kind publishes an empty inherited map.
    const helper = loadBridge({
      currentTarget: null,
      windowExtras: { getComputedStyle: () => ({ getPropertyValue: () => '99px' }) },
    });

    helper.bridge.emitTargetState();

    const inherited = helper.posts()[0].inherited;
    expect(inherited.heading).toEqual({});
    // The page kind samples <body>, which always exists.
    expect(inherited.page).toMatchObject({ fontSize: '99px' });
  });

  test('the inherited map is cached across emissions and invalidated by noteRerender and applyStyleState', () => {
    const helper = loadBridge({
      currentTarget: null,
      parseProbeMarkup: true,
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop === 'font-size' ? '16px' : '') }),
      },
    });

    helper.bridge.emitTargetState();
    helper.bridge.emitTargetState();
    expect(helper.messages).toHaveLength(2);
    expect(helper.posts()[1].inherited).toBe(helper.posts()[0].inherited);

    // noteRerender invalidates the cache AND emits immediately.
    helper.bridge.noteRerender();
    expect(helper.messages).toHaveLength(3);
    expect(helper.posts()[2].inherited).not.toBe(helper.posts()[0].inherited);
    expect(helper.posts()[2].inherited.heading).toMatchObject({ fontSize: '16px' });

    // applyStyleState invalidates without emitting; the next emission rebuilds.
    helper.bridge.applyStyleState();
    expect(helper.messages).toHaveLength(3);
    helper.bridge.emitTargetState();
    expect(helper.posts()[3].inherited).not.toBe(helper.posts()[2].inherited);
  });

  test('debounces selection, keyup, and click bursts into one trailing emission', () => {
    const timers = makeDeferredTimers();
    const helper = loadBridge({ currentTarget: null, windowExtras: timers.windowExtras });

    fireDoc(helper.doc, 'selectionchange');
    fireDoc(helper.doc, 'selectionchange');
    fireDoc(helper.doc, 'keyup');
    fireDoc(helper.doc, 'click');

    expect(helper.messages).toHaveLength(0);
    expect(timers.pendingCount()).toBe(1); // trailing debounce keeps one live timer
    timers.runAll();
    expect(helper.messages).toHaveLength(1);
    expect(helper.posts()[0].type).toBe('styleTargetState');
  });

  test('emits immediately when the window provides no timers', () => {
    const helper = loadBridge({ currentTarget: null });

    fireDoc(helper.doc, 'selectionchange');

    expect(helper.messages).toHaveLength(1);
    expect(helper.posts()[0].type).toBe('styleTargetState');
  });
});
