import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, TestText, keyEvent } from './canvas-test-dom';

function icons(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `<${name}>`]));
}

function controls(doc: TestDocument) {
  return {
    makeBtn: (_label: string, title: string) => {
      const btn = doc.createElement('button');
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
    nextRovingIndex: (visibleCount: number, currentIdx: number, key: string) => {
      const last = visibleCount - 1;
      if (visibleCount <= 0) return -1;
      if (key === 'Home') return 0;
      if (key === 'End') return last;
      if (key === 'ArrowLeft') return Math.max(0, currentIdx - 1);
      if (key === 'ArrowRight') return Math.min(last, currentIdx + 1);
      return currentIdx;
    },
  };
}

function loadCommandBar(win: Record<string, unknown>, doc: TestDocument): void {
  const sources = [
    '../media/canvas-text-metrics.js',
    '../media/canvas-command-format.js',
    '../media/canvas-command-shortcuts.js',
    '../media/canvas-command-insert.js',
    '../media/canvas-command-structure.js',
    '../media/canvas-command-bar-ui.js',
    '../media/canvas-command-bar.js',
  ];
  for (const rel of sources) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(source).not.toContain('acquireVsCodeApi()');
    new Function('window', 'document', source)(win, doc);
  }
}

function buttonByAction(doc: TestDocument, action: string): TestElement {
  const btn = doc.body.querySelectorAll('button').find((button) => button.dataset.action === action);
  if (!btn) throw new Error(`button not found: ${action}`);
  return btn;
}

