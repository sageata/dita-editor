import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');

describe('canvas rerender focus contract', () => {
  test('restores transform focus as a selected block when there is no caret offset', () => {
    expect(source).toContain("const el = main.querySelector('[data-autofocus]');");
    expect(source).toContain("if (typeof msg.caretOffset === 'number') {");
    expect(source).toContain("selectionModel.unitElType(el) === 'block' || selectionModel.unitElType(el) === 'image'");
    expect(source).toContain('setSelection(selectionModel.singleSel(el));');
    expect(source).toContain('setSelectionAnchor(el);');
  });
});
