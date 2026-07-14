// Slice γ (P1-3a) — pure block/list TYPE-TRANSFORM planning/validation core.
//
// Given a single focused element id + a parsed DocIndex (src/commands/validity.ts),
// decide whether a block/list type transform is legal and emit a deterministic
// INTENT that the later cst op (src/cst/structural.ts) + host wiring can apply.
// Like range-ops, this slice only PLANS: it never mutates the document and never
// serializes, so it cannot affect byte-exact round-tripping (a serialization-
// invariant test guards that). No UI/host wiring lives here.
//
// Supported transforms (corpus-grounded — feature-backlog P1-3, ul 1,737 / ol 115 /
// dense p+li; the cleanup need on PDF-extracted content):
//
//   • toOrderedList / toUnorderedList — rename a <ul>/<ol> in place. ul and ol share
//     an IDENTICAL (li)+ content model, so the rename always preserves structural
//     validity and only the tag name changes; the <li> children are untouched.
//   • paragraphToItem (p → li) — absorb a <p> into an ADJACENT <ul>/<ol> as a new
//     <li> that adopts the paragraph's children. Refused when there is no adjacent
//     list: synthesising a brand-new list container is insert-ops' job (P1-2), not a
//     transform, so this core deliberately does not create containers.
//   • paragraphToOrderedList / paragraphToUnorderedList — wrap a standalone <p> in a
//     new one-item <ol>/<ul>. This is the toolbar "turn this paragraph into a list"
//     behavior; paragraphToItem remains the adjacent-list join primitive.
//   • paragraphToSection / paragraphToNote / paragraphToCodeblock — turn a focused
//     paragraph into the selected block structure when the toolbar is used mid-text.
//   • linesToParagraph / linesToUnorderedList / linesToOrderedList / linesToSection /
//     linesToNote / linesToCodeblock — turn a focused <lines> block into the selected
//     structure. Lists preserve authored lines as list items; paragraph-like targets
//     demote authored line breaks to prose spacing.
//   • entryToParagraph / entryToUnorderedList / entryToOrderedList / entryToLines /
//     entryToNote / entryToCodeblock — wrap direct <entry> content in the selected
//     valid cell block, or retarget the content of a single existing cell block.
//     Refused only for mixed/multiple block content where the target content is
//     ambiguous.
//   • itemToParagraph (li → p) — lift a list item OUT of its list as a sibling <p>.
//     A sole item dissolves the list. Edge items lift before/after the list. Middle
//     items split the list into before/after lists around the paragraph. The item
//     must hold inline/text content only (a <p> cannot contain block children), and
//     the list's parent must accept both <p> and list siblings.
//
// Three outcomes on purpose — the UI binds to all three:
//   'ok'      — an applicable intent the host can apply.
//   'noop'    — well-formed but already in the target state (e.g. "make ordered" on an
//               <ol>). The control stays enabled; applying it is a safe no-op.
//   'invalid' — refused, with a code + reason for a disabled-with-reason control.
// Mirrors validity.ts's enabled/reason split and range-ops' explicit reject codes.

import { childElements, childrenNamed } from '../cst/query';
import { listNameForStyle, listStyle, type ListStyle } from '../cst/list-style';
import type { ElementNode } from '../cst/types';
import type { DocIndex, FocusState } from './validity';

export type { FocusState } from './validity';

export type TransformType =
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
  | 'noteContentToParagraph'
  | 'noteContentToUnorderedList'
  | 'noteContentToOrderedList'
  | 'noteContentToAlphabeticList'
  | 'noteContentToLines'
  | 'noteContentToCodeblock'
  | 'paragraphToItem'
  | 'itemToParagraph';

export type TransformRejectCode =
  | 'no-focus'
  | 'unknown-id'
  | 'wrong-kind'
  | 'no-adjacent-list'
  | 'block-content'
  | 'unsupported-parent'
  | 'orphan-item';

interface TransformBase {
  transform: TransformType;
}

/** Rename a <ul>↔<ol> in place (identical content models → always structure-safe). */
export interface ListKindIntent extends TransformBase {
  status: 'ok';
  transform: 'toOrderedList' | 'toUnorderedList' | 'toAlphabeticList';
  targetId: string;
  from: 'ul' | 'ol';
  to: 'ul' | 'ol';
  listStyle: ListStyle;
}