describe('canvas-command-bar Structure transform clicks', () => {
  test('clicking Structure buttons on direct note prose transforms it instead of appending blocks', () => {
    const doc = new TestDocument();
    const note = new TestElement('div', doc, {
      'data-struct-id': 'n1',
      'data-struct-kind': 'note',
      'data-edit-id': 'n1',
      contenteditable: 'true',
    });
    note.append(new TestText('Direct note'));
    doc.main.appendChild(note);
    doc.activeElement = note;

    const inserts: unknown[] = [];
    const transforms: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: note,
        getRangeAt: () => ({ startContainer: note, startOffset: 1, endContainer: note, endOffset: 1 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (message: unknown) => inserts.push(message) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => null,
      getStructVersion: () => 5,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 3,
      columnAnchorId: () => null,
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => transforms.push({ transform, id }),
      announceNav: () => undefined,
    });

    const paragraph = buttonByAction(doc, 'Paragraph');
    const unordered = buttonByAction(doc, 'Bulleted list');
    const table = buttonByAction(doc, 'Table');
    expect(paragraph.getAttribute('aria-disabled')).toBeNull();
    expect(unordered.getAttribute('aria-disabled')).toBeNull();
    expect(table.getAttribute('aria-disabled')).toBe('true');

    paragraph.click();
    unordered.click();
    table.click();

    expect(transforms).toEqual([
      { transform: 'noteContentToParagraph', id: 'n1' },
      { transform: 'noteContentToUnorderedList', id: 'n1' },
    ]);
    expect(inserts).toEqual([]);
  });

  test('a mixed note transforms the clicked text run in place, not the note tail', () => {
    const doc = new TestDocument();
    const note = new TestElement('div', doc, {
      'data-struct-id': 'n1',
      'data-struct-kind': 'note',
    });
    const run = new TestElement('span', doc, {
      'data-edit-id': 'n1:t0',
      'data-edit-run': 'true',
      contenteditable: 'true',
    });
    run.append(new TestText('Direct note'));
    note.appendChild(run);
    const list = new TestElement('ul', doc, {
      'data-struct-id': 'u1',
      'data-struct-kind': 'ul',
    });
    note.appendChild(list);
    doc.main.appendChild(note);
    doc.activeElement = run;

    const inserts: unknown[] = [];
    const transforms: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: run,
        getRangeAt: () => ({ startContainer: run, startOffset: 1, endContainer: run, endOffset: 1 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (message: unknown) => inserts.push(message) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => null,
      getStructVersion: () => 5,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 3,
      columnAnchorId: () => null,
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => transforms.push({ transform, id }),
      announceNav: () => undefined,
    });

    buttonByAction(doc, 'Paragraph').click();
    buttonByAction(doc, 'Bulleted list').click();

    expect(transforms).toEqual([
      { transform: 'noteContentToParagraph', id: 'n1:t0' },
      { transform: 'noteContentToUnorderedList', id: 'n1:t0' },
    ]);
    expect(inserts).toEqual([]);
  });

  test('a paragraph inside a note transforms at the end caret instead of appending empty siblings', () => {
    const doc = new TestDocument();
    const note = new TestElement('div', doc, {
      'data-struct-id': 'n1',
      'data-struct-kind': 'note',
    });
    const paragraph = new TestElement('p', doc, {
      'data-struct-id': 'p1',
      'data-struct-kind': 'p',
      'data-edit-id': 'p1',
      contenteditable: 'true',
    });
    paragraph.append(new TestText('Existing note paragraph'));
    note.appendChild(paragraph);
    doc.main.appendChild(note);
    doc.activeElement = paragraph;

    const inserts: unknown[] = [];
    const transforms: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: paragraph,
        getRangeAt: () => ({ startContainer: paragraph, startOffset: 1, endContainer: paragraph, endOffset: 1 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (message: unknown) => inserts.push(message) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => null,
      getStructVersion: () => 5,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => paragraph.textContent.length,
      columnAnchorId: () => null,
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => transforms.push({ transform, id }),
      announceNav: () => undefined,
    });

    const paragraphButton = buttonByAction(doc, 'Paragraph');
    const listButton = buttonByAction(doc, 'Bulleted list');
    expect(paragraphButton.getAttribute('aria-disabled')).toBe('true');
    expect(paragraphButton.getAttribute('aria-label')).toBe('Already a paragraph');
    expect(listButton.getAttribute('aria-disabled')).toBeNull();
    expect(listButton.getAttribute('aria-label')).toBe('Convert to bulleted list');

    paragraphButton.click();
    listButton.click();

    expect(transforms).toEqual([{ transform: 'paragraphToUnorderedList', id: 'p1' }]);
    expect(inserts).toEqual([]);
  });

  test('clicking Structure buttons in a direct <entry> posts entry transforms', () => {
    const doc = new TestDocument();
    const row = new TestElement('tr', doc, {
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
    });
    const cell = new TestElement('td', doc, {
      'data-cell-id': 'c1',
      'data-edit-id': 'c1',
      contenteditable: 'true',
    });
    cell.append(new TestText('Cell text'));
    row.appendChild(cell);
    const table = new TestElement('table', doc);
    table.appendChild(row);
    doc.main.appendChild(table);
    doc.activeElement = cell;

    const posted: Array<{ transform: string; id: string | null }> = [];
    const messages: unknown[] = [];
    const alignmentMenus = new Map<string, Array<Record<string, any>>>();
    const announcements: string[] = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: cell,
        getRangeAt: () => ({ startContainer: cell, startOffset: 0, endContainer: cell, endOffset: 0 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (message: unknown) => messages.push(message) },
      menu: {
        createMenu: (label: string) => ({
          openAt: (defs: Array<Record<string, any>>) => alignmentMenus.set(label, defs),
          close: () => undefined,
          isOpen: () => false,
        }),
      },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => null,
      getStructVersion: () => 3,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 0,
      columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => posted.push({ transform, id }),
      announceNav: (message: string) => announcements.push(message),
    });

    const paragraph = buttonByAction(doc, 'Paragraph');
    const lines = buttonByAction(doc, 'Lines');
    const ordered = buttonByAction(doc, 'Numbered list');
    const unordered = buttonByAction(doc, 'Bulleted list');

    expect(paragraph.getAttribute('aria-disabled')).toBeNull();
    expect(lines.getAttribute('aria-disabled')).toBeNull();
    expect(ordered.getAttribute('aria-disabled')).toBeNull();
    expect(unordered.getAttribute('aria-disabled')).toBeNull();
    const horizontal = buttonByAction(doc, 'Horizontal alignment');
    const vertical = buttonByAction(doc, 'Vertical alignment');
    expect(horizontal.style.display).toBe('inline-flex');
    expect(vertical.style.display).toBe('inline-flex');
    expect(horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Default');
    expect(vertical.getAttribute('aria-label')).toBe('Vertical alignment: Default');

    paragraph.click();
    lines.click();
    ordered.click();
    unordered.click();
    horizontal.focus();
    const enter = keyEvent('Enter');
    doc.body.children.find((element) => element.getAttribute('role') === 'toolbar')!.dispatch('keydown', enter);
    expect(enter.prevented).toBe(true);
    alignmentMenus.get('Horizontal alignment')!.find((item) => item.label === 'Center')!.onActivate();
    alignmentMenus.get('Horizontal alignment')!.find((item) => item.label === 'Default')!.onActivate();
    vertical.click();
    alignmentMenus.get('Vertical alignment')!.find((item) => item.label === 'Bottom')!.onActivate();
    alignmentMenus.get('Vertical alignment')!.find((item) => item.label === 'Default')!.onActivate();

    expect(posted).toEqual([
      { transform: 'entryToParagraph', id: 'c1' },
      { transform: 'entryToLines', id: 'c1' },
      { transform: 'entryToOrderedList', id: 'c1' },
      { transform: 'entryToUnorderedList', id: 'c1' },
    ]);
    expect(announcements).toEqual([]);
    expect(messages).toEqual([
      { type: 'setCalsAttr', id: 'c1', attrName: 'align', attrValue: 'center', baseStructVersion: 3 },
      { type: 'setCalsAttr', id: 'c1', attrName: 'align', attrValue: '', baseStructVersion: 3 },
      { type: 'setCalsAttr', id: 'c1', attrName: 'valign', attrValue: 'bottom', baseStructVersion: 3 },
      { type: 'setCalsAttr', id: 'c1', attrName: 'valign', attrValue: '', baseStructVersion: 3 },
    ]);
  });

  test('clicking Structure buttons on focused table-cell lines posts line-block transforms', () => {
    const doc = new TestDocument();
    const row = new TestElement('tr', doc, {
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
    });
    const cell = new TestElement('td', doc, {
      'data-cell-id': 'c1',
    });
    const lines = new TestElement('pre', doc, {
      class: 'lines',
      'data-struct-id': 'l1',
      'data-struct-kind': 'lines',
      'data-edit-id': 'l1',
      contenteditable: 'true',
    });
    lines.append(new TestText('First\nSecond'));
    cell.appendChild(lines);
    row.appendChild(cell);
    const table = new TestElement('table', doc);
    table.appendChild(row);
    doc.main.appendChild(table);
    doc.activeElement = lines;

    const posted: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: lines,
        getRangeAt: () => ({ startContainer: lines, startOffset: 0, endContainer: lines, endOffset: 0 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: () => undefined },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => null,
      getStructVersion: () => 4,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 0,
      columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: (_id: string, transform: string) =>
        transform === 'linesToSection'
          ? { status: 'invalid', reason: '<section> is not allowed in <entry>' }
          : { status: 'ok' },
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => posted.push({ transform, id }),
      announceNav: () => undefined,
    });

    const paragraph = buttonByAction(doc, 'Paragraph');
    const ordered = buttonByAction(doc, 'Numbered list');
    const note = buttonByAction(doc, 'Note');
    const section = buttonByAction(doc, 'Section heading');

    expect(paragraph.getAttribute('aria-disabled')).toBeNull();
    expect(ordered.getAttribute('aria-disabled')).toBeNull();
    expect(note.getAttribute('aria-disabled')).toBeNull();
    expect(section.getAttribute('aria-disabled')).toBe('true');

    paragraph.click();
    ordered.click();
    note.click();

    expect(posted).toEqual([
      { transform: 'linesToParagraph', id: 'l1' },
      { transform: 'linesToOrderedList', id: 'l1' },
      { transform: 'linesToNote', id: 'l1' },
    ]);
  });

  test('clicking Structure list buttons with multiple paragraphs selected posts one batch transform', () => {
    const doc = new TestDocument();
    const first = new TestElement('p', doc, {
      'data-struct-id': 'p1',
      'data-struct-kind': 'p',
      'data-edit-id': 'p1',
      contenteditable: 'true',
    });
    const second = new TestElement('p', doc, {
      'data-struct-id': 'p2',
      'data-struct-kind': 'p',
      'data-edit-id': 'p2',
      contenteditable: 'true',
    });
    first.append(new TestText('First'));
    second.append(new TestText('Second'));
    doc.main.append(first, second);
    doc.activeElement = first;

    const posted: unknown[] = [];
    const singleTransforms: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: first,
        getRangeAt: () => ({ startContainer: first, startOffset: 0, endContainer: first, endOffset: 0 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (msg: unknown) => posted.push(msg) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => ({ mode: 'blockRange', kind: 'p', members: [{ id: 'p1' }, { id: 'p2' }] }),
      getStructVersion: () => 7,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 0,
      columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => singleTransforms.push({ transform, id }),
      announceNav: () => undefined,
    });

    const structureBulleted = buttonByAction(doc, 'Bulleted list');
    expect(structureBulleted.getAttribute('aria-disabled')).toBeNull();
    structureBulleted.click();

    expect(singleTransforms).toEqual([]);
    expect(posted).toEqual([
      { type: 'multiTransform', transform: 'paragraphToUnorderedList', ids: ['p1', 'p2'], baseStructVersion: 7 },
    ]);

    posted.length = 0;
    singleTransforms.length = 0;
    const structureNumbered = buttonByAction(doc, 'Numbered list');
    expect(structureNumbered.getAttribute('aria-disabled')).toBeNull();
    structureNumbered.click();

    expect(singleTransforms).toEqual([]);
    expect(posted).toEqual([
      { type: 'multiTransform', transform: 'paragraphToOrderedList', ids: ['p1', 'p2'], baseStructVersion: 7 },
    ]);
  });

  test('clicking Structure list buttons with selected list items posts list-kind batch transforms', () => {
    const doc = new TestDocument();
    const list = new TestElement('ul', doc);
    const first = new TestElement('li', doc, {
      'data-struct-id': 'li1',
      'data-struct-kind': 'li',
      'data-edit-id': 'li1',
      contenteditable: 'true',
    });
    const second = new TestElement('li', doc, {
      'data-struct-id': 'li2',
      'data-struct-kind': 'li',
      'data-edit-id': 'li2',
      contenteditable: 'true',
    });
    first.append(new TestText('First'));
    second.append(new TestText('Second'));
    list.append(first, second);
    doc.main.appendChild(list);
    doc.activeElement = first;

    const posted: unknown[] = [];
    const singleTransforms: Array<{ transform: string; id: string | null }> = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: first,
        getRangeAt: () => ({ startContainer: first, startOffset: 0, endContainer: first, endOffset: 0 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (msg: unknown) => posted.push(msg) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => ({ mode: 'blockRange', kind: 'li', members: [{ id: 'li1' }, { id: 'li2' }] }),
      getStructVersion: () => 9,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 0,
      columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => singleTransforms.push({ transform, id }),
      announceNav: () => undefined,
    });

    const numbered = buttonByAction(doc, 'Numbered list');
    const bulleted = buttonByAction(doc, 'Bulleted list');
    expect(numbered.getAttribute('aria-disabled')).toBeNull();
    expect(numbered.getAttribute('aria-label')).toBe('Convert selected lists to numbered lists');
    expect(bulleted.getAttribute('aria-disabled')).toBe('true');
    expect(bulleted.getAttribute('aria-label')).toBe('Selected lists are already bulleted');

    numbered.click();

    expect(singleTransforms).toEqual([]);
    expect(posted).toEqual([
      { type: 'multiTransform', transform: 'toOrderedList', ids: ['li1', 'li2'], baseStructVersion: 9 },
    ]);
  });

  test('mixed multi-selection does not fall back to transforming the caret block', () => {
    const doc = new TestDocument();
    const paragraph = new TestElement('p', doc, {
      'data-struct-id': 'p1',
      'data-struct-kind': 'p',
      'data-edit-id': 'p1',
      contenteditable: 'true',
    });
    const list = new TestElement('ul', doc);
    const item = new TestElement('li', doc, {
      'data-struct-id': 'li1',
      'data-struct-kind': 'li',
      'data-edit-id': 'li1',
      contenteditable: 'true',
    });
    paragraph.append(new TestText('First'));
    item.append(new TestText('Second'));
    list.appendChild(item);
    doc.main.append(paragraph, list);
    doc.activeElement = paragraph;

    const posted: unknown[] = [];
    const singleTransforms: Array<{ transform: string; id: string | null }> = [];
    const announcements: string[] = [];
    const win = {
      CSS: { escape: (value: string) => value },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: paragraph,
        getRangeAt: () => ({ startContainer: paragraph, startOffset: 0, endContainer: paragraph, endOffset: 0 }),
      }),
    } as Record<string, unknown>;
    loadCommandBar(win, doc);

    (
      win.DitaEditorCanvasCommandBar as {
        installCommandBar(opts: Record<string, unknown>): { refresh(): void };
      }
    ).installCommandBar({
      document: doc,
      window: win,
      vscode: { postMessage: (msg: unknown) => posted.push(msg) },
      fontFamily: 'sans-serif',
      controls: controls(doc),
      menuIcons: icons(['paragraph', 'section', 'ul', 'ol', 'lines', 'note', 'codeblock', 'table']),
      barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
      getSelection: () => ({
        mode: 'multiSet',
        units: [
          { unit: 'block', kind: 'p', id: 'p1' },
          { unit: 'block', kind: 'li', id: 'li1' },
        ],
      }),
      getStructVersion: () => 8,
      structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
      caretOffset: () => 0,
      columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
      availFor: () => ({ enabled: true }),
      applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
      insertAvailFor: () => ({ enabled: true }),
      transformAvailFor: () => ({ status: 'ok' }),
      postStructural: () => undefined,
      withStructuralSuccess: (_op: string, _kind: string, extra: Record<string, unknown>) => extra,
      postTransform: (transform: string, id: string | null) => singleTransforms.push({ transform, id }),
      announceNav: (message: string) => announcements.push(message),
    });

    const unordered = buttonByAction(doc, 'Bulleted list');
    expect(unordered.getAttribute('aria-disabled')).toBe('true');
    unordered.click();

    expect(singleTransforms).toEqual([]);
    expect(posted).toEqual([]);
    expect(announcements).toContain('Unavailable: That transform is not available for this selection.');
  });
});
