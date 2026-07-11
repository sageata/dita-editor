import type * as vscode from 'vscode';
import { serializeEmbeddedJson } from '../webview/embedded-json';

export type TaxonomyInput =
  | 'text'
  | 'number'
  | 'date'
  | 'single-select'
  | 'multi-select';

export interface TaxonomyOption {
  value: string;
  label: string;
}

export interface TaxonomyField {
  attribute: string;
  label: string;
  input: TaxonomyInput;
  group?: string;
  options?: TaxonomyOption[];
}

export interface TaxonomyConfig {
  version: 1;
  fields: TaxonomyField[];
}

export const TAXONOMY_LIMITS = {
  maxBytes: 1_048_576,
  maxFields: 128,
  maxOptionsPerField: 1_000,
  maxTotalOptions: 10_000,
  maxStringCodeUnits: 512,
} as const;

const INPUTS = new Set<TaxonomyInput>([
  'text',
  'number',
  'date',
  'single-select',
  'multi-select',
]);
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isXmlCodePoint(codePoint: number): boolean {
  const allowed = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
  if (!allowed) return false;
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return false;
  return (codePoint & 0xffff) !== 0xfffe && (codePoint & 0xffff) !== 0xffff;
}

export function isXmlSafeString(value: string): boolean {
  if (value.length > TAXONOMY_LIMITS.maxStringCodeUnits) return false;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) return false;
      const codePoint = value.codePointAt(index)!;
      if (!isXmlCodePoint(codePoint)) return false;
      index += 1;
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) return false;
    if (!isXmlCodePoint(first)) return false;
  }
  return true;
}

export function isTaxonomyAttributeName(value: string): boolean {
  return ATTRIBUTE_NAME.test(value) && !/^xml/i.test(value);
}

function configuredString(value: unknown, label: string, nonEmpty = true): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (nonEmpty && value.trim().length === 0) throw new Error(`${label} must not be empty.`);
  if (!isXmlSafeString(value)) throw new Error(`${label} contains an unsupported character or is too long.`);
  return value;
}

function normalizeOption(value: unknown, fieldIndex: number, optionIndex: number): TaxonomyOption {
  const option = objectValue(value, `fields[${fieldIndex}].options[${optionIndex}]`);
  return {
    value: configuredString(option.value, `fields[${fieldIndex}].options[${optionIndex}].value`),
    label: configuredString(option.label, `fields[${fieldIndex}].options[${optionIndex}].label`),
  };
}

function normalizeField(value: unknown, index: number): TaxonomyField {
  const field = objectValue(value, `fields[${index}]`);
  const attribute = configuredString(field.attribute, `fields[${index}].attribute`);
  if (!isTaxonomyAttributeName(attribute)) {
    throw new Error(`fields[${index}].attribute must be an unprefixed, non-reserved ASCII NCName.`);
  }
  const label = configuredString(field.label, `fields[${index}].label`);
  if (typeof field.input !== 'string' || !INPUTS.has(field.input as TaxonomyInput)) {
    throw new Error(`fields[${index}].input is not supported.`);
  }
  const input = field.input as TaxonomyInput;
  const group = field.group === undefined
    ? undefined
    : configuredString(field.group, `fields[${index}].group`);
  const select = input === 'single-select' || input === 'multi-select';
  const rawOptions = field.options;
  if (!select && rawOptions !== undefined) {
    throw new Error(`fields[${index}].options is allowed only for select inputs.`);
  }
  if (select && !Array.isArray(rawOptions)) {
    throw new Error(`fields[${index}].options must be a non-empty array.`);
  }
  let options: TaxonomyOption[] | undefined;
  if (select) {
    const selectOptions = rawOptions as unknown[];
    if (selectOptions.length === 0) throw new Error(`fields[${index}].options must not be empty.`);
    if (selectOptions.length > TAXONOMY_LIMITS.maxOptionsPerField) {
      throw new Error(`fields[${index}].options exceeds the per-field limit.`);
    }
    const normalizedOptions = selectOptions.map(
      (option, optionIndex) => normalizeOption(option, index, optionIndex),
    );
    options = normalizedOptions;
    const seen = new Set<string>();
    for (const option of normalizedOptions) {
      if (seen.has(option.value)) throw new Error(`fields[${index}].options contains a duplicate value.`);
      if (input === 'multi-select' && /\s/u.test(option.value)) {
        throw new Error(`fields[${index}].options multi-select values must not contain whitespace.`);
      }
      seen.add(option.value);
    }
  }
  return {
    attribute,
    label,
    input,
    ...(group === undefined ? {} : { group }),
    ...(options === undefined ? {} : { options }),
  };
}

export function parseTaxonomyJson(source: string): TaxonomyConfig {
  if (new TextEncoder().encode(source).byteLength > TAXONOMY_LIMITS.maxBytes) {
    throw new Error('file exceeds the byte limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectValue(parsed, 'root');
  if (root.version !== 1) throw new Error('version must be 1.');
  if (!Array.isArray(root.fields)) throw new Error('fields must be an array.');
  if (root.fields.length > TAXONOMY_LIMITS.maxFields) throw new Error('fields exceeds the field limit.');
  const fields = root.fields.map(normalizeField);
  const attributes = new Set<string>();
  let totalOptions = 0;
  for (const field of fields) {
    if (attributes.has(field.attribute)) throw new Error(`duplicate field attribute ${JSON.stringify(field.attribute)}.`);
    attributes.add(field.attribute);
    totalOptions += field.options?.length ?? 0;
    if (totalOptions > TAXONOMY_LIMITS.maxTotalOptions) throw new Error('options exceeds the total option limit.');
  }
  return { version: 1, fields };
}

export async function loadTaxonomyFile(params: {
  configuredPath: string;
  uri: vscode.Uri;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  log(message: string): void;
}): Promise<TaxonomyConfig | null> {
  if (!params.configuredPath) return null;
  try {
    const bytes = await params.readFile(params.uri);
    if (bytes.byteLength > TAXONOMY_LIMITS.maxBytes) throw new Error('file exceeds the byte limit.');
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('file is not valid UTF-8.');
    }
    return parseTaxonomyJson(source);
  } catch (error) {
    params.log(`[taxonomy] ${params.configuredPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function escapeJsonForHtml(value: TaxonomyConfig | null): string {
  return serializeEmbeddedJson(value);
}
