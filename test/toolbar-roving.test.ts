// P0.2 keyboard-operable toolbar — roving-index behavior from the actual browser helper.
//
// CONTRACT (after the aria-disabled discoverability slice): the toolbar is a single composite tab
// stop. EVERY VISIBLE button is a roving target — including aria-disabled ("unavailable") controls,
// so a keyboard/SR user can land on one and hear WHY it's unavailable. Disabled-ness is NOT a
// roving criterion: aria-disabled buttons stay focusable (unlike a native `<button disabled>`), and
// HIDDEN buttons are excluded by the CALLER (canvas builds the visible-button list) — not here.
// So the helper is a pure index walk over a count: ArrowLeft/Right move one (no wrap), Home/End jump
// to the ends.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

interface CanvasControls {
  nextRovingIndex(visibleCount: number, currentIdx: number, key: string): number;
}

function loadControls(): CanvasControls {
  const source = readFileSync(new URL('../media/canvas-controls.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasControls: CanvasControls };
  new Function('window', source)(win);
  return win.DitaEditorCanvasControls;
}

describe('nextRovingIndex — APG roving over all visible buttons (no wrap)', () => {
  test('ArrowRight advances one, ArrowLeft retreats one', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(5, 1, 'ArrowRight')).toBe(2);
    expect(nextRovingIndex(5, 3, 'ArrowLeft')).toBe(2);
  });

  test('no wrap at either end', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(5, 4, 'ArrowRight')).toBe(4);
    expect(nextRovingIndex(5, 0, 'ArrowLeft')).toBe(0);
  });

  test('Home -> first, End -> last', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(5, 3, 'Home')).toBe(0);
    expect(nextRovingIndex(5, 1, 'End')).toBe(4);
  });

  test('an unrelated key leaves the (clamped) index unchanged', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(5, 2, 'Enter')).toBe(2);
    expect(nextRovingIndex(5, 2, 'a')).toBe(2);
  });

  test('disabled-ness is NOT a roving criterion: every index in range is reachable', () => {
    const { nextRovingIndex } = loadControls();

    // The helper roves over the full visible count; whether a given button is aria-disabled is the
    // canvas/AT layer's concern (it announces the reason). So with 6 visible buttons, ArrowRight
    // from the 5th lands on the 6th even if that 6th is an unavailable column control.
    expect(nextRovingIndex(6, 4, 'ArrowRight')).toBe(5);
    expect(nextRovingIndex(6, 0, 'End')).toBe(5);
    expect(nextRovingIndex(6, 5, 'Home')).toBe(0);
  });

  test('an out-of-range current index is clamped, THEN the move is applied', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(3, 9, 'ArrowRight')).toBe(2); // clamp 9->2, stays at last
    expect(nextRovingIndex(3, 9, 'ArrowLeft')).toBe(1); // clamp 9->2, ArrowLeft -> 1
    expect(nextRovingIndex(3, -4, 'ArrowRight')).toBe(1); // clamp -4->0, ArrowRight -> 1
    expect(nextRovingIndex(3, -4, 'Home')).toBe(0);
  });

  test('no visible buttons -> no target (-1)', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(0, 0, 'ArrowRight')).toBe(-1);
    expect(nextRovingIndex(0, 0, 'Home')).toBe(-1);
  });

  test('a single visible button -> every move stays on it', () => {
    const { nextRovingIndex } = loadControls();

    expect(nextRovingIndex(1, 0, 'ArrowRight')).toBe(0);
    expect(nextRovingIndex(1, 0, 'ArrowLeft')).toBe(0);
    expect(nextRovingIndex(1, 0, 'End')).toBe(0);
  });
});
