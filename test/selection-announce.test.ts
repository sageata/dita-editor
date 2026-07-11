import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { describeSelection, selectionEditability, type SelectionState } from '../src/selection/selection-announce';
import { selectableKinds, selectableOrderIds, type SelectableKind } from '../src/selection/selectable-order';

// Fixed kind map for deterministic phrasing of synthetic selections.
const KIND: Record<string, SelectableKind> = {
  e1: 'block',
  e2: 'block',
  c1: 'cell',
  c2: 'cell',
  c3: 'cell',
  i1: 'image',
  i2: 'image',
};
const kindOf = (id: string): SelectableKind | undefined => KIND[id];

function sel(ids: string[]): SelectionState {
  return { anchorId: ids[0] ?? null, focusId: ids[ids.length - 1] ?? null, ids };
}

describe('describeSelection', () => {
  test('empty -> "Selection cleared"', () => {
    expect(describeSelection(sel([]), kindOf)).toBe('Selection cleared');
  });
  test('single block -> "Item selected"', () => {
    expect(describeSelection(sel(['e1']), kindOf)).toBe('Item selected');
  });
  test('single cell -> "Cell selected"', () => {
    expect(describeSelection(sel(['c1']), kindOf)).toBe('Cell selected');
  });
  test('single image -> "Image selected"', () => {
    expect(describeSelection(sel(['i1']), kindOf)).toBe('Image selected');
  });
  test('three cells -> "3 cells selected"', () => {
    expect(describeSelection(sel(['c1', 'c2', 'c3']), kindOf)).toBe('3 cells selected');
  });
  test('two images -> "2 images selected"', () => {
    expect(describeSelection(sel(['i1', 'i2']), kindOf)).toBe('2 images selected');
  });
  test('two blocks -> "2 items selected"', () => {
    expect(describeSelection(sel(['e1', 'e2']), kindOf)).toBe('2 items selected');
  });
  test('mixed kinds -> generic "N items selected"', () => {
    expect(describeSelection(sel(['e1', 'c1']), kindOf)).toBe('2 items selected');
  });
  test('unknown id reads as a generic item', () => {
    expect(describeSelection(sel(['zzz']), kindOf)).toBe('Item selected');
  });
});

describe('selectionEditability', () => {
  test('empty -> enabled (count does not block; per-op validity still governs)', () => {
    expect(selectionEditability(sel([]))).toEqual({ enabled: true });
  });
  test('single -> enabled', () => {
    expect(selectionEditability(sel(['c1']))).toEqual({ enabled: true });
  });
  test('multi -> disabled with reason', () => {
    const r = selectionEditability(sel(['c1', 'c2']));
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain('Multiple items selected');
  });
});

// End-to-end: real parsed DITA -> selectable kinds -> selection -> announcement.
describe('describeSelection + selectableKinds (parsed DITA)', () => {
  const SRC =
    '<topic><title>T</title><body><p>one</p><fig><image href="a.png"/></fig><p>two</p></body></topic>';

  test('selecting a real image id announces "Image selected"', () => {
    const d = parse(SRC);
    const order = selectableOrderIds(d);
    const kinds = selectableKinds(d);
    const imgId = order.find((id) => kinds.get(id) === 'image');
    expect(imgId).toBeDefined();
    const state = sel([imgId!]);
    expect(describeSelection(state, (id) => kinds.get(id))).toBe('Image selected');
  });

  test('selecting two real paragraphs announces "2 items selected"', () => {
    const d = parse(SRC);
    const order = selectableOrderIds(d);
    const kinds = selectableKinds(d);
    const blocks = order.filter((id) => kinds.get(id) === 'block').slice(0, 2);
    const state: SelectionState = { anchorId: blocks[0], focusId: blocks[1], ids: blocks };
    expect(describeSelection(state, (id) => kinds.get(id))).toBe('2 items selected');
  });
});
