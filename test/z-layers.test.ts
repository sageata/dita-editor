// Z-INDEX LAYER GATE: every z-index in the webview must come from the documented
// ladder below and be registered here. This exists because content-attached table
// overlays once shipped at z 290-305 and painted over open menus and modals.
//
// The ladder (keep new layers inside a band; never exceed 120):
//   40-49  content-attached overlays (drag grip/drop line, resize handles,
//          "+" inserters) - must stay BELOW menus
//   50-59  hover toolbars (50), menus/popovers (55-56)
//   60-69  status bar, kb hint, toasts
//   70-79  selection pill, side panels + resize handles, command bar
//   80-89  dropdowns inside panels
//  100-109 error banner, find/replace
//  110-120 modals, slash menu (highest layer in the editor)
//
// Adding or changing a z-index? Pick the band that matches what the element may
// cover, then update REGISTRY. If two layers can be visible at once, the one that
// must win needs the higher band.

import { Glob } from 'bun';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = path.resolve(import.meta.dir, '..');

// file (relative to repo root) -> every z-index value it declares, sorted
const REGISTRY: Record<string, number[]> = {
  'media/canvas-chrome.js': [60, 61, 65, 100],
  'media/canvas-command-bar-ui.js': [75],
  'media/canvas-context-toolbar.js': [50],
  'media/canvas-find-replace.js': [105],
  'media/canvas-image-bar.js': [48, 50],
  'media/canvas-insert-menu.js': [55],
  'media/canvas-menu.js': [55, 56],
  'media/canvas-move-block.js': [46, 47],
  'media/canvas-properties.js': [74, 74, 76],
  'media/canvas-selection-controller.js': [70],
  'media/canvas-shortcut-help.js': [110, 111],
  'media/canvas-slash-menu.js': [120],
  'media/canvas-styles.js': [74, 74, 76],
  'media/canvas-table-insert-plus.js': [49],
  'media/canvas-table-resize.js': [48],
  'media/editor.css': [80],
  // Separate script-less Review Changes webview: only the sticky banner stacks
  // above topic content; nothing from the canvas ladder can appear there.
  'media/redline.css': [10],
};

// Layers that anchor to document content; they must never cover an open menu.
const CONTENT_OVERLAY_FILES = [
  'media/canvas-move-block.js',
  'media/canvas-table-insert-plus.js',
  'media/canvas-table-resize.js',
];
const MENU_Z = 55;
const MAX_Z = 120;

// Matches `z-index: 80` (css), `z-index:55` (cssText) and `zIndex = '48'` (js).
const Z_DECL = /z-?index\s*[:=]\s*['"]?(-?\d+)/gi;

function scanFiles(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const globs = ['media/*.js', 'media/*.css', 'src/webview/*.ts'];
  for (const pattern of globs) {
    for (const rel of new Glob(pattern).scanSync(ROOT)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const values = [...text.matchAll(Z_DECL)].map((m) => Number(m[1]));
      if (values.length > 0) found.set(rel, values.sort((a, b) => a - b));
    }
  }
  return found;
}

describe('webview z-index ladder', () => {
  const found = scanFiles();

  test('every z-index declaration matches the registry (see ladder at top of this file)', () => {
    const actual = Object.fromEntries([...found.entries()].sort());
    expect(actual).toEqual(REGISTRY);
  });

  test('content-attached overlays stay below menus', () => {
    for (const file of CONTENT_OVERLAY_FILES) {
      for (const z of found.get(file) ?? []) {
        expect(z, `${file} declares z-index ${z}, which would cover open menus (z ${MENU_Z})`).toBeLessThan(MENU_Z);
      }
    }
  });

  test('nothing exceeds the top of the ladder', () => {
    for (const [file, values] of found) {
      for (const z of values) {
        expect(z, `${file} declares z-index ${z}, above the ladder max ${MAX_Z}`).toBeLessThanOrEqual(MAX_Z);
      }
    }
  });
});
