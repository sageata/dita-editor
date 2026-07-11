import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_AUTHOR_STYLES,
  defaultStyleClassName,
  defaultSelectorsForTarget,
  isDefaultStyleClassName,
  managedAuthorClassNames,
  mergeMissingDefaultStyles,
  normalizeAuthorStyles,
  parseAuthorStyles,
  replaceManagedOutputClass,
  serializeAuthorStyles,
  shadeClassNameForColor,
  shadeManagedClassNames,
  slugStyleName,
  type AuthorStyleDefinition,
  type AuthorStyleTarget,
} from '../src/styles/author-styles';

function cssBlockFor(css: string, className: string): string {
  const match = css.match(new RegExp(`\\/\\* DITAEDITOR_AUTHOR_STYLE [^*]*"${className}"[\\s\\S]*?\\{\\n([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`CSS block not found for ${className}`);
  return match[1];
}

describe('author style registry', () => {
  test('serializes CSS blocks with metadata and parses them back', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);
    const parsed = parseAuthorStyles(css);

    expect(parsed).toEqual(DEFAULT_AUTHOR_STYLES);
    expect(css).toContain('DITAEDITOR_AUTHOR_STYLE');
    expect(css).toContain('.dc-heading-gold');
    expect(css).toContain('.title.dc-title-display');
    expect(css).toContain('h1.title.topictitle1.dc-title-display');
    expect(css).toContain('.ul.dc-list-spacious');
    expect(css).toContain('.entry.dc-cell-shaded');
    expect(css).toContain('border-left: 4px solid var(--dc-color-accent, #2563eb) !important;');
  });

  test('metadata escapes every slash without changing adversarial style names', () => {
    const name = 'Cabin */ /* DITAEDITOR_MANAGED_STYLES_START */\r\n' +
      '/* DITAEDITOR_MANAGED_STYLES_END */ / \\ \' " .fake { color: red; }';
    const styles: AuthorStyleDefinition[] = [
      { className: 'dc-adversarial', name, target: 'body', color: '#123456' },
      { className: 'dc-default-page', name, target: 'page', isDefault: true, contentWidth: '840px' },
    ];

    const css = serializeAuthorStyles(styles);
    const metadata = css.split('\n').filter((line) => line.startsWith('/* DITAEDITOR_AUTHOR_STYLE '));

    expect(metadata).toHaveLength(2);
    expect(metadata.every((line) => !/(^|[^\\])\//.test(line.slice(2, -2)))).toBe(true);
    expect(css).not.toContain('/* DITAEDITOR_MANAGED_STYLES_START */');
    expect(css).not.toContain('/* DITAEDITOR_MANAGED_STYLES_END */');
    expect(parseAuthorStyles(css).map((style) => style.name)).toEqual([name, name]);
  });

  test('serializes title styles with enough specificity to beat editor title CSS', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);

    expect(css).toContain('body.ditaeditor-canvas article article h1.title.topictitle1.dc-title-display');
    expect(css).toContain('h1.title.topictitle1.dc-title-display');
  });

  test('title and heading styles replace inherited chrome instead of mixing with it', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);
    const titleBlock = cssBlockFor(css, 'dc-title-display');
    const compactHeadingBlock = cssBlockFor(css, 'dc-heading-compact');
    const accentHeadingBlock = cssBlockFor(css, 'dc-heading-gold');

    expect(titleBlock).toContain('border-left: 0 !important;');
    expect(titleBlock).toContain('padding-left: 0 !important;');
    expect(titleBlock).toContain('border-bottom: 0 !important;');
    expect(titleBlock).toContain('padding-bottom: 0 !important;');
    expect(css).toContain('body.ditaeditor-canvas h1.title.topictitle1.dc-heading-compact');
    expect(css).toContain('h1.title.topictitle1.dc-heading-compact');
    expect(compactHeadingBlock).toContain('border-left: 0 !important;');
    expect(compactHeadingBlock).toContain('padding-left: 0 !important;');
    expect(accentHeadingBlock).toContain('border-left: 0 !important;');
    expect(accentHeadingBlock).toContain('border-left: 4px solid var(--dc-color-accent, #2563eb) !important;');
  });

  test('table cell base styles carry the theme cell padding and alignment', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);
    const headBlock = cssBlockFor(css, 'dc-default-tableHeadCell');
    const bodyBlock = cssBlockFor(css, 'dc-default-tableBodyCell');

    expect(headBlock).toContain('padding: 12px 14px;');
    expect(headBlock).toContain('text-align: left;');
    expect(headBlock).toContain('vertical-align: middle;');
    expect(bodyBlock).toContain('padding: 10px 14px;');
    expect(bodyBlock).toContain('vertical-align: top;');
    // Cell targets take an explicit padding, never the background "chip" padding.
    expect(headBlock).not.toContain('padding: 6px 10px;');
  });

  test('table base emits the full card border, clipped radius, and no chip padding', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);
    const block = cssBlockFor(css, 'dc-default-table');

    expect(block).toContain('border: 1px solid var(--dc-color-border, #d1d5db);');
    expect(block).toContain('border-collapse: collapse;');
    expect(block).toContain('border-radius: var(--dc-radius-md, 8px);');
    expect(block).toContain('overflow: hidden;');
    expect(block).toContain('background-color: var(--dc-color-surface, #ffffff);');
    expect(block).toContain('width: 100%;');
    // A table container is a full-bleed card, never a padded chip.
    expect(block).not.toContain('padding: 6px 10px;');
  });

  test('a table PRESET keeps the lighter top/bottom rule accent, not the full border', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-ruled', name: 'Ruled', target: 'table', borderColor: '#ccc' },
    ]);
    const block = cssBlockFor(css, 'dc-ruled');
    expect(block).toContain('border-top: 3px solid #ccc;');
    expect(block).toContain('border-bottom: 1px solid #ccc;');
    expect(block).not.toContain('border: 1px solid #ccc;');
  });

  test('topic-skin base styles reproduce the theme typography/spacing', () => {
    const css = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);

    const title = cssBlockFor(css, 'dc-default-title');
    expect(title).toContain('font-weight: 700;');
    expect(title).toContain('color: var(--dc-color-text, #1f2937);');
    expect(title).toContain('line-height: 1.15;');
    expect(title).toContain('margin-bottom: 28px;');
    expect(title).toContain('margin-top: 0;');

    const heading = cssBlockFor(css, 'dc-default-heading');
    expect(heading).toContain('font-size: 24px;');
    expect(heading).toContain('margin-top: 32px;');
    expect(heading).toContain('margin-bottom: 12px;');

    const body = cssBlockFor(css, 'dc-default-body');
    expect(body).toContain('margin-top: 0;');
    expect(body).toContain('margin-bottom: 16px;');

    const list = cssBlockFor(css, 'dc-default-list');
    expect(list).toContain('padding: 0 0 0 26px;');
    expect(list).toContain('margin-bottom: 18px;');

    const li = cssBlockFor(css, 'dc-default-listItem');
    expect(li).toContain('margin-top: 6px;');
    expect(li).toContain('margin-bottom: 0;');
  });

  test('an explicit padding suppresses the background chip padding on non-cell targets', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-pad', name: 'Padded', target: 'body', backgroundColor: '#eee', padding: '20px' },
    ]);
    const block = cssBlockFor(css, 'dc-pad');
    expect(block).toContain('padding: 20px;');
    expect(block).not.toContain('padding: 6px 10px;');
  });

  test('managed class replacement preserves unrelated outputclass tokens', () => {
    const managed = managedAuthorClassNames(DEFAULT_AUTHOR_STYLES);

    expect(replaceManagedOutputClass('keep dc-heading-gold other', 'dc-heading-compact', managed))
      .toBe('keep other dc-heading-compact');
    expect(replaceManagedOutputClass('keep dc-heading-gold other', '', managed))
      .toBe('keep other');
  });

  test('slugStyleName creates CSS-safe DITA Editor class names', () => {
    expect(slugStyleName('Cabin Heading / Accent')).toBe('dc-cabin-heading-accent');
    expect(slugStyleName('')).toBe('dc-style');
  });
});

const STRUCTURAL_TARGETS: Exclude<AuthorStyleTarget, 'all'>[] = [
  'title',
  'heading',
  'body',
  'shortdesc',
  'section',
  'list',
  'listItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeadCell',
  'tableBodyCell',
  'figure',
  'image',
  'note',
  'code',
  'lines',
];

function selectorsFromCss(css: string, className: string): string[] {
  const re = new RegExp(`\\/\\* DITAEDITOR_AUTHOR_STYLE [^\\n]*"${className}"[^\\n]*\\*\\/\\n([\\s\\S]*?) \\{`);
  const match = css.match(re);
  if (!match) throw new Error(`selectors not found for ${className}`);
  return match[1].split(',\n').map((s) => s.trim()).filter(Boolean);
}

// :where(...) contributes zero specificity; strip it (balanced parens, since the
// predicate may itself nest — e.g. :where(tr.row:nth-child(even))) before counting.
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

describe('kind-scoped default (base) styles', () => {
  test('normalization forces the reserved class name and round-trips through CSS', () => {
    const css = serializeAuthorStyles([
      { className: 'whatever', name: '', target: 'body', isDefault: true, color: '#123456' },
    ]);
    const parsed = parseAuthorStyles(css);

    expect(parsed).toEqual([
      { className: 'dc-default-body', name: 'Base paragraph', target: 'body', isDefault: true, color: '#123456' },
    ]);
    expect(defaultStyleClassName('body')).toBe('dc-default-body');
    expect(isDefaultStyleClassName('dc-default-listItem')).toBe(true);
    expect(isDefaultStyleClassName('dc-default-nope')).toBe(false);
  });

  test('an all-elements default is rejected and a preset cannot squat the reserved namespace', () => {
    const normalized = normalizeAuthorStyles([
      { className: 'dc-x', name: 'All base', target: 'all', isDefault: true, color: '#111111' },
      { className: 'dc-default-note', name: 'Sneaky', target: 'note', color: '#222222' },
    ]);

    expect(normalized[0].isDefault).toBeUndefined();
    expect(normalized[0].className).toBe('dc-x');
    expect(normalized[1].className).toBe('dc-sneaky');
  });

  test('defaults serialize before presets and empty defaults are dropped', () => {
    const preset: AuthorStyleDefinition = { className: 'dc-probe', name: 'Probe', target: 'body', color: '#654321' };
    const css = serializeAuthorStyles([
      preset,
      { className: '', name: 'Base', target: 'body', isDefault: true, color: '#123456' },
      { className: '', name: 'Empty base', target: 'note', isDefault: true },
    ]);

    expect(css.indexOf('dc-default-body')).toBeGreaterThan(-1);
    expect(css.indexOf('dc-default-body')).toBeLessThan(css.indexOf('dc-probe'));
    expect(css).not.toContain('dc-default-note');
  });

  test('default selectors are classless, doubled, and specificity-matched to preset twins', () => {
    for (const target of STRUCTURAL_TARGETS) {
      const css = serializeAuthorStyles([
        { className: 'dc-probe', name: 'Probe', target, color: '#654321' },
        { className: '', name: 'Base', target, isDefault: true, color: '#123456' },
      ]);
      const defSelectors = selectorsFromCss(css, defaultStyleClassName(target));
      expect(defSelectors.length).toBeGreaterThan(0);
      for (const selector of defSelectors) {
        expect(selector).not.toContain('dc-default');
        expect(selector).not.toContain('dc-probe');
      }

      // Applied presets must be able to win by source order, so the strongest
      // default selector may not out-specify the strongest comparable preset one.
      const presetSelectors = selectorsFromCss(css, 'dc-probe').filter((selector) => {
        if (selector.includes('article article')) return false;
        if (target === 'heading' && selector.includes('topictitle1')) return false;
        return true;
      });
      const maxDefault = Math.max(...defSelectors.map(specificity));
      const maxPreset = Math.max(...presetSelectors.map(specificity));
      expect({ target, maxDefault }).toEqual({ target, maxDefault: maxPreset });
    }
  });

  test('title and heading defaults leave nested topics and topic titles alone', () => {
    const titleSelectors = defaultSelectorsForTarget('title');
    const headingSelectors = defaultSelectorsForTarget('heading');

    expect(titleSelectors.some((s) => s.includes('article article'))).toBe(false);
    expect(headingSelectors.some((s) => s.includes('topictitle1'))).toBe(false);
    expect(titleSelectors).not.toContain('.title.title');
    expect(headingSelectors).not.toContain('.title.title');
  });

  test('code and lines backgrounds rely on cascade order without important overrides', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-code-x', name: 'Code fill', target: 'code', backgroundColor: '#eeeeee' },
      { className: '', name: 'Base', target: 'lines', isDefault: true, backgroundColor: '#dddddd' },
      { className: 'dc-body-x', name: 'Body fill', target: 'body', backgroundColor: '#cccccc' },
    ]);

    expect(css).toContain('background-color: #eeeeee;');
    expect(css).toContain('background-color: #dddddd;');
    expect(css).not.toContain('background-color: #eeeeee !important;');
    expect(css).not.toContain('background-color: #dddddd !important;');
    expect(css).toContain('background-color: #cccccc;');
  });

  test('default class names stay in the managed set so a leaked token self-heals', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: '', name: 'Base', target: 'body', isDefault: true, color: '#123456' },
      { className: 'dc-probe', name: 'Probe', target: 'body', color: '#654321' },
    ];
    const managed = managedAuthorClassNames(styles);

    expect(managed).toContain('dc-default-body');
    expect(replaceManagedOutputClass('keep dc-default-body', 'dc-probe', managed)).toBe('keep dc-probe');
  });
});

describe('structural variant base styles', () => {
  test('the striped-rows preset is a class-scoped opt-in on the table, not an automatic default', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-stripe', name: 'Striped rows', target: 'table', structuralVariant: 'zebraEven', backgroundColor: '#f9fafb' },
    ]);

    // Applied to a <table class="… dc-stripe">, it shades only its even body rows.
    expect(css).toContain('table.table.dc-stripe tbody.tbody tr.row:nth-child(even) td.entry');
    expect(css).toContain('background-color: #f9fafb;');
    // It is a preset (isDefault:false), never a dc-default-* auto rule.
    expect(css).not.toContain('dc-default-tableBodyCell-zebraEven');
    expect(parseAuthorStyles(css)).toEqual([
      { className: 'dc-stripe', name: 'Striped rows', target: 'table', structuralVariant: 'zebraEven', backgroundColor: '#f9fafb' },
    ]);
  });

  test('table-level variants target colgroup/caption and are never dropped as empty', () => {
    const css = serializeAuthorStyles([
      { className: '', name: 'Single col', target: 'table', isDefault: true, structuralVariant: 'singleCol' },
      { className: '', name: 'Empty caption', target: 'table', isDefault: true, structuralVariant: 'emptyCaption' },
    ]);

    expect(css).toContain('table.table colgroup col:where(:only-child)');
    expect(css).toContain('width: 100%;');
    expect(css).toContain('table.table caption:where(:empty)');
    expect(css).toContain('display: none;');
    // Both carry no VALUE_FIELDS yet must survive the defaults empty-drop.
    expect(css).toContain('dc-default-table-singleCol');
    expect(css).toContain('dc-default-table-emptyCaption');
  });

  test('an applied header preset wins over the always-on neutral base by source order', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-header-gold', name: 'Accent header', target: 'tableHeadCell', backgroundColor: '#2563eb' },
      { className: '', name: 'Neutral', target: 'tableHeadCell', isDefault: true, backgroundColor: '#1f2937' },
    ]);

    // The always-on base serializes before the applied preset...
    const baseIdx = css.indexOf('"dc-default-tableHeadCell"');
    const presetIdx = css.indexOf('"dc-header-gold"');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(presetIdx).toBeGreaterThan(baseIdx);

    // ...and the preset's strongest selector only ties the base's specificity, so later
    // source order (not higher specificity) is what makes the applied choice win.
    const base = defaultSelectorsForTarget('tableHeadCell');
    const presetSelectors = selectorsFromCss(css, 'dc-header-gold');
    expect(Math.max(...presetSelectors.map(specificity)))
      .toBe(Math.max(...base.map(specificity)));
  });

  test('markerColor emits a ::marker block and round-trips', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: '', name: 'Marker', target: 'listItem', isDefault: true, markerColor: 'var(--dc-color-accent, #2563eb)' },
    ];
    const css = serializeAuthorStyles(styles);

    expect(css).toContain('::marker {');
    expect(css).toContain('color: var(--dc-color-accent, #2563eb);');
    expect(parseAuthorStyles(css)).toEqual([
      { className: 'dc-default-listItem', name: 'Marker', target: 'listItem', isDefault: true, markerColor: 'var(--dc-color-accent, #2563eb)' },
    ]);
  });

  test('a base structuralVariant survives a serialize/parse round trip', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: '', name: 'Single col', target: 'table', isDefault: true, structuralVariant: 'singleCol', width: '100%' },
    ];
    expect(parseAuthorStyles(serializeAuthorStyles(styles))).toEqual([
      { className: 'dc-default-table-singleCol', name: 'Single col', target: 'table', isDefault: true, structuralVariant: 'singleCol', width: '100%' },
    ]);
  });

  test('base variants require isDefault; the zebra preset variant requires a non-default', () => {
    // singleCol is a base variant — dropped on a non-default (preset) style.
    const [preset] = normalizeAuthorStyles([
      { className: 'dc-x', name: 'Preset', target: 'table', structuralVariant: 'singleCol', width: '100%' },
    ]);
    expect(preset.structuralVariant).toBeUndefined();
    expect(preset.className).toBe('dc-x');

    // zebraEven is a preset variant — dropped on an isDefault (base) style.
    const [base] = normalizeAuthorStyles([
      { className: '', name: 'Base', target: 'table', isDefault: true, structuralVariant: 'zebraEven', backgroundColor: '#f9fafb' },
    ]);
    expect(base.structuralVariant).toBeUndefined();
  });
});

describe('merging forward-shipped base defaults into a stale on-disk set', () => {
  test('appends base defaults absent from the parsed set without touching existing entries', () => {
    const onDisk: AuthorStyleDefinition[] = [
      { className: 'dc-default-body', name: 'Base paragraph', target: 'body', isDefault: true, color: '#abcdef' },
      { className: 'dc-user-preset', name: 'User preset', target: 'body', color: '#123123' },
    ];
    const merged = mergeMissingDefaultStyles(onDisk);

    // The user's own dc-default-body (customized colour) is preserved, not overwritten.
    expect(merged.find((s) => s.className === 'dc-default-body')).toEqual(onDisk[0]);
    // A forward-shipped structural base absent on disk is seeded in.
    expect(merged.some((s) => s.className === 'dc-default-table-singleCol')).toBe(true);
    // The original entries are still present and unduplicated.
    expect(merged.filter((s) => s.className === 'dc-default-body')).toHaveLength(1);
    expect(merged.some((s) => s.className === 'dc-user-preset')).toBe(true);
  });

  test('never seeds preset (non-default) styles a user may have deleted', () => {
    // A file that kept only base defaults (every preset deleted) must not have the
    // shipped presets resurrected.
    const basesOnly = DEFAULT_AUTHOR_STYLES.filter((s) => s.isDefault);
    const merged = mergeMissingDefaultStyles(basesOnly);
    expect(merged.some((s) => s.className === 'dc-heading-gold')).toBe(false);
    expect(merged.some((s) => s.className === 'dc-cell-shaded')).toBe(false);
  });
});

describe('page-scoped default style', () => {
  test('a page style is always a base style and round-trips through CSS', () => {
    const css = serializeAuthorStyles([
      { className: 'whatever', name: 'Page', target: 'page', backgroundColor: '#ffffff' },
    ]);
    const parsed = parseAuthorStyles(css);

    expect(parsed).toEqual([
      { className: 'dc-default-page', name: 'Page', target: 'page', isDefault: true, backgroundColor: '#ffffff' },
    ]);
    expect(isDefaultStyleClassName('dc-default-page')).toBe(true);
  });

  test('each page field lands on its own editor-scoped + published selector pair', () => {
    const css = serializeAuthorStyles([
      {
        className: '',
        name: 'Page',
        target: 'page',
        isDefault: true,
        backgroundColor: '#f7f0e4',
        contentWidth: '840px',
        tableShadow: 'var(--dc-shadow-md, 0 6px 24px rgb(15 23 42 / 12%))',
      },
    ]);

    expect(css).toContain('body.ditaeditor-canvas,\nbody {\n  background: #f7f0e4;\n}');
    expect(css).toContain('body.ditaeditor-canvas main,\nmain[role="main"] {\n  max-width: 840px;\n}');
    expect(css).toContain('body.ditaeditor-canvas {\n  --dc-page-content-width: 840px;\n}');
    expect(css).toContain(
      'body.ditaeditor-canvas table.table,\ntable.table.table {\n  box-shadow: var(--dc-shadow-md, 0 6px 24px rgb(15 23 42 / 12%));\n}',
    );
    // No element-kind background chrome may leak onto the page rules.
    expect(css).not.toContain('padding: 6px 10px;');
    expect(css).not.toContain('border-radius: 4px;');
  });

  test('page style emits site-chrome custom properties (title quoted)', () => {
    const css = serializeAuthorStyles([
      {
        className: '', name: 'Page', target: 'page', isDefault: true,
        mastheadTitle: 'Cabin Manual', mastheadBg: '#123456',
        sidebarWidth: '300px', linkHover: '#abcabc',
      },
    ]);
    expect(css).toContain(':root {');
    expect(css).toContain('--dc-chrome-masthead-title: "Cabin Manual";');
    expect(css).toContain('--dc-chrome-masthead-bg: #123456;');
    expect(css).toContain('--dc-chrome-sidebar-width: 300px;');
    expect(css).toContain('--dc-chrome-link-hover: #abcabc;');
    // Unset chrome slots emit nothing, so the shell fallback stands.
    expect(css).not.toContain('--dc-chrome-sidebar-caption');
  });

  test('masthead title is CSS-escaped so it cannot break out of the string', () => {
    const css = serializeAuthorStyles([
      { className: '', name: 'Page', target: 'page', isDefault: true, mastheadTitle: 'a\\b"c' },
    ]);
    // Backslash -> \5c , quote -> \22 : the value stays one well-formed CSS string.
    expect(css).toContain('--dc-chrome-masthead-title: "a\\5c b\\22 c";');
    // No raw closing quote can appear mid-value to terminate the string early.
    expect(css).not.toContain('"a\\b"c"');
  });

  test('a page style with no chrome fields emits no chrome vars', () => {
    const css = serializeAuthorStyles([
      { className: '', name: 'Page', target: 'page', isDefault: true, contentWidth: '900px' },
    ]);
    expect(css).not.toContain('--dc-chrome-');
  });

  test('unset page fields emit no rule and an empty page default drops entirely', () => {
    const widthOnly = serializeAuthorStyles([
      { className: '', name: 'Page', target: 'page', isDefault: true, contentWidth: '960px' },
    ]);
    expect(widthOnly).toContain('--dc-page-content-width: 960px;');
    expect(widthOnly).not.toContain('background:');
    expect(widthOnly).not.toContain('box-shadow:');

    const empty = serializeAuthorStyles([
      { className: '', name: 'Page', target: 'page', isDefault: true },
    ]);
    expect(empty).not.toContain('dc-default-page');
  });

  test('the all-elements fan-out does not include the page target', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-probe', name: 'Probe', target: 'all', color: '#654321' },
    ]);
    const selectors = selectorsFromCss(css, 'dc-probe');

    expect(selectors.some((s) => s === 'body' || s.startsWith('main'))).toBe(false);
    expect(css).not.toContain('--dc-page-content-width');
  });

  test('page field values on element-kind styles round-trip but emit no declarations', () => {
    const css = serializeAuthorStyles([
      { className: 'dc-probe', name: 'Probe', target: 'body', color: '#654321', tableShadow: 'none' },
    ]);

    expect(parseAuthorStyles(css)[0].tableShadow).toBe('none');
    expect(cssBlockFor(css, 'dc-probe')).not.toContain('box-shadow');
  });
});

describe('F2 shading helpers', () => {
  test('shadeClassNameForColor encodes hex + target namespace, refuses non-hex', () => {
    expect(shadeClassNameForColor('#FFE8B3', 'tableCell')).toBe('dc-shade-ffe8b3');
    expect(shadeClassNameForColor('#ffe8b3', 'tableRow')).toBe('dc-shade-row-ffe8b3');
    expect(shadeClassNameForColor('red', 'tableCell')).toBeNull();
    expect(shadeClassNameForColor('#fff', 'tableCell')).toBeNull();
    expect(shadeClassNameForColor('', 'tableCell')).toBeNull();
  });

  test('a shade definition serializes with backgroundColor and round-trips through the CSS file', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: 'dc-shade-ffe8b3', name: 'Shade #ffe8b3', target: 'tableCell', backgroundColor: '#ffe8b3' },
    ];
    const css = serializeAuthorStyles(styles);
    expect(cssBlockFor(css, 'dc-shade-ffe8b3')).toContain('background-color: #ffe8b3');
    expect(parseAuthorStyles(css).map((s) => s.className)).toContain('dc-shade-ffe8b3');
  });

  test('shadeManagedClassNames is the shading SUBSET: dc-shade-* + built-ins, nothing else', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: 'dc-shade-ffe8b3', name: 'Shade', target: 'tableCell', backgroundColor: '#ffe8b3' },
      { className: 'dc-shade-row-eff1f3', name: 'Row shade', target: 'tableRow', backgroundColor: '#eff1f3' },
      { className: 'dc-heading-gold', name: 'Accent heading', target: 'heading', color: '#2563eb' },
    ];
    const managed = shadeManagedClassNames(styles);
    expect(managed).toContain('dc-shade-ffe8b3');
    expect(managed).toContain('dc-shade-row-eff1f3');
    expect(managed).toContain('dc-cell-shaded');
    expect(managed).toContain('dc-row-highlight');
    expect(managed).not.toContain('dc-heading-gold'); // clearing a shade never strips other styles
  });

  test('replacing a shade via the subset keeps unrelated managed classes intact', () => {
    const managed = ['dc-shade-ffe8b3', 'dc-shade-aabbcc', 'dc-cell-shaded', 'dc-row-highlight'];
    expect(replaceManagedOutputClass('dc-heading-gold dc-shade-ffe8b3', 'dc-shade-aabbcc', managed)).toBe(
      'dc-heading-gold dc-shade-aabbcc',
    );
    expect(replaceManagedOutputClass('dc-heading-gold dc-shade-ffe8b3', '', managed)).toBe('dc-heading-gold');
  });
});
