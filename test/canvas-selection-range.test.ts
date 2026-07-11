import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-selection-range.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasSelectionRange: {
      normalizeAvailability(msg: unknown): { forIds: string[]; actions: Array<{ action: string; enabled?: boolean; reason?: string }> };
      rangeAvailFor(
        rangeAvail: { forIds: string[]; actions: Array<{ action: string; enabled?: boolean; reason?: string }> } | null,
        ids: string[],
        action: string,
      ): { action: string; enabled?: boolean; reason?: string } | null;
      rangeQuerySelection(selection: Record<string, unknown>, ids: string[]): {
        kind: unknown;
        ids: string[];
        anchorId: unknown;
        focusId: unknown;
      };
      sameIds(a: unknown, b: unknown): boolean;
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasSelectionRange;
}

describe('canvas-selection-range', () => {
  test('compares selection ids exactly', () => {
    const helper = loadHelper();

    expect(helper.sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(helper.sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(helper.sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(helper.sameIds(null, ['a'])).toBe(false);
  });

  test('normalizes range availability and resolves only current actions', () => {
    const helper = loadHelper();
    const availability = helper.normalizeAvailability({
      forIds: ['a', 1, 'b'],
      actions: [{ action: 'rangeDelete', enabled: true }, { reason: 'missing action' }, null],
    });

    expect(availability).toEqual({
      forIds: ['a', 'b'],
      actions: [{ action: 'rangeDelete', enabled: true }],
    });
    expect(helper.rangeAvailFor(availability, ['a', 'b'], 'rangeDelete')).toEqual({ action: 'rangeDelete', enabled: true });
    expect(helper.rangeAvailFor(availability, ['b', 'a'], 'rangeDelete')).toBeNull();
    expect(helper.rangeAvailFor(availability, ['a', 'b'], 'cellRectMerge')).toBeNull();
  });

  test('builds the host range query payload for block and cell selections', () => {
    const helper = loadHelper();

    expect(helper.rangeQuerySelection({ mode: 'blockRange', anchorId: 'e1', focusId: 'e3' }, ['e1', 'e2', 'e3'])).toEqual({
      kind: 'blockRange',
      ids: ['e1', 'e2', 'e3'],
      anchorId: 'e1',
      focusId: 'e3',
    });
    expect(helper.rangeQuerySelection({ mode: 'cellRect', anchorCellId: 'c1', focusCellId: 'c4' }, ['c1', 'c2', 'c3', 'c4'])).toEqual({
      kind: 'cellRect',
      ids: ['c1', 'c2', 'c3', 'c4'],
      anchorId: 'c1',
      focusId: 'c4',
    });
  });
});
