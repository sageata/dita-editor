import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, type TestListener } from './canvas-test-dom';

interface TestWindow {
  listeners: Map<string, TestListener[]>;
  scrollX: number;
  scrollY: number;
  localStorage: { getItem(key: string): string | null };
  addEventListener(type: string, listener: TestListener): void;
  removeEventListener(type: string, listener: TestListener): void;
  dispatch(type: string, event?: Record<string, unknown>): void;
  requestAnimationFrame(callback: () => void): number;
}

// Handles are always mounted; the localStorage flag only restores the painted
// debug guides (a layer class). `guides` simulates a debugging user's opt-in.
function makeWindow(guides = false): TestWindow {
  return {
    listeners: new Map(),
    scrollX: 0,
    scrollY: 0,
    localStorage: {
      getItem: (key: string) => (guides && key === 'ditaeditor.visual.tableGuides' ? 'true' : null),
    },
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter((item) => item !== listener));
    },
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
}

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-table-resize.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasTableResize: {
      installTableColumnResize(opts: Record<string, unknown>): { refresh(): void; destroy(): void };
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasTableResize;
}

function setRect(el: TestElement, rect: { left: number; top: number; width: number; height: number }): void {
  const value = {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
  };
  (el as unknown as { getBoundingClientRect(): typeof value }).getBoundingClientRect = () => value;
}

function buildTwoColumnTable(doc: TestDocument): {
  table: TestElement;
  colA: TestElement;
  colB: TestElement;
} {
  const table = new TestElement('table', doc, {
    'data-table-resizable': 'true',
    'data-table-id': 'table1',
  });
  const colgroup = new TestElement('colgroup', doc);
  const colA = new TestElement('col', doc);
  const colB = new TestElement('col', doc);
  const tbody = new TestElement('tbody', doc);
  const row = new TestElement('tr', doc);
  const cellA = new TestElement('td', doc);
  const cellB = new TestElement('td', doc);
  colgroup.append(colA, colB);
  row.append(cellA, cellB);
  tbody.appendChild(row);
  table.append(colgroup, tbody);
  doc.main.appendChild(table);

  setRect(table, { left: 100, top: 40, width: 400, height: 120 });
  setRect(cellA, { left: 100, top: 40, width: 100, height: 60 });
  setRect(cellB, { left: 200, top: 40, width: 300, height: 60 });
  return { table, colA, colB };
}

describe('canvas table column resize', () => {
  test('handles mount by default but the layer carries no debug-paint class', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow(false);
    buildTwoColumnTable(doc);

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: () => undefined },
      getStructVersion: () => 3,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer');
    expect(layer).toBeInstanceOf(TestElement);
    expect(layer?.children.length).toBe(1);
    expect(layer?.classList.contains('dc-table-guides-debug')).toBe(false);
  });

  test('the tableGuides debug flag adds the always-visible paint class to the layer', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow(true);
    buildTwoColumnTable(doc);

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: () => undefined },
      getStructVersion: () => 3,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer');
    expect(layer).toBeInstanceOf(TestElement);
    expect(layer?.children.length).toBe(1);
    expect(layer?.classList.contains('dc-table-guides-debug')).toBe(true);
  });

  test('hover paints a stripe segment local to the cursor and clears on leave', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow(false);
    buildTwoColumnTable(doc);

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: () => undefined },
      getStructVersion: () => 3,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer')!;
    const handle = layer.children[0];
    handle.dispatch('pointermove', { clientY: 140 });
    // handle top is 40 → local y 100: mask window centered there, stripe painted
    expect(handle.style.background).toContain('linear-gradient(to right');
    expect(handle.style.maskImage).toContain('transparent 10px');
    expect(handle.style.maskImage).toContain('#000 40px');
    expect(handle.style.maskImage).toContain('#000 160px');
    handle.dispatch('pointerleave', {});
    expect(handle.style.background).toBe('');
    expect(handle.style.maskImage).toBe('');
  });

  test('handles never extend up behind the fixed command bar', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow(false);
    const { table } = buildTwoColumnTable(doc);
    setRect(table, { left: 100, top: 40, width: 400, height: 120 });
    const bar = new TestElement('div', doc, {});
    bar.className = 'cmd-bar';
    bar.classList.add('cmd-bar');
    setRect(bar, { left: 0, top: 0, width: 1600, height: 72 });
    doc.body.appendChild(bar);

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: () => undefined },
      getStructVersion: () => 3,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer')!;
    const handle = layer.children[0];
    // table top is 40 but the bar bottom is 72 — the handle starts below the bar
    expect(handle.style.top).toBe('72px');
  });

  test('mounts one overlay handle per column boundary without changing table children', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow();
    const { table } = buildTwoColumnTable(doc);
    const messages: unknown[] = [];

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: (message: unknown) => messages.push(message) },
      getStructVersion: () => 3,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer');
    expect(layer).toBeInstanceOf(TestElement);
    expect(layer?.children.length).toBe(1);
    expect(table.children.map((child) => child.tagName)).toEqual(['colgroup', 'tbody']);
    expect(messages).toEqual([]);
  });

  test('previews widths during drag and posts one normalized fractional update on pointerup', () => {
    const doc = new TestDocument();
    const testWindow = makeWindow();
    const { table, colA, colB } = buildTwoColumnTable(doc);
    const messages: unknown[] = [];

    loadHelper().installTableColumnResize({
      document: doc,
      window: testWindow,
      vscode: { postMessage: (message: unknown) => messages.push(message) },
      getStructVersion: () => 7,
      announceNav: () => undefined,
    });

    const layer = doc.body.children.find((child) => child.className === 'dc-table-resize-layer')!;
    const handle = layer.children[0];
    handle.dispatch('pointerdown', {
      button: 0,
      clientX: 200,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    testWindow.dispatch('pointermove', {
      clientX: 240,
      preventDefault: () => undefined,
    });

    expect(colA.style.width).toBe('35%');
    expect(colB.style.width).toBe('65%');
    expect(table.style.tableLayout).toBe('fixed');
    expect(messages).toEqual([]);

    testWindow.dispatch('pointerup', { preventDefault: () => undefined });

    expect(messages).toEqual([
      {
        type: 'setTableColumnWidths',
        id: 'table1',
        widths: [0.7, 1.3],
        baseStructVersion: 7,
      },
    ]);
    expect(table.style.tableLayout).toBe('fixed');
  });
});
