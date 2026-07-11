import { createHash } from 'node:crypto';
import {
  DEFAULT_AUTHOR_STYLES,
  mergeMissingDefaultStyles,
  normalizeAuthorStyle,
  parseAuthorStyles,
  serializeAuthorStyles,
  type AuthorStyleDefinition,
} from '../styles/author-styles';

export const MANAGED_STYLES_START = '/* DITAEDITOR_MANAGED_STYLES_START */';
export const MANAGED_STYLES_END = '/* DITAEDITOR_MANAGED_STYLES_END */';

export type ManagedStylesInspection = {
  kind: 'missing' | 'marked' | 'legacy-canonical' | 'refused';
  styles: AuthorStyleDefinition[];
  sourceText: string;
  sourceHash: string;
  renderCssText: string;
  writable: boolean;
  error?: string;
};

export type ManagedStylesWritePlan =
  | {
      ok: true;
      expectedSourceHash: string | null;
      startOffset: number;
      endOffset: number;
      replacement: string;
      resultingText: string;
      migrated: boolean;
      create: boolean;
    }
  | { ok: false; reason: string };

function hashSource(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
}

function literalOffsets(source: string, marker: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= source.length - marker.length) {
    const offset = source.indexOf(marker, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + marker.length;
  }
  return offsets;
}

function refusedInspection(source: string, error: string): ManagedStylesInspection {
  return {
    kind: 'refused',
    styles: mergeMissingDefaultStyles(parseAuthorStyles(source)),
    sourceText: source,
    sourceHash: hashSource(source),
    renderCssText: source,
    writable: false,
    error,
  };
}

function legacySerialization(styles: AuthorStyleDefinition[]): string {
  return serializeAuthorStyles(styles)
    .split('\n')
    .map((line) => line.startsWith('/* DITAEDITOR_AUTHOR_STYLE ')
      ? line.replace(/\\\//g, '/')
      : line)
    .join('\n');
}

const REQUIRED_STYLE_FIELDS = new Set(['className', 'name', 'target']);
const OPTIONAL_BOOLEAN_STYLE_FIELDS = new Set(['isDefault']);
const OPTIONAL_STRING_STYLE_FIELDS = new Set([
  'structuralVariant',
  'fontSize',
  'contentWidth',
  'tableShadow',
  'mastheadTitle',
  'mastheadBg',
  'mastheadText',
  'mastheadAccent',
  'sidebarWidth',
  'sidebarBg',
  'sidebarLink',
  'sidebarHover',
  'sidebarActive',
  'sidebarAccent',
  'sidebarCaption',
  'linkColor',
  'linkHover',
  'fontWeight',
  'color',
  'backgroundColor',
  'borderColor',
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
]);

type StrictStylesResult =
  | { ok: true; styles: AuthorStyleDefinition[] }
  | { ok: false; reason: string };

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function strictAuthorStyles(input: unknown): StrictStylesResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'Style changes must be a complete array.' };
  }
  const styles: AuthorStyleDefinition[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === null || typeof value !== 'object') {
      return { ok: false, reason: `Style ${index + 1} must be a plain object.` };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: `Style ${index + 1} must be a plain object.` };
    }
    const raw = value as Record<string, unknown>;
    for (const field of REQUIRED_STYLE_FIELDS) {
      if (!Object.hasOwn(raw, field) || typeof raw[field] !== 'string') {
        return { ok: false, reason: `Style ${index + 1} has an invalid ${field} field.` };
      }
    }
    for (const [field, fieldValue] of Object.entries(raw)) {
      const known = REQUIRED_STYLE_FIELDS.has(field) ||
        OPTIONAL_BOOLEAN_STYLE_FIELDS.has(field) || OPTIONAL_STRING_STYLE_FIELDS.has(field);
      if (!known) {
        return { ok: false, reason: `Style ${index + 1} contains unsupported field ${JSON.stringify(field)}.` };
      }
      if (OPTIONAL_BOOLEAN_STYLE_FIELDS.has(field) && typeof fieldValue !== 'boolean') {
        return { ok: false, reason: `Style ${index + 1} has an invalid ${field} field.` };
      }
      if (OPTIONAL_STRING_STYLE_FIELDS.has(field) && typeof fieldValue !== 'string') {
        return { ok: false, reason: `Style ${index + 1} has an invalid ${field} field.` };
      }
      if (typeof fieldValue === 'string' && hasUnpairedUtf16Surrogate(fieldValue)) {
        return {
          ok: false,
          reason: `Style ${index + 1} field ${JSON.stringify(field)} contains an unpaired UTF-16 surrogate and cannot be encoded losslessly.`,
        };
      }
    }
    const normalized = normalizeAuthorStyle(raw, index);
    if (normalized === null) {
      return { ok: false, reason: `Style ${index + 1} is invalid.` };
    }
    const rawKeys = Object.keys(raw).sort();
    const normalizedKeys = Object.keys(normalized).sort();
    if (rawKeys.length !== normalizedKeys.length ||
      rawKeys.some((field, fieldIndex) =>
        field !== normalizedKeys[fieldIndex] || raw[field] !== (normalized as unknown as Record<string, unknown>)[field])) {
      return {
        ok: false,
        reason: `Style ${index + 1} would be silently changed by normalization. Correct the payload before saving.`,
      };
    }
    if (seen.has(normalized.className)) {
      return { ok: false, reason: `Style class ${JSON.stringify(normalized.className)} is duplicated.` };
    }
    seen.add(normalized.className);
    styles.push(normalized);
  }
  const emitted = parseAuthorStyles(serializeAuthorStyles(styles));
  if (emitted.length !== styles.length) {
    return {
      ok: false,
      reason: 'One or more style entries would be dropped by serialization. Add a valid declaration or remove the empty entry before saving.',
    };
  }
  for (let index = 0; index < styles.length; index += 1) {
    const style = styles[index];
    const roundTripped = emitted.find((candidate) => candidate.className === style.className);
    const styleRecord = style as unknown as Record<string, unknown>;
    const roundTripRecord = roundTripped as unknown as Record<string, unknown> | undefined;
    const styleKeys = Object.keys(styleRecord).sort();
    const roundTripKeys = roundTripRecord ? Object.keys(roundTripRecord).sort() : [];
    if (!roundTripRecord || styleKeys.length !== roundTripKeys.length ||
      styleKeys.some((field, fieldIndex) =>
        field !== roundTripKeys[fieldIndex] || styleRecord[field] !== roundTripRecord[field])) {
      return {
        ok: false,
        reason: `Style ${index + 1} would be silently changed by serialization. Correct the payload before saving.`,
      };
    }
  }
  return { ok: true, styles };
}

