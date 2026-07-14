import { assignElementIds, structuralIds } from '../cst/element-ids';
import { canDeleteElement } from '../cst/structural';
import type { Document, ElementNode } from '../cst/types';
import { buildAvailabilityMap, type AvailabilityMap, type DocIndex, type FocusState } from '../commands/validity';
import { canInsert, type InsertKind, type InsertPosition } from '../commands/insert-ops';
import { planTransform, type TransformType } from '../commands/transform-ops';
import { buildNavigationMap, type NavKey, type NavResult } from '../keyboard/nav-model';

export type NavMap = Record<string, Record<NavKey, NavResult>>;

type TransformStatus = 'ok' | 'noop' | 'invalid';
export type TransformMap = Record<string, Partial<Record<TransformType, { status: TransformStatus; reason?: string }>>>;
const TRANSFORMS_BY_KIND: Record<string, TransformType[]> = {
  entry: [
    'entryToParagraph',
    'entryToUnorderedList',
    'entryToOrderedList',
    'entryToAlphabeticList',
    'entryToLines',
    'entryToNote',
    'entryToCodeblock',
  ],
  li: ['toOrderedList', 'toUnorderedList', 'toAlphabeticList', 'itemToParagraph'],
  p: [
    'paragraphToOrderedList',
    'paragraphToUnorderedList',
    'paragraphToAlphabeticList',
    'paragraphToSection',
    'paragraphToNote',
    'paragraphToCodeblock',
    'paragraphToItem',
  ],
  lines: [
    'linesToParagraph',
    'linesToUnorderedList',
    'linesToOrderedList',
    'linesToAlphabeticList',
    'linesToSection',
    'linesToNote',
    'linesToCodeblock',
  ],
  note: [
    'noteContentToParagraph',
    'noteContentToUnorderedList',
    'noteContentToOrderedList',
    'noteContentToAlphabeticList',
    'noteContentToLines',
    'noteContentToCodeblock',
  ],
};

export function buildNavMap(doc: Document): NavMap {
  return buildNavigationMap(doc);
}

export function buildCmdMap(doc: Document): AvailabilityMap {
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  const map = buildAvailabilityMap({ doc, byId });
  for (const [el, { id }] of structuralIds(doc)) {
    const check = canDeleteElement(el, el.parent ?? null);
    const entry = map[id] ?? (map[id] = {});
    entry.deleteElement = check.canDelete ? { enabled: true } : { enabled: false, reason: check.reason };
  }
  return map;
}

export function resolveTransformFocus(transform: TransformType, focusedId: string, idx: DocIndex): FocusState {
  if (transform.startsWith('noteContentTo')) {
    return { id: focusedId.split(':t', 1)[0] };
  }
  if (
    transform === 'entryToParagraph' ||
    transform === 'entryToUnorderedList' ||
    transform === 'entryToOrderedList' ||
    transform === 'entryToAlphabeticList' ||
    transform === 'entryToLines' ||
    transform === 'entryToNote' ||
    transform === 'entryToCodeblock'
  ) {
    let entry: ElementNode | null | undefined = idx.byId.get(focusedId);
    while (entry && entry.name !== 'entry') entry = entry.parent;
    if (!entry) return { id: focusedId };
    for (const [id, el] of idx.byId) if (el === entry) return { id };
    return { id: focusedId };
  }
  if (transform !== 'toOrderedList' && transform !== 'toUnorderedList' && transform !== 'toAlphabeticList') return { id: focusedId };
  let list: ElementNode | null | undefined = idx.byId.get(focusedId);
  while (list && list.name !== 'ul' && list.name !== 'ol') list = list.parent;
  if (!list) return { id: focusedId };
  for (const [id, el] of idx.byId) if (el === list) return { id };
  return { id: focusedId };
}

export function buildTransformMap(doc: Document): TransformMap {
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  const idx: DocIndex = { doc, byId };
  const map: TransformMap = {};
  for (const [id, el] of byId) {
    const candidates = TRANSFORMS_BY_KIND[el.name];
    if (!candidates) continue;
    const entry: Partial<Record<TransformType, { status: TransformStatus; reason?: string }>> = {};
    for (const t of candidates) {
      const r = planTransform(t, resolveTransformFocus(t, id, idx), idx);
      entry[t] = r.status === 'ok' ? { status: 'ok' } : { status: r.status, reason: r.reason };
    }
    map[id] = entry;
  }
  return map;
}

type InsertMode = 'before' | 'after' | 'into';
type InsertKindAvail = { kind: InsertKind; enabled: boolean; reason?: string };
export type InsertMap = Record<string, Partial<Record<InsertMode, InsertKindAvail[]>>>;
const INSERT_KINDS_ALL: InsertKind[] = [
  'paragraph',
  'lines',
  'unorderedList',
  'alphabeticList',
  'orderedList',
  'listItem',
  'table',
  'note',
  'codeblock',
  'section',
];

export function buildInsertMap(doc: Document): InsertMap {
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  const idx: DocIndex = { doc, byId };
  const availAt = (pos: InsertPosition): InsertKindAvail[] =>
    INSERT_KINDS_ALL.map((kind) => {
      const v = canInsert(kind, pos, idx);
      return v.enabled ? { kind, enabled: true } : { kind, enabled: false, reason: v.reason };
    });
  const map: InsertMap = {};
  for (const [id, el] of byId) {
    const entry: Partial<Record<InsertMode, InsertKindAvail[]>> = {};
    if (el.name === 'p' || el.name === 'li') {
      entry.before = availAt({ mode: 'before', refId: id });
      entry.after = availAt({ mode: 'after', refId: id });
      if (el.name === 'li') entry.into = availAt({ mode: 'into', containerId: id });
    } else if (el.name === 'entry') {
      entry.into = availAt({ mode: 'into', containerId: id });
    } else if (el.name === 'note') {
      entry.into = availAt({ mode: 'into', containerId: id });
    } else if (el.name === 'table' || el.name === 'fig') {
      entry.after = availAt({ mode: 'after', refId: id });
    }
    if (Object.keys(entry).length > 0) map[id] = entry;
  }
  return map;
}

export type DocProps = { id: string; kind: string; attrs: Array<{ name: string; value: string }> } | null;

export function buildDocProps(doc: Document): DocProps {
  const ids = assignElementIds(doc);
  for (const node of doc.children) {
    if (node.type === 'element') {
      const id = ids.get(node);
      if (id) return { id, kind: node.name, attrs: node.attrs.map((a) => ({ name: a.name, value: a.value })) };
    }
  }
  return null;
}
