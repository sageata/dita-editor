import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

type MenuOpen = {
  defs: Array<Record<string, any>>;
  opts: Record<string, any>;
};

function icons(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `<${name}>`]));
}

function loadContextMenu() {
  const source = readFileSync(new URL('../media/canvas-context-menu.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasContextMenu: {
      installContextMenu(opts: Record<string, unknown>): { close(restoreFocus: boolean): void; isOpen(): boolean };
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasContextMenu;
}

function dispatchContextMenu(doc: TestDocument, target: TestElement): { prevented: boolean } {
  const event = {
    target,
    clientX: 120,
    clientY: 80,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  for (const listener of doc.listeners.get('contextmenu') ?? []) listener(event);
  return event;
}

function defaultResolveInsertEntries(ctx: { id: string; kind?: string }) {
  const noun = ctx.kind === 'p' ? 'paragraph' : 'list item';
  return [
    { label: `Insert paragraph inside this ${noun}`, op: 'paragraph', payload: { mode: 'into', containerId: ctx.id } },
    { label: `Insert section inside this ${noun}`, op: 'section', payload: { mode: 'into', containerId: ctx.id } },
    { label: `Insert paragraph before this ${noun}`, op: 'paragraph', payload: { mode: 'before', refId: ctx.id } },
    { label: `Insert note before this ${noun}`, op: 'note', payload: { mode: 'before', refId: ctx.id } },
    { label: `Insert paragraph after this ${noun}`, op: 'paragraph', payload: { mode: 'after', refId: ctx.id } },
    { label: 'Insert table after this table', op: 'table', payload: { mode: 'after', refId: 'table1' } },
  ];
}

function testNounForKind(kind: string): string {
  switch (kind) {
    case 'p': return 'paragraph';
    case 'li': return 'list item';
    case 'lines': return 'lines block';
    case 'image': return 'image';
    case 'fig': return 'figure';
    case 'table': return 'table';
    default: return kind;
  }
}

function installForCapture(doc: TestDocument, open: MenuOpen, overrides: Record<string, unknown> = {}) {
  const menuIcons = icons([
    'paragraph',
    'ul',
    'alphaOl',
    'ol',
    'table',
    'tableCell',
    'lines',
    'note',
    'codeblock',
    'section',
    'convert',
    'indent',
    'outdent',
    'trash',
    'rowAdd',
    'rowDelete',
    'columnAdd',
    'columnDelete',
    'mergeRight',
    'mergeDown',
    'splitCell',
    'insertInside',
    'insertBefore',
    'insertAfter',
  ]);
  return loadContextMenu().installContextMenu({
    document: doc,
    vscode: overrides.vscode || { postMessage: () => undefined },
    menu: {
      createMenu: (_ariaLabel: string, _onToggle: (open: boolean) => void) => ({
        openAt: (defs: Array<Record<string, any>>, _x: number, _y: number, opts: Record<string, any>) => {
          open.defs = defs;
          open.opts = opts;
        },
        close: () => undefined,
        isOpen: () => false,
        contains: () => false,
      }),
    },
    menuIcons,
    menuIconForOp: (op: string) => `<${op}>`,
    editableTarget: () => null,
    toolbar: { style: { display: 'block' } },
    clearHideTimer: () => undefined,
    highlightCell: () => undefined,
    clearCellHighlight: () => undefined,
    caretOffset: () => 0,
    setCaret: () => undefined,
    columnAnchorId: (cell: TestElement) => cell.getAttribute('data-cell-id'),
    availFor: (_id: string, op: string) =>
      op === 'mergeRight' || op === 'outdentItem'
        ? { enabled: false, reason: 'Not available here' }
        : { enabled: true },
    postStructural: () => undefined,
    withStructuralSuccess: (_op: string, _kind: string, extra: unknown) => extra || {},
    transformAvailFor: (_id: string, transform: string) =>
      transform === 'toUnorderedList' || transform === 'entryToLines'
        ? { status: 'noop', reason: 'List is already a bulleted list' }
        : { status: 'ok' },
    postTransform: () => undefined,
    resolveInsertEntries: overrides.resolveInsertEntries || defaultResolveInsertEntries,
    insertAvailFor: (_id: string, mode: string, op: string) =>
      mode === 'into' && op === 'section' ? { enabled: false, reason: 'Not permitted inside list item' } : { enabled: true },
    idOfPayload: (payload: { mode: string; containerId?: string; refId?: string }) =>
      payload.mode === 'into' ? payload.containerId : payload.refId,
    nounForKind: overrides.nounForKind || testNounForKind,
    getStyleState: overrides.getStyleState || (() => ({})),
    getSelection: overrides.getSelection || (() => null),
    currentSelectionIds: overrides.currentSelectionIds || (() => []),
    rangeActionForSelection: overrides.rangeActionForSelection || (() => null),
    rangeAvailFor: overrides.rangeAvailFor || (() => null),
    announceNav: () => undefined,
    showError: () => undefined,
  });
}

describe('canvas-context-menu', () => {
  test('cell shading forwards the currently displayed managed stylesheet hash', () => {
    const doc = new TestDocument();
    const table = doc.createElement('table');
    table.setAttribute('data-struct-id', 'table1');
    table.setAttribute('data-struct-kind', 'table');
    const row = doc.createElement('tr');
    row.setAttribute('data-struct-id', 'row1');
    row.setAttribute('data-struct-kind', 'row');
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'cell1');
    doc.main.appendChild(table);
    table.appendChild(row);
    row.appendChild(cell);
    const open: MenuOpen = { defs: [], opts: {} };
    const messages: unknown[] = [];
    installForCapture(doc, open, {
      vscode: { postMessage: (message: unknown) => messages.push(message) },
      getStyleState: () => ({
        sourceHash: 'displayed-context-menu-hash',
        targetToken: 'displayed-context-menu-target-token',
      }),
    });

    dispatchContextMenu(doc, cell);
    const shading = open.defs.find((definition) => definition.label === 'Shading')!;
    shading.submenu.find((definition: Record<string, unknown>) => definition.label === 'Cell: Gold tint').onActivate();

    expect(messages).toEqual([{
      type: 'applyShade',
      ids: ['cell1'],
      color: '#f7f0e4',
      sourceHash: 'displayed-context-menu-hash',
      targetToken: 'displayed-context-menu-target-token',
      baseStructVersion: 0,
    }]);
  });

  test('table cell context menu matches frame E grouping and actions', () => {
    const doc = new TestDocument();
    const table = doc.createElement('table');
    table.setAttribute('data-struct-id', 'table1');
    table.setAttribute('data-struct-kind', 'table');
    const row = doc.createElement('tr');
    row.setAttribute('data-struct-id', 'row1');
    row.setAttribute('data-struct-kind', 'row');
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'cell1');
    doc.main.appendChild(table);
    table.appendChild(row);
    row.appendChild(cell);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open);

    const event = dispatchContextMenu(doc, cell);

    expect(event.prevented).toBe(true);
    expect(open.opts.width).toBe(340);
    expect(open.defs[0]).toEqual({
      elementHeader: { label: 'Table cell', icon: '<tableCell>', tag: '<entry>' },
    });
    expect(open.defs.filter((def) => def.header).map((def) => def.header)).toEqual([]);
    expect(open.defs.filter((def) => def.label).map((def) => def.label)).toEqual([
      'Convert content',
      'Row',
      'Column',
      'Borders',
      'Align text',
      'Vertical align',
      'Shading',
      'Table settings',
      'Delete this table',
    ]);
    const convert = open.defs.find((def) => def.label === 'Convert content')!;
    const lines = convert.submenu.find((def: Record<string, unknown>) => def.label === 'Convert content to lines')!;
    expect(lines.enabled).toBe(false);
    expect(lines.icon).toBe('<lines>');
    expect(open.defs.some((def) => String(def.label || '').startsWith('Merge with'))).toBe(false);
    const shading = open.defs.find((def) => def.label === 'Shading')!;
    expect(shading.submenu.map((def: Record<string, unknown>) => def.label).filter(Boolean)).toEqual([
      'Cell: Neutral', 'Cell: Gold tint', 'Cell: Blue tint', 'Cell: White', 'Cell: Custom color…', 'Cell: Clear',
      'Row: Neutral', 'Row: Gold tint', 'Row: Blue tint', 'Row: White', 'Row: Custom color…', 'Row: Clear',
    ]);
    const deleteTable = open.defs.find((def) => def.label === 'Delete this table')!;
    expect(deleteTable.del).toBe(true);
    expect(deleteTable.icon).toBe('<trash>');
  });

  test('shows only Merge selected cells for a mergeable rectangular selection', () => {
    const doc = new TestDocument();
    const table = doc.createElement('table');
    table.setAttribute('data-struct-id', 'table1');
    const row = doc.createElement('tr');
    row.setAttribute('data-struct-id', 'row1');
    row.setAttribute('data-struct-kind', 'row');
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'cell1');
    doc.main.appendChild(table);
    table.appendChild(row);
    row.appendChild(cell);
    const open: MenuOpen = { defs: [], opts: {} };
    const posted: unknown[] = [];
    installForCapture(doc, open, {
      vscode: { postMessage: (message: unknown) => posted.push(message) },
      getSelection: () => ({ mode: 'cellRect' }),
      currentSelectionIds: () => ['cell1', 'cell2'],
      rangeActionForSelection: () => 'cellRectMerge',
      rangeAvailFor: () => ({ enabled: true }),
    });

    dispatchContextMenu(doc, cell);
    const merge = open.defs.find((def) => def.label === 'Merge selected cells')!;
    expect(merge.enabled).toBe(true);
    merge.onActivate();
    expect(posted).toEqual([{ type: 'rangeExecute', action: 'cellRectMerge', ids: ['cell1', 'cell2'] }]);
  });

  test('list item context menu matches frame F fly-out grouping', () => {
    const doc = new TestDocument();
    const list = doc.createElement('ul');
    list.setAttribute('data-struct-id', 'list1');
    list.setAttribute('data-struct-kind', 'ul');
    const item = doc.createElement('li');
    item.setAttribute('data-struct-id', 'item1');
    item.setAttribute('data-struct-kind', 'li');
    doc.main.appendChild(list);
    list.appendChild(item);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open);

    const event = dispatchContextMenu(doc, item);

    expect(event.prevented).toBe(true);
    expect(open.opts.width).toBe(264);
    expect(open.opts.allowSubmenus).toBe(true);
    expect(open.defs[0]).toEqual({
      elementHeader: { label: 'List item', icon: '<ul>', tag: '<li>' },
    });

    const topLabels = open.defs.filter((def) => def.label).map((def) => def.label);
    expect(topLabels).toEqual([
      'Convert to',
      'Indent',
      'Outdent',
      'Insert inside',
      'Insert before',
      'Insert after',
      'Copy as DITA',
      'Paste DITA before',
      'Paste DITA after',
      'Delete this list item',
    ]);

    const convert = open.defs.find((def) => def.label === 'Convert to')!;
    expect(convert.submenu.map((def: Record<string, unknown>) => def.label)).toEqual([
      'Paragraph',
      'Alphabetic list',
      'Numbered list',
      'Bulleted list',
    ]);
    expect(convert.submenu[3].enabled).toBe(false);

    const inside = open.defs.find((def) => def.label === 'Insert inside')!;
    expect(inside.submenu.map((def: Record<string, unknown>) => def.label)).toEqual(['Paragraph', 'Section']);
    expect(inside.submenu[1].enabled).toBe(false);

    const after = open.defs.find((def) => def.label === 'Insert after')!;
    expect(after.submenu.map((def: Record<string, unknown>) => def.label)).toEqual(['Paragraph']);
    const outdent = open.defs.find((def) => def.label === 'Outdent')!;
    expect(outdent.shortcut).toBe('Shift+Tab');
    expect(outdent.enabled).toBe(false);
  });

  test('paragraph context menu uses list-style convert and insert fly-outs', () => {
    const doc = new TestDocument();
    const paragraph = doc.createElement('p');
    paragraph.setAttribute('data-struct-id', 'p1');
    paragraph.setAttribute('data-struct-kind', 'p');
    doc.main.appendChild(paragraph);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open, {
      resolveInsertEntries: (ctx: { id: string }) => [
        { label: 'Insert paragraph before this paragraph', op: 'paragraph', payload: { mode: 'before', refId: ctx.id } },
        { label: 'Insert note before this paragraph', op: 'note', payload: { mode: 'before', refId: ctx.id } },
        { label: 'Insert paragraph after this paragraph', op: 'paragraph', payload: { mode: 'after', refId: ctx.id } },
      ],
    });

    const event = dispatchContextMenu(doc, paragraph);

    expect(event.prevented).toBe(true);
    expect(open.opts.width).toBe(264);
    expect(open.opts.allowSubmenus).toBe(true);
    expect(open.defs[0]).toEqual({
      elementHeader: { label: 'paragraph', icon: '<paragraph>', tag: '<p>' },
    });
    expect(open.defs.filter((def) => def.header).map((def) => def.header)).toEqual([]);
    expect(open.defs.filter((def) => def.label).map((def) => def.label)).toEqual([
      'Convert to',
      'Insert before',
      'Insert after',
      'Copy as DITA',
      'Paste DITA before',
      'Paste DITA after',
      'Delete this paragraph',
    ]);

    const convert = open.defs.find((def) => def.label === 'Convert to')!;
    expect(convert.submenu.map((def: Record<string, unknown>) => def.label)).toEqual([
      'Section',
      'Bulleted list',
      'Alphabetic list',
      'Numbered list',
      'Note',
      'Code block',
      'List item',
    ]);

    const before = open.defs.find((def) => def.label === 'Insert before')!;
    expect(before.submenu.map((def: Record<string, unknown>) => def.label)).toEqual(['Paragraph', 'Note']);
    const del = open.defs.find((def) => def.label === 'Delete this paragraph')!;
    expect(del.shortcut).toBe('Del');
  });

  test('lines context menu exposes the same convert fly-out pattern', () => {
    const doc = new TestDocument();
    const lines = doc.createElement('pre');
    lines.setAttribute('data-struct-id', 'lines1');
    lines.setAttribute('data-struct-kind', 'lines');
    doc.main.appendChild(lines);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open, { resolveInsertEntries: () => [] });

    const event = dispatchContextMenu(doc, lines);

    expect(event.prevented).toBe(true);
    expect(open.opts.allowSubmenus).toBe(true);
    expect(open.defs.filter((def) => def.label).map((def) => def.label)).toEqual([
      'Convert to',
      'Copy as DITA',
      'Paste DITA before',
      'Paste DITA after',
      'Delete this lines block',
    ]);
    const convert = open.defs.find((def) => def.label === 'Convert to')!;
    expect(convert.submenu.map((def: Record<string, unknown>) => def.label)).toEqual([
      'Paragraph',
      'Bulleted list',
      'Alphabetic list',
      'Numbered list',
      'Section',
      'Note',
      'Code block',
    ]);
  });

  test('nested figure elements keep parent insert targets in grouped fly-out labels', () => {
    const doc = new TestDocument();
    const fig = doc.createElement('figure');
    fig.setAttribute('data-struct-id', 'fig1');
    fig.setAttribute('data-struct-kind', 'fig');
    const image = doc.createElement('img');
    image.setAttribute('data-struct-id', 'image1');
    image.setAttribute('data-struct-kind', 'image');
    doc.main.appendChild(fig);
    fig.appendChild(image);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open, {
      resolveInsertEntries: () => [
        { label: 'Insert paragraph after this figure', op: 'paragraph', payload: { mode: 'after', refId: 'fig1' } },
        { label: 'Insert table after this figure', op: 'table', payload: { mode: 'after', refId: 'fig1' } },
      ],
    });

    const event = dispatchContextMenu(doc, image);

    expect(event.prevented).toBe(true);
    expect(open.opts.allowSubmenus).toBe(true);
    // IX-9: images open the image-specific menu — image-bar actions first, then
    // the same grouped insert fly-outs and delete the element menu offered.
    expect(open.defs.filter((def) => def.label).map((def) => def.label)).toEqual([
      'Change image…',
      'Edit alt text…',
      'Resize image…',
      'Insert after figure',
      'Delete this image',
    ]);
    const afterFigure = open.defs.find((def) => def.label === 'Insert after figure')!;
    expect(afterFigure.submenu.map((def: Record<string, unknown>) => def.label)).toEqual(['Paragraph', 'Table']);
  });

  test('an image inside a table cell opens image actions instead of cell actions', () => {
    const doc = new TestDocument();
    const row = doc.createElement('tr');
    row.setAttribute('data-struct-id', 'row1');
    row.setAttribute('data-struct-kind', 'row');
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'cell1');
    const image = doc.createElement('img');
    image.setAttribute('data-struct-id', 'image1');
    image.setAttribute('data-struct-kind', 'image');
    doc.main.appendChild(row);
    row.appendChild(cell);
    cell.appendChild(image);
    const open: MenuOpen = { defs: [], opts: {} };
    installForCapture(doc, open, { resolveInsertEntries: () => [] });

    dispatchContextMenu(doc, image);

    expect(open.defs.filter((def) => def.label).map((def) => def.label)).toEqual([
      'Change image…',
      'Edit alt text…',
      'Resize image…',
      'Delete this image',
    ]);
  });
});
