// Block/list type transforms (P1-3b apply core).
//
// Applies the transform INTENTS planned by src/commands/transform-ops.ts. Pure
// source-to-source, same surgical model as applyStructuralEdit: untouched nodes
// slice verbatim, so everything outside the intentional transform stays byte-exact.
//
// Deliberately independent of the planning layer: it takes a primitive
// TransformSpec (plain ids/enums), not a TransformIntent, so cst never imports
// src/commands (which imports cst back). The host/webview wiring maps a planned
// intent's fields onto TransformSpec 1:1.
//
// Attribute policy: ul<->ol RENAME preserves the element's attributes
// (id/outputclass, ... ) by splicing only the tag name. p<->li conversions DROP
// the source wrapper's attributes and carry over only its children, matching the
// planning contract ("the new element adopts the other's children").

import { parse } from './parse';
import { serialize } from './serialize';
import { makeElement, makeRawText, markDirty, removeAttrs, setAttr } from './edit';
import { childElements, childrenNamed } from './query';
import { assignElementIds, findElementById } from './element-ids';
import { insertAfter, insertBefore, leadingWs, removeWithLeadingWs, setElementChildren, trailingWs } from './tree-edit';
import {
  attrValue,
  listAttrsForStyle,
  listNameForStyle,
  outputclassWithAlpha,
  outputclassWithoutAlpha,
  type ListStyle,
} from './list-style';
import type { CstNode, Document, ElementNode } from './types';
import type { StructuralResult } from './structural';

type EntryWrapperKind = 'p' | 'ul' | 'ol' | 'lines' | 'note' | 'codeblock';
type LinesTargetKind = 'p' | 'ul' | 'ol' | 'section' | 'note' | 'codeblock';

export interface TransformSpec {
  transform:
    | 'toOrderedList'
    | 'toUnorderedList'
    | 'toAlphabeticList'
    | 'paragraphToOrderedList'
    | 'paragraphToUnorderedList'
    | 'paragraphToAlphabeticList'
    | 'paragraphToSection'
    | 'paragraphToNote'
    | 'paragraphToCodeblock'
    | 'linesToParagraph'
    | 'linesToUnorderedList'
    | 'linesToOrderedList'
    | 'linesToAlphabeticList'
    | 'linesToSection'
    | 'linesToNote'
    | 'linesToCodeblock'
    | 'entryToParagraph'
    | 'entryToUnorderedList'
    | 'entryToOrderedList'
    | 'entryToAlphabeticList'
    | 'entryToLines'
    | 'entryToNote'
    | 'entryToCodeblock'
    | 'paragraphToItem'
    | 'itemToParagraph';
  /** ul/ol to rename (list-kind transforms). */
  targetId?: string;
  /** Element that should keep focus when the target container is renamed. */
  focusId?: string;
  /** <p> to convert (paragraphToItem). */
  paragraphId?: string;
  /** Adjacent ul/ol the new <li> joins (paragraphToItem). */
  listId?: string;
  /** Append/prepend to one list, or merge the paragraph between two matching lists. */
  position?: 'append' | 'prepend' | 'merge-between';
  /** Following list removed when position is merge-between. */
  mergeListId?: string;
  /** New list kind for paragraphToOrderedList / paragraphToUnorderedList. */
  listKind?: 'ul' | 'ol';
  /** Marker style for ol variants: plain numbered or lower-alpha. */
  listStyle?: ListStyle;
  /** New block kind for paragraphTo* / linesTo* block transforms. */
  blockKind?: LinesTargetKind;
  /** <lines> block to convert (linesTo* transforms). */
  linesId?: string;
  /** <entry> to wrap (entryTo* transforms). */
  entryId?: string;
  /** New wrapper for direct entry content. */
  wrapperKind?: EntryWrapperKind;
  /** <li> to convert (itemToParagraph). */
  itemId?: string;
  /** How the item leaves its list (itemToParagraph). */
  mode?: 'dissolve-list' | 'lift-before' | 'lift-after' | 'split-list';
}

