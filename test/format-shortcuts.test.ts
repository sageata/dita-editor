import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

interface CanvasCommandShortcuts {
  formatShortcutOp(event: Record<string, unknown>): string | null;
}

function loadShortcuts(): CanvasCommandShortcuts {
  const source = readFileSync(new URL('../media/canvas-command-shortcuts.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasCommandShortcuts: CanvasCommandShortcuts };
  new Function('window', source)(win);
  return win.DitaEditorCanvasCommandShortcuts;
}

describe('formatShortcutOp', () => {
  test('maps common Word-style text formatting shortcuts', () => {
    const { formatShortcutOp } = loadShortcuts();

    expect(formatShortcutOp({ ctrlKey: true, key: 'b' })).toBe('b');
    expect(formatShortcutOp({ metaKey: true, key: 'B' })).toBe('b');
    expect(formatShortcutOp({ ctrlKey: true, key: 'i' })).toBe('i');
    expect(formatShortcutOp({ metaKey: true, key: 'I' })).toBe('i');
    expect(formatShortcutOp({ ctrlKey: true, key: 'u' })).toBe('u');
    expect(formatShortcutOp({ metaKey: true, key: 'U' })).toBe('u');
  });

  test('maps inline code, subscript, and superscript shortcuts', () => {
    const { formatShortcutOp } = loadShortcuts();

    expect(formatShortcutOp({ ctrlKey: true, key: '`' })).toBe('codeph');
    expect(formatShortcutOp({ metaKey: true, key: 'Dead' })).toBe('codeph');
    expect(formatShortcutOp({ ctrlKey: true, key: '=' })).toBe('sub');
    expect(formatShortcutOp({ ctrlKey: true, shiftKey: true, key: '=' })).toBe('sup');
    expect(formatShortcutOp({ metaKey: true, shiftKey: true, key: '+' })).toBe('sup');
  });

  test('ignores non-formatting modifier combinations', () => {
    const { formatShortcutOp } = loadShortcuts();

    expect(formatShortcutOp({ key: 'b' })).toBeNull();
    expect(formatShortcutOp({ ctrlKey: true, altKey: true, key: 'b' })).toBeNull();
    expect(formatShortcutOp({ ctrlKey: true, shiftKey: true, key: 'b' })).toBeNull();
    expect(formatShortcutOp({ ctrlKey: true, shiftKey: true, key: 'u' })).toBeNull();
  });
});
