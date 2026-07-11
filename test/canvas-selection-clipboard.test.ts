import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestElement, TestText } from './canvas-test-dom';

interface ClipboardHelpers {
  cellPasteValues(text: string, count: number): string[];
  cellRectPasteValuesFromMatrix(selection: unknown, matrix: string[][]): string[] | null;
  selectionHtml(selection: unknown, els: TestElement[]): string;
  selectionPlainText(selection: unknown, els: TestElement[]): string;
  tabularPasteMatrix(text: string, allowLineRows: boolean): string[][] | null;
}

function loadHelpers(): ClipboardHelpers {
  const source = readFileSync(new URL('../media/canvas-selection-clipboard.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasSelectionClipboard: ClipboardHelpers };
  new Function('window', source)(win);
  return win.DitaEditorCanvasSelectionClipboard;
}

describe('canvas-selection-clipboard', () => {
  test('maps spreadsheet clipboard text onto selected cells', () => {
    const helpers = loadHelpers();

    expect(helpers.cellPasteValues('a\tb\nc\td\n', 4)).toEqual(['a', 'b', 'c', 'd']);
    expect(helpers.cellPasteValues('same', 2)).toEqual(['same', 'same']);
    expect(helpers.cellPasteValues('a\nb', 1)).toEqual(['a\nb']);
    expect(helpers.cellPasteValues('a\rb', 2)).toEqual(['a', 'b']);
  });

  test('maps line rows by cell-rectangle geometry only when allowed', () => {
    const helpers = loadHelpers();
    const selection = {
      mode: 'cellRect',
      members: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }],
      rect: { c0: 0, c1: 1 },
    };

    expect(helpers.tabularPasteMatrix('Top\nBottom', false)).toBeNull();
    expect(helpers.tabularPasteMatrix('Top\nBottom', true)).toEqual([['Top'], ['Bottom']]);
    expect(helpers.cellRectPasteValuesFromMatrix(selection, [['Top'], ['Bottom']])).toEqual([
      'Top',
      '',
      'Bottom',
      '',
    ]);
  });

  test('formats selected cell rectangles as TSV and sanitized HTML table fragments', () => {
    const helpers = loadHelpers();
    const richCell = new TestElement('td');
    const para = new TestElement('p');
    para.innerHTML = '<strong>Rich</strong>';
    para.textContent = 'Rich';
    para.setAttribute('data-edit-id', 'c1:t0');
    para.setAttribute('contenteditable', 'true');
    para.classList.add('is-selected');
    richCell.appendChild(para);
    const plainCell = new TestElement('td');
    plainCell.innerHTML = '<em>Second</em>';
    plainCell.textContent = 'Second';
    const selection = {
      mode: 'cellRect',
      members: [
        { id: 'c1', text: 'Rich' },
        { id: 'c2', text: 'Second' },
      ],
      rect: { c0: 0, c1: 1 },
    };

    expect(helpers.selectionPlainText(selection, [richCell, plainCell])).toBe('Rich\tSecond');
    expect(helpers.selectionHtml(selection, [richCell, plainCell])).toBe(
      '<table><tbody><tr><td><p><strong>Rich</strong></p></td><td><em>Second</em></td></tr></tbody></table>',
    );
  });

  test('prunes nested selected descendants when copying mixed block selections', () => {
    const helpers = loadHelpers();
    const parent = new TestElement('li');
    const nestedList = new TestElement('ul');
    const child = new TestElement('li');
    parent.append(new TestText('Parent '), nestedList);
    child.append(new TestText('Nested'));
    nestedList.appendChild(child);
    const selection = {
      mode: 'multiSet',
      units: [
        { unit: 'block', id: 'p1' },
        { unit: 'block', id: 'p2' },
      ],
    };

    expect(helpers.selectionPlainText(selection, [parent, child])).toBe('Parent Nested');
    expect(helpers.selectionHtml(selection, [parent, child])).toBe('<li>Parent <ul><li>Nested</li></ul></li>');
  });
});
