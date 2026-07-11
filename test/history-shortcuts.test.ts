import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

interface CanvasCommandShortcuts {
  historyShortcutOp(event: Record<string, unknown>): string | null;
}

function loadShortcuts(): CanvasCommandShortcuts {
  const source = readFileSync(new URL('../media/canvas-command-shortcuts.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasCommandShortcuts: CanvasCommandShortcuts };
  new Function('window', source)(win);
  return win.DitaEditorCanvasCommandShortcuts;
}

describe('historyShortcutOp', () => {
  test('maps platform undo shortcuts', () => {
    const { historyShortcutOp } = loadShortcuts();

    expect(historyShortcutOp({ metaKey: true, key: 'z' })).toBe('undo');
    expect(historyShortcutOp({ ctrlKey: true, key: 'Z' })).toBe('undo');
  });

  test('maps platform redo shortcuts', () => {
    const { historyShortcutOp } = loadShortcuts();

    expect(historyShortcutOp({ metaKey: true, shiftKey: true, key: 'z' })).toBe('redo');
    expect(historyShortcutOp({ ctrlKey: true, shiftKey: true, key: 'Z' })).toBe('redo');
    expect(historyShortcutOp({ ctrlKey: true, key: 'y' })).toBe('redo');
    expect(historyShortcutOp({ metaKey: true, key: 'Y' })).toBe('redo');
  });

  test('maps plain find shortcut to the webview find command', () => {
    const { historyShortcutOp } = loadShortcuts();

    expect(historyShortcutOp({ metaKey: true, key: 'f' })).toBe('find');
    expect(historyShortcutOp({ ctrlKey: true, key: 'F' })).toBe('find');
  });

  test('ignores non-history and Alt-modified combinations', () => {
    const { historyShortcutOp } = loadShortcuts();

    expect(historyShortcutOp({ key: 'z' })).toBeNull();
    expect(historyShortcutOp({ ctrlKey: true, altKey: true, key: 'z' })).toBeNull();
    expect(historyShortcutOp({ metaKey: true, key: 'b' })).toBeNull();
    expect(historyShortcutOp({ ctrlKey: true, shiftKey: true, key: 'y' })).toBeNull();
    expect(historyShortcutOp({ ctrlKey: true, shiftKey: true, key: 'f' })).toBeNull();
  });
});
