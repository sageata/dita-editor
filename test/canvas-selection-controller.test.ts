import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

class FakeHtmlNode {
  constructor(
    readonly tagName: string,
    readonly textContent = '',
    private readonly rows: FakeHtmlNode[] = [],
    private readonly cells: FakeHtmlNode[] = [],
  ) {}

  querySelector(selector: string): FakeHtmlNode | null {
    return selector === 'table' && this.tagName === 'document' ? new FakeHtmlNode('table', '', this.rows) : null;
  }

  querySelectorAll(selector: string): FakeHtmlNode[] {
    if (selector === 'tr') return this.rows;
    if (selector === 'td, th') return this.cells;
    return [];
  }
}

class FakeDomParser {
  parseFromString(html: string): FakeHtmlNode {
    const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0] ?? '';
    const rows = Array.from(table.matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((rowMatch) => {
      const cells = Array.from(rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cellMatch) => {
        const text = cellMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, '\u00a0')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&amp;/gi, '&');
        return new FakeHtmlNode('td', text);
      });
      return new FakeHtmlNode('tr', '', [], cells);
    });
    return new FakeHtmlNode('document', '', rows);
  }
}

function installController(extraOptions: Record<string, unknown> = {}) {
  const announceSource = readFileSync(new URL('../media/canvas-selection-announce.js', import.meta.url), 'utf8');
  const summarySource = readFileSync(new URL('../media/canvas-selection-summary.js', import.meta.url), 'utf8');
  const rangeSource = readFileSync(new URL('../media/canvas-selection-range.js', import.meta.url), 'utf8');
  const clipboardSource = readFileSync(new URL('../media/canvas-selection-clipboard.js', import.meta.url), 'utf8');
  const restoreSource = readFileSync(new URL('../media/canvas-selection-restore.js', import.meta.url), 'utf8');
  const dependenciesSource = readFileSync(new URL('../media/canvas-selection-dependencies.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../media/canvas-selection-controller.js', import.meta.url), 'utf8');
  expect(summarySource).not.toContain('acquireVsCodeApi');
  expect(rangeSource).not.toContain('acquireVsCodeApi');
  expect(clipboardSource).not.toContain('acquireVsCodeApi');
  expect(restoreSource).not.toContain('acquireVsCodeApi');
  expect(dependenciesSource).not.toContain('acquireVsCodeApi');
  expect(source).not.toContain('acquireVsCodeApi');

  const win = {} as {
    DitaEditorCanvasSelectionAnnounce: unknown;
    DitaEditorCanvasSelectionSummary: unknown;
    DitaEditorCanvasSelectionRange: unknown;
    DitaEditorCanvasSelectionClipboard: unknown;
    DitaEditorCanvasSelectionRestore: unknown;
    DitaEditorCanvasSelectionDependencies: unknown;
    DitaEditorCanvasSelectionController: {
      installSelectionController: (opts: Record<string, unknown>) => SelectionController;
    };
  };
  const doc = new TestDocument();
  const block = new TestElement('p');
  block.textContent = 'Alpha';
  block.setAttribute('data-struct-id', 'e1');
  block.setAttribute('data-struct-kind', 'p');
  doc.main.appendChild(block);
  const secondBlock = new TestElement('p');
  secondBlock.textContent = 'Beta';
  secondBlock.setAttribute('data-struct-id', 'e2');
  secondBlock.setAttribute('data-struct-kind', 'p');
  doc.main.appendChild(secondBlock);
  const table = new TestElement('table');
  const tbody = new TestElement('tbody');
  const row1 = new TestElement('tr');
  const row2 = new TestElement('tr');
  doc.main.appendChild(table);
  table.appendChild(tbody);
  tbody.appendChild(row1);
  tbody.appendChild(row2);
  const cellA = new TestElement('td');
  cellA.textContent = 'A';
  cellA.setAttribute('data-cell-id', 'c1');
  row1.appendChild(cellA);
  const cellB = new TestElement('td');
  cellB.textContent = 'B';
  cellB.setAttribute('data-cell-id', 'c2');
  row1.appendChild(cellB);
  const cellC = new TestElement('td');
  cellC.textContent = 'C';
  cellC.setAttribute('data-cell-id', 'c3');
  row2.appendChild(cellC);
  const cellD = new TestElement('td');
  cellD.textContent = 'D';
  cellD.setAttribute('data-cell-id', 'c4');
  row2.appendChild(cellD);
  const elementsById = new Map<string, TestElement>([
    ['e1', block],
    ['e2', secondBlock],
    ['c1', cellA],
    ['c2', cellB],
    ['c3', cellC],
    ['c4', cellD],
  ]);
  const cellPositions = new Map<TestElement, { row: number; col: number }>([
    [cellA, { row: 0, col: 0 }],
    [cellB, { row: 0, col: 1 }],
    [cellC, { row: 1, col: 0 }],
    [cellD, { row: 1, col: 1 }],
  ]);
  const cellsByPosition = new Map<string, TestElement>([
    ['0:0', cellA],
    ['0:1', cellB],
    ['1:0', cellC],
    ['1:1', cellD],
  ]);

  new Function('window', summarySource)(win);
  new Function('window', rangeSource)(win);
  new Function('window', clipboardSource)(win);
  new Function('window', restoreSource)(win);
  new Function('window', dependenciesSource)(win);
  new Function('window', 'document', source)(win, doc);

  let reflected: { mode: string; ids: string[]; active: boolean } | null = null;
  let ariaApplied: TestElement[] = [];
  let refreshes = 0;
  let rangeRefreshes = 0;
  const announcements: string[] = [];
  const posted: unknown[] = [];
  new Function('window', announceSource)(win);
  const controller = win.DitaEditorCanvasSelectionController.installSelectionController({
    document: doc,
    window: { getSelection: () => ({ removeAllRanges: () => undefined }), DOMParser: FakeDomParser },
    selectionAnnouncement: win.DitaEditorCanvasSelectionAnnounce,
    selectionClipboard: win.DitaEditorCanvasSelectionClipboard,
    vscode: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    },
    selectionModel: {
      selectionMemberEls: (
        selection: {
          mode?: string;
          id?: string;
          units?: Array<{ id: string }>;
          members?: Array<{ id: string }>;
        } | null,
      ) => {
        if (!selection) return [];
        if (selection.mode === 'single' && selection.id) {
          const el = elementsById.get(selection.id);
          return el ? [el] : [];
        }
        const members = selection.mode === 'multiSet' ? selection.units ?? [] : selection.members ?? [];
        return members.map((m) => elementsById.get(m.id)).filter((el): el is TestElement => !!el);
      },
      selectionAnchorEl: () => block,
      selectionUnits: () => [],
      unitOf: (target: TestElement) =>
        target === block || target === secondBlock ? { type: 'block', el: target } : null,
      unitElType: () => null,
      unitFromPoint: (_main: TestElement, clientY: number) => {
        for (const el of [block, secondBlock]) {
          const rect = el.getBoundingClientRect();
          if (clientY >= rect.top && clientY <= rect.bottom) return { type: 'block', el };
        }
        return null;
      },
      fingerprintOf: (el: TestElement) => el.textContent,
      singleSel: () => null,
      buildSelection: (anchor: TestElement, focus: TestElement) => {
        const unitFor = (el: TestElement) =>
          el === block
            ? { unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' }
            : el === secondBlock
              ? { unit: 'block', id: 'e2', kind: 'p', text: 'Beta' }
              : null;
        const anchorUnit = unitFor(anchor);
        const focusUnit = unitFor(focus);
        return anchorUnit && focusUnit ? { mode: 'multiSet', units: [anchorUnit, focusUnit] } : null;
      },
      buildCellRect: (anchor: TestElement, focus: TestElement) => {
        const a = cellPositions.get(anchor);
        const f = cellPositions.get(focus);
        if (!a || !f) return null;
        const r0 = Math.min(a.row, f.row);
        const r1 = Math.max(a.row, f.row);
        const c0 = Math.min(a.col, f.col);
        const c1 = Math.max(a.col, f.col);
        const members: Array<{ id: string; text: string }> = [];
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            const cell = cellsByPosition.get(`${row}:${col}`);
            const id = cell?.getAttribute('data-cell-id');
            if (cell && id) members.push({ id, text: cell.textContent });
          }
        }
        return {
          mode: 'cellRect',
          anchorCellId: anchor.getAttribute('data-cell-id'),
          focusCellId: focus.getAttribute('data-cell-id'),
          members,
          rect: { section: 'tbody', r0, r1, c0, c1 },
        };
      },
      resolveMember: (_main: TestElement, _unit: string, id: string) => elementsById.get(id) ?? null,
      unitDesc: (el: TestElement) =>
        el === block
          ? { unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' }
          : el === secondBlock
            ? { unit: 'block', id: 'e2', kind: 'p', text: 'Beta' }
          : el === cellA
            ? { unit: 'cell', id: 'c1', kind: 'entry', text: 'A' }
            : el === cellB
              ? { unit: 'cell', id: 'c2', kind: 'entry', text: 'B' }
              : null,
      sortUnitsByDocOrder: (units: unknown[]) => units,
    },
    selectionAria: {
      clear: () => {
        ariaApplied = [];
      },
      apply: (_main: TestElement, els: TestElement[]) => {
        ariaApplied = els;
      },
    },
    selectionDebug: {
      reflect: (mode: string, ids: string[], active: boolean) => {
        reflected = { mode, ids, active };
      },
    },
    refreshCommandBar: () => {
      refreshes++;
    },
    announceNav: (message: string) => {
      announcements.push(message);
    },
    configureRangeButton: () => {
      rangeRefreshes++;
    },
    postStructural: (op: string, id: string, extra?: Record<string, unknown>) => {
      posted.push({ type: 'structural', op, id, ...(extra ?? {}) });
    },
    withStructuralSuccess: (_op: string, _kind: string, extra?: Record<string, unknown>) => extra ?? {},
    isContextToolbarShown: () => true,
    getImageBar: () => ({ update: () => undefined }),
    ...extraOptions,
  });
  return {
    controller,
    doc,
    block,
    secondBlock,
    cellA,
    cellB,
    cellC,
    cellD,
    announcements: () => announcements,
    posted: () => posted,
    reflected: () => reflected,
    ariaApplied: () => ariaApplied,
    refreshes: () => refreshes,
    rangeRefreshes: () => rangeRefreshes,
  };
}

