import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { CANVAS_SCRIPT_FILES, type CanvasScriptFile } from '../src/webview/canvas-scripts';

const mediaDir = join(import.meta.dir, '..', 'media');

const indexOf = (file: CanvasScriptFile): number => CANVAS_SCRIPT_FILES.indexOf(file);
const scriptFiles: readonly string[] = CANVAS_SCRIPT_FILES;

describe('CANVAS_SCRIPT_FILES', () => {
  test('contains each browser script once and all files exist', () => {
    expect(new Set(CANVAS_SCRIPT_FILES).size).toBe(CANVAS_SCRIPT_FILES.length);
    for (const file of CANVAS_SCRIPT_FILES) {
      expect(existsSync(join(mediaDir, file))).toBe(true);
    }
  });

  test('does not production-load debug probes', () => {
    expect(scriptFiles).not.toContain('canvas-debug.js');
    expect(scriptFiles).not.toContain('canvas-selection-probes.js');
  });

  test('loads helper scripts before their browser consumers', () => {
    expect(CANVAS_SCRIPT_FILES.at(-1)).toBe('canvas.js');
    expect(indexOf('canvas-text-metrics.js')).toBeLessThan(indexOf('canvas-editing.js'));
    expect(indexOf('canvas-text-metrics.js')).toBeLessThan(indexOf('canvas-keyboard-nav.js'));
    expect(indexOf('canvas-text-metrics.js')).toBeLessThan(indexOf('canvas-command-format.js'));
    expect(indexOf('canvas-text-metrics.js')).toBeLessThan(indexOf('canvas-command-structure.js'));
    expect(indexOf('canvas-context-toolbar-state.js')).toBeLessThan(indexOf('canvas-context-toolbar.js'));
    expect(indexOf('canvas-command-format.js')).toBeLessThan(indexOf('canvas-command-bar.js'));
    expect(indexOf('canvas-command-shortcuts.js')).toBeLessThan(indexOf('canvas-command-bar.js'));
    expect(indexOf('canvas-command-insert.js')).toBeLessThan(indexOf('canvas-command-bar.js'));
    expect(indexOf('canvas-command-structure.js')).toBeLessThan(indexOf('canvas-command-bar.js'));
    expect(indexOf('canvas-command-bar-ui.js')).toBeLessThan(indexOf('canvas-command-bar.js'));
    expect(indexOf('canvas-end-insert.js')).toBeLessThan(indexOf('canvas.js'));
    expect(indexOf('canvas-selection-summary.js')).toBeLessThan(indexOf('canvas-selection-controller.js'));
    expect(indexOf('canvas-selection-range.js')).toBeLessThan(indexOf('canvas-selection-controller.js'));
    expect(indexOf('canvas-selection-clipboard.js')).toBeLessThan(indexOf('canvas-selection-controller.js'));
    expect(indexOf('canvas-selection-restore.js')).toBeLessThan(indexOf('canvas-selection-controller.js'));
    expect(indexOf('canvas-selection-dependencies.js')).toBeLessThan(indexOf('canvas-selection-controller.js'));
  });
});
