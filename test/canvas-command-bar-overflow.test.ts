import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

interface BarEntry {
  wrap: TestElement;
  divider: TestElement | null;
}

interface BarUi {
  cmdBar: TestElement;
  cmdRow: TestElement;
  cmdRowEntries: BarEntry[];
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
}

interface OverflowNs {
  computeOverflowLayout(
    containerWidth: number,
    caretWidth: number,
    rows: Array<{ widths: number[]; reserved: number }>,
  ): { caretVisible: boolean; fitCounts: number[] };
  installOverflow(opts: {
    document: TestDocument;
    ui: BarUi;
    measureWidth(el: TestElement): number;
  }): { update(): void; toggle(): void; close(refocus: boolean): void; isOpen(): boolean };
}

function loadHarness() {
  const uiSource = readFileSync(new URL('../media/canvas-command-bar-ui.js', import.meta.url), 'utf8');
  const overflowSource = readFileSync(new URL('../media/canvas-command-bar-overflow.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasCommandBarUi: { createCommandBarUi(opts: Record<string, unknown>): BarUi };
    DitaEditorCanvasCommandBarOverflow: OverflowNs;
  };
  new Function('window', uiSource)(win);
  new Function('window', overflowSource)(win);
  const doc = new TestDocument();
  const ui = win.DitaEditorCanvasCommandBarUi.createCommandBarUi({
    document: doc,
    fontFamily: 'sans-serif',
    controls: {
      makeBtn: (_label: string, title: string) => {
        const btn = doc.createElement('button');
        btn.dataset.action = title;
        btn.setAttribute('aria-label', title);
        return btn;
      },
    },
    menuIcons: Object.fromEntries(
      ['paragraph', 'section', 'ul', 'alphaOl', 'ol', 'lines', 'note', 'codeblock', 'indent', 'outdent', 'table']
        .map((name) => [name, `<${name}>`]),
    ),
    barIcons: Object.fromEntries(
      ['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref'].map((name) => [name, `<${name}>`]),
    ),
  });
  // Every group measures 100px, the status 50px; the bar width is adjustable.
  let barWidth = 2000;
  const groupWraps = new Set(ui.cmdRowEntries.map((entry) => entry.wrap));
  const overflow = win.DitaEditorCanvasCommandBarOverflow.installOverflow({
    document: doc,
    ui,
    measureWidth: (el: TestElement) => {
      if (el === ui.cmdBar) return barWidth;
      if (el === ui.cmdStatus) return 50;
      if (groupWraps.has(el)) return 100;
      return 0;
    },
  });
  return { doc, ui, overflow, ns: win.DitaEditorCanvasCommandBarOverflow, setBarWidth: (w: number) => { barWidth = w; } };
}

describe('computeOverflowLayout', () => {
  const { ns } = loadHarness();

  test('hides the caret when every row fits', () => {
    const layout = ns.computeOverflowLayout(1000, 38, [
      { widths: [100, 125, 125, 125], reserved: 0 },
      { widths: [100, 125, 125, 125], reserved: 50 },
    ]);
    expect(layout).toEqual({ caretVisible: false, fitCounts: [4, 4] });
  });

  test('reserves the caret width once any row overflows', () => {
    const layout = ns.computeOverflowLayout(372, 38, [
      { widths: [100, 125, 125, 125], reserved: 0 },
      { widths: [100, 125, 125, 125], reserved: 50 },
    ]);
    // caret avail 334 → 100+125 fits, +125 (350) exceeds; row 2 loses 50 more
    // to the status, same fit here.
    expect(layout).toEqual({ caretVisible: true, fitCounts: [2, 2] });
  });

  test('fits nothing when even the first group cannot fit', () => {
    const layout = ns.computeOverflowLayout(60, 38, [{ widths: [100, 125], reserved: 0 }]);
    expect(layout).toEqual({ caretVisible: true, fitCounts: [0] });
  });

  test('a row that exactly fits keeps everything', () => {
    const layout = ns.computeOverflowLayout(450, 38, [{ widths: [100, 125, 125, 100], reserved: 0 }]);
    expect(layout).toEqual({ caretVisible: false, fitCounts: [4] });
  });
});

describe('installOverflow', () => {
  test('wide bar keeps all groups in the row with the caret hidden', () => {
    const { ui, overflow } = loadHarness();
    overflow.update();
    expect(ui.moreBtn.style.display).toBe('none');
    expect(ui.overflowPop.children).toHaveLength(0);
    expect(ui.fmtGroup.wrap.parentElement).toBe(ui.cmdRow);
    expect(ui.viewGroup.wrap.parentElement).toBe(ui.cmdRow);
  });

  test('narrow bar moves trailing groups into the popover and shows the caret', () => {
    const { ui, overflow, setBarWidth } = loadHarness();
    overflow.update();
    setBarWidth(400);
    overflow.update();

    // base 372, caret+status avail 284: topic(100)+history(125) stay;
    // fmt(125) would hit 350 — it and everything after overflows.
    expect(ui.moreBtn.style.display).toBe('inline-flex');
    expect(ui.topicGroup.wrap.parentElement).toBe(ui.cmdRow);
    expect(ui.historyGroup.wrap.parentElement).toBe(ui.cmdRow);
    expect(ui.fmtGroup.wrap.parentElement).toBe(ui.overflowPop);
    expect(ui.structGroup.wrap.parentElement).toBe(ui.overflowPop);
    expect(ui.insertGroup.wrap.parentElement).toBe(ui.overflowPop);
    expect(ui.tableGroup.wrap.parentElement).toBe(ui.overflowPop);
    expect(ui.viewGroup.wrap.parentElement).toBe(ui.overflowPop);
    // Canonical order in the popover matches the row order.
    expect(ui.overflowPop.children).toEqual([
      ui.fmtGroup.wrap, ui.structGroup.wrap, ui.insertGroup.wrap,
      ui.tableGroup.wrap, ui.viewGroup.wrap,
    ]);
    // The status stays pinned at the end of the row.
    expect(ui.cmdRow.children.at(-1)).toBe(ui.cmdStatus);
    // Dividers of overflowed groups are hidden, not shipped to the popover.
    for (const entry of ui.cmdRowEntries.slice(2)) {
      expect(entry.divider?.style.display).toBe('none');
    }
  });

  test('update is idempotent and restores canonical order when width returns', () => {
    const { ui, overflow, setBarWidth } = loadHarness();
    overflow.update();
    const wideRow = [...ui.cmdRow.children];
    setBarWidth(400);
    overflow.update();
    const narrowRow = [...ui.cmdRow.children];
    overflow.update();
    expect(ui.cmdRow.children).toEqual(narrowRow);
    setBarWidth(2000);
    overflow.update();
    expect(ui.cmdRow.children.filter((c) => c.className === 'cmd-group'))
      .toEqual(wideRow.filter((c) => c.className === 'cmd-group'));
    expect(ui.moreBtn.style.display).toBe('none');
    expect(ui.overflowPop.children).toHaveLength(0);
  });

  test('hidden groups are skipped and stay out of the popover', () => {
    const { ui, overflow, setBarWidth } = loadHarness();
    ui.tableGroup.wrap.style.display = 'none';
    setBarWidth(400);
    overflow.update();
    expect(ui.tableGroup.wrap.parentElement).toBe(ui.cmdRow);
    // With table hidden, view is still past the fit point and overflows.
    expect(ui.viewGroup.wrap.parentElement).toBe(ui.overflowPop);
  });

  test('toggle opens the popover, focuses it, and Escape refocuses the caret', () => {
    const { doc, ui, overflow, setBarWidth } = loadHarness();
    setBarWidth(400);
    overflow.update();

    overflow.toggle();
    expect(overflow.isOpen()).toBe(true);
    expect(ui.overflowPop.style.display).toBe('flex');
    expect(ui.moreBtn.getAttribute('aria-expanded')).toBe('true');
    expect(doc.activeElement?.tagName).toBe('button');
    expect(ui.overflowPop.contains(doc.activeElement)).toBe(true);

    for (const listener of doc.listeners.get('keydown') ?? []) listener({ key: 'Escape' } as never);
    expect(overflow.isOpen()).toBe(false);
    expect(ui.overflowPop.style.display).toBe('none');
    expect(ui.moreBtn.getAttribute('aria-expanded')).toBe('false');
    expect(doc.activeElement).toBe(ui.moreBtn);
  });

  test('an outside pointerdown closes the popover without stealing focus back', () => {
    const { doc, ui, overflow, setBarWidth } = loadHarness();
    setBarWidth(400);
    overflow.update();
    overflow.toggle();
    expect(overflow.isOpen()).toBe(true);

    const outside = doc.createElement('div');
    doc.body.appendChild(outside);
    for (const listener of doc.listeners.get('pointerdown') ?? []) listener({ target: outside } as never);
    expect(overflow.isOpen()).toBe(false);

    // A pointerdown inside the popover must not close it.
    overflow.toggle();
    const inside = ui.overflowPop.children[0];
    for (const listener of doc.listeners.get('pointerdown') ?? []) listener({ target: inside } as never);
    expect(overflow.isOpen()).toBe(true);
  });

  test('the caret disappearing closes an open popover', () => {
    const { ui, overflow, setBarWidth } = loadHarness();
    setBarWidth(400);
    overflow.update();
    overflow.toggle();
    expect(overflow.isOpen()).toBe(true);
    setBarWidth(2000);
    overflow.update();
    expect(overflow.isOpen()).toBe(false);
    expect(ui.overflowPop.children).toHaveLength(0);
  });
});
