import { existsSync, readFileSync, readdirSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const mediaDir = new URL('../media/', import.meta.url);

const assetUrls = {
  'content-theme.css': new URL('../media/content-theme.css', import.meta.url),
  'editor.css': new URL('../media/editor.css', import.meta.url),
  'redline.css': new URL('../media/redline.css', import.meta.url),
  'styles-panel.js': new URL('../media/styles-panel.js', import.meta.url),
  'canvas-table-resize.js': new URL('../media/canvas-table-resize.js', import.meta.url),
  'to-html.ts': new URL('../src/render/to-html.ts', import.meta.url),
  'author-styles.ts': new URL('../src/styles/author-styles.ts', import.meta.url),
} as const;

function readAsset(name: keyof typeof assetUrls): string {
  return existsSync(assetUrls[name]) ? readFileSync(assetUrls[name], 'utf8') : '';
}

const runtimePresentationAssets = readdirSync(mediaDir, { withFileTypes: true })
  .filter((entry) =>
    entry.isFile()
    && (/^canvas.*\.js$/.test(entry.name) || /^(?:content-theme|editor|redline)\.(?:css|js)$/.test(entry.name)))
  .map((entry) => entry.name)
  .sort();

function readRuntimePresentationAsset(name: string): string {
  return readFileSync(new URL(name, mediaDir), 'utf8');
}

function atRuleBody(source: string, header: string): string {
  const headerIndex = source.indexOf(header);
  if (headerIndex === -1) return '';
  const openIndex = source.indexOf('{', headerIndex + header.length);
  if (openIndex === -1) return '';
  let depth = 1;
  for (let index = openIndex + 1; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  return '';
}

function cssRuleBody(source: string, selector: string): string {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((value) => value.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return '';
}

describe('public style assets', () => {
  test('the content theme contains structural editing rules but no author presentation', () => {
    const theme = readAsset('content-theme.css');
    expect(theme).not.toBe('');

    for (const selector of [
      'main .ditaeditor-align-left',
      'img.image',
      'pre.codeblock',
      'table.table',
      'th.entry',
      'td.entry',
      'colgroup col:only-child',
      'caption:empty',
    ]) {
      expect(theme).toContain(selector);
    }

    expect(theme).not.toMatch(/--dc-(?:color|font|radius|shadow)-/);
    expect(theme).not.toMatch(/(?:^|\s)(?:color|background|font-family|font-size|box-shadow|border-radius):/m);
    expect(theme).not.toContain('h1.title.topictitle1');
    expect(theme).not.toContain('.shortdesc');
    expect(theme).not.toContain('.note');
  });

  test('structural document selectors remain zero-specificity for repository overrides', () => {
    const theme = readAsset('content-theme.css');
    expect(theme).not.toMatch(/^\s*body\.ditaeditor-canvas/m);
    expect(theme).toContain(':where(body.ditaeditor-canvas img.image)');
    expect(theme).toContain(':where(body.ditaeditor-canvas table.table)');
    expect(theme).toContain(':where(body.ditaeditor-canvas table.table th.entry)');
  });

  test('scoped shipped defaults contain no private presentation dependencies', () => {
    const privateToken = ['--', 'ey', '-'].join('');
    const privateBrand = ['eti', 'had'].join('');
    for (const name of Object.keys(assetUrls) as Array<keyof typeof assetUrls>) {
      const source = readAsset(name);
      expect(source.toLowerCase(), name).not.toContain(privateToken);
      expect(source.toLowerCase(), name).not.toContain(privateBrand);
      expect(source, name).not.toMatch(/@import\s+(?:url\()?\s*['"]?https?:\/\//i);
    }
  });

  test('all shipped canvas and review presentation assets avoid the corporate font family', () => {
    expect(runtimePresentationAssets).toContain('canvas.js');
    expect(runtimePresentationAssets).toContain('content-theme.css');

    for (const name of runtimePresentationAssets) {
      expect(readRuntimePresentationAsset(name), name).not.toMatch(/ibm\s+plex\b/i);
    }
  });

  test('shipped CSS contains no private ey-prefixed selectors', () => {
    const privateSelectorPrefix = ['.', 'ey', '-'].join('');
    for (const name of ['content-theme.css', 'editor.css', 'redline.css'] as const) {
      expect(readAsset(name).toLowerCase(), name).not.toContain(privateSelectorPrefix);
    }
  });

  test('style provenance uses neutral descriptions and only a repository-relative setup path', () => {
    const stylesPanel = readAsset('styles-panel.js');

    expect(stylesPanel).toContain('configured workspace stylesheet');
    expect(stylesPanel).toContain('managed author stylesheet');
    expect(stylesPanel).toContain('DITA Editor surface stylesheet');
    expect(stylesPanel).toContain('css/ditaeditor-author-styles.css');
    expect(stylesPanel).not.toMatch(/(?:[A-Za-z]:\\|\/Users\/)[^'"`]*\.css/i);
  });

  test('style provenance text and managed badges follow the workbench theme palette', () => {
    const stylesPanel = readAsset('styles-panel.js');

    // Contrast is theme-owned now: the panel must draw its text/badge colors
    // from --vscode-* variables (whose themes are contrast-audited upstream)
    // rather than shipping its own hardcoded light palette.
    expect(stylesPanel).toContain('var(--vscode-foreground');
    expect(stylesPanel).toContain('var(--vscode-descriptionForeground');
    expect(stylesPanel).toContain('var(--vscode-badge-background');
    expect(stylesPanel).toContain('var(--vscode-badge-foreground');
  });

  test('forced colors preserve structural cues for every redline change state', () => {
    const forcedColors = atRuleBody(readAsset('redline.css'), '@media (forced-colors: active)');
    expect(forcedColors).not.toBe('');
    expect(forcedColors).not.toContain('forced-color-adjust');

    const stateCues = [
      ['.redline-compare-row-inserted [data-redline-side="new"]', 'solid'],
      ['.redline-compare-row-deleted [data-redline-side="old"]', 'double'],
      ['.redline-compare-row-modified .redline-compare-cell', 'solid'],
      ['.redline-compare-row-formatChanged .redline-compare-cell', 'dotted'],
      ['.redline-compare-row-movedFrom [data-redline-side="old"]', 'dashed'],
      ['.redline-compare-row-movedTo [data-redline-side="new"]', 'dashed'],
      ['.redline-block-ins', 'solid'],
      ['.redline-block-del', 'double'],
      ['.redline-block-fmt', 'dotted'],
      ['.redline-block-mod', 'solid'],
      ['.redline-block-moved', 'dashed'],
      ['.redline-block-moved-from', 'dashed'],
      ['ins.redline', 'double'],
      ['del.redline', 'double'],
    ] as const;
    for (const [selector, style] of stateCues) {
      const body = cssRuleBody(forcedColors, selector);
      expect(body, selector).toMatch(new RegExp(
        `(?:outline|border(?:-[a-z-]+)?|text-decoration)\\s*:[^;]*\\b${style}\\b[^;]*(?:CanvasText|Highlight|LinkText)`,
        'i',
      ));
    }

    const changedTableSelectors = [
      'tr.redline-row-ins > td',
      'tr.redline-row-ins > th',
      'tr.redline-row-del > td',
      'tr.redline-row-del > th',
      'tr.redline-row-fmt > td',
      'tr.redline-row-fmt > th',
      'td.redline-entry-fmt',
      'th.redline-entry-fmt',
      '.redline-cell-ins',
      '.redline-cell-del',
    ];
    for (const selector of changedTableSelectors) {
      const body = cssRuleBody(forcedColors, selector);
      expect(body, selector).toMatch(/(?:outline|border(?:-[a-z-]+)?|text-decoration)\s*:/i);
      expect(body, selector).toMatch(/(?:CanvasText|Highlight|LinkText)/i);
    }
  });
});