export function applyTransform(source: string, spec: TransformSpec): StructuralResult {
  const doc = parse(source);
  let focusEl: ElementNode | null = null;

  switch (spec.transform) {
    case 'toOrderedList':
    case 'toUnorderedList':
    case 'toAlphabeticList': {
      const list = requireEl(doc, spec.targetId, 'list-kind target');
      if (list.name !== 'ul' && list.name !== 'ol') {
        throw new Error(`list-kind transform target is <${list.name}>, not a list`);
      }
      const focused = spec.focusId ? findElementById(doc, spec.focusId) : undefined;
      const style = spec.listStyle ??
        (spec.transform === 'toAlphabeticList'
          ? 'alpha'
          : spec.transform === 'toOrderedList'
            ? 'ordered'
            : 'unordered');
      focusEl = renameListStyle(doc, list, style);
      if (focused && (focused === list || isDescendantOf(focused, list))) focusEl = focused;
      break;
    }
    case 'paragraphToItem': {
      const p = requireEl(doc, spec.paragraphId, 'paragraphToItem source');
      const list = requireEl(doc, spec.listId, 'paragraphToItem list');
      if (p.name !== 'p') throw new Error(`paragraphToItem source is <${p.name}>, not a paragraph`);
      if (list.name !== 'ul' && list.name !== 'ol') {
        throw new Error(`paragraphToItem list is <${list.name}>, not a list`);
      }
      const mergeList = spec.mergeListId ? requireEl(doc, spec.mergeListId, 'paragraphToItem merge list') : undefined;
      if (mergeList && mergeList.name !== 'ul' && mergeList.name !== 'ol') {
        throw new Error(`paragraphToItem merge list is <${mergeList.name}>, not a list`);
      }
      focusEl = paragraphToItem(p, list, spec.position ?? 'append', mergeList);
      break;
    }
    case 'paragraphToOrderedList':
    case 'paragraphToUnorderedList':
    case 'paragraphToAlphabeticList': {
      const p = requireEl(doc, spec.paragraphId, `${spec.transform} source`);
      if (p.name !== 'p') throw new Error(`${spec.transform} source is <${p.name}>, not a paragraph`);
      const style = spec.listStyle ??
        (spec.transform === 'paragraphToAlphabeticList'
          ? 'alpha'
          : spec.transform === 'paragraphToOrderedList'
            ? 'ordered'
            : 'unordered');
      focusEl = paragraphToList(p, spec.listKind ?? listNameForStyle(style), style);
      break;
    }
    case 'paragraphToSection':
    case 'paragraphToNote':
    case 'paragraphToCodeblock': {
      const p = requireEl(doc, spec.paragraphId, `${spec.transform} source`);
      if (p.name !== 'p') throw new Error(`${spec.transform} source is <${p.name}>, not a paragraph`);
      const kind = (spec.blockKind as 'section' | 'note' | 'codeblock' | undefined) ??
        (spec.transform === 'paragraphToSection'
          ? 'section'
          : spec.transform === 'paragraphToNote'
            ? 'note'
            : 'codeblock');
      focusEl = paragraphToBlock(p, kind);
      break;
    }
    case 'linesToParagraph':
    case 'linesToUnorderedList':
    case 'linesToOrderedList':
    case 'linesToAlphabeticList':
    case 'linesToSection':
    case 'linesToNote':
    case 'linesToCodeblock': {
      const lines = requireEl(doc, spec.linesId, `${spec.transform} source`);
      if (lines.name !== 'lines') throw new Error(`${spec.transform} source is <${lines.name}>, not a lines block`);
      const kind = spec.blockKind ?? linesTargetKind(spec.transform);
      const style = spec.listStyle ??
        (spec.transform === 'linesToAlphabeticList'
          ? 'alpha'
          : kind === 'ul'
            ? 'unordered'
            : kind === 'ol'
              ? 'ordered'
              : undefined);
      focusEl = linesToBlock(lines, kind, style);
      break;
    }
    case 'entryToParagraph':
    case 'entryToUnorderedList':
    case 'entryToOrderedList':
    case 'entryToAlphabeticList':
    case 'entryToLines':
    case 'entryToNote':
    case 'entryToCodeblock': {
      const entry = requireEl(doc, spec.entryId, `${spec.transform} source`);
      if (entry.name !== 'entry') throw new Error(`${spec.transform} source is <${entry.name}>, not a table cell`);
      const kind = spec.wrapperKind ?? entryWrapperKind(spec.transform);
      const style = spec.listStyle ??
        (spec.transform === 'entryToAlphabeticList'
          ? 'alpha'
          : kind === 'ul'
            ? 'unordered'
            : kind === 'ol'
              ? 'ordered'
              : undefined);
      focusEl = entryToBlock(entry, kind, style);
      break;
    }
    case 'itemToParagraph': {
      const li = requireEl(doc, spec.itemId, 'itemToParagraph source');
      if (li.name !== 'li') throw new Error(`itemToParagraph source is <${li.name}>, not a list item`);
      focusEl = itemToParagraph(li, spec.mode ?? 'lift-before');
      break;
    }
  }

  const focusId = focusEl ? assignElementIds(doc).get(focusEl) ?? null : null;
  // Transforms reposition/rename whole blocks; there is no text caret to restore.
  return { source: serialize(doc), focusId, caretOffset: null };
}