/** Move a <p> into an adjacent list as a new <li> adopting the paragraph's children. */
export interface ParagraphToItemIntent extends TransformBase {
  status: 'ok';
  transform: 'paragraphToItem';
  paragraphId: string;
  listId: string;
  mergeListId?: string;
  listKind: 'ul' | 'ol';
  /** Where the new <li> lands in the adjacent list. */
  position: 'append' | 'prepend' | 'merge-between';
}

/** Wrap a <p> in a fresh <ul>/<ol> with one <li> adopting the paragraph's children. */
export interface ParagraphToListIntent extends TransformBase {
  status: 'ok';
  transform: 'paragraphToOrderedList' | 'paragraphToUnorderedList' | 'paragraphToAlphabeticList';
  paragraphId: string;
  listKind: 'ul' | 'ol';
  listStyle: ListStyle;
}

/** Convert a <p> into a structural block selected from the Structure toolbar. */
export interface ParagraphToBlockIntent extends TransformBase {
  status: 'ok';
  transform: 'paragraphToSection' | 'paragraphToNote' | 'paragraphToCodeblock';
  paragraphId: string;
  blockKind: 'section' | 'note' | 'codeblock';
}

/** Convert a <lines> block into another valid block shape at the same position. */
export interface LinesToBlockIntent extends TransformBase {
  status: 'ok';
  transform:
    | 'linesToParagraph'
    | 'linesToUnorderedList'
    | 'linesToOrderedList'
    | 'linesToAlphabeticList'
    | 'linesToSection'
    | 'linesToNote'
    | 'linesToCodeblock';
  linesId: string;
  blockKind: 'p' | 'ul' | 'ol' | 'section' | 'note' | 'codeblock';
  listStyle?: ListStyle;
}

/** Wrap direct <entry> content in a valid table-cell block. */
export interface EntryToBlockIntent extends TransformBase {
  status: 'ok';
  transform:
    | 'entryToParagraph'
    | 'entryToUnorderedList'
    | 'entryToOrderedList'
    | 'entryToAlphabeticList'
    | 'entryToLines'
    | 'entryToNote'
    | 'entryToCodeblock';
  entryId: string;
  wrapperKind: 'p' | 'ul' | 'ol' | 'lines' | 'note' | 'codeblock';
  listStyle?: ListStyle;
}

/** Wrap the focused direct-text/phrase run inside a note at its current position. */
export interface NoteContentToBlockIntent extends TransformBase {
  status: 'ok';
  transform:
    | 'noteContentToParagraph'
    | 'noteContentToUnorderedList'
    | 'noteContentToOrderedList'
    | 'noteContentToAlphabeticList'
    | 'noteContentToLines'
    | 'noteContentToCodeblock';
  noteId: string;
  blockKind: 'p' | 'ul' | 'ol' | 'lines' | 'codeblock';
  listStyle?: ListStyle;
}

/** Lift a <li> out of its list as a sibling <p> (or dissolve a single-item list). */
export interface ItemToParagraphIntent extends TransformBase {
  status: 'ok';
  transform: 'itemToParagraph';
  itemId: string;
  listId: string;
  /** Container that receives the new <p> (the list's parent). */
  parentId: string;
  /** dissolve-list: sole item → the whole <ul>/<ol> becomes the <p>.
   *  lift-before/after: the <p> is placed just before/after the list.
   *  split-list: a middle item becomes a paragraph between before/after lists. */
  mode: 'dissolve-list' | 'lift-before' | 'lift-after' | 'split-list';
}

export type TransformIntent =
  | ListKindIntent
  | ParagraphToItemIntent
  | ParagraphToListIntent
  | ParagraphToBlockIntent
  | LinesToBlockIntent
  | EntryToBlockIntent
  | NoteContentToBlockIntent
  | ItemToParagraphIntent;

export interface TransformNoop extends TransformBase {
  status: 'noop';
  reason: string;
}

export interface TransformInvalid extends TransformBase {
  status: 'invalid';
  code: TransformRejectCode;
  reason: string;
}

export type TransformResult = TransformIntent | TransformNoop | TransformInvalid;

// Conservative allowlist of containers known to accept a block <p> alongside a list,
// grounded in the corpus (lists occur in body / li / entry) plus <section>, the
// canonical DITA block container. An unrecognised parent is REFUSED rather than
// guessed valid — this core never speculates a content model it cannot verify.
const PARENT_ACCEPTS_P = new Set(['body', 'conbody', 'refbody', 'li', 'entry', 'section', 'note']);
const PARENT_ACCEPTS_LIST = new Set(['body', 'conbody', 'refbody', 'li', 'entry', 'section', 'note']);
const PARENT_ACCEPTS_SECTION = new Set(['body', 'conbody', 'refbody']);
const PARENT_ACCEPTS_BLOCK = new Set(['body', 'conbody', 'refbody', 'section', 'li', 'entry']);

