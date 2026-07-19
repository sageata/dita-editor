export type AuthorStyleTarget =
  | 'all'
  | 'page'
  | 'title'
  | 'heading'
  | 'body'
  | 'shortdesc'
  | 'section'
  | 'list'
  | 'listItem'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'tableHeadCell'
  | 'tableBodyCell'
  | 'figure'
  | 'image'
  | 'note'
  | 'code'
  | 'lines';

/**
 * A structural refinement that pins a base style to a DOM-shape predicate
 * ([colspan], nth-child(even), [rowspan], :only-child, :empty) rather than a
 * user-applied class. Meaningful only on isDefault base styles; the predicate
 * is emitted inside :where() so it adds no specificity (a user preset on the
 * same element always wins by source order).
 */
export type AuthorStyleVariant = 'zebraEven';

/**
 * Which (target, variant) pairs are legal. Zebra striping is an opt-in table
 * preset; editor-only table geometry is maintained in content-theme.css.
 */
const STRUCTURAL_VARIANTS: Partial<Record<AuthorStyleTarget, AuthorStyleVariant[]>> = {
  table: ['zebraEven'],
};

const PRESET_VARIANTS = new Set<AuthorStyleVariant>(['zebraEven']);

const VARIANT_SET = new Set<AuthorStyleVariant>(
  Object.values(STRUCTURAL_VARIANTS).flat() as AuthorStyleVariant[],
);

function isVariantAllowed(target: AuthorStyleTarget, variant: AuthorStyleVariant): boolean {
  return (STRUCTURAL_VARIANTS[target] ?? []).includes(variant);
}

export interface AuthorStyleDefinition {
  className: string;
  name: string;
  target: AuthorStyleTarget;
  /** Kind-scoped base style: classless selectors, always on, never applied via outputclass. */
  isDefault?: boolean;
  /** Base-only: pins the rule to a DOM-shape predicate (see AuthorStyleVariant). */
  structuralVariant?: AuthorStyleVariant;
  fontSize?: string;
  /** Page-only: max-width of the document content column (e.g. '840px'). */
  contentWidth?: string;
  /** Page-only: box-shadow under document tables ('none' or a shadow value). */
  tableShadow?: string;
  fontWeight?: string;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  textTransform?: string;
  letterSpacing?: string;
  /** Line height (unitless or with unit). */
  lineHeight?: string;
  /** Corner radius (e.g. '4px'); when set on a background style it overrides the default 4px. */
  borderRadius?: string;
  /** Table-only: which edge the accent (borderColor) draws on — 'top' | 'bottom' | 'left' | 'right' | 'full'. Unset keeps the classic top 3px / bottom 1px rule pair. */
  borderEdge?: string;
  /** Table-only: accent border thickness (e.g. '4px'). */
  borderWidth?: string;
  /** Table width (e.g. '100%'). */
  width?: string;
  /** Horizontal overflow (e.g. 'auto'). */
  overflowX?: string;
  /** List item ::marker color. */
  markerColor?: string;
  /** Box padding shorthand (e.g. '12px 14px'); on cell targets it replaces the theme's cell padding. */
  padding?: string;
  /** Text alignment (e.g. 'left', 'center'). */
  textAlign?: string;
  /** Table-cell vertical alignment (e.g. 'top', 'middle'). */
  verticalAlign?: string;
  spacingBefore?: string;
  spacingAfter?: string;
}

export interface AuthorStyleState {
  styles: AuthorStyleDefinition[];
  /** Canonical generated declarations for previews and the temporary live layer. */
  cssText: string;
  status: 'missing' | 'ready' | 'migration-required' | 'refused';
  writable: boolean;
  sourceHash: string;
  targetToken: string;
  /** Workspace-relative repository path shown in the Styles view. */
  cssPath?: string;
  /** Cache-busted webview URI for the complete repository-owned stylesheet. */
  stylesheetHref?: string;
  error?: string;
}

export const AUTHOR_STYLE_CSS_FILE = 'ditaeditor-author-styles.css';