function requireEl(doc: Document, id: string | undefined, what: string): ElementNode {
  const el = id ? findElementById(doc, id) : undefined;
  if (!el) throw new Error(`${what} not found: ${id}`);
  return el;
}

function isDescendantOf(el: ElementNode, ancestor: ElementNode): boolean {
  let current = el.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Rename a <ul>/<ol> in place: splice only the tag name in the open tag and emit a
 *  fresh close tag, leaving attributes and children byte-identical. */
function renameListKind(doc: Document, list: ElementNode, to: 'ul' | 'ol'): ElementNode {
  const openTag = list.newOpenTag ?? doc.source.slice(list.openTagRange.start, list.openTagRange.end);
  list.newOpenTag = openTag.replace(/^<[^\s/>]+/, `<${to}`);
  list.name = to;
  // Null close range means serialize emits `</to>` instead of slicing the old `</from>`.
  list.closeTagRange = null;
  markDirty(list);
  return list;
}

function setListOutputclassForStyle(doc: Document, list: ElementNode, style: ListStyle): void {
  const existing = attrValue(list, 'outputclass');
  if (style === 'alpha') {
    setAttr(list, 'outputclass', outputclassWithAlpha(existing), doc.source);
    return;
  }
  const next = outputclassWithoutAlpha(existing);
  if (next === existing) return;
  if (next === null) {
    removeAttrs(list, ['outputclass'], doc.source);
  } else {
    setAttr(list, 'outputclass', next, doc.source);
  }
}

function renameListStyle(doc: Document, list: ElementNode, style: ListStyle): ElementNode {
  const to = listNameForStyle(style);
  const renamed = list.name === to ? list : renameListKind(doc, list, to);
  setListOutputclassForStyle(doc, renamed, style);
  return renamed;
}

/** Convert a <p> into a <li> joined to an adjacent list. */
function paragraphToItem(
  p: ElementNode,
  list: ElementNode,
  position: 'append' | 'prepend' | 'merge-between',
  mergeList?: ElementNode,
): ElementNode {
  // Apply-time precondition re-check: ids are reassigned on every edit, so a stale
  // spec must not be trusted.
  const sibs = p.parent ? childElements(p.parent) : [];
  const i = sibs.indexOf(p);
  if (position === 'merge-between') {
    if (!mergeList) throw new Error('paragraphToItem merge-between: missing following list');
    if (sibs[i - 1] !== list || sibs[i + 1] !== mergeList) {
      throw new Error("paragraphToItem merge-between: paragraph is not between the requested lists");
    }
    if (list.name !== mergeList.name) {
      throw new Error('paragraphToItem merge-between: list kinds do not match');
    }
    const beforeItems = childrenNamed(list, 'li');
    const afterItems = childrenNamed(mergeList, 'li');
    if (beforeItems.length === 0 || afterItems.length === 0) {
      throw new Error('paragraphToItem merge-between: both lists must contain items');
    }
    const li = makeElement('li', [], p.children.slice());
    setElementChildren(list, formattedListChildren(list, [...beforeItems, li, ...afterItems]));
    removeWithLeadingWs(p);
    removeWithLeadingWs(mergeList);
    return li;
  }
  if (position === 'append' && sibs[i - 1] !== list) {
    throw new Error("paragraphToItem append: list is not the paragraph's immediate previous sibling");
  }
  if (position === 'prepend' && sibs[i + 1] !== list) {
    throw new Error("paragraphToItem prepend: list is not the paragraph's immediate next sibling");
  }

  const li = makeElement('li', [], p.children.slice());
  const items = childrenNamed(list, 'li');
  if (position === 'append') {
    const last = items[items.length - 1];
    if (!last) throw new Error('paragraphToItem: target list has no item to append after');
    insertAfter(last, li);
  } else {
    const first = items[0];
    if (!first) throw new Error('paragraphToItem: target list has no item to prepend before');
    insertBefore(first, li);
  }
  removeWithLeadingWs(p);
  return li;
}

/** Convert a <p> into a fresh one-item <ul>/<ol>. */
function paragraphToList(p: ElementNode, kind: 'ul' | 'ol', style: ListStyle = kind === 'ul' ? 'unordered' : 'ordered'): ElementNode {
  const parent = p.parent;
  if (!parent) throw new Error('paragraphToList: paragraph has no parent');
  if (!['body', 'conbody', 'refbody', 'li', 'entry', 'section'].includes(parent.name)) {
    throw new Error(`paragraphToList: list is not permitted inside <${parent.name}>`);
  }
  const idx = parent.children.indexOf(p);
  const lead = leadingWs(parent.children, idx);
  const itemLead = `${lead}  `;
  const li = makeElement('li', [], p.children.slice());
  const list = makeElement(kind, listAttrsForStyle(style), [makeRawText(itemLead), li, makeRawText(lead)]);
  insertBefore(p, list);
  removeWithLeadingWs(p);
  return li;
}

/** Convert a <p> into a toolbar-selected block structure. */
function paragraphToBlock(p: ElementNode, kind: 'section' | 'note' | 'codeblock'): ElementNode {
  const parent = p.parent;
  if (!parent) throw new Error('paragraphToBlock: paragraph has no parent');
  const sectionAllowed = ['body', 'conbody', 'refbody'].includes(parent.name);
  const blockAllowed = ['body', 'conbody', 'refbody', 'section', 'li', 'entry'].includes(parent.name);
  if (kind === 'section' ? !sectionAllowed : !blockAllowed) {
    throw new Error(`paragraphToBlock: <${kind}> is not permitted inside <${parent.name}>`);
  }
  if (kind === 'codeblock') {
    const code = makeElement('codeblock', [], p.children.slice());
    insertBefore(p, code);
    removeWithLeadingWs(p);
    return code;
  }
  const idx = parent.children.indexOf(p);
  const lead = leadingWs(parent.children, idx);
  const childLead = `${lead}  `;
  const child = makeElement('p', [], p.children.slice());
  const block = makeElement(kind, [], [makeRawText(childLead), child, makeRawText(lead)]);
  insertBefore(p, block);
  removeWithLeadingWs(p);
  return child;
}

function linesTargetKind(transform: TransformSpec['transform']): LinesTargetKind {
  switch (transform) {
    case 'linesToParagraph':
      return 'p';
    case 'linesToUnorderedList':
      return 'ul';
    case 'linesToOrderedList':
      return 'ol';
    case 'linesToAlphabeticList':
      return 'ol';
    case 'linesToSection':
      return 'section';
    case 'linesToNote':
      return 'note';
    case 'linesToCodeblock':
      return 'codeblock';
    default:
      throw new Error(`not a lines transform: ${transform}`);
  }
}

function replaceElement(el: ElementNode, replacement: ElementNode): ElementNode {
  const parent = el.parent;
  if (!parent) throw new Error('replaceElement: element has no parent');
  const idx = parent.children.indexOf(el);
  if (idx < 0) throw new Error('replaceElement: element is not in its parent');
  parent.children[idx] = replacement;
  replacement.parent = parent;
  markDirty(parent);
  return replacement;
}

function textOnlyRaw(children: CstNode[]): string | null {
  if (!children.every((child) => child.type === 'text')) return null;
  return children.map((child) => child.type === 'text' ? (child.newText ?? child.raw) : '').join('');
}

function paragraphPayloadFromLines(children: CstNode[]): CstNode[] {
  const raw = textOnlyRaw(children);
  if (raw === null) return children.slice();
  const collapsed = raw.replace(/[ \t]*\r?\n[ \t]*/g, ' ').trim();
  return collapsed ? [makeRawText(collapsed)] : [];
}

function lineTextItems(children: CstNode[]): CstNode[][] | null {
  const raw = textOnlyRaw(children);
  if (raw === null || !/\r?\n/.test(raw)) return null;
  const items = raw.split(/\r?\n/g).map(trimRawText).filter((item) => item !== '');
  return items.length > 1 ? items.map((item) => [makeRawText(item)]) : null;
}

function listChildrenForReplacement(lines: ElementNode, items: ElementNode[]): CstNode[] {
  const parent = lines.parent;
  if (!parent) throw new Error('linesToBlock: lines has no parent');
  if (parent.name === 'entry') return items;
  const idx = parent.children.indexOf(lines);
  const lead = leadingWs(parent.children, idx);
  const childLead = `${lead}  `;
  const children: CstNode[] = [];
  for (const item of items) {
    children.push(makeRawText(childLead));
    children.push(item);
  }
  children.push(makeRawText(lead));
  return children;
}

function wrapperChildrenForReplacement(lines: ElementNode, child: ElementNode): CstNode[] {
  const parent = lines.parent;
  if (!parent) throw new Error('linesToBlock: lines has no parent');
  if (parent.name === 'entry') return [child];
  const idx = parent.children.indexOf(lines);
  const lead = leadingWs(parent.children, idx);
  return [makeRawText(`${lead}  `), child, makeRawText(lead)];
}

function assertLinesTargetAllowed(lines: ElementNode, kind: LinesTargetKind): void {
  const parent = lines.parent;
  if (!parent) throw new Error('linesToBlock: lines has no parent');
  const sectionAllowed = ['body', 'conbody', 'refbody'].includes(parent.name);
  const blockAllowed = ['body', 'conbody', 'refbody', 'section', 'li', 'entry'].includes(parent.name);
  const listAllowed = ['body', 'conbody', 'refbody', 'section', 'li', 'entry'].includes(parent.name);
  const paragraphAllowed = ['body', 'conbody', 'refbody', 'section', 'li', 'entry'].includes(parent.name);
  const allowed = kind === 'section'
    ? sectionAllowed
    : kind === 'ul' || kind === 'ol'
      ? listAllowed
      : kind === 'p'
        ? paragraphAllowed
        : blockAllowed;
  if (!allowed) throw new Error(`linesToBlock: <${kind}> is not permitted inside <${parent.name}>`);
}

function linesToList(lines: ElementNode, kind: 'ul' | 'ol', style: ListStyle = kind === 'ul' ? 'unordered' : 'ordered'): ElementNode {
  const itemChildren = bulletTextItems(lines.children) ?? lineTextItems(lines.children) ?? [lines.children.slice()];
  const items = itemChildren.map((children) => makeElement('li', [], children));
  const list = makeElement(kind, listAttrsForStyle(style), listChildrenForReplacement(lines, items));
  replaceElement(lines, list);
  return items[0] ?? list;
}

function linesToBlock(lines: ElementNode, kind: LinesTargetKind, style?: ListStyle): ElementNode {
  assertLinesTargetAllowed(lines, kind);
  if (kind === 'ul' || kind === 'ol') return linesToList(lines, kind, style);
  if (kind === 'p') return replaceElement(lines, makeElement('p', [], paragraphPayloadFromLines(lines.children)));
  if (kind === 'codeblock') return replaceElement(lines, makeElement('codeblock', [], lines.children.slice()));
  const p = makeElement('p', [], paragraphPayloadFromLines(lines.children));
  const block = makeElement(kind, [], wrapperChildrenForReplacement(lines, p));
  replaceElement(lines, block);
  return p;
}

const ENTRY_BLOCK_CHILDREN = new Set([
  'ul', 'ol', 'sl', 'dl',
  'p', 'lq', 'note', 'fig', 'pre', 'lines', 'codeblock', 'msgblock', 'screen',
  'table', 'simpletable',
  'section', 'example', 'bodydiv', 'sectiondiv', 'div',
  'steps', 'steps-unordered', 'substeps', 'step', 'stepsection', 'cmd',
]);

function entryWrapperKind(transform: TransformSpec['transform']): EntryWrapperKind {
  switch (transform) {
    case 'entryToParagraph':
      return 'p';
    case 'entryToUnorderedList':
      return 'ul';
    case 'entryToOrderedList':
      return 'ol';
    case 'entryToAlphabeticList':
      return 'ol';
    case 'entryToLines':
      return 'lines';
    case 'entryToNote':
      return 'note';
    case 'entryToCodeblock':
      return 'codeblock';
    default:
      throw new Error(`not an entry transform: ${transform}`);
  }
}

function hasEntryBlockChild(entry: ElementNode): boolean {
  return childElements(entry).some((child) => ENTRY_BLOCK_CHILDREN.has(child.name));
}

function onlyBlockChild(el: ElementNode, blockNames = ENTRY_BLOCK_CHILDREN): ElementNode | null {
  const blocks = childElements(el).filter((child) => blockNames.has(child.name));
  if (blocks.length !== 1) return null;
  const only = blocks[0];
  const hasOtherContent = el.children.some((child) => {
    if (child === only) return false;
    return child.type !== 'text' || (child.newText ?? child.raw).trim() !== '';
  });
  return hasOtherContent ? null : only;
}

function trimRawText(value: string): string {
  return value.replace(/^\s+/, '').replace(/\s+$/, '');
}

function bulletTextItems(children: CstNode[]): CstNode[][] | null {
  const raw = textOnlyRaw(children);
  if (raw === null) return null;
  if (!raw.includes('\u2022')) return null;
  const items = raw.split(/\u2022/g).map(trimRawText).filter((item) => item !== '');
  return items.length > 1 ? items.map((item) => [makeRawText(item)]) : null;
}

function entryChildren(entry: ElementNode): CstNode[] {
  return entry.children.slice();
}

function listPayloadChildren(list: ElementNode, separator: string): CstNode[] {
  const items = childElements(list).filter((child) => child.name === 'li');
  const children: CstNode[] = [];
  items.forEach((item, index) => {
    if (index > 0) children.push(makeRawText(separator));
    children.push(...item.children);
  });
  return children;
}

function notePayloadChildren(note: ElementNode): CstNode[] {
  const paragraph = onlyBlockChild(note, new Set(['p']));
  return paragraph ? paragraph.children.slice() : note.children.slice();
}

function existingBlockPayloadChildren(block: ElementNode, targetKind: EntryWrapperKind): CstNode[] {
  if (block.name === 'ul' || block.name === 'ol') {
    if (targetKind === 'ul' || targetKind === 'ol') return block.children.slice();
    return listPayloadChildren(block, targetKind === 'p' || targetKind === 'note' ? ' ' : '\n');
  }
  if (block.name === 'lines' && (targetKind === 'p' || targetKind === 'note')) return paragraphPayloadFromLines(block.children);
  if (block.name === 'note') return notePayloadChildren(block);
  return block.children.slice();
}

function entryPayloadChildren(entry: ElementNode, targetKind: EntryWrapperKind): CstNode[] {
  const block = onlyBlockChild(entry);
  return block ? existingBlockPayloadChildren(block, targetKind) : entryChildren(entry);
}

function entryToList(entry: ElementNode, kind: 'ul' | 'ol', style: ListStyle = kind === 'ul' ? 'unordered' : 'ordered'): ElementNode {
  const sourceBlock = onlyBlockChild(entry);
  if (sourceBlock && (sourceBlock.name === 'ul' || sourceBlock.name === 'ol')) {
    const items = childElements(sourceBlock).filter((child) => child.name === 'li');
    const list = makeElement(kind, listAttrsForStyle(style), sourceBlock.children.slice());
    setElementChildren(entry, [list]);
    return items[0] ?? list;
  }
  const payload = entryPayloadChildren(entry, kind);
  const itemChildren = bulletTextItems(payload) ?? (sourceBlock?.name === 'lines' ? lineTextItems(payload) : null) ?? [payload];
  const items = itemChildren.map((children) => makeElement('li', [], children));
  const list = makeElement(kind, listAttrsForStyle(style), items);
  setElementChildren(entry, [list]);
  return items[0] ?? list;
}

function entryToBlock(entry: ElementNode, kind: EntryWrapperKind, style?: ListStyle): ElementNode {
  const sourceBlock = onlyBlockChild(entry);
  if (hasEntryBlockChild(entry) && !sourceBlock) {
    throw new Error('entryToBlock: cell contains multiple or mixed block content');
  }
  if (kind === 'ul' || kind === 'ol') return entryToList(entry, kind, style);

  const children = entryPayloadChildren(entry, kind);
  if (kind === 'note') {
    const p = makeElement('p', [], children);
    const note = makeElement('note', [], [p]);
    setElementChildren(entry, [note]);
    return p;
  }
  const block = makeElement(kind, [], children);
  setElementChildren(entry, [block]);
  return block;
}

function clonedAttrs(el: ElementNode): Array<{ name: string; value: string; quote?: '"' | "'" }> {
  return el.attrs.map((attr) => ({ name: attr.name, value: attr.value, quote: attr.quote }));
}

function formattedListChildren(list: ElementNode, items: ElementNode[]): CstNode[] {
  const firstItemIndex = list.children.indexOf(items[0]);
  const itemWs = firstItemIndex >= 0 ? leadingWs(list.children, firstItemIndex) : '\n';
  const closeWs = trailingWs(list);
  const children: CstNode[] = [];
  for (const item of items) {
    children.push(makeRawText(itemWs));
    children.push(item);
  }
  children.push(makeRawText(closeWs));
  return children;
}

/** Convert a <li> into a <p> lifted out of its list. */
function itemToParagraph(
  li: ElementNode,
  mode: 'dissolve-list' | 'lift-before' | 'lift-after' | 'split-list',
): ElementNode {
  const list = li.parent;
  if (!list || (list.name !== 'ul' && list.name !== 'ol')) {
    throw new Error('itemToParagraph: item is not inside a list');
  }
  // Apply-time precondition re-check: the mode must match the item's real
  // position, and lift modes must leave a non-empty list.
  const items = childrenNamed(list, 'li');
  const pos = items.indexOf(li);
  if (mode === 'dissolve-list' && items.length !== 1) {
    throw new Error('itemToParagraph dissolve-list: list does not have exactly one item');
  }
  if (mode === 'lift-before' && !(items.length > 1 && pos === 0)) {
    throw new Error('itemToParagraph lift-before: item is not the first of a multi-item list');
  }
  if (mode === 'lift-after' && !(items.length > 1 && pos === items.length - 1)) {
    throw new Error('itemToParagraph lift-after: item is not the last of a multi-item list');
  }
  if (mode === 'split-list' && !(items.length > 2 && pos > 0 && pos < items.length - 1)) {
    throw new Error('itemToParagraph split-list: item is not a middle item of a three-plus-item list');
  }

  const p = makeElement('p', [], li.children.slice());
  if (mode === 'dissolve-list') {
    // Sole item: the whole list becomes the paragraph, at the list's position.
    insertBefore(list, p);
    removeWithLeadingWs(list);
  } else if (mode === 'lift-before') {
    insertBefore(list, p);
    removeWithLeadingWs(li);
  } else if (mode === 'lift-after') {
    insertAfter(list, p);
    removeWithLeadingWs(li);
  } else {
    const beforeItems = items.slice(0, pos);
    const afterItems = items.slice(pos + 1);
    const afterList = makeElement(list.name, clonedAttrs(list), formattedListChildren(list, afterItems));
    setElementChildren(list, formattedListChildren(list, beforeItems));
    insertAfter(list, p);
    insertAfter(p, afterList);
  }
  return p;
}