interface SelectionController {
  getSelection(): unknown;
  setSelection(sel: unknown): void;
  clearSelection(): void;
  getSelectionCountText(): string;
  applyRangeAvailability(msg: unknown): void;
  restoreSelectionAfterRerender(main: unknown): void;
  singleTargetMultiReason(): string;
  cellPasteValues(text: string, count: number): string[];
}

describe('canvas-selection-controller', () => {
  test('paints and clears a single selection through injected hooks', () => {
    const { controller, block, reflected, ariaApplied, refreshes } = installController();

    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });

    expect(block.classList.has('is-selected')).toBe(true);
    expect(controller.getSelectionCountText()).toBe('1 block selected');
    expect(reflected()).toEqual({ mode: 'single', ids: ['e1'], active: true });
    expect(ariaApplied()).toEqual([block]);
    expect(refreshes()).toBe(1);

    controller.clearSelection();

    expect(block.classList.has('is-selected')).toBe(false);
    expect(controller.getSelection()).toBeNull();
    expect(controller.getSelectionCountText()).toBe('');
    expect(reflected()).toEqual({ mode: 'none', ids: [], active: false });
    expect(refreshes()).toBe(2);
  });

  test('ignores range availability that does not answer the current selection', () => {
    const { controller, rangeRefreshes } = installController();

    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });
    controller.applyRangeAvailability({ forIds: ['other'], actions: [{ action: 'rangeDelete', enabled: true }] });

    expect(rangeRefreshes()).toBe(0);
  });

  test('keeps a selected cell after rerender changes its text', () => {
    const { controller, doc, cellA, ariaApplied } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });

    cellA.textContent = 'New';
    controller.restoreSelectionAfterRerender(doc.main);

    expect(controller.getSelection()).toEqual({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'New' });
    expect(controller.getSelectionCountText()).toBe('1 cell selected');
    expect(ariaApplied()).toEqual([cellA]);
  });

  test('keeps a selected cell rectangle after rerender changes cell text', () => {
    const { controller, doc, cellA, cellB, ariaApplied } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });

    cellA.textContent = 'Left';
    cellB.textContent = 'Right';
    controller.restoreSelectionAfterRerender(doc.main);

    expect(controller.getSelection()).toEqual({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'Left' },
        { id: 'c2', text: 'Right' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });
    expect(controller.getSelectionCountText()).toBe('2 cells selected (rectangle)');
    expect(ariaApplied()).toEqual([cellA, cellB]);
  });

  test('speaks selection changes through the shared announcement contract', () => {
    const { doc, block, announcements } = installController();
    const click = doc.listeners.get('click')?.[0];
    expect(click).toBeDefined();

    click!({
      target: block,
      shiftKey: false,
      metaKey: true,
      ctrlKey: false,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });

    expect(announcements()).toEqual(['Item selected']);
  });

  test('dragging through whitespace resolves the focus by vertical selectable position', () => {
    const { controller, doc, block, secondBlock, ariaApplied } = installController();
    block.getBoundingClientRect = () => ({ left: 120, top: 0, bottom: 20 });
    secondBlock.getBoundingClientRect = () => ({ left: 160, top: 40, bottom: 60 });
    let movePrevented = false;

    for (const listener of doc.listeners.get('mousedown') ?? []) {
      listener({
        target: block,
        preventDefault: () => undefined,
      });
    }
    for (const listener of doc.listeners.get('mousemove') ?? []) {
      listener({
        target: doc.main,
        clientY: 48,
        preventDefault: () => {
          movePrevented = true;
        },
      });
    }

    expect(movePrevented).toBe(true);
    expect(controller.getSelection()).toEqual({
      mode: 'multiSet',
      units: [
        { unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' },
        { unit: 'block', id: 'e2', kind: 'p', text: 'Beta' },
      ],
    });
    expect(ariaApplied()).toEqual([block, secondBlock]);
  });

  test('speaks cleared selection without canvas-only punctuation', () => {
    const { controller, doc, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Escape',
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(announcements()).toEqual(['Selection cleared']);
  });

  test('uses the shared multi-selection editability reason for single-target toolbar actions', () => {
    const { controller } = installController();
    controller.setSelection({
      mode: 'multiSet',
      units: [
        { unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' },
        { unit: 'block', id: 'e2', kind: 'p', text: 'Beta' },
      ],
    });

    expect(controller.singleTargetMultiReason()).toBe(
      'Multiple items selected — select one item for single-target structural edits',
    );
  });

  test('copies a selected block to plain text and HTML clipboard flavors', () => {
    const { controller, doc } = installController();
    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });
    const copied = new Map<string, string>();
    let prevented = false;

    for (const listener of doc.listeners.get('copy') ?? []) {
      listener({
        clipboardData: {
          setData: (type: string, value: string) => copied.set(type, value),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => undefined,
      });
    }

    expect(prevented).toBe(true);
    expect(copied.get('text/plain')).toBe('Alpha');
    expect(copied.get('text/html')).toBe('<p>Alpha</p>');
  });

  test('copies a selected cell rectangle as tabular plain text', () => {
    const { controller, doc, cellA, cellB, cellC, cellD, announcements } = installController();
    cellA.textContent = 'A & B';
    cellB.textContent = 'C < D';
    cellC.textContent = 'E';
    cellD.textContent = 'D';
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c4',
      members: [
        { id: 'c1', text: 'A & B' },
        { id: 'c2', text: 'C < D' },
        { id: 'c3', text: 'E' },
        { id: 'c4', text: 'D' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 1, c0: 0, c1: 1 },
    });
    const copied = new Map<string, string>();

    for (const listener of doc.listeners.get('copy') ?? []) {
      listener({
        clipboardData: {
          setData: (type: string, value: string) => copied.set(type, value),
        },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(copied.get('text/plain')).toBe('A & B\tC < D\nE\tD');
    expect(copied.get('text/html')).toBe(
      '<table><tbody><tr><td>A &amp; B</td><td>C &lt; D</td></tr><tr><td>E</td><td>D</td></tr></tbody></table>',
    );
    expect(announcements()).toEqual(['4 items copied.']);
  });

  test('copies a selected cell rectangle with rich sanitized HTML', () => {
    const { controller, doc, cellA, cellB } = installController();
    const richPara = new TestElement('p');
    richPara.innerHTML = '<strong>Rich</strong>';
    richPara.textContent = 'Rich';
    richPara.setAttribute('data-edit-id', 'c1:t0');
    richPara.setAttribute('contenteditable', 'true');
    richPara.classList.add('is-selected');
    cellA.textContent = 'Rich';
    cellA.appendChild(richPara);
    cellB.textContent = 'Second';
    cellB.innerHTML = '<em>Second</em>';
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'Rich' },
        { id: 'c2', text: 'Second' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });
    const copied = new Map<string, string>();

    for (const listener of doc.listeners.get('copy') ?? []) {
      listener({
        clipboardData: {
          setData: (type: string, value: string) => copied.set(type, value),
        },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(copied.get('text/plain')).toBe('Rich\tSecond');
    expect(copied.get('text/html')).toBe(
      '<table><tbody><tr><td><p><strong>Rich</strong></p></td><td><em>Second</em></td></tr></tbody></table>',
    );
  });

  test('cuts a selected block by copying it and posting the existing delete action', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });
    const copied = new Map<string, string>();
    let prevented = false;

    for (const listener of doc.listeners.get('cut') ?? []) {
      listener({
        clipboardData: {
          setData: (type: string, value: string) => copied.set(type, value),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => undefined,
      });
    }

    expect(prevented).toBe(true);
    expect(copied.get('text/plain')).toBe('Alpha');
    expect(posted()).toEqual([{ type: 'structural', op: 'deleteElement', id: 'e1' }]);
    expect(announcements()).toEqual(['Deleting p…', 'Selection cut.']);
  });

  test('cuts a selected cell rectangle as TSV and clears those cells', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c4',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
        { id: 'c3', text: 'C' },
        { id: 'c4', text: 'D' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 1, c0: 0, c1: 1 },
    });
    const copied = new Map<string, string>();
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('cut') ?? []) {
      listener({
        clipboardData: {
          setData: (type: string, value: string) => copied.set(type, value),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(copied.get('text/plain')).toBe('A\tB\nC\tD');
    expect(copied.get('text/html')).toBe(
      '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>',
    );
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellClear', ids: ['c1', 'c2', 'c3', 'c4'] }]);
    expect(announcements()).toEqual(['Clearing 4 cells…', 'Selection cut.']);
  });

  test('maps spreadsheet clipboard text onto selected cells', () => {
    const { controller } = installController();

    expect(controller.cellPasteValues('a\tb\nc\td\n', 4)).toEqual(['a', 'b', 'c', 'd']);
    expect(controller.cellPasteValues('same', 2)).toEqual(['same', 'same']);
    expect(controller.cellPasteValues('a\nb', 1)).toEqual(['a\nb']);
    expect(controller.cellPasteValues('a\rb', 2)).toEqual(['a', 'b']);
  });

  test('paste replaces a selected table cell through the host range action', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'New' : ''),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellTextReplace', ids: ['c1'], values: ['New'] }]);
    expect(announcements()).toEqual(['Pasting into cell…']);
  });

  test('paste replaces a selected paragraph through the structural block paste path', () => {
    const { controller, doc, posted, announcements } = installController({
      selectedBlockPasteBlocksFromClipboard: () => ['<strong>New</strong>'],
      withStructuralSuccess: (_op: string, _kind: string, extra?: Record<string, unknown>) => ({
        ...(extra ?? {}),
        announceOnSuccess: 'Content pasted.',
      }),
    });
    controller.setSelection({ mode: 'single', unit: 'block', id: 'e1', kind: 'p', text: 'Alpha' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: () => '',
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([
      {
        type: 'structural',
        op: 'pasteBlocks',
        id: 'e1',
        prefix: '',
        suffix: '',
        blocks: ['<strong>New</strong>'],
        announceOnSuccess: 'Content pasted.',
      },
    ]);
    expect(announcements()).toEqual(['Pasting content…']);
  });

  test('paste expands tabular clipboard text from a selected anchor cell', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'A\tB\nC\tD' : ''),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([
      { type: 'rangeExecute', action: 'cellTextReplace', ids: ['c1', 'c2', 'c3', 'c4'], values: ['A', 'B', 'C', 'D'] },
    ]);
    expect(announcements()).toEqual(['Pasting into 4 cells…']);
  });

  test('paste expands HTML table clipboard data from a selected anchor cell', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) =>
            type === 'text/html'
              ? '<table><tbody><tr><td><strong>One</strong></td><td>Two</td></tr><tr><td>Three &amp; four</td><td>&nbsp;Five</td></tr></tbody></table>'
              : type === 'text/plain'
                ? 'wrong plain fallback'
                : '',
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([
      {
        type: 'rangeExecute',
        action: 'cellTextReplace',
        ids: ['c1', 'c2', 'c3', 'c4'],
        values: ['One', 'Two', 'Three & four', ' Five'],
      },
    ]);
    expect(announcements()).toEqual(['Pasting into 4 cells…']);
  });

  test('paste replaces a selected cell rectangle with tabular clipboard text', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'A\tB\n' : ''),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellTextReplace', ids: ['c1', 'c2'], values: ['A', 'B'] }]);
    expect(announcements()).toEqual(['Pasting into 2 cells…']);
  });

  test('paste maps newline rows by selected cell rectangle geometry', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c4',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
        { id: 'c3', text: 'C' },
        { id: 'c4', text: 'D' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 1, c0: 0, c1: 1 },
    });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'Top\nBottom' : ''),
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([
      {
        type: 'rangeExecute',
        action: 'cellTextReplace',
        ids: ['c1', 'c2', 'c3', 'c4'],
        values: ['Top', '', 'Bottom', ''],
      },
    ]);
    expect(announcements()).toEqual(['Pasting into 4 cells…']);
  });

  test('paste maps HTML table clipboard data onto a selected cell rectangle', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) =>
            type === 'text/html' ? '<table><tr><td>One</td><td>Two</td></tr></table>' : '',
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellTextReplace', ids: ['c1', 'c2'], values: ['One', 'Two'] }]);
    expect(announcements()).toEqual(['Pasting into 2 cells…']);
  });

  test('paste maps HTML table rows by selected cell rectangle geometry', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c4',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
        { id: 'c3', text: 'C' },
        { id: 'c4', text: 'D' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 1, c0: 0, c1: 1 },
    });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        clipboardData: {
          getData: (type: string) =>
            type === 'text/html' ? '<table><tr><td>Top</td></tr><tr><td>Bottom</td></tr></table>' : '',
        },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([
      {
        type: 'rangeExecute',
        action: 'cellTextReplace',
        ids: ['c1', 'c2', 'c3', 'c4'],
        values: ['Top', '', 'Bottom', ''],
      },
    ]);
    expect(announcements()).toEqual(['Pasting into 4 cells…']);
  });

  test('typing a printable key replaces a selected table cell', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Z',
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellTextReplace', ids: ['c1'], values: ['Z'] }]);
    expect(announcements()).toEqual(['Replacing cell text…']);
  });

  test('typing with command modifiers does not replace a selected table cell', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Z',
        metaKey: true,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => undefined,
      });
    }

    expect(prevented).toBe(false);
    expect(posted()).toEqual([]);
    expect(announcements()).toEqual([]);
  });

  test('delete clears a selected table cell through the host range action', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({ mode: 'single', unit: 'cell', id: 'c1', kind: 'entry', text: 'A' });
    let prevented = false;
    let stopped = false;

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Delete',
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellClear', ids: ['c1'] }]);
    expect(announcements()).toEqual(['Clearing cell…']);
  });

  test('delete clears a selected cell rectangle instead of trying to delete table structure', () => {
    const { controller, doc, posted, announcements } = installController();
    controller.setSelection({
      mode: 'cellRect',
      anchorCellId: 'c1',
      focusCellId: 'c2',
      members: [
        { id: 'c1', text: 'A' },
        { id: 'c2', text: 'B' },
      ],
      rect: { section: 'tbody', r0: 0, r1: 0, c0: 0, c1: 1 },
    });
    let prevented = false;

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Backspace',
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => undefined,
      });
    }
    controller.clearSelection();

    expect(prevented).toBe(true);
    expect(posted()).toEqual([{ type: 'rangeExecute', action: 'cellClear', ids: ['c1', 'c2'] }]);
    expect(announcements()).toEqual(['Clearing 2 cells…']);
  });
});