// DITA BLOCK elements that cannot legally appear inside a <p>. When a <li> becomes a
// <p> it adopts the item's children, so the item is refused only if it holds one of
// these. Inline/phrase/link/image content (<b>, <i>, <ph>, <xref>, <uicontrol>,
// <codeph>, <image>, …) IS valid paragraph content and must stay enabled. We denylist
// blocks (a small, well-bounded set) rather than allowlist inline (an open-ended set),
// the inverse of PARENT_ACCEPTS_P's cardinality — an unlisted child is treated as
// inline. The corpus has no inline markup today, but DITA permits it and this gate
// must not disable the common rich-text list item.
const BLOCK_CHILDREN = new Set([
  // lists
  'ul', 'ol', 'sl', 'dl',
  // block content
  'p', 'lq', 'note', 'fig', 'pre', 'lines', 'codeblock', 'msgblock', 'screen',
  // tables
  'table', 'simpletable',
  // sectioning / divisions (defensive — malformed nesting)
  'section', 'example', 'bodydiv', 'sectiondiv', 'div',
  // task model
  'steps', 'steps-unordered', 'substeps', 'step', 'stepsection', 'cmd',
]);

function hasBlockChild(el: ElementNode): boolean {
  return childElements(el).some((c) => BLOCK_CHILDREN.has(c.name));
}

function noop(transform: TransformType, reason: string): TransformNoop {
  return { status: 'noop', transform, reason };
}

function invalid(
  transform: TransformType,
  code: TransformRejectCode,
  reason: string,
): TransformInvalid {
  return { status: 'invalid', transform, code, reason };
}

function reverseIds(idx: DocIndex): Map<ElementNode, string> {
  const rev = new Map<ElementNode, string>();
  for (const [id, el] of idx.byId) rev.set(el, id);
  return rev;
}

function isList(el: ElementNode | undefined): el is ElementNode {
  return !!el && (el.name === 'ul' || el.name === 'ol');
}

function sameAttrs(a: ElementNode, b: ElementNode): boolean {
  if (a.attrs.length !== b.attrs.length) return false;
  return a.attrs.every((attr, i) => {
    const other = b.attrs[i];
    return attr.name === other.name && attr.value === other.value && attr.quote === other.quote;
  });
}

/**
 * Plan `transform` for the element currently in focus, given the parsed document.
 * Pure: never mutates `idx` or its document.
 */
