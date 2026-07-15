import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

type NativeMenu = {
  refresh(): void;
  execute(command: string, context: Record<string, any>): boolean;
};

function loadNativeContextMenu() {
  const source = readFileSync(new URL('../media/canvas-native-context-menu.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as Record<string, any>;
  new Function('window', source)(win);
  return win.DitaEditorCanvasNativeContextMenu;
}

function contextOf(element: TestElement): Record<string, any> {
  return JSON.parse(element.getAttribute('data-vscode-context') || '{}');
}

function mergedContext(...elements: TestElement[]): Record<string, any> {
  return Object.assign({}, ...elements.map(contextOf));
}

function fixture(overrides: Record<string, unknown> = {}) {
  const document = new TestDocument();
  const messages: unknown[] = [];
  let timerClears = 0;
  const table = document.createElement('table');
  table.setAttribute('data-struct-id', 'table1');
  table.setAttribute('data-struct-kind', 'table');
  const row = document.createElement('tr');
  row.setAttribute('data-struct-id', 'row1');
  row.setAttribute('data-struct-kind', 'row');
  const cell = document.createElement('td');
  cell.setAttribute('data-cell-id', 'cell1');
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-struct-id', 'p1');
  paragraph.setAttribute('data-struct-kind', 'p');
  const image = document.createElement('img');
  image.setAttribute('data-struct-id', 'image1');
  image.setAttribute('data-struct-kind', 'image');
  document.main.appendChild(table);
  table.appendChild(row);
  row.appendChild(cell);
  cell.appendChild(paragraph);
  cell.appendChild(image);

  const menu: NativeMenu = loadNativeContextMenu().installNativeContextMenu({
    document,
    vscode: { postMessage: (message: unknown) => messages.push(message) },
    getSessionId: () => 'session-a',
    getStructVersion: () => 7,
    getStyleState: () => ({ sourceHash: 'hash-a', targetToken: 'target-a' }),
    clearTimer: () => { timerClears++; },
    columnAnchorId: () => 'col1',
    availFor: (_id: string, op: string) => ({ enabled: op !== 'deleteColumn' }),
    transformAvailFor: (_id: string, transform: string) => ({ status: transform === 'entryToLines' ? 'noop' : 'ok' }),
    insertAvailFor: (_id: string, mode: string, kind: string) => ({ enabled: !(mode === 'into' && kind === 'section') }),
    withStructuralSuccess: (op: string, kind: string) => ({ announceOnSuccess: `${op}:${kind}` }),
    currentSelectionIds: () => ['cell1', 'cell2'],
    rangeActionForSelection: () => 'cellRectMerge',
    rangeAvailFor: () => ({ enabled: true }),
    ...overrides,
  });
  return { document, messages, table, row, cell, paragraph, image, menu, timerClears: () => timerClears };
}

describe('canvas native context menu', () => {
  test('decorates native targets without intercepting the browser contextmenu event', () => {
    const { document, cell, paragraph, image } = fixture();
    expect(document.listeners.get('contextmenu')).toBeUndefined();
    const context = contextOf(cell);
    expect({
      preventDefaultContextMenuItems: context.preventDefaultContextMenuItems,
      ditaNativeSession: context.ditaNativeSession,
      ditaNativeStructVersion: context.ditaNativeStructVersion,
      ditaNativeContext: context.ditaNativeContext,
      ditaNativeCellId: context.ditaNativeCellId,
      ditaNativeRowId: context.ditaNativeRowId,
      ditaNativeTableId: context.ditaNativeTableId,
      ditaNativeColumnId: context.ditaNativeColumnId,
      ditaNativeShowMerge: context.ditaNativeShowMerge,
      mergeEnabled: context['ditaNativeEnabled.range.cellRectMerge'],
      deleteColumnEnabled: context['ditaNativeEnabled.structural.column.deleteColumn'],
      linesEnabled: context['ditaNativeEnabled.transform.entryToLines'],
      cellInsert: context['ditaNativeHas.cellInto'],
    }).toEqual({
      preventDefaultContextMenuItems: true,
      ditaNativeSession: 'session-a',
      ditaNativeStructVersion: 7,
      ditaNativeContext: 'cell',
      ditaNativeCellId: 'cell1',
      ditaNativeRowId: 'row1',
      ditaNativeTableId: 'table1',
      ditaNativeColumnId: 'col1',
      ditaNativeShowMerge: true,
      mergeEnabled: true,
      deleteColumnEnabled: false,
      linesEnabled: false,
      cellInsert: false,
    });
    // Structural descendants inherit the cell menu. Images deliberately override it.
    expect(paragraph.getAttribute('data-vscode-context')).toBeNull();
    expect(contextOf(image)).toMatchObject({
      ditaNativeContext: 'image',
      ditaNativeTargetId: 'image1',
      ditaNativeKind: 'image',
      'ditaNativeHas.cellInto': true,
    });
  });

  test('refreshes target state from the latest generation and availability maps', () => {
    let generation = 2;
    let canDelete = false;
    const { paragraph, table, menu } = fixture({
      getStructVersion: () => generation,
      availFor: (_id: string, op: string) => ({ enabled: op !== 'deleteElement' || canDelete }),
    });
    expect(contextOf(paragraph)).toEqual({}); // paragraph is inside a cell
    // Use the table target because it owns its own element context.
    expect(contextOf(table).ditaNativeStructVersion).toBe(2);
    expect(contextOf(table)['ditaNativeEnabled.delete.table']).toBe(false);
    generation = 3;
    canDelete = true;
    menu.refresh();
    expect(contextOf(table).ditaNativeStructVersion).toBe(3);
  });

  test('decorates standalone elements, lists, and list items with their exact targets', () => {
    const { document, menu } = fixture();
    const standalone = document.createElement('p');
    standalone.setAttribute('data-struct-id', 'outside-p');
    standalone.setAttribute('data-struct-kind', 'p');
    const list = document.createElement('ol');
    list.setAttribute('data-struct-id', 'list1');
    list.setAttribute('data-struct-kind', 'ol');
    const item = document.createElement('li');
    item.setAttribute('data-struct-id', 'item1');
    item.setAttribute('data-struct-kind', 'li');
    const nested = document.createElement('p');
    nested.setAttribute('data-struct-id', 'nested-p');
    nested.setAttribute('data-struct-kind', 'p');
    document.main.appendChild(standalone);
    document.main.appendChild(list);
    list.appendChild(item);
    item.appendChild(nested);
    menu.refresh();

    expect(contextOf(standalone)).toMatchObject({
      ditaNativeContext: 'element', ditaNativeTargetId: 'outside-p', ditaNativeKind: 'p',
      'ditaNativeHas.selfBefore': true, 'ditaNativeHas.selfAfter': true,
    });
    expect(contextOf(list)).toMatchObject({
      ditaNativeContext: 'element', ditaNativeTargetId: 'list1', ditaNativeKind: 'ol',
      'ditaNativeEnabled.transform.toOrderedList': false,
    });
    expect(contextOf(item)).toMatchObject({
      ditaNativeContext: 'element', ditaNativeTargetId: 'item1', ditaNativeKind: 'li',
      'ditaNativeHas.selfInto': true,
      'ditaNativeEnabled.structural.target.indentItem': true,
    });
    expect(mergedContext(list, item, nested)).toMatchObject({
      ditaNativeTargetId: 'nested-p',
      'ditaNativeHas.selfBefore': true,
      'ditaNativeHas.selfAfter': true,
      'ditaNativeHas.selfInto': false,
      'ditaNativeTarget.selfInto': '',
    });

    const figure = document.createElement('figure');
    figure.setAttribute('data-struct-id', 'fig1');
    figure.setAttribute('data-struct-kind', 'fig');
    const figureImage = document.createElement('img');
    figureImage.setAttribute('data-struct-id', 'fig-image');
    figureImage.setAttribute('data-struct-kind', 'image');
    document.main.appendChild(figure);
    figure.appendChild(figureImage);
    menu.refresh();
    expect(mergedContext(figure, figureImage)).toMatchObject({
      ditaNativeContext: 'image',
      ditaNativeTargetId: 'fig-image',
      'ditaNativeHas.selfAfter': false,
      'ditaNativeTarget.selfAfter': '',
      'ditaNativeHas.figureAfter': true,
      'ditaNativeTarget.figureAfter': 'fig1',
    });
  });

  test('executes each command family with captured target ids, session, and generation', () => {
    const { messages, table, cell, image, menu, timerClears } = fixture();
    const tableContext = contextOf(table);
    const cellContext = contextOf(cell);
    const imageContext = contextOf(image);
    for (const [command, context] of [
      ['ditaeditor.context.transform.entryToParagraph', cellContext],
      ['ditaeditor.context.insert.cellInto.note', imageContext],
      ['ditaeditor.context.structural.row.addRowAfter', cellContext],
      ['ditaeditor.context.range.cellRectMerge', cellContext],
      ['ditaeditor.context.cals.cell.align.center', cellContext],
      ['ditaeditor.context.shade.cell.gold', cellContext],
      ['ditaeditor.context.tgroup.grid.none', cellContext],
      ['ditaeditor.context.image.alt', imageContext],
      ['ditaeditor.context.delete.image', imageContext],
      ['ditaeditor.context.clipboard.copy', tableContext],
    ] as const) expect(menu.execute(command, context)).toBe(true);

    expect(messages).toEqual([
      { type: 'transform', transform: 'entryToParagraph', id: 'cell1', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'insert', op: 'note', payload: { mode: 'into', containerId: 'cell1' }, nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'structural', op: 'addRowAfter', id: 'row1', announceOnSuccess: 'addRowAfter:row', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'rangeExecute', action: 'cellRectMerge', ids: ['cell1', 'cell2'], nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'setCalsAttr', id: 'cell1', attrName: 'align', attrValue: 'center', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'applyShade', ids: ['cell1'], sourceHash: 'hash-a', targetToken: 'target-a', color: '#f7f0e4', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'setTgroupAttr', id: 'table1', attrs: [{ name: 'colsep', value: '0' }, { name: 'rowsep', value: '0' }], nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'editImageAlt', id: 'image1', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'structural', op: 'deleteImage', id: 'image1', announceOnSuccess: 'deleteImage:image', nativeContextSession: 'session-a', baseStructVersion: 7 },
      { type: 'copyDita', ids: ['table1'], nativeContextSession: 'session-a', baseStructVersion: 7 },
    ]);
    expect(timerClears()).toBe(3);
  });
});
