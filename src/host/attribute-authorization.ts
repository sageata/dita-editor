import { attrValueError } from '../commands/attr-validity';
import { findElementById } from '../cst/element-ids';
import { parse } from '../cst/parse';
import { childrenNamed } from '../cst/query';
import { isElement, type Document, type ElementNode } from '../cst/types';
import {
  isHorizontalAlignment,
  isHorizontalAlignmentElement,
  type HorizontalAlignment,
  wholeEditableElementSet,
} from './horizontal-alignment-actions';
import {
  isTaxonomyAttributeName,
  isXmlSafeString,
  type TaxonomyConfig,
  type TaxonomyField,
} from '../config/taxonomy';
import {
  AUTHOR_STYLE_TARGET_LABELS,
  shadeManagedClassNames,
  type AuthorStyleDefinition,
  type AuthorStyleTarget,
} from '../styles/author-styles';

export type AuthorizedAttributeAction =
  | {
      kind: 'element';
      ids: string[];
      attrName: string;
      attrValue: string;
    }
  | {
      kind: 'tgroup';
      tableId: string;
      attrs: Array<{ name: 'colsep' | 'rowsep'; value: '' | '0' | '1' }>;
    }
  | {
      kind: 'style';
      ids: string[];
      className: string;
      styleTarget: AuthorStyleTarget;
      managedClassNames: string[];
    }
  | {
      kind: 'shade';
      ids: string[];
      color: '' | 'custom' | `#${string}`;
      styleTarget: 'tableCell' | 'tableRow';
      label: string;
      managedClassNames: string[];
    }
  | {
      kind: 'horizontalAlign';
      ids: string[];
      align: HorizontalAlignment;
    };

export type AttributeAuthorizationResult =
  | { ok: true; action: AuthorizedAttributeAction }
  | { ok: false; reason: string };

const CALS_MATRIX: Record<string, ReadonlySet<string>> = {
  table: new Set(['frame']),
  row: new Set(['rowsep', 'valign']),
  entry: new Set(['colsep', 'rowsep', 'align', 'valign']),
};

const SHADE_LABELS = new Map<string, string>([
  ['#eff1f3', 'Neutral'],
  ['#f7f0e4', 'Gold tint'],
  ['#e3edf7', 'Blue tint'],
  ['#ffffff', 'White'],
]);

const MESSAGE_KEYS: Record<string, ReadonlySet<string>> = {
  setTaxonomyAttr: new Set(['type', 'id', 'attrName', 'attrValue', 'baseStructVersion']),
  setExistingPropertyAttr: new Set(['type', 'id', 'attrName', 'attrValue', 'baseStructVersion']),
  setCalsAttr: new Set(['type', 'id', 'attrName', 'attrValue', 'baseStructVersion']),
  setCalsAttrMulti: new Set(['type', 'ids', 'attrName', 'attrValue', 'baseStructVersion']),
  setTgroupAttr: new Set(['type', 'id', 'attrs', 'baseStructVersion']),
  setHorizontalAlign: new Set(['type', 'ids', 'align', 'baseStructVersion']),
  applyStyle: new Set(['type', 'ids', 'className', 'baseStructVersion']),
  clearStyle: new Set(['type', 'ids', 'styleTarget', 'baseStructVersion']),
  applyShade: new Set(['type', 'ids', 'color', 'sourceHash', 'targetToken', 'baseStructVersion']),
  clearShade: new Set(['type', 'ids', 'sourceHash', 'targetToken', 'baseStructVersion']),
};

function reject(reason: string): AttributeAuthorizationResult {
  return { ok: false, reason };
}

function allStringsXmlSafe(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return isXmlSafeString(value);
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => allStringsXmlSafe(item, seen));
  return Object.values(value as Record<string, unknown>).every((item) => allStringsXmlSafe(item, seen));
}

function parseCurrent(source: string): Document | null {
  try {
    return parse(source);
  } catch {
    return null;
  }
}

function rootElement(doc: Document): ElementNode | null {
  return doc.children.find(isElement) ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function idsValue(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((id) => typeof id === 'string' && id !== '')) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? ids : null;
}

function elementIds(doc: Document, ids: string[]): ElementNode[] | null {
  const elements = ids.map((id) => findElementById(doc, id));
  return elements.every((element): element is ElementNode => element !== undefined)
    ? elements
    : null;
}

function currentAttr(element: ElementNode, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name === name)?.value ?? null;
}

