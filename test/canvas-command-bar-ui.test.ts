import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

function makeControls(doc: TestDocument) {
  return {
    makeBtn: (_label: string, title: string) => {
      const btn = doc.createElement('button');
      btn.dataset.action = title;
      btn.setAttribute('aria-label', title);
      return btn;
    },
  };
}

function icons(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `<${name}>`]));
}

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-command-bar-ui.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  interface CommandBarUi {
    cmdBar: TestElement;
    cmdStatus: TestElement;
    cmdBtns: TestElement[];
    biParagraph: TestElement;
    biTable: TestElement;
    inlineInsertBtns: TestElement[];
    aiList: TestElement;
    fmtOp: Record<string, string>;
    fmtSelector: Record<string, string>;
    inlineInsertOp: Record<string, string>;
    fmtBtnByOp: Record<string, TestElement>;
    fmtBold: TestElement;
    tableDivider: TestElement;
    topicGroup: { wrap: TestElement; label: TestElement };
    topicDivider: TestElement;
    biLines: TestElement;
  }
  const win = {} as {
    DitaEditorCanvasCommandBarUi: {
      createCommandBarUi(opts: Record<string, unknown>): CommandBarUi;
    };
  };
  const doc = new TestDocument();
  new Function('window', source)(win);
  const ui = win.DitaEditorCanvasCommandBarUi.createCommandBarUi({
    document: doc,
    fontFamily: 'sans-serif',
    controls: makeControls(doc),
    menuIcons: icons(['paragraph', 'section', 'ul', 'alphaOl', 'ol', 'lines', 'note', 'codeblock', 'indent', 'outdent', 'table']),
    barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
  });
  return { doc, ui };
}