export function planTransform(
  transform: TransformType,
  focus: FocusState,
  idx: DocIndex,
): TransformResult {
  if (focus.id == null) return invalid(transform, 'no-focus', 'Nothing is in focus');
  const el = idx.byId.get(focus.id);
  if (!el) return invalid(transform, 'unknown-id', 'Focused element was not found');
  const rev = reverseIds(idx);

  switch (transform) {
    case 'toOrderedList':
      return planListKind(transform, el, rev, 'ordered');
    case 'toUnorderedList':
      return planListKind(transform, el, rev, 'unordered');
    case 'toAlphabeticList':
      return planListKind(transform, el, rev, 'alpha');
    case 'paragraphToItem':
      return planParagraphToItem(el, rev);
    case 'paragraphToOrderedList':
      return planParagraphToList(transform, el, rev, 'ordered');
    case 'paragraphToUnorderedList':
      return planParagraphToList(transform, el, rev, 'unordered');
    case 'paragraphToAlphabeticList':
      return planParagraphToList(transform, el, rev, 'alpha');
    case 'paragraphToSection':
      return planParagraphToBlock(transform, el, rev, 'section');
    case 'paragraphToNote':
      return planParagraphToBlock(transform, el, rev, 'note');
    case 'paragraphToCodeblock':
      return planParagraphToBlock(transform, el, rev, 'codeblock');
    case 'linesToParagraph':
      return planLinesToBlock(transform, el, rev, 'p');
    case 'linesToUnorderedList':
      return planLinesToBlock(transform, el, rev, 'ul');
    case 'linesToOrderedList':
      return planLinesToBlock(transform, el, rev, 'ol', 'ordered');
    case 'linesToAlphabeticList':
      return planLinesToBlock(transform, el, rev, 'ol', 'alpha');
    case 'linesToSection':
      return planLinesToBlock(transform, el, rev, 'section');
    case 'linesToNote':
      return planLinesToBlock(transform, el, rev, 'note');
    case 'linesToCodeblock':
      return planLinesToBlock(transform, el, rev, 'codeblock');
    case 'entryToParagraph':
      return planEntryToBlock(transform, el, rev, 'p');
    case 'entryToUnorderedList':
      return planEntryToBlock(transform, el, rev, 'ul');
    case 'entryToOrderedList':
      return planEntryToBlock(transform, el, rev, 'ol', 'ordered');
    case 'entryToAlphabeticList':
      return planEntryToBlock(transform, el, rev, 'ol', 'alpha');
    case 'entryToLines':
      return planEntryToBlock(transform, el, rev, 'lines');
    case 'entryToNote':
      return planEntryToBlock(transform, el, rev, 'note');
    case 'entryToCodeblock':
      return planEntryToBlock(transform, el, rev, 'codeblock');
    case 'noteContentToParagraph':
      return planNoteContentToBlock(transform, el, rev, 'p');
    case 'noteContentToUnorderedList':
      return planNoteContentToBlock(transform, el, rev, 'ul', 'unordered');
    case 'noteContentToOrderedList':
      return planNoteContentToBlock(transform, el, rev, 'ol', 'ordered');
    case 'noteContentToAlphabeticList':
      return planNoteContentToBlock(transform, el, rev, 'ol', 'alpha');
    case 'noteContentToLines':
      return planNoteContentToBlock(transform, el, rev, 'lines');
    case 'noteContentToCodeblock':
      return planNoteContentToBlock(transform, el, rev, 'codeblock');
    case 'itemToParagraph':
      return planItemToParagraph(el, rev);
  }
}

function planNoteContentToBlock(
  transform: NoteContentToBlockIntent['transform'],
  el: ElementNode,
  rev: Map<ElementNode, string>,
  blockKind: NoteContentToBlockIntent['blockKind'],
  listStyle?: ListStyle,
): TransformResult {
  if (el.name !== 'note') {
    return invalid(transform, 'wrong-kind', 'This action needs direct note content in focus');
  }
  return {
    status: 'ok',
    transform,
    noteId: rev.get(el) as string,
    blockKind,
    listStyle,
  };
}

function planListKind(
  transform: 'toOrderedList' | 'toUnorderedList' | 'toAlphabeticList',
  el: ElementNode,
  rev: Map<ElementNode, string>,
  toStyle: ListStyle,
): TransformResult {
  if (!isList(el)) {
    return invalid(transform, 'wrong-kind', 'This action needs a list (ul/ol) in focus');
  }
  if (listStyle(el) === toStyle) {
    const reason = toStyle === 'alpha'
      ? 'List is already alphabetic'
      : toStyle === 'ordered'
        ? 'List is already numbered'
        : 'List is already unordered';
    return noop(transform, reason);
  }
  const to = listNameForStyle(toStyle);
  return {
    status: 'ok',
    transform,
    targetId: rev.get(el) as string,
    from: el.name as 'ul' | 'ol',
    to,
    listStyle: toStyle,
  };
}

function planParagraphToItem(
  el: ElementNode,
  rev: Map<ElementNode, string>,
): TransformResult {
  const T = 'paragraphToItem' as const;
  if (el.name !== 'p') return invalid(T, 'wrong-kind', 'This action needs a paragraph in focus');

  const parent = el.parent ?? null;
  const sibs = parent ? childElements(parent) : [];
  const i = sibs.indexOf(el);
  const prev = sibs[i - 1];
  const next = sibs[i + 1];

  if (isList(prev) && isList(next) && prev.name === next.name && sameAttrs(prev, next)) {
    return {
      status: 'ok',
      transform: T,
      paragraphId: rev.get(el) as string,
      listId: rev.get(prev) as string,
      mergeListId: rev.get(next) as string,
      listKind: prev.name as 'ul' | 'ol',
      position: 'merge-between',
    };
  }

  // Prefer appending to a preceding list; otherwise prepend to a following one.
  let list: ElementNode | undefined;
  let position: 'append' | 'prepend' | undefined;
  if (isList(prev)) {
    list = prev;
    position = 'append';
  } else if (isList(next)) {
    list = next;
    position = 'prepend';
  }
  if (!list || !position) {
    return invalid(T, 'no-adjacent-list', 'Convert to list item needs an adjacent list to join');
  }

  return {
    status: 'ok',
    transform: T,
    paragraphId: rev.get(el) as string,
    listId: rev.get(list) as string,
    listKind: list.name as 'ul' | 'ol',
    position,
  };
}

