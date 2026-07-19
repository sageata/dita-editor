import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const css = readFileSync(new URL('../media/editor.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../media/content-theme.css', import.meta.url), 'utf8');

describe('editor.css', () => {
  test('managed alignment classes are shared by editable and read-only markup with deterministic precedence', () => {
    const left = theme.indexOf('main .ditaeditor-align-left');
    const center = theme.indexOf('main .ditaeditor-align-center');
    const right = theme.indexOf('main .ditaeditor-align-right');
    const justify = theme.indexOf('main .ditaeditor-align-justify');

    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(center);
    expect(center).toBeLessThan(right);
    expect(right).toBeLessThan(justify);
    expect(theme.slice(left, justify + 160)).not.toContain('[data-struct-id]');
    expect(theme).toMatch(/main \.ditaeditor-align-left\s*{\s*text-align: left !important;/);
    expect(theme).toMatch(/main \.ditaeditor-align-center\s*{\s*text-align: center !important;/);
    expect(theme).toMatch(/main \.ditaeditor-align-right\s*{\s*text-align: right !important;/);
    expect(theme).toMatch(/main \.ditaeditor-align-justify\s*{\s*text-align: justify !important;/);
    expect(theme).toMatch(/main \.cmd\.ditaeditor-align-left,[\s\S]*main \.cmd\.ditaeditor-align-justify\s*{\s*display: block;/);
  });

  test('semantic lines blocks preserve authored breaks without imposing typography', () => {
    expect(theme).toContain('body.ditaeditor-canvas pre.lines');
    expect(theme).toContain('white-space: pre-wrap;');
    expect(theme).toContain('overflow-wrap: break-word;');
    expect(theme).not.toContain('font-family:');
    expect(theme).not.toContain('line-height:');
    expect(theme).not.toContain('data-preserve-lines');
  });

  test('table geometry stays editable without shipping table presentation', () => {
    expect(theme).toMatch(/table\.table\)\s*{[^}]*border-collapse: separate;[^}]*border-spacing: 0;/s);
    expect(theme).toContain('table.table colgroup col:only-child');
    expect(theme).toContain('table.table caption:empty');
    expect(theme).toContain('display: none;');
    expect(theme).not.toContain('--dc-color-border');
    expect(theme).not.toMatch(/frame-(?:all|topbot|sides|top|bottom|none)/);
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

  test('author table presentation is absent from extension stylesheets', () => {
    expect(theme).not.toContain('box-shadow:');
    expect(theme).not.toContain('--dc-shadow-md');
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
