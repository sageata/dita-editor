import { existsSync, readFileSync, readdirSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const mediaDir = new URL('../media/', import.meta.url);

const assetUrls = {
  'content-theme.css': new URL('../media/content-theme.css', import.meta.url),
  'editor.css': new URL('../media/editor.css', import.meta.url),
  'redline.css': new URL('../media/redline.css', import.meta.url),
  'canvas-styles.js': new URL('../media/canvas-styles.js', import.meta.url),
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

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
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

function stripWhere(selector: string): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    if (selector.startsWith(':where(', i)) {
      i += ':where('.length;
      let depth = 1;
      while (i < selector.length && depth > 0) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')') depth--;
        i++;
      }
    } else {
      out += selector[i];
      i++;
    }
  }
  return out;
}

function specificity(selector: string): number {
  const stripped = stripWhere(selector);
  const ids = (stripped.match(/#[A-Za-z_-][\w-]*/g) ?? []).length;
  const classes = (stripped.match(/\.[A-Za-z_-][\w-]*/g) ?? []).length;
  const elements = (stripped.replace(/[.#][\w-]+/g, ' ').match(/[A-Za-z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + elements;
}

const exactTokens = {
  '--dc-font-family': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--dc-color-text': '#1f2937',
  '--dc-color-text-muted': '#4b5563',
  '--dc-color-surface': '#ffffff',
  '--dc-color-surface-muted': '#f3f4f6',
  '--dc-color-border': '#d1d5db',
  '--dc-color-accent': '#2563eb',
  '--dc-color-accent-strong': '#1d4ed8',
  '--dc-radius-md': '8px',
  '--dc-shadow-md': '0 6px 24px rgb(15 23 42 / 12%)',
} as const;

describe('public style assets', () => {
  test('the neutral content theme defines and consumes the complete public token contract', () => {
    const theme = readAsset('content-theme.css');
    expect(theme).not.toBe('');

    for (const [token, value] of Object.entries(exactTokens)) {
      expect(theme).toContain(`${token}: ${value};`);
      expect(theme).toContain(`var(${token})`);
    }
  });

  test('the content theme covers the rendered DITA document vocabulary', () => {
    const theme = readAsset('content-theme.css');
    const selectors = [
      'article.nested0',
      'h1.title.topictitle1',
      '.shortdesc',
      'p.p',
      'ul.ul',
      '.note',
      'figure.fig',
      'img.image',
      'code.ph.codeph',
      'pre.pre',
      'pre.lines',
      'a',
      'table.table',
      'th.entry',
      'td.entry',
    ];

    for (const selector of selectors) {
      expect(theme).toContain(selector);
    }
  });

  test('theme selectors have zero specificity so later developer styles can override them', () => {
    const theme = readAsset('content-theme.css');
    const comparisons = [
      [':where(body.ditaeditor-canvas h1.title.topictitle1)', '.title'],
      [':where(body.ditaeditor-canvas p.p)', 'p.p'],
      [':where(body.ditaeditor-canvas table.table th.entry)', 'table.table th.entry'],
    ] as const;

    expect(theme).not.toMatch(/^\s*body\.ditaeditor-canvas/m);
    for (const [themeSelector, laterDeveloperSelector] of comparisons) {
      expect(theme).toContain(themeSelector);
      expect(specificity(themeSelector)).toBe(0);
      expect(specificity(laterDeveloperSelector)).toBeGreaterThan(specificity(themeSelector));
    }
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

  test('style provenance uses neutral source descriptions instead of filenames', () => {
    const stylesPanel = readAsset('canvas-styles.js');

    expect(stylesPanel).toContain('configured workspace stylesheet');
    expect(stylesPanel).toContain('managed author stylesheet');
    expect(stylesPanel).toContain('DITA Editor surface stylesheet');
    expect(stylesPanel).not.toMatch(/(?:css\/|[A-Za-z]:\\|\/Users\/)[^'"`]*\.css/i);
  });

  test('style provenance text and managed badges meet WCAG AA contrast', () => {
    const stylesPanel = readAsset('canvas-styles.js');

    expect(stylesPanel).toContain("const GRAY_MUTED = '#4b5563';");
    expect(stylesPanel).toContain('background:#f0f7fa;color:#31586a;');
    expect(contrastRatio('#4b5563', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#31586a', '#f0f7fa')).toBeGreaterThanOrEqual(4.5);
  });

  test('forced colors preserve structural cues for every redline change state', () => {
    const forcedColors = atRuleBody(readAsset('redline.css'), '@media (forced-colors: active)');
    expect(forcedColors).not.toBe('');
    expect(forcedColors).not.toContain('forced-color-adjust');

    const stateCues = [
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