function planParagraphToList(
  transform: 'paragraphToOrderedList' | 'paragraphToUnorderedList' | 'paragraphToAlphabeticList',
  el: ElementNode,
  rev: Map<ElementNode, string>,
  listStyle: ListStyle,
): TransformResult {
  if (el.name !== 'p') return invalid(transform, 'wrong-kind', 'This action needs a paragraph in focus');
  const parent = el.parent ?? null;
  if (!parent || !PARENT_ACCEPTS_LIST.has(parent.name)) {
    return invalid(
      transform,
      'unsupported-parent',
      `A list is not allowed in <${parent ? parent.name : '?'}>`,
    );
  }
  return {
    status: 'ok',
    transform,
    paragraphId: rev.get(el) as string,
    listKind: listNameForStyle(listStyle),
    listStyle,
  };
}

function planParagraphToBlock(
  transform: 'paragraphToSection' | 'paragraphToNote' | 'paragraphToCodeblock',
  el: ElementNode,
  rev: Map<ElementNode, string>,
  blockKind: 'section' | 'note' | 'codeblock',
): TransformResult {
  if (el.name !== 'p') return invalid(transform, 'wrong-kind', 'This action needs a paragraph in focus');
  const parent = el.parent ?? null;
  const allowed = blockKind === 'section'
    ? !!parent && PARENT_ACCEPTS_SECTION.has(parent.name)
    : !!parent && (
      PARENT_ACCEPTS_BLOCK.has(parent.name) ||
      (blockKind === 'codeblock' && parent.name === 'note')
    );
  if (!allowed) {
    return invalid(
      transform,
      'unsupported-parent',
      `<${blockKind}> is not allowed in <${parent ? parent.name : '?'}>`,
    );
  }
  return {
    status: 'ok',
    transform,
    paragraphId: rev.get(el) as string,
    blockKind,
  };
}

function parentAllowsLinesTarget(parent: ElementNode | null, blockKind: LinesToBlockIntent['blockKind']): boolean {
  if (!parent) return false;
  if (blockKind === 'p') return PARENT_ACCEPTS_P.has(parent.name);
  if (blockKind === 'ul' || blockKind === 'ol') return PARENT_ACCEPTS_LIST.has(parent.name);
  if (blockKind === 'section') return PARENT_ACCEPTS_SECTION.has(parent.name);
  return PARENT_ACCEPTS_BLOCK.has(parent.name);
}

function planLinesToBlock(
  transform: LinesToBlockIntent['transform'],
  el: ElementNode,
  rev: Map<ElementNode, string>,
  blockKind: LinesToBlockIntent['blockKind'],
  targetListStyle?: ListStyle,
): TransformResult {
  if (el.name !== 'lines') return invalid(transform, 'wrong-kind', 'This action needs a lines block in focus');
  const parent = el.parent ?? null;
  if (!parentAllowsLinesTarget(parent, blockKind)) {
    return invalid(
      transform,
      'unsupported-parent',
      `<${blockKind}> is not allowed in <${parent ? parent.name : '?'}>`,
    );
  }
  return {
    status: 'ok',
    transform,
    linesId: rev.get(el) as string,
    blockKind,
    listStyle: blockKind === 'ul' || blockKind === 'ol' ? targetListStyle ?? (blockKind === 'ul' ? 'unordered' : 'ordered') : undefined,
  };
}

