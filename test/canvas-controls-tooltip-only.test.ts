// Command-bar buttons (dataset.tooltipOnly) surface availability text through
// the fast custom tooltip; setBtnEnabled must keep aria-label fresh for them
// WITHOUT restoring the native title it would normally write.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { TestDocument, TestElement } from './canvas-test-dom';

interface CanvasControls {
  setBtnEnabled(btn: TestElement, ok: boolean, title: string): void;
}

function loadControls(): CanvasControls {
  const source = readFileSync(new URL('../media/canvas-controls.js', import.meta.url), 'utf8');
  const win = {} as { DitaEditorCanvasControls: CanvasControls };
  new Function('window', source)(win);
  return win.DitaEditorCanvasControls;
}

function makeButton(action: string): TestElement {
  const btn = new TestDocument().createElement('button');
  btn.dataset.action = action;
  return btn;
}

describe('setBtnEnabled title handling', () => {
  test('ordinary buttons keep getting a native title and matching aria-label', () => {
    const { setBtnEnabled } = loadControls();
    const btn = makeButton('Bold');

    setBtnEnabled(btn, false, 'Select text to format');
    expect(btn.title).toBe('Bold. Unavailable: Select text to format');
    expect(btn.getAttribute('aria-label')).toBe('Bold. Unavailable: Select text to format');

    setBtnEnabled(btn, true, 'Bold');
    expect(btn.title).toBe('Bold');
    expect(btn.getAttribute('aria-label')).toBe('Bold');
  });

  test('tooltipOnly buttons update aria-label but never the native title', () => {
    const { setBtnEnabled } = loadControls();
    const btn = makeButton('Bold');
    btn.dataset.tooltipOnly = '1';

    setBtnEnabled(btn, false, 'Select text to format');
    expect(btn.title).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('Bold. Unavailable: Select text to format');
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    setBtnEnabled(btn, true, 'Bold');
    expect(btn.title).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('Bold');
  });
});