function taxonomyValueAllowed(field: TaxonomyField, value: string, current: string | null): boolean {
  if (value === '') return true;
  if (field.input === 'text') return true;
  if (field.input === 'number') {
    if (value !== value.trim() || !/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return false;
    return Number.isFinite(Number(value));
  }
  if (field.input === 'date') {
    const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  const configured = new Set((field.options ?? []).map((option) => option.value));
  if (field.input === 'single-select') return configured.has(value);
  if (value !== value.trim()) return false;
  const tokens = value.split(/\s+/u);
  if (new Set(tokens).size !== tokens.length) return false;
  const existing = new Set(String(current ?? '').split(/\s+/u).filter(Boolean));
  return tokens.every((token) => configured.has(token) || existing.has(token));
}

function authorizeRootAttribute(
  doc: Document,
  message: Record<string, unknown>,
  taxonomy: TaxonomyConfig | null,
  family: 'taxonomy' | 'existing',
): AttributeAuthorizationResult {
  const id = stringValue(message.id);
  const attrName = stringValue(message.attrName);
  const attrValue = stringValue(message.attrValue);
  if (id === null || attrName === null || attrValue === null) return reject('The attribute request is incomplete.');
  const root = rootElement(doc);
  if (!root || findElementById(doc, id) !== root) return reject('The attribute target is not the current document root.');
  const fields = taxonomy?.fields ?? [];
  const field = fields.find((candidate) => candidate.attribute === attrName);
  if (family === 'taxonomy') {
    if (!field) return reject('The requested attribute is not in the active taxonomy.');
    if (!taxonomyValueAllowed(field, attrValue, currentAttr(root, attrName))) {
      return reject(`The value is not allowed for taxonomy field ${attrName}.`);
    }
  } else {
    if (!isTaxonomyAttributeName(attrName)) return reject('The existing property name is not safe.');
    if (field) return reject('Taxonomy attributes must use the taxonomy action.');
    if (currentAttr(root, attrName) === null) return reject('The existing property action cannot create an absent attribute.');
    const valueError = attrValueError(attrName, attrValue);
    if (valueError) return reject(valueError);
  }
  return { ok: true, action: { kind: 'element', ids: [id], attrName, attrValue } };
}

function authorizeCals(doc: Document, message: Record<string, unknown>): AttributeAuthorizationResult {
  const attrName = stringValue(message.attrName);
  const attrValue = stringValue(message.attrValue);
  const ids = message.type === 'setCalsAttrMulti'
    ? idsValue(message.ids)
    : (typeof message.id === 'string' && message.id !== '' ? [message.id] : null);
  if (!ids || attrName === null || attrValue === null) return reject('The CALS attribute request is incomplete.');
  const elements = elementIds(doc, ids);
  if (!elements) return reject('One or more CALS targets are stale.');
  const expectedKind = elements[0].name;
  if (!elements.every((element) => element.name === expectedKind)) return reject('CALS multi-edit targets must have one element kind.');
  if (!CALS_MATRIX[expectedKind]?.has(attrName)) return reject('That CALS attribute is not allowed on the selected element kind.');
  const valueError = attrValueError(attrName, attrValue);
  if (valueError) return reject(valueError);
  return { ok: true, action: { kind: 'element', ids, attrName, attrValue } };
}

function authorizeTgroup(doc: Document, message: Record<string, unknown>): AttributeAuthorizationResult {
  const tableId = stringValue(message.id);
  if (!tableId || !Array.isArray(message.attrs) || message.attrs.length === 0) {
    return reject('The tgroup attribute request is incomplete.');
  }
  const table = findElementById(doc, tableId);
  if (!table || table.name !== 'table' || !childrenNamed(table, 'tgroup')[0]) {
    return reject('The tgroup target is not a current table.');
  }
  const attrs: Array<{ name: 'colsep' | 'rowsep'; value: '' | '0' | '1' }> = [];
  const names = new Set<string>();
  for (const candidate of message.attrs) {
    if (!candidate || typeof candidate !== 'object') return reject('A tgroup attribute entry is invalid.');
    const raw = candidate as Record<string, unknown>;
    if (Object.keys(raw).some((key) => key !== 'name' && key !== 'value')) {
      return reject('A tgroup attribute entry contains an unsupported field.');
    }
    if (raw.name !== 'colsep' && raw.name !== 'rowsep') return reject('Only colsep and rowsep may be set on tgroup.');
    if (raw.value !== '' && raw.value !== '0' && raw.value !== '1') return reject('A tgroup separator value must be 0, 1, or empty.');
    if (names.has(raw.name)) return reject('A tgroup attribute may appear only once.');
    names.add(raw.name);
    attrs.push({ name: raw.name, value: raw.value });
  }
  return { ok: true, action: { kind: 'tgroup', tableId, attrs } };
}

function authorizeHorizontalAlignment(
  doc: Document,
  message: Record<string, unknown>,
): AttributeAuthorizationResult {
  const ids = idsValue(message.ids);
  if (!ids) return reject('The horizontal alignment request has no valid targets.');
  if (!isHorizontalAlignment(message.align)) return reject('The horizontal alignment value is not supported.');
  const elements = elementIds(doc, ids);
  if (!elements) return reject('One or more horizontal alignment targets are stale.');
  const wholeEditable = wholeEditableElementSet(doc);
  if (!elements.every((element) => isHorizontalAlignmentElement(element, wholeEditable))) {
    return reject('Horizontal alignment is not supported for one or more selected elements.');
  }
  if (message.align === 'justify' && elements.some((element) => element.name === 'image')) {
    return reject('Images cannot use justified alignment.');
  }
  return { ok: true, action: { kind: 'horizontalAlign', ids, align: message.align } };
}

function ancestorNamed(element: ElementNode, names: readonly string[]): ElementNode | null {
  for (let current: ElementNode | null | undefined = element; current; current = current.parent) {
    if (names.includes(current.name)) return current;
  }
  return null;
}

function directStyleTarget(element: ElementNode, target: AuthorStyleTarget): boolean {
  if (target === 'all') return true;
  if (target === 'title') {
    return element.name === 'title' && ['topic', 'concept', 'task', 'reference'].includes(element.parent?.name ?? '');
  }
  if (target === 'heading') return element.name === 'title' && element.parent?.name === 'section';
  if (target === 'body') return element.name === 'p';
  if (target === 'shortdesc') return element.name === 'shortdesc';
  if (target === 'section') return element.name === 'section';
  if (target === 'list') return element.name === 'ul' || element.name === 'ol';
  if (target === 'listItem') return element.name === 'li';
  if (target === 'table') return element.name === 'table';
  if (target === 'tableRow') return element.name === 'row';
  if (target === 'tableCell') return element.name === 'entry';
  if (target === 'tableHeadCell' || target === 'tableBodyCell') {
    if (element.name !== 'entry') return false;
    const section = ancestorNamed(element.parent!, ['thead', 'tbody']);
    return section?.name === (target === 'tableHeadCell' ? 'thead' : 'tbody');
  }
  if (target === 'figure') return element.name === 'fig';
  if (target === 'image') return element.name === 'image';
  if (target === 'note') return element.name === 'note';
  if (target === 'code') return element.name === 'codeblock' || element.name === 'codeph';
  return target === 'lines' && element.name === 'lines';
}

function hasStyleTarget(element: ElementNode, target: AuthorStyleTarget): boolean {
  if (directStyleTarget(element, target)) return true;
  const ancestorTargets: Partial<Record<AuthorStyleTarget, string[]>> = {
    section: ['section'], list: ['ul', 'ol'], table: ['table'], tableRow: ['row'],
    tableCell: ['entry'], figure: ['fig'], note: ['note'],
  };
  const names = ancestorTargets[target];
  if (names && ancestorNamed(element.parent!, names)) return true;
  if ((target === 'tableHeadCell' || target === 'tableBodyCell')) {
    const entry = ancestorNamed(element.parent!, ['entry']);
    return entry ? directStyleTarget(entry, target) : false;
  }
  return false;
}

function canTransformToStyleTarget(element: ElementNode, target: AuthorStyleTarget): boolean {
  if (target === 'heading') return element.name === 'p';
  if (target === 'body') {
    return (element.name === 'title' && element.parent?.name === 'section') ||
      ['entry', 'li', 'lines'].includes(element.name);
  }
  if (target === 'list' || target === 'listItem') return ['p', 'entry', 'lines'].includes(element.name);
  if (target === 'section') return ['p', 'lines'].includes(element.name);
  if (target === 'note' || target === 'code') return ['p', 'entry', 'lines'].includes(element.name);
  return target === 'lines' && element.name === 'entry';
}

function compatibleStyleSelection(elements: ElementNode[], target: AuthorStyleTarget, apply: boolean): boolean {
  if (target === 'page') return false;
  if (elements.length > 1) return elements.every((element) => directStyleTarget(element, target));
  return hasStyleTarget(elements[0], target) || (apply && canTransformToStyleTarget(elements[0], target));
}

function styleAuthorityFieldsPresent(message: Record<string, unknown>, names: string[]): boolean {
  return names.some((name) => Object.prototype.hasOwnProperty.call(message, name));
}

function authorizeStyle(
  doc: Document,
  message: Record<string, unknown>,
  styles: AuthorStyleDefinition[],
): AttributeAuthorizationResult {
  const ids = idsValue(message.ids);
  if (!ids) return reject('The style request has no valid targets.');
  const elements = elementIds(doc, ids);
  if (!elements) return reject('One or more style targets are stale.');
  const presets = styles.filter((style) => !style.isDefault);
  if (message.type === 'applyStyle') {
    if (styleAuthorityFieldsPresent(message, ['styleTarget', 'managedClassNames', 'label'])) {
      return reject('The style request supplied host-owned authority fields.');
    }
    const className = stringValue(message.className);
    const style = className === null ? undefined : presets.find((candidate) => candidate.className === className);
    if (!style) return reject('The requested style is not registered in the current stylesheet.');
    if (!compatibleStyleSelection(elements, style.target, true)) return reject('The registered style is incompatible with the selected element.');
    return {
      ok: true,
      action: {
        kind: 'style', ids, className: style.className, styleTarget: style.target,
        managedClassNames: presets.map((candidate) => candidate.className),
      },
    };
  }
  if (styleAuthorityFieldsPresent(message, ['className', 'managedClassNames', 'label'])) {
    return reject('The clear-style request supplied host-owned authority fields.');
  }
  const styleTarget = stringValue(message.styleTarget);
  if (!styleTarget || !Object.prototype.hasOwnProperty.call(AUTHOR_STYLE_TARGET_LABELS, styleTarget)) {
    return reject('The clear-style target is not supported.');
  }
  const target = styleTarget as AuthorStyleTarget;
  if (!compatibleStyleSelection(elements, target, false)) return reject('The clear-style target is incompatible with the selected element.');
  return {
    ok: true,
    action: {
      kind: 'style', ids, className: '', styleTarget: target,
      managedClassNames: presets
        .filter((style) => style.target === target || style.target === 'all')
        .map((style) => style.className),
    },
  };
}

function authorizeShade(
  doc: Document,
  message: Record<string, unknown>,
  styles: AuthorStyleDefinition[],
): AttributeAuthorizationResult {
  if (styleAuthorityFieldsPresent(message, ['styleTarget', 'managedClassNames', 'label', 'className'])) {
    return reject('The shading request supplied host-owned authority fields.');
  }
  const ids = idsValue(message.ids);
  if (!ids) return reject('The shading request has no valid targets.');
  const elements = elementIds(doc, ids);
  if (!elements) return reject('One or more shading targets are stale.');
  const elementName = elements[0].name;
  if ((elementName !== 'row' && elementName !== 'entry') || !elements.every((element) => element.name === elementName)) {
    return reject('Shading targets must be all rows or all cells.');
  }
  const styleTarget = elementName === 'row' ? 'tableRow' : 'tableCell';
  let color: '' | 'custom' | `#${string}` = '';
  if (message.type === 'applyShade') {
    const requested = stringValue(message.color);
    if (requested === null || (requested !== 'custom' && !/^#[0-9a-f]{6}$/.test(requested))) {
      return reject('The shading color is not a normalized six-digit hex value.');
    }
    color = requested as 'custom' | `#${string}`;
  }
  const label = color && color !== 'custom'
    ? SHADE_LABELS.get(color) ?? (styleTarget === 'tableRow' ? 'Shaded row' : 'Shaded cell')
    : (styleTarget === 'tableRow' ? 'Shaded row' : 'Shaded cell');
  return {
    ok: true,
    action: {
      kind: 'shade', ids, color, styleTarget, label,
      managedClassNames: shadeManagedClassNames(styles),
    },
  };
}

export function authorizeAttributeMessage(params: {
  source: string;
  message: Record<string, unknown>;
  taxonomy: TaxonomyConfig | null;
  styles: AuthorStyleDefinition[];
  structVersion: number;
}): AttributeAuthorizationResult {
  if (!allStringsXmlSafe(params.message)) return reject('The request contains a string that is not safe in XML.');
  const type = params.message.type;
  if (typeof type !== 'string' || !MESSAGE_KEYS[type]) return reject('The attribute message family is not supported.');
  if (Object.keys(params.message).some((key) => !MESSAGE_KEYS[type].has(key))) {
    return reject('The attribute request contains fields from another message family.');
  }
  if (params.message.baseStructVersion !== params.structVersion) {
    return reject('The attribute request was created from a stale render.');
  }
  const doc = parseCurrent(params.source);
  if (!doc) return reject('The current DITA document could not be parsed.');
  if (type === 'setTaxonomyAttr') return authorizeRootAttribute(doc, params.message, params.taxonomy, 'taxonomy');
  if (type === 'setExistingPropertyAttr') return authorizeRootAttribute(doc, params.message, params.taxonomy, 'existing');
  if (type === 'setCalsAttr' || type === 'setCalsAttrMulti') return authorizeCals(doc, params.message);
  if (type === 'setTgroupAttr') return authorizeTgroup(doc, params.message);
  if (type === 'setHorizontalAlign') return authorizeHorizontalAlignment(doc, params.message);
  if (type === 'applyStyle' || type === 'clearStyle') return authorizeStyle(doc, params.message, params.styles);
  if (type === 'applyShade' || type === 'clearShade') return authorizeShade(doc, params.message, params.styles);
  return reject('The attribute message family is not supported.');
}