function planItemToParagraph(
  el: ElementNode,
  rev: Map<ElementNode, string>,
): TransformResult {
  const T = 'itemToParagraph' as const;
  if (el.name !== 'li') return invalid(T, 'wrong-kind', 'This action needs a list item in focus');

  const list = el.parent ?? null;
  if (!isList(list ?? undefined)) {
    return invalid(T, 'orphan-item', 'List item is not inside a list');
  }
  // The new <p> adopts the item's children: refuse only if the item holds a true
  // block child (nested list/p/table/…). Inline/phrase/image content is valid <p>
  // content and stays enabled — see BLOCK_CHILDREN.
  if (hasBlockChild(el)) {
    return invalid(T, 'block-content', 'Item contains block content that cannot become a paragraph');
  }
  const container = (list as ElementNode).parent ?? null;
  if (!container || !PARENT_ACCEPTS_P.has(container.name)) {
    return invalid(
      T,
      'unsupported-parent',
      `A paragraph is not allowed in <${container ? container.name : '?'}>`,
    );
  }
  if (!PARENT_ACCEPTS_LIST.has(container.name)) {
    return invalid(
      T,
      'unsupported-parent',
      `A split list is not allowed in <${container.name}>`,
    );
  }

  const items = childrenNamed(list as ElementNode, 'li');
  const pos = items.indexOf(el);
  let mode: ItemToParagraphIntent['mode'];
  if (items.length === 1) mode = 'dissolve-list';
  else if (pos === 0) mode = 'lift-before';
  else if (pos === items.length - 1) mode = 'lift-after';
  else mode = 'split-list';

  return {
    status: 'ok',
    transform: T,
    itemId: rev.get(el) as string,
    listId: rev.get(list as ElementNode) as string,
    parentId: rev.get(container) as string,
    mode,
  };
}

function onlyBlockChild(el: ElementNode): ElementNode | null {
  const blocks = childElements(el).filter((c) => BLOCK_CHILDREN.has(c.name));
  if (blocks.length !== 1) return null;
  const only = blocks[0];
  const hasOtherContent = el.children.some((child) => {
    if (child === only) return false;
    return child.type !== 'text' || (child.newText ?? child.raw).trim() !== '';
  });
  return hasOtherContent ? null : only;
}

function onlyBlockChildKind(el: ElementNode): string | null {
  return onlyBlockChild(el)?.name ?? null;
}

function planEntryToBlock(
  transform: EntryToBlockIntent['transform'],
  el: ElementNode,
  rev: Map<ElementNode, string>,
  wrapperKind: EntryToBlockIntent['wrapperKind'],
  targetListStyle?: ListStyle,
): TransformResult {
  if (el.name !== 'entry') return invalid(transform, 'wrong-kind', 'This action needs a table cell in focus');
  const currentKind = onlyBlockChildKind(el);
  const desiredStyle = wrapperKind === 'ul' || wrapperKind === 'ol'
    ? targetListStyle ?? (wrapperKind === 'ul' ? 'unordered' : 'ordered')
    : undefined;
  const currentBlock = onlyBlockChild(el);
  if (currentKind === wrapperKind && (!desiredStyle || (currentBlock && listStyle(currentBlock) === desiredStyle))) {
    return noop(transform, desiredStyle === 'alpha' ? 'Cell content is already an alphabetic list' : `Cell content is already a <${wrapperKind}>`);
  }
  if (currentKind !== null) {
    return {
      status: 'ok',
      transform,
      entryId: rev.get(el) as string,
      wrapperKind,
      listStyle: desiredStyle,
    };
  }
  if (hasBlockChild(el)) {
    return invalid(
      transform,
      'block-content',
      'Cell contains multiple or mixed block content that cannot be converted as one unit',
    );
  }
  return {
    status: 'ok',
    transform,
    entryId: rev.get(el) as string,
    wrapperKind,
    listStyle: desiredStyle,
  };
}

/** Which transforms are immediately applicable (status 'ok') for this focus —
 *  excludes 'noop' and 'invalid'. Deterministic, possibly empty. */
export function availableTransforms(focus: FocusState, idx: DocIndex): TransformType[] {
  const all: TransformType[] = [
    'toOrderedList',
    'toUnorderedList',
    'toAlphabeticList',
    'paragraphToOrderedList',
    'paragraphToUnorderedList',
    'paragraphToAlphabeticList',
    'paragraphToSection',
    'paragraphToNote',
    'paragraphToCodeblock',
    'linesToParagraph',
    'linesToUnorderedList',
    'linesToOrderedList',
    'linesToAlphabeticList',
    'linesToSection',
    'linesToNote',
    'linesToCodeblock',
    'entryToParagraph',
    'entryToUnorderedList',
    'entryToOrderedList',
    'entryToAlphabeticList',
    'entryToLines',
    'entryToNote',
    'entryToCodeblock',
    'noteContentToParagraph',
    'noteContentToUnorderedList',
    'noteContentToOrderedList',
    'noteContentToAlphabeticList',
    'noteContentToLines',
    'noteContentToCodeblock',
    'paragraphToItem',
    'itemToParagraph',
  ];
  return all.filter((t) => planTransform(t, focus, idx).status === 'ok');
}
