import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument } from './canvas-test-dom';

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-context-toolbar-state.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasContextToolbarState: {
      availabilitySummary(buttons: unknown[], isUnavailable: (button: unknown) => boolean): string;
      columnAnchorId(cell: unknown): string | null;
      isSummonKey(event: Record<string, unknown>): boolean;
      multiSelectionSummary(count: number, action: string | null, availability: { enabled: boolean; reason?: string } | null): string;
      rangeButtonState(action: string, count: number, availability: { enabled: boolean; reason?: string } | null): {
        text: string;
        label: string;
        enabled: boolean;
        title: string;
      };
      resultMessage(action: string): string;
      toolbarKindNoun(current: { kind?: string; cellEntryId?: string } | null): string;
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasContextToolbarState;
}

describe('canvas-context-toolbar-state', () => {
  test('finds the editable anchor for a table column', () => {
    const helper = loadHelper();
    const doc = new TestDocument();
    const table = doc.createElement('table');
    const firstRow = doc.createElement('tr');
    const secondRow = doc.createElement('tr');
    const firstA = doc.createElement('td');
    const firstB = doc.createElement('td');
    const secondA = doc.createElement('td');
    const secondB = doc.createElement('td');
    secondB.setAttribute('data-edit-id', 'cell-b');
    firstRow.append(firstA, firstB);
    secondRow.append(secondA, secondB);
    table.append(firstRow, secondRow);
    doc.main.appendChild(table);

    expect(helper.columnAnchorId(firstB)).toBe('cell-b');
    expect(helper.columnAnchorId(firstA)).toBeNull();

    firstA.setAttribute('data-cell-id', 'entry-a');
    expect(helper.columnAnchorId(firstA)).toBe('entry-a');
  });

  test('formats toolbar labels and availability summaries', () => {
    const helper = loadHelper();
    const available = {};
    const unavailable = {};

    expect(helper.toolbarKindNoun({ kind: 'row', cellEntryId: 'c1' })).toBe('a table cell');
    expect(helper.toolbarKindNoun({ kind: 'p', cellEntryId: 'c1' })).toBe('a table cell');
    expect(helper.toolbarKindNoun({ kind: 'li' })).toBe('a list item');
    expect(helper.toolbarKindNoun({ kind: 'unknown' })).toBe('this element');
    expect(helper.rangeButtonState('cellRectMerge', 3, null)).toEqual({
      text: '▦',
      label: 'Merge 3 selected cells',
      enabled: false,
      title: 'Merge 3 selected cells — checking…',
    });
    expect(helper.rangeButtonState('rangeDelete', 2, { enabled: false, reason: 'Locked' }).title).toBe('Locked');
    expect(helper.resultMessage('cellRectMerge')).toBe('Merging selected cells.');
    expect(helper.resultMessage('rangeDelete')).toBe('Deleting selected items.');
    expect(helper.availabilitySummary([available, unavailable], (button) => button === unavailable)).toBe('1 available, 1 unavailable');
    expect(helper.availabilitySummary([available], () => false)).toBe('1 action');
    expect(helper.multiSelectionSummary(4, 'cellRectMerge', { enabled: true })).toBe('4 items selected — "Merge selected cells" available');
    expect(helper.multiSelectionSummary(2, 'rangeDelete', { enabled: false, reason: 'Mixed selection' })).toBe('2 items selected — Mixed selection');
  });

  test('recognizes keyboard summon shortcuts', () => {
    const helper = loadHelper();

    expect(helper.isSummonKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(helper.isSummonKey({ key: 'F10', altKey: true })).toBe(true);
    expect(helper.isSummonKey({ key: 'ContextMenu' })).toBe(true);
    expect(helper.isSummonKey({ key: 'F10' })).toBe(false);
  });
});
