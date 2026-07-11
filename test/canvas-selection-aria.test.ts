import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestElement } from './canvas-test-dom';

function makeFixture(role?: string) {
  const main = new TestElement('main');
  const table = new TestElement('table', undefined, role ? { role } : {});
  const row = new TestElement('tr');
  const head = new TestElement('th', undefined, { 'data-selection-kind': 'header' });
  const cellA = new TestElement('td', undefined, { 'data-selection-kind': 'cell' });
  const cellB = new TestElement('td', undefined, { 'data-selection-kind': 'cell' });
  main.append(table);
  table.append(row);
  row.append(head, cellA, cellB);
  return { main, table, head, cellA, cellB };
}

function installSelectionAria(main: TestElement) {
  const source = readFileSync(new URL('../media/canvas-selection-aria.js', import.meta.url), 'utf8');
  const win = {} as { DitaEditorCanvasSelectionAria: { installSelectionAria: (opts: unknown) => SelectionAria } };
  const doc = { querySelector: (selector: string) => (selector === 'main' ? main : null) };
  new Function('window', 'document', source)(win, doc);
  return win.DitaEditorCanvasSelectionAria.installSelectionAria({ document: doc });
}

interface SelectionAria {
  apply(main: TestElement, selectedEls: TestElement[]): void;
  clear(): void;
}

describe('canvas-selection-aria', () => {
  test('promotes selected table cells to a transient ARIA grid selection', () => {
    const { main, table, head, cellA, cellB } = makeFixture();
    const aria = installSelectionAria(main);

    aria.apply(main, [head, cellB]);

    expect(table.getAttribute('role')).toBe('grid');
    expect(table.getAttribute('aria-multiselectable')).toBe('true');
    expect(head.getAttribute('aria-selected')).toBe('true');
    expect(cellA.getAttribute('aria-selected')).toBe('false');
    expect(cellB.getAttribute('aria-selected')).toBe('true');
  });

  test('clear restores table attributes and removes aria-selected from cells', () => {
    const { main, table, cellA, cellB } = makeFixture('table');
    const aria = installSelectionAria(main);

    aria.apply(main, [cellA]);
    aria.clear();

    expect(table.getAttribute('role')).toBe('table');
    expect(table.getAttribute('aria-multiselectable')).toBe(null);
    expect(cellA.getAttribute('aria-selected')).toBe(null);
    expect(cellB.getAttribute('aria-selected')).toBe(null);
  });
});
