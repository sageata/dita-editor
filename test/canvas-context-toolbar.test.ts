import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

function makeControls(doc: TestDocument) {
  return {
    nextRovingIndex: () => 0,
    makeBtn: (label: string, title: string) => {
      const btn = doc.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.dataset.action = title;
      btn.setAttribute('aria-label', title);
      return btn;
    },
    isUnavailable: (btn: TestElement) => btn.getAttribute('aria-disabled') === 'true',
    setBtnEnabled: (btn: TestElement, ok: boolean, title: string) => {
      if (ok) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', 'true');
      btn.title = title;
      btn.setAttribute('aria-label', title);
    },
    makeSep: () => doc.createElement('span'),
  };
}

function installToolbar(extraOpts: Record<string, unknown> = {}) {
  const helperSource = readFileSync(new URL('../media/canvas-context-toolbar-state.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../media/canvas-context-toolbar.js', import.meta.url), 'utf8');
  expect(helperSource).not.toContain('acquireVsCodeApi');
  expect(source).not.toContain('acquireVsCodeApi');
  const doc = new TestDocument();
  const posted: unknown[] = [];
  const announced: string[] = [];
  const win = {} as {
    DitaEditorCanvasContextToolbarState: Record<string, unknown>;
    DitaEditorCanvasContextToolbar: {
      installContextToolbar(opts: Record<string, unknown>): {
        isShown(): boolean;
        getCurrent(): Record<string, unknown> | null;
        showFor(structEl: TestElement, cellEl: TestElement | null): void;
        visibleBtns(): TestElement[];
      };
    };
  };
  new Function('window', helperSource)(win);
  new Function('window', 'document', source)(win, doc);
  const controls = makeControls(doc);
  const toolbar = win.DitaEditorCanvasContextToolbar.installContextToolbar({
    document: doc,
    window: { scrollX: 0, scrollY: 0, innerHeight: 800 },
    vscode: { postMessage: (msg: unknown) => posted.push(msg) },
    controls,
    ADD_OP: { p: 'addParaAfter', row: 'addRowAfter' },
    DEL_OP: { p: 'deletePara', row: 'deleteRow' },
    editableTarget: () => null,
    structTarget: () => null,
    caretOffset: () => 0,
    setCaret: () => undefined,
    availFor: () => ({ enabled: true }),
    applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls.setBtnEnabled(btn, true, label),
    postStructural: (op: string, id: string, extra?: Record<string, unknown>) => posted.push({ type: 'structural', op, id, ...extra }),
    withStructuralSuccess: (op: string, kind: string, extra?: Record<string, unknown>) => ({
      ...(extra || {}),
      announceOnSuccess: `${op}:${kind}`,
    }),
    getSelection: () => null,
    isMultiSelection: () => false,
    selectionCount: () => 0,
    singleTargetMultiReason: () => '',
    rangeActionForSelection: () => null,
    rangeAvailFor: () => null,
    currentSelectionIds: () => [],
    getInsertMenuController: () => null,
    getContextMenuController: () => null,
    getImageBar: () => null,
    announceNav: (message: string) => announced.push(message),
    ...extraOpts,
  });
  return { toolbar, posted, announced, doc };
}

describe('canvas-context-toolbar', () => {
  test('the visual canvas disables the floating hover toolbar', () => {
    const canvasSource = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');
    expect(canvasSource).toContain('floatingEnabled: false,');
  });

  test('can be disabled so hover never shows the floating structural controls', () => {
    const { toolbar, doc } = installToolbar({ floatingEnabled: false });
    const paragraph = doc.createElement('p');
    paragraph.setAttribute('data-struct-id', 'p1');
    paragraph.setAttribute('data-struct-kind', 'p');

    toolbar.showFor(paragraph, null);

    expect(toolbar.isShown()).toBe(false);
    expect(toolbar.getCurrent()).toBeNull();
    expect(doc.listeners.get('mouseover')).toBeUndefined();
    expect(doc.listeners.get('mouseout')).toBeUndefined();
    expect(doc.listeners.get('keydown')).toBeUndefined();
  });

  test('structural clicks post host-confirmed success text without local success announcement', () => {
    const { toolbar, posted, announced, doc } = installToolbar();
    const paragraph = doc.createElement('p');
    paragraph.setAttribute('data-struct-id', 'p1');
    paragraph.setAttribute('data-struct-kind', 'p');

    toolbar.showFor(paragraph, null);
    toolbar.visibleBtns()[0].click();

    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'addParaAfter',
        id: 'p1',
        announceOnSuccess: 'addParaAfter:p',
      },
    ]);
    expect(announced).toEqual([]);
  });

  test('nested cell paragraphs expose table row and column controls', () => {
    const { toolbar, posted, doc } = installToolbar();
    const table = doc.createElement('table');
    const row = doc.createElement('tr');
    row.setAttribute('data-struct-id', 'r1');
    row.setAttribute('data-struct-kind', 'row');
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'c1');
    const paragraph = doc.createElement('p');
    paragraph.setAttribute('data-struct-id', 'p1');
    paragraph.setAttribute('data-struct-kind', 'p');
    cell.appendChild(paragraph);
    row.appendChild(cell);
    table.appendChild(row);
    doc.main.appendChild(table);

    toolbar.showFor(paragraph, cell);

    expect(toolbar.getCurrent()).toMatchObject({
      id: 'r1',
      kind: 'row',
      rowId: 'r1',
      cellId: 'c1',
      cellEntryId: 'c1',
    });
    expect(toolbar.visibleBtns().map((btn) => btn.textContent)).toContain('+|');

    const addColumn = toolbar.visibleBtns().find((btn) => btn.textContent === '+|');
    addColumn?.click();

    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'addColumnAfter',
        id: 'c1',
        announceOnSuccess: 'addColumnAfter:row',
      },
    ]);
  });
});
