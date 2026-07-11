import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, TestText, keyEvent } from './canvas-test-dom';

function loadKeyboardNav() {
  const source = readFileSync(new URL('../media/canvas-keyboard-nav.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasKeyboardNav: {
      installKeyboardNavigation(opts: Record<string, unknown>): void;
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasKeyboardNav;
}

function cell(id: string, text: string, doc: TestDocument): TestElement {
  const el = new TestElement('td', doc, {
    'data-cell-id': id,
    'data-edit-id': id,
    contenteditable: 'true',
  });
  el.textContent = text;
  return el;
}

function dispatchKey(doc: TestDocument, event: Record<string, unknown>): void {
  for (const listener of doc.listeners.get('keydown') ?? []) listener(event);
}

function installNav(
  doc: TestDocument,
  opts: {
    navMap?: Record<string, unknown>;
    selected?: TestElement[];
    announcements?: string[];
  } = {},
): void {
  loadKeyboardNav().installKeyboardNavigation({
    document: doc,
    window: {
      getSelection: () => ({
        rangeCount: 0,
        isCollapsed: true,
        toString: () => '',
      }),
    },
    getNavMap: () => opts.navMap ?? {},
    editableTarget: (target: unknown) =>
      target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
    cellEditTarget: (target: unknown) => target,
    selectContents: (target: TestElement) => opts.selected?.push(target),
    caretOffset: () => 0,
    setCaret: () => undefined,
    focusNonEditableTarget: () => undefined,
    announceNav: (message: string) => opts.announcements?.push(message),
  });
}

describe('canvas-keyboard-nav', () => {
  test('arrow navigation can continue from a whole-cell selection', () => {
    const globalWithCss = globalThis as typeof globalThis & { CSS?: typeof CSS };
    const oldCss = globalWithCss.CSS;
    globalWithCss.CSS = { escape: (value: string) => value } as unknown as typeof CSS;
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);

    const selectedRange = {
      getClientRects: () => [{ top: 0, bottom: 10, height: 10 }],
    };
    const win = {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        toString: () => 'Alpha',
        getRangeAt: () => selectedRange,
      }),
    };
    const selected: TestElement[] = [];

    loadKeyboardNav().installKeyboardNavigation({
      document: doc,
      window: win,
      getNavMap: () => ({
        c1: {
          ArrowRight: { ok: true, targetId: 'c2', via: 'grid' },
        },
      }),
      editableTarget: (target: unknown) =>
        target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
      cellEditTarget: (target: unknown) => target,
      selectContents: (target: TestElement) => selected.push(target),
      caretOffset: () => 0,
      setCaret: () => undefined,
      focusNonEditableTarget: () => undefined,
      announceNav: () => undefined,
    });

    const event = Object.assign(keyEvent('ArrowRight'), { target: first });
    try {
      dispatchKey(doc, event);
    } finally {
      globalWithCss.CSS = oldCss;
    }

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(second);
    expect(selected).toEqual([second]);
  });

  test('arrow navigation can continue from a wrapped whole-cell selection with multiple rects', () => {
    const globalWithCss = globalThis as typeof globalThis & { CSS?: typeof CSS };
    const oldCss = globalWithCss.CSS;
    globalWithCss.CSS = { escape: (value: string) => value } as unknown as typeof CSS;
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha wrapped', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);

    const selectedRange = {
      getClientRects: () => [
        { top: 0, bottom: 10, height: 10 },
        { top: 12, bottom: 22, height: 10 },
      ],
    };
    const win = {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        toString: () => 'Alpha wrapped',
        getRangeAt: () => selectedRange,
      }),
    };
    const selected: TestElement[] = [];

    loadKeyboardNav().installKeyboardNavigation({
      document: doc,
      window: win,
      getNavMap: () => ({
        c1: {
          ArrowRight: { ok: true, targetId: 'c2', via: 'grid' },
        },
      }),
      editableTarget: (target: unknown) =>
        target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
      cellEditTarget: (target: unknown) => target,
      selectContents: (target: TestElement) => selected.push(target),
      caretOffset: () => 0,
      setCaret: () => undefined,
      focusNonEditableTarget: () => undefined,
      announceNav: () => undefined,
    });

    const event = Object.assign(keyEvent('ArrowRight'), { target: first });
    try {
      dispatchKey(doc, event);
    } finally {
      globalWithCss.CSS = oldCss;
    }

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(second);
    expect(selected).toEqual([second]);
  });

  test('arrow navigation treats render-only conref labels as zero length at source end', () => {
    const globalWithCss = globalThis as typeof globalThis & { CSS?: typeof CSS };
    const oldCss = globalWithCss.CSS;
    globalWithCss.CSS = { escape: (value: string) => value } as unknown as typeof CSS;
    const doc = new TestDocument();
    const first = new TestElement('p', doc, { 'data-edit-id': 'e1', contenteditable: 'true' });
    const chip = new TestElement('span', doc, { 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' });
    first.append(new TestText('a '), chip, new TestText(' b'));
    chip.append(new TestText('reuse.dita#r/x'));
    const second = new TestElement('p', doc, { 'data-edit-id': 'e2', contenteditable: 'true' });
    second.textContent = 'Next';
    doc.main.append(first, second);
    const win = {
      getSelection: () => ({ rangeCount: 1, isCollapsed: true }),
    };
    const setCaretCalls: Array<{ target: TestElement; offset: number }> = [];

    loadKeyboardNav().installKeyboardNavigation({
      document: doc,
      window: win,
      getNavMap: () => ({
        e1: {
          ArrowRight: { ok: true, targetId: 'e2', via: 'flow' },
        },
      }),
      editableTarget: (target: unknown) =>
        target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
      cellEditTarget: () => null,
      selectContents: () => undefined,
      caretOffset: () => 4,
      sourceTextLength: () => 4,
      setCaret: (target: TestElement, offset: number) => setCaretCalls.push({ target, offset }),
      focusNonEditableTarget: () => undefined,
      announceNav: () => undefined,
    });

    const event = Object.assign(keyEvent('ArrowRight'), { target: first });
    try {
      dispatchKey(doc, event);
    } finally {
      globalWithCss.CSS = oldCss;
    }

    expect(first.textContent.length).toBeGreaterThan(4);
    expect(event.prevented).toBe(true);
    expect(setCaretCalls).toEqual([{ target: second, offset: 0 }]);
  });

  test('arrow navigation does not leave a multi-paragraph cell from an inner paragraph boundary', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const previous = cell('c0', 'Previous', doc);
    const cellEl = new TestElement('td', doc, { 'data-cell-id': 'c1' });
    const first = new TestElement('p', doc, { 'data-edit-id': 'p1', contenteditable: 'true' });
    const second = new TestElement('p', doc, { 'data-edit-id': 'p2', contenteditable: 'true' });
    first.textContent = 'First';
    second.textContent = 'Second';
    cellEl.append(first, second);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(previous, cellEl);
    const selected: TestElement[] = [];

    loadKeyboardNav().installKeyboardNavigation({
      document: doc,
      window: {
        getSelection: () => ({ rangeCount: 1, isCollapsed: true }),
      },
      getNavMap: () => ({
        c1: {
          ArrowLeft: { ok: true, targetId: 'c0', via: 'grid' },
        },
      }),
      editableTarget: (target: unknown) =>
        target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
      cellEditTarget: (target: unknown) => target,
      selectContents: (target: TestElement) => selected.push(target),
      caretOffset: () => 0,
      sourceTextLength: (target: TestElement) => target.textContent.length,
      setCaret: () => undefined,
      focusNonEditableTarget: () => undefined,
      announceNav: () => undefined,
    });

    const event = Object.assign(keyEvent('ArrowLeft'), { target: second });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(false);
    expect(doc.activeElement).toBeNull();
    expect(selected).toEqual([]);
  });

  test('arrow navigation can leave a multi-paragraph cell from the outer cell boundary', () => {
    const globalWithCss = globalThis as typeof globalThis & { CSS?: typeof CSS };
    const oldCss = globalWithCss.CSS;
    globalWithCss.CSS = { escape: (value: string) => value } as unknown as typeof CSS;
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const previous = cell('c0', 'Previous', doc);
    const cellEl = new TestElement('td', doc, { 'data-cell-id': 'c1' });
    const first = new TestElement('p', doc, { 'data-edit-id': 'p1', contenteditable: 'true' });
    const second = new TestElement('p', doc, { 'data-edit-id': 'p2', contenteditable: 'true' });
    first.textContent = 'First';
    second.textContent = 'Second';
    cellEl.append(first, second);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(previous, cellEl);
    const selected: TestElement[] = [];

    loadKeyboardNav().installKeyboardNavigation({
      document: doc,
      window: {
        getSelection: () => ({ rangeCount: 1, isCollapsed: true }),
      },
      getNavMap: () => ({
        c1: {
          ArrowLeft: { ok: true, targetId: 'c0', via: 'grid' },
        },
      }),
      editableTarget: (target: unknown) =>
        target instanceof TestElement && target.hasAttribute('contenteditable') ? target : null,
      cellEditTarget: (target: unknown) => target,
      selectContents: (target: TestElement) => selected.push(target),
      caretOffset: () => 0,
      sourceTextLength: (target: TestElement) => target.textContent.length,
      setCaret: () => undefined,
      focusNonEditableTarget: () => undefined,
      announceNav: () => undefined,
    });

    const event = Object.assign(keyEvent('ArrowLeft'), { target: first });
    try {
      dispatchKey(doc, event);
    } finally {
      globalWithCss.CSS = oldCss;
    }

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(previous);
    expect(selected).toEqual([previous]);
  });

  test('Tab moves forward through table cells without using the browser tab order', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);
    const selected: TestElement[] = [];

    installNav(doc, { selected });

    const event = Object.assign(keyEvent('Tab'), { target: first });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(second);
    expect(selected).toEqual([second]);
  });

  test('Shift+Tab moves backward through table cells', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);
    const selected: TestElement[] = [];

    installNav(doc, { selected });

    const event = Object.assign(keyEvent('Tab'), { target: second, shiftKey: true });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(first);
    expect(selected).toEqual([first]);
  });

  test('Tab crosses table row boundaries in rendered cell order', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const rowA = new TestElement('tr', doc);
    const rowB = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    const third = cell('c3', 'Gamma', doc);
    doc.main.appendChild(table);
    table.append(rowA, rowB);
    rowA.append(first, second);
    rowB.append(third);
    const selected: TestElement[] = [];

    installNav(doc, { selected });

    const event = Object.assign(keyEvent('Tab'), { target: second });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(third);
    expect(selected).toEqual([third]);
  });

  test('Tab at a table edge announces the boundary and keeps focus in the editor', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const only = cell('c1', 'Alpha', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.appendChild(only);
    doc.activeElement = only;
    const selected: TestElement[] = [];
    const announcements: string[] = [];

    installNav(doc, { selected, announcements });

    const event = Object.assign(keyEvent('Tab'), { target: only });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(only);
    expect(selected).toEqual([]);
    expect(announcements).toEqual(['Already at the last cell in the table']);
  });

  test('Tab at the last table cell moves to the next document element when navMap provides an escape', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const only = cell('c1', 'Alpha', doc);
    const after = new TestElement('p', doc, {
      'data-edit-id': 'p1',
      contenteditable: 'true',
    });
    after.textContent = 'After';
    doc.main.append(table, after);
    table.appendChild(row);
    row.appendChild(only);
    doc.activeElement = only;
    const selected: TestElement[] = [];

    installNav(doc, {
      selected,
      navMap: {
        c1: {
          ArrowDown: { ok: true, targetId: 'p1', via: 'document' },
        },
      },
    });

    const event = Object.assign(keyEvent('Tab'), { target: only });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(after);
    expect(selected).toEqual([after]);
  });

  test('Shift+Tab at the first table cell moves to the previous document element when navMap provides an escape', () => {
    const doc = new TestDocument();
    const before = new TestElement('p', doc, {
      'data-edit-id': 'p0',
      contenteditable: 'true',
    });
    before.textContent = 'Before';
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const only = cell('c1', 'Alpha', doc);
    doc.main.append(before, table);
    table.appendChild(row);
    row.appendChild(only);
    doc.activeElement = only;
    const selected: TestElement[] = [];

    installNav(doc, {
      selected,
      navMap: {
        c1: {
          ArrowUp: { ok: true, targetId: 'p0', via: 'document' },
        },
      },
    });

    const event = Object.assign(keyEvent('Tab'), { target: only, shiftKey: true });
    dispatchKey(doc, event);

    expect(event.prevented).toBe(true);
    expect(doc.activeElement).toBe(before);
    expect(selected).toEqual([before]);
  });

  test('does not double-handle Tab after the editing key handler claims it', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);
    doc.activeElement = first;
    const selected: TestElement[] = [];
    const announcements: string[] = [];

    installNav(doc, { selected, announcements });

    const event = Object.assign(keyEvent('Tab'), {
      target: first,
      defaultPrevented: true,
      prevented: true,
    });
    dispatchKey(doc, event);

    expect(doc.activeElement).toBe(first);
    expect(selected).toEqual([]);
    expect(announcements).toEqual([]);
  });

  test('Page/F2/Escape and modified Home/End are left to the browser or VS Code', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const row = new TestElement('tr', doc);
    const first = cell('c1', 'Alpha', doc);
    const second = cell('c2', 'Beta', doc);
    doc.main.appendChild(table);
    table.appendChild(row);
    row.append(first, second);
    doc.activeElement = first;
    const selected: TestElement[] = [];
    const announcements: string[] = [];

    installNav(doc, {
      selected,
      announcements,
      navMap: {
        c1: {
          Home: { ok: true, targetId: 'c1', via: 'grid' },
          End: { ok: true, targetId: 'c2', via: 'grid' },
        },
      },
    });

    const events = [
      Object.assign(keyEvent('PageUp'), { target: first }),
      Object.assign(keyEvent('PageDown'), { target: first }),
      Object.assign(keyEvent('F2'), { target: first }),
      Object.assign(keyEvent('Escape'), { target: first }),
      Object.assign(keyEvent('Home'), { target: first, ctrlKey: true }),
      Object.assign(keyEvent('End'), { target: first, metaKey: true }),
    ];

    for (const event of events) dispatchKey(doc, event);

    expect(events.map((event) => event.prevented)).toEqual([false, false, false, false, false, false]);
    expect(doc.activeElement).toBe(first);
    expect(selected).toEqual([]);
    expect(announcements).toEqual([]);
  });
});
