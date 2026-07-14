import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const css = readFileSync(new URL('../media/editor.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../media/content-theme.css', import.meta.url), 'utf8');

describe('editor.css', () => {
  test('semantic lines blocks preserve authored breaks with paragraph typography', () => {
    expect(theme).toContain('body.ditaeditor-canvas pre.lines');
    expect(theme).toContain('white-space: pre-wrap;');
    expect(theme).toContain('font-family: inherit;');
    expect(theme).toContain('line-height: inherit;');
    expect(theme).toContain('background: transparent;');
    expect(theme).not.toContain('background: transparent !important;');
    expect(theme).not.toContain('data-preserve-lines');
  });

  test('table cell lines do not add block spacing below the cell content', () => {
    expect(theme).toMatch(
      /:where\(body\.ditaeditor-canvas :is\(th, td\)\.entry \.lines\)\s*{\s*margin: 0;\s*}/,
    );
  });

  test('CALS grid and frame choices control distinct, non-conflicting border edges', () => {
    expect(theme).toMatch(/th\.entry\),\s*:where\([^)]*td\.entry\)\s*{[^}]*border: 0;[^}]*border-right: 1px solid var\(--dc-color-border\);[^}]*border-bottom: 1px solid var\(--dc-color-border\);/s);
    expect(theme).toContain('table.table tr > td.entry:last-child)');
    expect(theme).toContain('table.table tbody > tr:last-child > td.entry)');
    expect(theme).toMatch(/table\.table\.frame-all\)\s*{\s*border-width: 1px;/s);
    expect(theme).toMatch(/table\.table\.frame-topbot\)\s*{\s*border-width: 1px 0;/s);
    expect(theme).toMatch(/table\.table\.frame-sides\)\s*{\s*border-width: 0 1px;/s);
    expect(theme).toMatch(/table\.table\.frame-top\)\s*{\s*border-width: 1px 0 0;/s);
    expect(theme).toMatch(/table\.table\.frame-bottom\)\s*{\s*border-width: 0 0 1px;/s);
    expect(theme).toMatch(/table\.table\.frame-none\)\s*{\s*border-width: 0;/s);
  });

  test('editable text selections keep prose background transparent', () => {
    expect(css).toContain('body.ditaeditor-canvas [contenteditable].is-selected:not(td):not(th)');
    expect(css).toContain('background: transparent;');
  });

  test('table headers are never position:sticky (displaced thead covered body rows)', () => {
    expect(css).not.toContain('position: sticky');
    expect(css).not.toContain('--dc-topclear');
  });

  test('resize handles paint no full-height stripe outside the debug layer class', () => {
    expect(css).not.toContain('.dc-table-col-resize-handle:hover');
    expect(css).toContain('.dc-table-guides-debug .dc-table-col-resize-handle');
  });

  test('document shadows live in the content theme while private outputclasses stay workspace-owned', () => {
    expect(theme).toMatch(/:where\(body\.ditaeditor-canvas table\.table\)\s*{[\s\S]*?box-shadow: var\(--dc-shadow-md\);/);
    expect(css).not.toContain('body.ditaeditor-canvas table.table {');
    expect(theme).not.toMatch(/\.ey[-_][A-Za-z0-9_-]*\b/i);
    expect(css).not.toMatch(/\.ey[-_][A-Za-z0-9_-]*\b/i);
  });

  test('end insertion chrome uses only neutral text and accent alpha literals', () => {
    expect(css).toContain('approximately 5.2:1 (#2563eb on white)');
    expect(css).toContain('rgb(31 41 55 / 22%)');
    expect(css).toContain('rgb(31 41 55 / 24%)');
    expect(css).toContain('rgb(31 41 55 / 72%)');
    expect(css).toContain('rgb(37 99 235 / 42%)');
    expect(css).toContain('rgb(37 99 235 / 4%)');
    expect(css).not.toMatch(/rgba\((?:38, 58, 70|153, 111, 42),/);
    expect(css).not.toContain('#996f2a');
  });

  test('empty editables keep a real caret anchor but paint NO visible label (user request)', () => {
    expect(css).toContain('body.ditaeditor-canvas br[data-empty-caret]');
    expect(css).not.toContain('content: attr(data-empty-placeholder);');
    expect(css).not.toContain('[data-empty-placeholder]:has(> br[data-empty-caret]:only-child)::before');
    expect(css).not.toContain('p.p:empty::before');
  });
});