export const AUTHOR_STYLE_TARGET_LABELS: Record<AuthorStyleTarget, string> = {
  all: 'All elements',
  page: 'Page',
  title: 'Topic title',
  heading: 'Section heading',
  body: 'Paragraph',
  shortdesc: 'Short description',
  section: 'Section',
  list: 'List',
  listItem: 'List item',
  table: 'Table',
  tableRow: 'Table row',
  tableCell: 'Table cell',
  tableHeadCell: 'Header cell',
  tableBodyCell: 'Body cell',
  figure: 'Figure',
  image: 'Image',
  note: 'Note',
  code: 'Code',
  lines: 'Lines',
};

const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TARGETS = new Set<AuthorStyleTarget>(Object.keys(AUTHOR_STYLE_TARGET_LABELS) as AuthorStyleTarget[]);
const ALL_STRUCTURAL_TARGETS: Exclude<AuthorStyleTarget, 'all' | 'page'>[] = [
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
const VALUE_FIELDS = [
  'fontSize',
  'fontWeight',
  'color',
  'backgroundColor',
  'borderColor',
  'borderEdge',
  'borderWidth',
  'textTransform',
  'letterSpacing',
  'lineHeight',
  'borderRadius',
  'width',
  'overflowX',
  'markerColor',
  'padding',
  'textAlign',
  'verticalAlign',
  'spacingBefore',
  'spacingAfter',
  'contentWidth',
  'tableShadow',
] as const;

export function isAuthorStyleClassName(value: string): boolean {
  return CLASS_NAME.test(value);
}

export function defaultStyleClassName(target: AuthorStyleTarget, variant?: AuthorStyleVariant): string {
  return variant ? `dc-default-${target}-${variant}` : `dc-default-${target}`;
}

export function isDefaultStyleClassName(value: string): boolean {
  if (!value.startsWith('dc-default-')) return false;
  let rest = value.slice('dc-default-'.length);
  // Strip a trailing known-variant suffix (dc-default-<target>-<variant>) before the target check.
  for (const variant of VARIANT_SET) {
    if (rest.endsWith(`-${variant}`)) {
      rest = rest.slice(0, -(variant.length + 1));
      break;
    }
  }
  return TARGETS.has(rest as AuthorStyleTarget);
}

export function slugStyleName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dc-${slug || 'style'}`;
}

export function authorStyleValidationError(style: AuthorStyleDefinition): string | null {
  if (!style.name.trim()) return 'Style name is required.';
  if (!isAuthorStyleClassName(style.className)) {
    return 'Style class must start with a letter or underscore and use only letters, numbers, underscores, or hyphens.';
  }
  if (!TARGETS.has(style.target)) return 'Style target is not supported.';
  for (const field of VALUE_FIELDS) {
    const value = style[field];
    if (value == null || value === '') continue;
    if (/[{};<>]/.test(value) || value.includes('*/')) {
      return `Invalid CSS value in ${field}.`;
    }
  }
  return null;
}

const BORDER_EDGES = new Set(['top', 'bottom', 'left', 'right', 'full']);

export function normalizeAuthorStyle(input: unknown, fallbackIndex = 0): AuthorStyleDefinition | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<Record<keyof AuthorStyleDefinition, unknown>>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const target = typeof raw.target === 'string' && TARGETS.has(raw.target as AuthorStyleTarget)
    ? raw.target as AuthorStyleTarget
    : 'all';
  // Base styles are per structural kind only; an 'all' default would fan classless rules everywhere.
  // The page target is base-style-only: presets/outputclass application are meaningless for the page.
  const isDefault = target === 'page' || (raw.isDefault === true && target !== 'all');
  // Structural variants are opt-in predicates carried by applied presets.
  const rawVariant = typeof raw.structuralVariant === 'string'
    ? raw.structuralVariant as AuthorStyleVariant
    : undefined;
  let variant: AuthorStyleVariant | undefined;
  if (rawVariant && VARIANT_SET.has(rawVariant) && isVariantAllowed(target, rawVariant)) {
    const presetVariant = PRESET_VARIANTS.has(rawVariant);
    if (presetVariant ? !isDefault : isDefault) variant = rawVariant;
  }
  const classNameRaw = typeof raw.className === 'string' ? raw.className.trim() : slugStyleName(name || `style-${fallbackIndex + 1}`);
  let className = isAuthorStyleClassName(classNameRaw) ? classNameRaw : slugStyleName(name || `style-${fallbackIndex + 1}`);
  if (isDefault) {
    className = defaultStyleClassName(target, variant);
  } else if (isDefaultStyleClassName(className)) {
    // Reserved namespace: a non-default style may not squat a base-style class name.
    className = slugStyleName(name || `style-${fallbackIndex + 1}`);
  }
  const style: AuthorStyleDefinition = {
    className,
    name: name || (isDefault ? 'Default' : `Style ${fallbackIndex + 1}`),
    target,
  };
  if (isDefault) style.isDefault = true;
  if (variant) style.structuralVariant = variant;
  for (const field of VALUE_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) style[field] = trimmed;
  }
  // borderEdge names a CSS property suffix and borderWidth a length; both are
  // table-only knobs — anything else is dropped rather than emitted.
  if (style.borderEdge && !(style.target === 'table' && BORDER_EDGES.has(style.borderEdge))) {
    delete style.borderEdge;
  }
  if (style.borderWidth && !(style.target === 'table' && /^\d{1,2}px$/.test(style.borderWidth))) {
    delete style.borderWidth;
  }
  return authorStyleValidationError(style) ? null : style;
}

export function normalizeAuthorStyles(input: unknown): AuthorStyleDefinition[] {
  const source = Array.isArray(input) ? input : [];
  const out: AuthorStyleDefinition[] = [];
  const seen = new Set<string>();
  source.forEach((item, index) => {
    const style = normalizeAuthorStyle(item, index);
    if (!style || seen.has(style.className)) return;
    seen.add(style.className);
    out.push(style);
  });
  return out;
}

export function parseAuthorStyles(cssText: string): AuthorStyleDefinition[] {
  const out: AuthorStyleDefinition[] = [];
  const seen = new Set<string>();
  const re = /\/\*\s*DITAEDITOR_AUTHOR_STYLE\s+({[\s\S]*?})\s*\*\//g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssText)) != null) {
    try {
      const style = normalizeAuthorStyle(JSON.parse(match[1]), out.length);
      if (!style || seen.has(style.className)) continue;
      seen.add(style.className);
      out.push(style);
    } catch {
      // Invalid user-edited metadata comments are ignored; the host logs read/write errors.
    }
  }
  return out;
}

export function hasStyleValues(style: AuthorStyleDefinition): boolean {
  return VALUE_FIELDS.some((field) => {
    const value = style[field];
    return value != null && value !== '';
  });
}

export function serializeAuthorStyles(styles: AuthorStyleDefinition[]): string {
  // Defaults serialize first (and drop when empty) so equal-specificity preset
  // rules later in the file win the cascade by source order.
  const kept = normalizeAuthorStyles(styles)
    .filter((style) => !style.isDefault || hasStyleValues(style));
  const normalized = [
    ...kept.filter((style) => style.isDefault),
    ...kept.filter((style) => !style.isDefault),
  ];
  return [
    '/* DITA Editor author styles.',
    ' * This file is the CSS source used by the visual editor Styles panel and generated output.',
    ' * Edit through the panel where possible; each block is keyed by DITAEDITOR_AUTHOR_STYLE metadata.',
    ' */',
    '',
    ...normalized.flatMap((style) => serializeStyleBlock(style)),
  ].join('\n').trimEnd() + '\n';
}

export function managedAuthorClassNames(styles: AuthorStyleDefinition[]): string[] {
  return normalizeAuthorStyles(styles).map((style) => style.className);
}

// F2 cell/row shading: dynamic managed classes keyed by color. Cells and rows get
// distinct namespaces so each definition's target-scoped selectors stay honest.
const SHADE_CLASS = /^dc-shade(?:-row)?-[0-9a-f]{6}$/;

export function shadeClassNameForColor(
  color: string,
  target: 'tableCell' | 'tableRow',
): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return target === 'tableRow' ? `dc-shade-row-${hex}` : `dc-shade-${hex}`;
}

/** The shading-managed subset (dynamic dc-shade-* plus the shading built-ins):
 *  replacing or clearing a shade must never strip unrelated managed classes. */
export function shadeManagedClassNames(styles: AuthorStyleDefinition[]): string[] {
  const dynamic = styles.map((s) => s.className).filter((c) => SHADE_CLASS.test(c));
  return [...new Set([...dynamic, 'dc-cell-shaded', 'dc-row-highlight'])];
}

export function replaceManagedOutputClass(
  currentValue: string,
  nextClassName: string,
  managedClassNames: string[],
): string {
  const managed = new Set(managedClassNames.filter(isAuthorStyleClassName));
  const existing = currentValue.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const kept = existing.filter((token) => !managed.has(token));
  const next = nextClassName.trim();
  if (next) kept.push(next);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of kept) {
    if (seen.has(token)) continue;
    seen.add(token);
    deduped.push(token);
  }
  return deduped.join(' ');
}

function metadataJson(style: AuthorStyleDefinition): string {
  return JSON.stringify(style).replace(/\//g, '\\/');
}

function serializeStyleBlock(style: AuthorStyleDefinition): string[] {
  if (style.target === 'page') return serializePageStyleBlock(style);
  const declarations = styleDeclarations(style);
  const selector = selectorForStyle(style);
  const lines = [
    `/* DITAEDITOR_AUTHOR_STYLE ${metadataJson(style)} */`,
    `${selector} {`,
    ...declarations.map((line) => `  ${line}`),
    '}',
    '',
  ];
  // ::marker is a pseudo-element and cannot share the main rule's declaration
  // block, so its color rides a second block on the same selector list.
  if (style.markerColor) {
    const markerSelector = selector
      .split(',\n')
      .map((sel) => `${sel.trim()}::marker`)
      .join(',\n');
    lines.push(
      `${markerSelector} {`,
      `  color: ${style.markerColor};`,
      '}',
      '',
    );
  }
  return lines;
}

/**
 * The page style is not an element kind: each field lands on its own selector
 * (body / main / table), so one metadata comment heads several rules — the
 * comment-driven parser round-trips that fine. Every rule pairs an
 * editor-scoped selector with a published-output twin. The tableShadow rule
 * deliberately ties editor.css's flattening override at (0,2,2): the live
 * author-styles <style> is last in <head>, so a user-chosen shadow wins in the
 * editor, and the doubled-class variant out-specifies the theme when published.
 */
function serializePageStyleBlock(style: AuthorStyleDefinition): string[] {
  const out: string[] = [`/* DITAEDITOR_AUTHOR_STYLE ${metadataJson(style)} */`];
  if (style.backgroundColor) {
    out.push(
      'body.ditaeditor-canvas,',
      'body {',
      `  background: ${style.backgroundColor};`,
      '}',
    );
  }
  if (style.contentWidth) {
    out.push(
      'body.ditaeditor-canvas main,',
      'main[role="main"] {',
      `  max-width: ${style.contentWidth};`,
      '}',
      // Read by the side panels' inline width math (baseEditorWidth()).
      'body.ditaeditor-canvas {',
      `  --dc-page-content-width: ${style.contentWidth};`,
      '}',
    );
  }
  if (style.tableShadow) {
    out.push(
      'body.ditaeditor-canvas table.table,',
      'table.table.table {',
      `  box-shadow: ${style.tableShadow};`,
      '}',
    );
  }
  out.push('');
  return out;
}

function selectorForStyle(style: AuthorStyleDefinition): string {
  const cls = style.className;
  let selectors: string[];
  if (!style.isDefault && style.structuralVariant === 'zebraEven' && style.target === 'table') {
    // Opt-in stripe: applied to a <table>, shade its even body rows' cells.
    selectors = [
      `.body table.table.${cls} tbody.tbody tr.row:nth-child(even) td.entry`,
      `table.table.${cls} tbody.tbody tr.row:nth-child(even) td.entry`,
    ];
  } else if (style.isDefault && style.target !== 'all' && style.target !== 'page') {
    selectors = defaultSelectorsForTarget(style.target);
  } else {
    selectors = [...selectorsForTarget(style.target, cls), `.${cls}`];
  }
  const seen = new Set<string>();
  return selectors
    .filter((selector) => {
      if (seen.has(selector)) return false;
      seen.add(selector);
      return true;
    })
    .join(',\n');
}

const DEFAULT_CLASS_MARKER = 'dc__default__marker';

/**
 * Classless selectors for a kind-scoped base style, derived from the preset
 * selector list by swapping the preset class for a repeat of the structural
 * class. This keeps every default selector at exactly the specificity of its
 * preset twin (so presets, serialized later, win ties by source order) while
 * out-specifying editor.css's body.ditaeditor-canvas content rules.
 */
export function defaultSelectorsForTarget(
  target: Exclude<AuthorStyleTarget, 'all' | 'page'>,
): string[] {
  const plain: string[] = [];
  for (const selector of selectorsForTarget(target, DEFAULT_CLASS_MARKER)) {
    if (!selector.endsWith(`.${DEFAULT_CLASS_MARKER}`)) continue;
    const base = selector.slice(0, -(DEFAULT_CLASS_MARKER.length + 1));
    // Nested-topic titles keep editor.css's de-emphasis under a base style.
    if (base.includes('article article')) continue;
    // A heading base style must not leak onto topic titles.
    if (target === 'heading' && base.includes('topictitle1')) continue;
    const lastCompound = base.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
    const classes = lastCompound.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
    // Bare-element catch-alls have no structural class to double.
    if (!classes.length) continue;
    const doubled = `${base}${classes[classes.length - 1]}`;
    // `.title.title` alone is ambiguous between topic titles and section headings.
    if (doubled === '.title.title') continue;
    plain.push(doubled);
  }
  return plain;
}

function selectorsForTarget(target: AuthorStyleTarget, cls: string): string[] {
  if (target === 'all') {
    return ALL_STRUCTURAL_TARGETS.flatMap((structuralTarget) => selectorsForTarget(structuralTarget, cls));
  }
  if (target === 'body') {
    return [
      `body.ditaeditor-canvas p.p.${cls}`,
      `.body p.p.${cls}`,
      `p.p.${cls}`,
      `.p.${cls}`,
      `p.${cls}`,
    ];
  }
  if (target === 'shortdesc') {
    return [
      `.body p.shortdesc.${cls}`,
      `p.shortdesc.${cls}`,
      `.shortdesc.${cls}`,
    ];
  }
  if (target === 'section') {
    return [
      `.body section.section.${cls}`,
      `section.section.${cls}`,
      `.section.${cls}`,
      `section.${cls}`,
    ];
  }
  if (target === 'list') {
    return [
      `.body ul.ul.${cls}`,
      `.body ol.ol.${cls}`,
      `.body ol.steps.${cls}`,
      `ul.ul.${cls}`,
      `ol.ol.${cls}`,
      `ol.steps.${cls}`,
      `.ul.${cls}`,
      `.ol.${cls}`,
      `.steps.${cls}`,
      `ul.${cls}`,
      `ol.${cls}`,
    ];
  }
  if (target === 'listItem') {
    return [
      `.body ul.ul > li.li.${cls}`,
      `.body ol.ol > li.li.${cls}`,
      `.body ol.steps > li.step.${cls}`,
      `ul.ul > li.li.${cls}`,
      `ol.ol > li.li.${cls}`,
      `ol.steps > li.step.${cls}`,
      `.li.${cls}`,
      `.step.${cls}`,
      `li.${cls}`,
    ];
  }
  if (target === 'table') {
    return [
      `.body table.table.${cls}`,
      `table.table.${cls}`,
      `.table.${cls}`,
      `table.${cls}`,
    ];
  }
  if (target === 'tableRow') {
    return [
      `.body table.table tr.row.${cls}`,
      `table.table tr.row.${cls}`,
      `tr.row.${cls}`,
      `.row.${cls}`,
      `tr.${cls}`,
    ];
  }
  if (target === 'tableCell') {
    return [
      `.body table.table td.entry.${cls}`,
      `.body table.table th.entry.${cls}`,
      `table.table td.entry.${cls}`,
      `table.table th.entry.${cls}`,
      `td.entry.${cls}`,
      `th.entry.${cls}`,
      `.entry.${cls}`,
      `td.${cls}`,
      `th.${cls}`,
    ];
  }
  if (target === 'tableHeadCell') {
    return [
      `.body table.table thead.thead th.entry.${cls}`,
      `table.table thead.thead th.entry.${cls}`,
      `thead.thead th.entry.${cls}`,
      `.thead th.entry.${cls}`,
      `th.entry.${cls}`,
    ];
  }
  if (target === 'tableBodyCell') {
    return [
      `.body table.table tbody.tbody td.entry.${cls}`,
      `table.table tbody.tbody td.entry.${cls}`,
      `tbody.tbody td.entry.${cls}`,
      `.tbody td.entry.${cls}`,
      `td.entry.${cls}`,
    ];
  }
  if (target === 'figure') {
    return [
      `.body figure.fig.${cls}`,
      `figure.fig.${cls}`,
      `.fig.${cls}`,
      `.fignone.${cls}`,
      `figure.${cls}`,
    ];
  }
  if (target === 'image') {
    return [
      `.body figure.fig img.image.${cls}`,
      `figure.fig img.image.${cls}`,
      `img.image.${cls}`,
      `.image.${cls}`,
      `img.${cls}`,
    ];
  }
  if (target === 'note') {
    return [
      `.body div.note.${cls}`,
      `div.note.${cls}`,
      `.note.${cls}`,
      `.note_note.${cls}`,
    ];
  }
  if (target === 'code') {
    return [
      `body.ditaeditor-canvas code.ph.codeph.${cls}`,
      `code.ph.codeph.${cls}`,
      `.ph.codeph.${cls}`,
      `pre.pre.${cls}`,
      `.pre.${cls}`,
      `.codeblock.${cls}`,
      `.codeph.${cls}`,
      `pre.${cls}`,
      `code.${cls}`,
    ];
  }
  if (target === 'lines') {
    return [
      `.body pre.lines.${cls}`,
      `pre.lines.${cls}`,
      `.lines.${cls}`,
    ];
  }
  if (target === 'title') {
    return [
      `body.ditaeditor-canvas article article h1.title.topictitle1.${cls}`,
      `h1.title.topictitle1.${cls}`,
      `.title.topictitle1.${cls}`,
      `.title.${cls}`,
      `.topictitle1.${cls}`,
      `h1.${cls}`,
    ];
  }
  return [
    `body.ditaeditor-canvas h1.title.topictitle1.${cls}`,
    `h1.title.topictitle1.${cls}`,
    `.title.topictitle1.${cls}`,
    `.body section.section > .title.${cls}`,
    `section.section > .title.${cls}`,
    `.section .title.${cls}`,
    `h2.title.${cls}`,
    `h3.title.${cls}`,
    `.title.${cls}`,
    `h2.${cls}`,
    `h3.${cls}`,
  ];
}

function styleDeclarations(style: AuthorStyleDefinition): string[] {
  if (style.structuralVariant === 'zebraEven') {
    return [`background-color: ${style.backgroundColor || 'var(--dc-color-surface-muted, #f3f4f6)'};`];
  }
  const out: string[] = [];
  add(out, 'font-size', style.fontSize);
  add(out, 'font-weight', style.fontWeight);
  add(out, 'color', style.color);
  add(out, 'background-color', style.backgroundColor);
  add(out, 'text-transform', style.textTransform);
  add(out, 'letter-spacing', style.letterSpacing);
  add(out, 'line-height', style.lineHeight);
  add(out, 'padding', style.padding);
  add(out, 'text-align', style.textAlign);
  add(out, 'vertical-align', style.verticalAlign);
  if (style.target === 'table') {
    add(out, 'width', style.width);
    add(out, 'overflow-x', style.overflowX);
    // Every authored table style opts the table out of border-collapse:
    // Chrome paints a COLLAPSED table's own borders in the cell-grid layer,
    // which the theme's rounded overflow:hidden card clips — accent borders
    // compute but never render (proven in a live repro). The separate model
    // paints borders normally, follows the card radius, and makes table
    // padding meaningful.
    out.push('border-collapse: separate;');
    out.push('border-spacing: 0;');
  }
  add(out, 'margin-top', style.spacingBefore);
  add(out, 'margin-bottom', style.spacingAfter);
  addStructuralChromeReset(out, style.target);
  // New table cell targets never get the inline "chip" padding/radius below. Cell
  // padding is now expressible directly via the `padding` value field (emitted above),
  // so a base cell style carries its own padding instead of borrowing the theme's.
  const isNewCellTarget = style.target === 'tableHeadCell' || style.target === 'tableBodyCell';
  if (style.borderColor) {
    const headingChrome = style.target === 'title' || style.target === 'heading';
    const important = headingChrome ? ' !important' : '';
    if (style.target === 'table') {
      // A base table draws the theme's full card border (all four sides); a preset
      // keeps the lighter top/bottom rule accent so existing table presets are
      // unchanged. borderEdge/borderWidth (normalized table-only knobs) redirect
      // the accent to one edge or all sides at a chosen thickness.
      const accentWidth = style.borderWidth || '';
      if (style.isDefault || style.borderEdge === 'full') {
        out.push(`border: ${accentWidth || '1px'} solid ${style.borderColor};`);
      } else if (style.borderEdge && BORDER_EDGES.has(style.borderEdge)) {
        out.push(`border-${style.borderEdge}: ${accentWidth || '3px'} solid ${style.borderColor};`);
      } else {
        out.push(`border-top: ${accentWidth || '3px'} solid ${style.borderColor};`);
        out.push(`border-bottom: 1px solid ${style.borderColor};`);
      }
    } else if (style.target === 'tableHeadCell') {
      out.push(`border: 1px solid ${style.borderColor};`);
    } else if (style.target === 'tableBodyCell') {
      // The always-on body-cell base draws a full border; an applied preset (e.g.
      // Row-group cell) contributes a left accent over it.
      out.push(style.isDefault
        ? `border: 1px solid ${style.borderColor};`
        : `border-left: 3px solid ${style.borderColor};`);
    } else if (style.target === 'tableRow') {
      out.push(`border-left: 3px solid ${style.borderColor};`);
    } else if (style.target === 'tableCell') {
      out.push(`border-left: 3px solid ${style.borderColor};`);
    } else if (style.target === 'image') {
      out.push(`border: 2px solid ${style.borderColor};`);
    } else {
      out.push(`border-left: 4px solid ${style.borderColor}${important};`);
      out.push(`padding-left: 12px${important};`);
    }
  }
  if (style.borderRadius && style.target === 'table') {
    out.push(`border-radius: ${style.borderRadius};`);
    // A rounded base table clips its corners so cell fills don't bleed past the radius.
    if (style.isDefault) out.push('overflow: hidden;');
  }
  // A table container never takes the inline "chip" padding/radius — its fill is a
  // full-bleed card background, not a padded pill.
  if (style.backgroundColor && !isNewCellTarget && style.target !== 'table' && !style.padding) {
    out.push('padding: 6px 10px;');
    out.push(`border-radius: ${style.borderRadius || '4px'};`);
  }
  if (!out.length) out.push('font-weight: inherit;');
  return out;
}

function addStructuralChromeReset(out: string[], target: AuthorStyleTarget): void {
  if (target !== 'title' && target !== 'heading') return;
  out.push('border-left: 0 !important;');
  out.push('padding-left: 0 !important;');
  if (target === 'title') {
    out.push('border-bottom: 0 !important;');
    out.push('padding-bottom: 0 !important;');
  }
}

function add(out: string[], prop: string, value: string | undefined): void {
  if (!value) return;
  out.push(`${prop}: ${value};`);
}