describe('canvas-command-bar-ui', () => {
  test('builds the command bar shell and stable button groups', () => {
    const { doc, ui } = loadHelper();

    expect((ui.cmdBar as TestElement).getAttribute('role')).toBe('toolbar');
    expect(ui.topicGroup.wrap.getAttribute('role')).toBe('group');
    expect(ui.topicGroup.wrap.getAttribute('aria-labelledby')).toBe(ui.topicGroup.label.id);
    expect(ui.topicDivider.getAttribute('aria-hidden')).toBe('true');
    expect(doc.main.style.paddingTop).toBe('var(--ditaeditor-toolbar-height, 72px)');
    expect(ui.cmdBtns as TestElement[]).toHaveLength(40);
    expect((ui as unknown as { vZoomPct: TestElement }).vZoomPct.textContent).toBe('100%');
    expect((ui as unknown as { vHelp: TestElement }).vHelp.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    expect((ui.cmdStatus as TestElement).textContent).toBe('DITA · visual');
    // The EDIT group (Save + cryptic element-edit icon buttons) is gone: its
    // actions live on the keyboard (Cmd/Ctrl+S, Alt+Arrow move, clipboard).
    for (const gone of [
      'Save document',
      'Copy selected element as DITA',
      'Paste DITA before selected element',
      'Paste DITA after selected element',
      'Delete selected element',
      'Move selected element earlier',
      'Move selected element later',
    ]) {
      expect(doc.body.querySelector(`[aria-label="${gone}"]`)).toBeNull();
    }
    expect((ui as unknown as { eSave?: TestElement }).eSave).toBeUndefined();
    expect((ui as unknown as { editGroup?: unknown }).editGroup).toBeUndefined();
    expect((ui.biParagraph as TestElement).getAttribute('aria-label')).toBe('Paragraph');
    expect((ui.aiList as TestElement).getAttribute('aria-label')).toBe('Alphabetic list');
    expect((ui.biLines as TestElement).getAttribute('aria-label')).toBe('Lines');
    expect((ui as unknown as { biIndent: TestElement }).biIndent.getAttribute('aria-label')).toBe('Increase indent');
    expect((ui as unknown as { biOutdent: TestElement }).biOutdent.getAttribute('aria-label')).toBe('Decrease indent');
    expect((ui.biTable as TestElement).getAttribute('aria-label')).toBe('Table');
    expect((ui as unknown as { cAlignHorizontal: TestElement }).cAlignHorizontal.getAttribute('aria-label')).toBe('Horizontal alignment');
    expect((ui as unknown as { cAlignVertical: TestElement }).cAlignVertical.getAttribute('aria-label')).toBe('Vertical alignment');
    expect((ui as unknown as { cAlignHorizontal: TestElement }).cAlignHorizontal.parentElement).toBe(
      (ui as unknown as { fmtGroup: { row: TestElement } }).fmtGroup.row,
    );
    expect((ui as unknown as { cAlignVertical: TestElement }).cAlignVertical.parentElement).toBe(
      (ui as unknown as { tableGroup: { row: TestElement } }).tableGroup.row,
    );
    expect((ui.inlineInsertBtns as TestElement[]).map((btn) => btn.getAttribute('aria-label'))).toEqual([
      'Image',
      'Cross-reference',
      'Reuse content',
    ]);
  });

  test('lays all groups on one row with a hidden overflow caret and popover', () => {
    const { doc, ui } = loadHelper();
    const bar = ui as unknown as {
      cmdBar: TestElement;
      cmdRows: TestElement;
      cmdRow: TestElement;
      cmdRowEntries: Array<{ wrap: TestElement; divider: TestElement | null }>;
      moreBtn: TestElement;
      overflowPop: TestElement;
      cmdStatus: TestElement;
      topicGroup: { wrap: TestElement };
      historyGroup: { wrap: TestElement };
      fmtGroup: { wrap: TestElement };
      structGroup: { wrap: TestElement };
      insertGroup: { wrap: TestElement };
      tableGroup: { wrap: TestElement };
      viewGroup: { wrap: TestElement };
      cmdBtns: TestElement[];
    };

    expect(bar.cmdRows.parentElement).toBe(bar.cmdBar);
    expect(bar.cmdRow.parentElement).toBe(bar.cmdRows);
    expect(bar.cmdRows.children).toHaveLength(1);
    expect(bar.cmdStatus.parentElement).toBe(bar.cmdRow);
    // Canonical group order on the single row; every group parents to it.
    expect(bar.cmdRowEntries.map((entry) => entry.wrap)).toEqual([
      bar.topicGroup.wrap,
      bar.historyGroup.wrap,
      bar.fmtGroup.wrap,
      bar.structGroup.wrap,
      bar.insertGroup.wrap,
      bar.tableGroup.wrap,
      bar.viewGroup.wrap,
    ]);
    for (const entry of bar.cmdRowEntries) {
      expect(entry.wrap.parentElement).toBe(bar.cmdRow);
    }
    // Every group after the first is preceded by a divider.
    expect(bar.cmdRowEntries[0].divider).toBeNull();
    for (const entry of bar.cmdRowEntries.slice(1)) {
      expect(entry.divider).toBeInstanceOf(TestElement);
    }

    expect(bar.moreBtn.parentElement).toBe(bar.cmdBar);
    expect(bar.moreBtn.style.display).toBe('none');
    expect(bar.moreBtn.getAttribute('aria-haspopup')).toBe('true');
    expect(bar.moreBtn.getAttribute('aria-expanded')).toBe('false');
    expect(bar.moreBtn.getAttribute('aria-controls')).toBe('ditaeditor-command-overflow');
    expect(bar.cmdBtns.at(-1)).toBe(bar.moreBtn);

    expect(bar.overflowPop.parentElement).toBe(doc.body);
    expect(bar.overflowPop.id).toBe('ditaeditor-command-overflow');
    expect(bar.overflowPop.getAttribute('role')).toBe('group');
    expect(bar.overflowPop.getAttribute('aria-label')).toBe('More commands');
    expect(bar.overflowPop.style.display).toBe('none');
  });

  test('bar buttons opt out of native titles in favor of the custom tooltip', () => {
    const { ui } = loadHelper();
    for (const btn of ui.cmdBtns as TestElement[]) {
      expect(btn.dataset.tooltipOnly).toBe('1');
      expect(btn.title).toBe('');
    }
  });

  test('returns the command maps consumed by canvas-command-bar behavior', () => {
    const { ui } = loadHelper();

    expect((ui.fmtOp as Record<string, string>).Bold).toBe('b');
    expect((ui.fmtSelector as Record<string, string>).codeph).toBe('code.ph.codeph,code');
    expect((ui.inlineInsertOp as Record<string, string>).Image).toBe('image');
    expect((ui.fmtBtnByOp as Record<string, TestElement>).b).toBe(ui.fmtBold);
    expect(ui.tableDivider).toBeInstanceOf(TestElement);
  });
});