export function inspectManagedAuthorStylesheet(
  source: string | null,
): ManagedStylesInspection {
  if (source === null) {
    const renderCssText = serializeAuthorStyles(DEFAULT_AUTHOR_STYLES);
    return {
      kind: 'missing',
      styles: DEFAULT_AUTHOR_STYLES,
      sourceText: '',
      sourceHash: hashSource(''),
      renderCssText,
      writable: true,
    };
  }
  const starts = literalOffsets(source, MANAGED_STYLES_START);
  const ends = literalOffsets(source, MANAGED_STYLES_END);
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) {
    const delimiterOffset = starts[0] + MANAGED_STYLES_START.length;
    const delimiter = source.startsWith('\r\n', delimiterOffset)
      ? '\r\n'
      : source.startsWith('\n', delimiterOffset)
        ? '\n'
        : null;
    if (delimiter === null) {
      return refusedInspection(
        source,
        'The managed start marker must be followed by LF or CRLF before styles can be saved.',
      );
    }
    const body = source.slice(delimiterOffset + delimiter.length, ends[0]);
    const parsed = parseAuthorStyles(body);
    if (serializeAuthorStyles(parsed) !== body) {
      return refusedInspection(
        source,
        'The managed style region contains malformed or noncanonical CSS. Restore canonical DITA Editor style blocks before saving.',
      );
    }
    return {
      kind: 'marked',
      styles: mergeMissingDefaultStyles(parsed),
      sourceText: source,
      sourceHash: hashSource(source),
      renderCssText: source,
      writable: true,
    };
  }
  if (starts.length === 0 && ends.length === 0) {
    const parsed = parseAuthorStyles(source);
    if (serializeAuthorStyles(parsed) === source || legacySerialization(parsed) === source) {
      return {
        kind: 'legacy-canonical',
        styles: mergeMissingDefaultStyles(parsed),
        sourceText: source,
        sourceHash: hashSource(source),
        renderCssText: source,
        writable: true,
      };
    }
    return refusedInspection(
      source,
      'The unmarked author stylesheet is not canonical DITA Editor CSS. Restore it before saving or migrate it manually.',
    );
  }
  return refusedInspection(
    source,
    'The managed stylesheet must contain exactly one start marker followed by exactly one end marker before styles can be saved.',
  );
}

export function planManagedAuthorStylesheetWrite(
  source: string | null,
  styles: unknown,
): ManagedStylesWritePlan {
  const validated = strictAuthorStyles(styles);
  if (!validated.ok) return validated;
  if (source === null) {
    const replacement = serializeAuthorStyles(validated.styles);
    const startOffset = MANAGED_STYLES_START.length + 1;
    return {
      ok: true,
      expectedSourceHash: null,
      startOffset,
      endOffset: startOffset + replacement.length,
      replacement,
      resultingText: `${MANAGED_STYLES_START}\n${replacement}${MANAGED_STYLES_END}`,
      migrated: false,
      create: true,
    };
  }
  const inspection = inspectManagedAuthorStylesheet(source);
  if (!inspection.writable) {
    return {
      ok: false,
      reason: inspection.error ?? 'The managed author stylesheet cannot be changed safely.',
    };
  }
  const replacement = serializeAuthorStyles(validated.styles);
  if (inspection.kind === 'marked') {
    const markerOffset = source.indexOf(MANAGED_STYLES_START);
    const delimiterOffset = markerOffset + MANAGED_STYLES_START.length;
    const delimiterLength = source.startsWith('\r\n', delimiterOffset) ? 2 : 1;
    const startOffset = delimiterOffset + delimiterLength;
    const endOffset = source.indexOf(MANAGED_STYLES_END, startOffset);
    return {
      ok: true,
      expectedSourceHash: inspection.sourceHash,
      startOffset,
      endOffset,
      replacement,
      resultingText: source.slice(0, startOffset) + replacement + source.slice(endOffset),
      migrated: false,
      create: false,
    };
  }
  const resultingText = `${MANAGED_STYLES_START}\n${replacement}${MANAGED_STYLES_END}`;
  return {
    ok: true,
    expectedSourceHash: inspection.sourceHash,
    startOffset: 0,
    endOffset: source.length,
    replacement: resultingText,
    resultingText,
    migrated: true,
    create: false,
  };
}
