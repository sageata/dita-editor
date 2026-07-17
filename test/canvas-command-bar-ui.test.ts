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
    editGroup: { wrap: TestElement; label: TestElement };
    editDivider: TestElement;
    eSave: TestElement;
    eCopy: TestElement;
    ePasteBefore: TestElement;
    ePasteAfter: TestElement;
    eDelete: TestElement;
    eMoveEarlier: TestElement;
    eMoveLater: TestElement;
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
    expect(ui.editGroup.wrap.getAttribute('role')).toBe('group');
    expect(ui.editGroup.wrap.getAttribute('aria-labelledby')).toBe(ui.editGroup.label.id);
    expect(ui.editDivider.getAttribute('aria-hidden')).toBe('true');
    expect(doc.main.style.paddingTop).toBe('var(--ditaeditor-toolbar-height, 72px)');
    expect(ui.cmdBtns as TestElement[]).toHaveLength(46);
    expect((ui as unknown as { vZoomPct: TestElement }).vZoomPct.textContent).toBe('100%');
    expect((ui as unknown as { vHelp: TestElement }).vHelp.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    expect((ui.cmdStatus as TestElement).textContent).toBe('DITA · visual');
    expect([
      ui.eSave, ui.eCopy, ui.ePasteBefore, ui.ePasteAfter,
      ui.eDelete, ui.eMoveEarlier, ui.eMoveLater,
    ].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Save document',
      'Copy selected element as DITA',
      'Paste DITA before selected element',
      'Paste DITA after selected element',
      'Delete selected element',
      'Move selected element earlier',
      'Move selected element later',
    ]);
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

  test('returns the command maps consumed by canvas-command-bar behavior', () => {
    const { ui } = loadHelper();

    expect((ui.fmtOp as Record<string, string>).Bold).toBe('b');
    expect((ui.fmtSelector as Record<string, string>).codeph).toBe('code.ph.codeph,code');
    expect((ui.inlineInsertOp as Record<string, string>).Image).toBe('image');
    expect((ui.fmtBtnByOp as Record<string, TestElement>).b).toBe(ui.fmtBold);
    expect(ui.tableDivider).toBeInstanceOf(TestElement);
  });
});
