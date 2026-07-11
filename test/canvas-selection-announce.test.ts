import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { describeSelection, selectionEditability, type SelectionState } from '../src/selection/selection-announce';
import type { SelectableKind } from '../src/selection/selectable-order';

interface CanvasSelectionAnnounce {
  describeSelection(state: SelectionState, kindOf: (id: string) => SelectableKind | undefined): string;
  selectionEditability(state: SelectionState): { enabled: boolean; reason?: string };
}

function loadCanvasSelectionAnnounce(): CanvasSelectionAnnounce {
  const source = readFileSync(new URL('../media/canvas-selection-announce.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasSelectionAnnounce: CanvasSelectionAnnounce };
  new Function('window', source)(win);
  return win.DitaEditorCanvasSelectionAnnounce;
}

const KIND: Record<string, SelectableKind> = {
  e1: 'block',
  e2: 'block',
  c1: 'cell',
  c2: 'cell',
  i1: 'image',
};
const kindOf = (id: string): SelectableKind | undefined => KIND[id];
const sel = (ids: string[]): SelectionState => ({
  anchorId: ids[0] ?? null,
  focusId: ids[ids.length - 1] ?? null,
  ids,
});

describe('canvas-selection-announce', () => {
  test.each([
    [[]],
    [['e1']],
    [['c1']],
    [['i1']],
    [['c1', 'c2']],
    [['e1', 'e2']],
    [['e1', 'c1']],
    [['missing']],
  ])('mirrors the TypeScript describeSelection contract for %p', (ids) => {
    const state = sel(ids);
    const webview = loadCanvasSelectionAnnounce();

    expect(webview.describeSelection(state, kindOf)).toBe(describeSelection(state, kindOf));
  });

  test('mirrors the TypeScript selectionEditability contract', () => {
    const webview = loadCanvasSelectionAnnounce();

    expect(webview.selectionEditability(sel([]))).toEqual(selectionEditability(sel([])));
    expect(webview.selectionEditability(sel(['e1']))).toEqual(selectionEditability(sel(['e1'])));
    expect(webview.selectionEditability(sel(['e1', 'e2']))).toEqual(selectionEditability(sel(['e1', 'e2'])));
  });
});
