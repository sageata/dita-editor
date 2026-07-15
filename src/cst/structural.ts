// Structural edits (add/remove table rows, list items, paragraphs) over the CST.
// Built on the same surgical primitives as text edits: new nodes are synthetic
// (reconstructed), everything untouched is sliced verbatim, so the on-disk diff
// stays minimal. New rows/items mirror their sibling's indentation.

import { parse } from './parse';
import { serialize } from './serialize';
import { insertNode, makeElement, makeRawText, markDirty, setAttr } from './edit';
import { childElements, childrenNamed } from './query';
import { assignElementIds, findElementById } from './element-ids';
import { mergeRight, mergeDown, mergeLeft, mergeUp, splitCell } from './table-merge';
import { computeGrid, gridCellFor, isGridValid } from './table-grid';
import { joinTextBlocks, pasteBlocksIntoTextBlock, splitTextBlock } from './text-block-structural';
import { listAttrsForStyle, listNameForStyle, listStyle, nextNestedListStyle } from './list-style';
import {
  appendChild,
  insertAfter,
  insertBefore,
  leadingWsOfFirstNamed,
  removeWithLeadingWs,
  trailingWs,
} from './tree-edit';
import type { CstNode, Document, ElementNode } from './types';

export { applyTransform, type TransformSpec } from './transform-apply';

export type StructuralOp =
  | 'addRowAfter'
  | 'addRowBefore'
  | 'deleteRow'
  | 'addItemAfter'
  | 'deleteItem'
  | 'addParaAfter'
  | 'deletePara'
  | 'addColumnAfter'
  | 'addColumnBefore'
  | 'deleteColumn'
  | 'mergeRight'
  | 'mergeDown'
  | 'mergeLeft'
  | 'mergeUp'
  | 'splitCell'
  | 'promoteRowToHeader'
  | 'demoteRowFromHeader'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'addTableTitle'
  | 'split'
  | 'pasteBlocks'
  | 'join'
  | 'deleteTable'
  | 'deleteList'
  | 'deleteFig'
  | 'deleteImage'
  | 'deleteTitle'
  | 'deleteElement'
  | 'indentItem'
  | 'outdentItem'
  | 'moveBefore'
  | 'moveAfter';

/** Topic-root elements whose <title> is REQUIRED (so it can never be deleted). A
 *  <title> inside table/fig/section is OPTIONAL and therefore deletable. Defined
 *  locally so cst never depends on the render layer (which keeps a narrower copy). */
const TOPIC_ROOTS = new Set([
  'topic',
  'concept',
  'task',
  'reference',
  'glossentry',
  'glossgroup',
]);

// --- Universal, category-driven deletion guard -----------------------------
//
// One content-model gate for "delete the selected element" (StructuralOp
// 'deleteElement'). It encodes the DITA occurrence rules by CATEGORY so any
// element either deletes or refuses-with-reason, replacing per-kind special-
// casing. The existing per-kind ops (deletePara/Item/Table/…) are unchanged;
// this is additive and is the SINGLE SOURCE OF TRUTH (validity.ts reuses it).
//
// The CST tracks only tag names (no @class / specialization is recorded on the
// nodes), so categories group tag NAMES rather than class bases.

/** Parents whose only child of a given kind is required: a list keeps ≥1 <li>. */
const LIST_PARENTS = new Set(['ul', 'ol']);
/** Mixed-content parents that do NOT require a block-level child — a <li>, <entry>, or
 *  <note> may hold just text (or be empty), so deleting its only block is allowed. */
const OPTIONAL_BLOCK_PARENTS = new Set(['li', 'entry', 'note']);
/** CALS row sections that keep ≥1 <row> (thead/tbody are (row)+). */
const ROW_SECTIONS = new Set(['thead', 'tbody']);
/** Block-level element names: a (block)+ container (body/section/conbody/cell/…)
 *  must keep at least one of these. Notably EXCLUDES <image> (optional in every
 *  container) and <title> (handled by the required-singleton rule), so deleting
 *  them is never blocked by the sole-block guard. */
const BLOCK_LEVEL = new Set([
  'p',
  'ul',
  'ol',
  'dl',
  'sl',
  'table',
  'simpletable',
  'fig',
  'section',
  'lines',
  'pre',
  'note',
  'codeblock',
]);

export interface DeleteCheck {
  canDelete: boolean;
  reason?: string;
}

const INLINE_JOIN_TARGETS = new Set(['p', 'li', 'title', 'shortdesc', 'note', 'cmd']);
const PLAIN_JOIN_TARGETS = new Set(['lines', 'codeblock']);
const JOIN_INLINE_CHILDREN = new Set(['b', 'i', 'u', 'codeph', 'sub', 'sup', 'tt', 'line-through', 'overline', 'xref', 'ph']);

function hasJoinableInlineContent(el: ElementNode): boolean {
  return el.children.every((child) => child.type === 'text' || (child.type === 'element' && (
    JOIN_INLINE_CHILDREN.has(child.name) || (el.name === 'li' && (child.name === 'ul' || child.name === 'ol'))
  )));
}

function hasPlainTextContent(el: ElementNode): boolean {
  return el.children.every((child) => child.type === 'text');
}

function soleItemListWrapperBefore(current: ElementNode, previous: ElementNode): ElementNode | null {
  const list = current.parent;
  if (!list || (list.name !== 'ul' && list.name !== 'ol') || childElements(list).length !== 1) return null;
  if (list.attrs.length > 0 || current.attrs.length > 0) return null;
  if (list.children.some((child) => child !== current && (
    child.type !== 'text' || (child.newText ?? child.raw).trim() !== ''
  ))) return null;
  if (current.children.some((child) => child.type === 'element' && (child.name === 'ul' || child.name === 'ol'))) return null;
  const container = list.parent;
  if (!container || previous.parent !== container) return null;
  const siblings = childElements(container);
  return siblings[siblings.indexOf(list) - 1] === previous ? list : null;
}

export function canJoinTextBlocks(current: ElementNode, previous: ElementNode | null): DeleteCheck {
  const parent = current.parent ?? null;
  if (!parent || !previous) {
    return { canDelete: false, reason: 'The previous text element is not an adjacent sibling' };
  }
  const wrapper = soleItemListWrapperBefore(current, previous);
  const siblings = childElements(parent);
  if (!wrapper && (previous.parent !== parent || siblings[siblings.indexOf(current) - 1] !== previous)) {
    return { canDelete: false, reason: 'The previous text element is not an adjacent sibling' };
  }
  const currentInline = INLINE_JOIN_TARGETS.has(current.name);
  const previousInline = INLINE_JOIN_TARGETS.has(previous.name);
  const currentPlain = PLAIN_JOIN_TARGETS.has(current.name);
  const previousPlain = PLAIN_JOIN_TARGETS.has(previous.name);
  if ((!currentInline && !currentPlain) || (!previousInline && !previousPlain)) {
    return { canDelete: false, reason: 'These element types cannot be joined as text' };
  }
  if (!wrapper && (current.name === 'li' || previous.name === 'li') && (current.name !== 'li' || previous.name !== 'li')) {
    return { canDelete: false, reason: 'A list item can only join the preceding item in the same list' };
  }
  if ((currentPlain || previousPlain) && (!hasPlainTextContent(current) || !hasPlainTextContent(previous))) {
    return { canDelete: false, reason: 'Rich inline content cannot be merged into a plain-text block' };
  }
  if (!currentPlain && !hasJoinableInlineContent(current)) {
    return { canDelete: false, reason: 'The current element contains content that cannot be joined safely' };
  }
  if (!previousPlain && !hasJoinableInlineContent(previous)) {
    return { canDelete: false, reason: 'The previous element contains content that cannot be joined safely' };
  }
  return wrapper ? canDeleteElement(wrapper, wrapper.parent ?? null) : canDeleteElement(current, parent);
}

/** Can `el` (with the given `parent`) be deleted on its own without violating the
 *  DITA content model? Pure: reads the CST only. Categories, in priority order:
 *   - entry (CALS cell): never deletable alone — delete its row/column instead.
 *   - REQUIRED_SINGLETONS: a <title> directly under a topic root is required.
 *   - MIN_ONE_IN_PARENT: the last <li> of a list / last <row> of a section.
 *   - SOLE_BLOCK: a block-level element that is its parent's only block-level child.
 *   - otherwise deletable. */
export function canDeleteElement(el: ElementNode, parent: ElementNode | null): DeleteCheck {
  if (!parent) return { canDelete: false, reason: 'Cannot delete the document root' };

  // A table cell carries CALS geometry (col-count / spans); removing one on its
  // own would corrupt the grid, so it is never independently deletable.
  if (el.name === 'entry') {
    return {
      canDelete: false,
      reason: "A table cell can't be deleted on its own — delete its row or column instead.",
    };
  }

  // REQUIRED_SINGLETONS: a <title> inside a topic root is mandatory. (A <title> in
  // an OPTIONAL container — table/fig/section — falls through and stays deletable.)
  if (el.name === 'title' && TOPIC_ROOTS.has(parent.name)) {
    return { canDelete: false, reason: `Cannot delete the required <title> of a <${parent.name}>` };
  }

  // A list's SOLE <li>: deleting it would leave an invalid empty list, so the delete
  // CASCADES to removing the whole (would-be-empty) list. Defer to whether THE LIST is
  // deletable — a nested sublist inside an <li> is (mixed content); a top-level list that
  // is the sole block of a required container is not (and surfaces the list's own reason).
  if (el.name === 'li' && LIST_PARENTS.has(parent.name)) {
    if (childrenNamed(parent, 'li').length <= 1) {
      return canDeleteElement(parent, parent.parent ?? null);
    }
    return { canDelete: true };
  }
  if (el.name === 'row' && ROW_SECTIONS.has(parent.name)) {
    if (childrenNamed(parent, 'row').length <= 1) {
      return { canDelete: false, reason: `Cannot delete the only <row> in <${parent.name}>` };
    }
    return { canDelete: true };
  }

  // SOLE_BLOCK: a (block)+ container must keep one block-level child — refuse when this
  // block is the parent's only block-level child. EXEMPT <li>/<entry>: they are mixed
  // models (text allowed, no required block), so deleting their only block is valid.
  if (BLOCK_LEVEL.has(el.name) && !OPTIONAL_BLOCK_PARENTS.has(parent.name)) {
    const blocks = childElements(parent).filter((c) => BLOCK_LEVEL.has(c.name));
    if (blocks.length <= 1) {
      return { canDelete: false, reason: `Cannot delete the only block in <${parent.name}>` };
    }
    return { canDelete: true };
  }

  return { canDelete: true };
}

/** Extra data carried by split/join/paste, computed client-side from the live DOM so
 *  the host never has to decode entities for the surrounding editable text. */
export interface StructuralPayload {
  /** split: decoded text kept in the original element. */
  prefix?: string;
  /** split: decoded text moved into the new sibling. */
  suffix?: string;
  /** split: inline HTML kept in the original element, when splitting rich inline content. */
  prefixHtml?: string;
  /** split: inline HTML moved into the new sibling, when splitting rich inline content. */
  suffixHtml?: string;
  /** join: element id to merge the current element's text into. */
  prevId?: string;
  /** join: combined decoded text for the merge target. */
  merged?: string;
  /** join: combined inline HTML for the merge target, when joining rich inline content. */
  mergedHtml?: string;
  /** join: caret offset (decoded chars) within the merged text. */
  boundary?: number;
  /** pasteBlocks: sanitized inline-HTML snippets for each pasted block. */
  blocks?: string[];
  /** indent/outdent: caret offset (decoded chars) to preserve in the moved item. */
  caret?: number;
  /** moveBefore/moveAfter: id of the SAME-PARENT sibling to move next to. */
  refId?: string;
}

export interface StructuralResult {
  source: string;
  /** Edit id of the element to focus after re-render (the new sibling for an
   *  add/split, the merge target for a join), or null for deletes. Matches the
   *  id render will re-assign after re-parse. */
  focusId: string | null;
  /** Caret offset (decoded chars) to place inside the focused element, or null. */
  caretOffset: number | null;
}

export function applyStructuralEdit(
  source: string,
  op: StructuralOp,
  id: string,
  payload: StructuralPayload = {},
): StructuralResult {
  const doc = parse(source);
  const el = findElementById(doc, id);
  if (!el) throw new Error(`structural target not found: ${id}`);

  let focusEl: ElementNode | null = null;
  let caretOffset: number | null = null;
  switch (op) {
    case 'addRowAfter': {
      const row = makeEmptyRowLike(el);
      insertAfter(el, row);
      focusEl = firstEntry(row);
      caretOffset = 0;
      break;
    }
    case 'addRowBefore': {
      const row = makeEmptyRowLike(el);
      insertBefore(el, row);
      focusEl = firstEntry(row);
      caretOffset = 0;
      break;
    }
    case 'addItemAfter': {
      const li = makeElement('li', [], []);
      insertAfter(el, li);
      focusEl = li;
      caretOffset = 0;
      break;
    }
    case 'addParaAfter': {
      const para = makeElement('p', [], []);
      insertAfter(el, para);
      focusEl = para;
      caretOffset = 0;
      break;
    }
    case 'addColumnAfter': {
      focusEl = addColumnAfter(doc, el);
      caretOffset = 0;
      break;
    }
    case 'addColumnBefore': {
      focusEl = addColumnBefore(doc, el);
      caretOffset = 0;
      break;
    }
    case 'deleteColumn': {
      focusEl = deleteColumn(doc, el);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'mergeRight': {
      focusEl = mergeRight(doc, el);
      break;
    }
    case 'mergeDown': {
      focusEl = mergeDown(doc, el);
      break;
    }
    case 'mergeLeft': {
      focusEl = mergeLeft(doc, el);
      break;
    }
    case 'mergeUp': {
      focusEl = mergeUp(doc, el);
      break;
    }
    case 'promoteRowToHeader': {
      focusEl = promoteRowToHeader(el);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'demoteRowFromHeader': {
      focusEl = demoteRowFromHeader(el);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'moveColumnLeft': {
      focusEl = moveColumn(doc, el, -1);
      caretOffset = payload.caret ?? null;
      break;
    }
    case 'moveColumnRight': {
      focusEl = moveColumn(doc, el, 1);
      caretOffset = payload.caret ?? null;
      break;
    }
    case 'addTableTitle': {
      focusEl = addTableTitle(el);
      caretOffset = 0;
      break;
    }
    case 'splitCell': {
      focusEl = splitCell(doc, el);
      break;
    }
    case 'split': {
      // Same-named sibling carries the suffix; the original keeps the prefix.
      const result = splitTextBlock(el, payload);
      focusEl = result.focusEl;
      caretOffset = result.caretOffset;
      break;
    }
    case 'pasteBlocks': {
      const result = pasteBlocksIntoTextBlock(el, payload);
      focusEl = result.focusEl;
      caretOffset = result.caretOffset;
      break;
    }
    case 'join': {
      const target = payload.prevId ? findElementById(doc, payload.prevId) : null;
      if (!target) throw new Error(`join target not found: ${payload.prevId}`);
      const check = canJoinTextBlocks(el, target);
      if (!check.canDelete) throw new Error(check.reason ?? 'These text elements cannot be joined');
      const result = joinTextBlocks(el, target, payload, soleItemListWrapperBefore(el, target) ?? el);
      focusEl = result.focusEl;
      caretOffset = result.caretOffset;
      break;
    }
    case 'deleteRow':
    case 'deletePara':
      removeWithLeadingWs(el);
      break;
    case 'deleteItem': {
      if (el.name !== 'li') throw new Error(`deleteItem target is <${el.name}>, not <li>`);
      const check = canDeleteElement(el, el.parent ?? null);
      if (!check.canDelete) throw new Error(check.reason ?? 'Cannot delete this list item');
      // Deleting the final item must be one atomic edit: remove its list as well,
      // never serialize the transient invalid shape <ul/> / <ol/>.
      const target = deleteTargetFor(el);
      focusEl = nextOrPrevBlock(target);
      removeWithLeadingWs(target);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'deleteTable':
    case 'deleteList':
    case 'deleteFig': {
      // Whole-block delete: the target IS the table/ul|ol/fig element itself.
      assertBlockDeleteKind(el, op);
      guardNotOnlyBlock(el); // throws (no write) if it is the sole block-level child
      // Caret lands on a usable sibling — the next block, else the previous if it was last.
      focusEl = nextOrPrevBlock(el);
      removeWithLeadingWs(el);
      caretOffset = 0;
      break;
    }
    case 'deleteImage': {
      // The target IS the <image> element. Image is OPTIONAL in every container it
      // appears in (fig/entry/p/…), so there is no "would-empty required child" guard
      // to mirror — it is always deletable. Sliced byte-exact like deletePara.
      if (el.name !== 'image') throw new Error(`deleteImage target is <${el.name}>, not <image>`);
      focusEl = nextOrPrevBlock(el);
      removeWithLeadingWs(el);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'deleteTitle': {
      // Parent-aware: <title> is REQUIRED in a topic root (refuse, no write) and
      // OPTIONAL in table/fig/section (deletable). Focus lands on the next sibling.
      if (el.name !== 'title') throw new Error(`deleteTitle target is <${el.name}>, not <title>`);
      const parent = el.parent;
      if (parent && TOPIC_ROOTS.has(parent.name)) {
        throw new Error(`Cannot delete the required <title> of a <${parent.name}>`);
      }
      focusEl = nextOrPrevBlock(el);
      removeWithLeadingWs(el);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'deleteElement': {
      // Universal delete: the category-driven guard decides whether ANY selected
      // element may be removed. Refuse-with-reason (no write) or byte-exact slice,
      // same primitive as deletePara/deleteImage. canDeleteElement is the single
      // source of truth — validity.ts consults the same function before invoke.
      const check = canDeleteElement(el, el.parent ?? null);
      if (!check.canDelete) throw new Error(check.reason ?? 'Cannot delete this element');
      // CASCADE: deleting a list's sole <li> removes the whole would-be-empty list (which
      // carries that item's nested sublists with it), matching the guard's promotion above.
      const target = deleteTargetFor(el);
      focusEl = nextOrPrevBlock(target);
      removeWithLeadingWs(target);
      caretOffset = focusEl ? 0 : null;
      break;
    }
    case 'indentItem': {
      focusEl = indentItem(el);
      caretOffset = payload.caret ?? null;
      break;
    }
    case 'outdentItem': {
      focusEl = outdentItem(el);
      caretOffset = payload.caret ?? null;
      break;
    }
    case 'moveBefore':
    case 'moveAfter': {
      // Same-parent reorder (IX-1 drag-and-drop / IX-2 Alt+Arrow). The moved
      // element stays a CLEAN node, so its bytes are sliced verbatim into the
      // new position — only the two whitespace seams change.
      if (!payload.refId) throw new Error(`${op} requires a reference sibling id`);
      const ref = findElementById(doc, payload.refId);
      if (!ref) throw new Error(`move reference not found: ${payload.refId}`);
      if (ref === el) throw new Error('cannot move an element next to itself');
      if (ref.parent !== el.parent) {
        throw new Error('Move is limited to siblings in the same container');
      }
      removeWithLeadingWs(el);
      if (op === 'moveBefore') insertBefore(ref, el);
      else insertAfter(ref, el);
      focusEl = el;
      caretOffset = payload.caret ?? null;
      break;
    }
  }

  const focusId = focusEl ? assignElementIds(doc).get(focusEl) ?? null : null;
  return { source: serialize(doc), focusId, caretOffset };
}

function firstEntry(row: ElementNode): ElementNode | null {
  const entry = row.children.find((c) => c.type === 'element' && c.name === 'entry');
  return entry ? (entry as ElementNode) : null;
}

// --- Whole-block deletes (table / list / figure) ---------------------------
//
// The target is the BLOCK element itself (not a child). Removal reuses the same
// removeWithLeadingWs primitive as deletePara, so exactly the element + its own
// leading indentation whitespace is sliced out and everything else stays verbatim.

const BLOCK_DELETE_KINDS: Record<'deleteTable' | 'deleteList' | 'deleteFig', readonly string[]> = {
  deleteTable: ['table'],
  deleteList: ['ul', 'ol'],
  deleteFig: ['fig'],
};

function assertBlockDeleteKind(
  el: ElementNode,
  op: 'deleteTable' | 'deleteList' | 'deleteFig',
): void {
  const allowed = BLOCK_DELETE_KINDS[op];
  if (!allowed.includes(el.name)) {
    throw new Error(`${op} target is <${el.name}>, not ${allowed.map((n) => `<${n}>`).join(' or ')}`);
  }
}

/** A body/section/conbody is (block)+: refuse (no write) deleting the sole block-level
 *  child of its container — mirrors the "Cannot delete every <kind>" occurrence guard. */
function guardNotOnlyBlock(el: ElementNode): void {
  const parent = el.parent;
  if (!parent) throw new Error('cannot delete a top-level node');
  if (childElements(parent).length <= 1) {
    throw new Error('Cannot delete the only block in its container');
  }
}

/** The element a universal delete actually removes: a list's SOLE <li> promotes to the
 *  whole (would-be-empty) list, so deleting the last item removes the list with it. */
function deleteTargetFor(el: ElementNode): ElementNode {
  const parent = el.parent;
  if (
    el.name === 'li' &&
    parent &&
    (parent.name === 'ul' || parent.name === 'ol') &&
    childrenNamed(parent, 'li').length <= 1
  ) {
    return parent;
  }
  return el;
}

/** Focus target after a whole-block delete: the next block sibling, else the previous. */
function nextOrPrevBlock(el: ElementNode): ElementNode | null {
  const parent = el.parent;
  if (!parent) return null;
  const sibs = childElements(parent);
  const i = sibs.indexOf(el);
  return sibs[i + 1] ?? sibs[i - 1] ?? null;
}

/** Remove el plus its immediately-preceding whitespace text, for a clean delete. */
/** Build an empty row matching the column count and indentation of a sibling row. */
function makeEmptyRowLike(row: ElementNode): ElementNode {
  const cols = childrenNamed(row, 'entry').length;
  const entryWs = leadingWsOfFirstNamed(row, 'entry');
  const closeWs = trailingWs(row);
  const children: CstNode[] = [];
  for (let i = 0; i < cols; i++) {
    children.push(makeRawText(entryWs));
    children.push(makeElement('entry', [], []));
  }
  children.push(makeRawText(closeWs));
  return makeElement('row', [], children);
}

// --- Column edits (no-span CALS tables only) -------------------------------
//
// Restricted to tables with NO merged cells: with morerows/namest/nameend a
// row's <entry> count no longer equals @cols (rows are partly covered by spans),
// so a uniform "insert/remove entry at column N in every row" would corrupt the
// geometry. Those tables refuse the op (caller re-renders to resync). Merged-cell
// column editing is a fast-follow, matching the deferred merge/split decision.
//
// colspecs are canonical c1..cN (verified across the corpus); we keep them so by
// REPLACING any colspec whose position changed with a fresh synthetic one, which
// serializes to the exact corpus format `<colspec colname="cN" colnum="N"/>`.

function attrOf(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function tgroupOf(entry: ElementNode): ElementNode {
  let n: ElementNode | null | undefined = entry.parent;
  while (n && n.name !== 'tgroup') n = n.parent;
  if (!n) throw new Error('entry is not inside a tgroup');
  return n;
}

function tableRows(tgroup: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  for (const section of childElements(tgroup)) {
    if (section.name === 'thead' || section.name === 'tbody') {
      rows.push(...childrenNamed(section, 'row'));
    }
  }
  return rows;
}

function hasMergedCells(tgroup: ElementNode): boolean {
  return tableRows(tgroup).some((row) =>
    childrenNamed(row, 'entry').some(
      (e) => attrOf(e, 'namest') || attrOf(e, 'nameend') || attrOf(e, 'morerows'),
    ),
  );
}

function columnIndexOf(entry: ElementNode): number {
  const row = entry.parent;
  if (!row) return -1;
  return childrenNamed(row, 'entry').indexOf(entry);
}

/** Make colname/colnum match each colspec's 1-based position again, updating only
 *  the ones that actually shifted (synthetic ones are already correct). The shift
 *  is applied IN PLACE via setAttr — splicing just the two value spans — so any
 *  extra attrs on the colspec (colwidth, align, …) are preserved. colnum is the
 *  rightmost of the two and updated first, so a digit-count change (c9 -> c10)
 *  never invalidates colname's source offset that setAttr keys off. */
function renumberColspecs(tgroup: ElementNode, source: string): void {
  childrenNamed(tgroup, 'colspec').forEach((cs, i) => {
    if (cs.synthetic) return;
    const colname = `c${i + 1}`;
    const colnum = String(i + 1);
    if (attrOf(cs, 'colname') === colname && attrOf(cs, 'colnum') === colnum) return;
    setAttr(cs, 'colnum', colnum, source);
    setAttr(cs, 'colname', colname, source);
  });
}

function starColumnWidthUnits(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !text.includes('*')) return null;
  const units = text.replace(/\*/g, '').trim();
  const parsed = units === '' ? 1 : Number(units);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatStarColumnWidth(value: number): string {
  const rounded = Math.max(0.05, Math.round(value * 1000) / 1000);
  const text = rounded.toFixed(3).replace(/\.?0+$/, '');
  return `${text}*`;
}

function setColspecWidth(colspec: ElementNode, value: string, source: string): void {
  if (attrOf(colspec, 'colwidth') === value) return;
  if (!colspec.synthetic) {
    setAttr(colspec, 'colwidth', value, source);
    return;
  }
  const existing = colspec.attrs.find((a) => a.name === 'colwidth');
  if (existing) {
    existing.value = value;
  } else {
    colspec.attrs.push({
      name: 'colwidth',
      value,
      quote: '"',
      valueRange: { start: -1, end: -1 },
      range: { start: -1, end: -1 },
    });
  }
  markDirty(colspec);
}

/** Width policy for an inserted column, tuned so OTHER columns never move:
 *  - A table with NO explicit widths stays width-free (browser auto-layout
 *    absorbs the new column; not a single existing byte changes).
 *  - A table WITH star widths keeps its TOTAL: the new column takes
 *    min((A+B)/3, table average) from its two boundary neighbours, which
 *    shrink proportionally to donate it (an edge insert takes half of the
 *    lone neighbour, same cap). Only the neighbours + the new colspec are
 *    touched — distant columns keep their exact widths. */
function seedColumnWidthsAfterAdd(tgroup: ElementNode, inserted: ElementNode, source: string): void {
  const colspecs = childrenNamed(tgroup, 'colspec');
  const insertedIndex = colspecs.indexOf(inserted);
  const others = colspecs.filter((cs) => cs !== inserted);
  const units = others.map((cs) => starColumnWidthUnits(attrOf(cs, 'colwidth')));
  if (!others.length || units.every((u) => u === null)) return; // auto-layout table

  const unitOf = (cs: ElementNode) => starColumnWidthUnits(attrOf(cs, 'colwidth')) ?? 1;
  const total = units.reduce((sum: number, u) => sum + (u ?? 1), 0);
  const avg = total / others.length;
  const left = insertedIndex > 0 ? colspecs[insertedIndex - 1] : null;
  const right = insertedIndex < colspecs.length - 1 ? colspecs[insertedIndex + 1] : null;

  let take: number;
  if (left && right) {
    const a = unitOf(left);
    const b = unitOf(right);
    take = Math.min((a + b) / 3, avg);
    setColspecWidth(left, formatStarColumnWidth(a - take * (a / (a + b))), source);
    setColspecWidth(right, formatStarColumnWidth(b - take * (b / (a + b))), source);
  } else {
    const lone = (left ?? right) as ElementNode;
    const n = unitOf(lone);
    take = Math.min(n / 2, avg);
    setColspecWidth(lone, formatStarColumnWidth(n - take), source);
  }
  setColspecWidth(inserted, formatStarColumnWidth(take), source);
}

function newColspec(num: number): ElementNode {
  return makeElement(
    'colspec',
    [
      { name: 'colname', value: `c${num}` },
      { name: 'colnum', value: String(num) },
    ],
    [],
    true,
  );
}

// Column INSERTS are span-aware (per-boundary): inserting between columns k and
// k+1 is legal unless a namest/nameend span CROSSES that boundary. The grid gives
// every cell's true column range, so covered rows (morerows) and offset entry
// indices are handled; namest/nameend references at or past the insertion point
// are renumbered (+1) so the canonical c1..cN colspecs stay consistent.
// deleteColumn keeps the blanket merged-table refusal (removal under spans is a
// genuinely different problem).

/** Does any cell's horizontal span cross the boundary between columns k and k+1? */
function spanCrossesColumnBoundary(grid: ReturnType<typeof computeGrid>, k: number): boolean {
  return grid.cells.some((c) => c.colStart <= k && c.colEnd > k);
}

/** Insert an empty column so it becomes column k+1 (1-based); `focusRow` picks
 *  which row's fresh entry gets focus. */
function addColumnAt(doc: Document, tgroup: ElementNode, k: number, focusRow: ElementNode | null): ElementNode | null {
  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) throw new Error('cannot edit columns of a malformed table');
  if (spanCrossesColumnBoundary(grid, k)) {
    throw new Error('a merged cell spans across this boundary');
  }

  const cols = Number(attrOf(tgroup, 'cols') ?? '0');

  // Renumber namest/nameend references past the boundary BEFORE colspecs move
  // (values come from the current grid; setAttr splices are per-entry).
  // colnameByNum maps 1-based column -> colname; after the insert every column
  // > k shifts one right, and renumberColspecs restores canonical c1..cN, so the
  // new reference for column n is simply `c{n}`.
  const numByName = new Map<string, number>();
  for (const [num, name] of grid.colnameByNum) numByName.set(name, num);
  for (const row of tableRows(tgroup)) {
    for (const cell of childrenNamed(row, 'entry')) {
      const st = attrOf(cell, 'namest');
      const en = attrOf(cell, 'nameend');
      if (!st && !en) continue;
      // Rightmost attr first so a digit-count change (c9 -> c10) cannot
      // invalidate the other value's source offset (mirrors renumberColspecs).
      if (en) {
        const num = numByName.get(en);
        if (num !== undefined && num > k) setAttr(cell, 'nameend', `c${num + 1}`, doc.source);
      }
      if (st) {
        const num = numByName.get(st);
        if (num !== undefined && num > k) setAttr(cell, 'namest', `c${num + 1}`, doc.source);
      }
    }
  }

  setAttr(tgroup, 'cols', String(cols + 1), doc.source);

  const colspecs = childrenNamed(tgroup, 'colspec');
  const insertedColspec = newColspec(k + 1);
  if (colspecs.length) {
    if (k === 0) insertBefore(colspecs[0], insertedColspec);
    else insertAfter(colspecs[Math.min(k, colspecs.length) - 1], insertedColspec);
    renumberColspecs(tgroup, doc.source);
    seedColumnWidthsAfterAdd(tgroup, insertedColspec, doc.source);
  }

  let focus: ElementNode | null = null;
  for (const row of tableRows(tgroup)) {
    const entries = childrenNamed(row, 'entry');
    if (!entries.length) throw new Error('table rows are inconsistent');
    const fresh = makeElement('entry', [], []);
    // The new cell goes before the first entry that starts past the boundary;
    // rows whose remaining entries are all left of it (covered further right
    // by morerows) append after their last entry.
    const nextEntry = entries.find((e) => {
      const cell = gridCellFor(grid, e);
      return cell !== undefined && cell.colStart > k;
    });
    if (nextEntry) insertBefore(nextEntry, fresh);
    else insertAfter(entries[entries.length - 1], fresh);
    if (row === focusRow) focus = fresh;
  }
  return focus;
}

function addColumnAfter(doc: Document, entry: ElementNode): ElementNode | null {
  const tgroup = tgroupOf(entry);
  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) throw new Error('cannot edit columns of a malformed table');
  const cell = gridCellFor(grid, entry);
  if (!cell) throw new Error('entry is not a direct cell of its row');
  return addColumnAt(doc, tgroup, cell.colEnd, entry.parent as ElementNode);
}

function addColumnBefore(doc: Document, entry: ElementNode): ElementNode | null {
  const tgroup = tgroupOf(entry);
  const grid = computeGrid(tgroup);
  if (!isGridValid(grid)) throw new Error('cannot edit columns of a malformed table');
  const cell = gridCellFor(grid, entry);
  if (!cell) throw new Error('entry is not a direct cell of its row');
  return addColumnAt(doc, tgroup, cell.colStart - 1, entry.parent as ElementNode);
}

function deleteColumn(doc: Document, entry: ElementNode): ElementNode | null {
  const tgroup = tgroupOf(entry);
  if (hasMergedCells(tgroup)) throw new Error('column editing unsupported on merged-cell tables');
  const colIdx = columnIndexOf(entry);
  if (colIdx < 0) throw new Error('entry is not a direct cell of its row');
  const cols = Number(attrOf(tgroup, 'cols') ?? '0');
  if (cols <= 1) throw new Error('cannot delete the only column');
  const row = entry.parent as ElementNode;

  setAttr(tgroup, 'cols', String(cols - 1), doc.source);

  removeWithLeadingWs(childrenNamed(tgroup, 'colspec')[colIdx]);
  renumberColspecs(tgroup, doc.source);

  for (const r of tableRows(tgroup)) {
    const cell = childrenNamed(r, 'entry')[colIdx];
    if (cell) removeWithLeadingWs(cell);
  }

  const remaining = childrenNamed(row, 'entry');
  return remaining[Math.min(colIdx, remaining.length - 1)] ?? null;
}

// --- Header row toggle (thead <-> tbody) ------------------------------------
//
// Promote moves the FIRST tbody row to the end of the thead (creating <thead>
// before <tbody> when absent — CALS order is colspec*, thead?, tbody); demote
// moves the LAST thead row to the front of the tbody, removing a now-row-empty
// <thead> entirely (thead is (row)+, so an empty one may not remain). The row
// node stays CLEAN and moves verbatim, exactly like moveBefore/moveAfter.

function rowSection(row: ElementNode): ElementNode {
  const parent = row.parent;
  if (!parent || !ROW_SECTIONS.has(parent.name)) {
    throw new Error('row is not inside a thead/tbody section');
  }
  return parent;
}

function rowHasVerticalSpan(row: ElementNode): boolean {
  return childrenNamed(row, 'entry').some((e) => attrOf(e, 'morerows'));
}

/** Does a morerows span from an EARLIER row of `section` reach row index `idx`? */
function spanFromAboveReaches(section: ElementNode, idx: number): boolean {
  const rows = childrenNamed(section, 'row');
  for (let r = 0; r < idx; r++) {
    for (const e of childrenNamed(rows[r], 'entry')) {
      const mr = Number(attrOf(e, 'morerows') ?? '0');
      if (Number.isFinite(mr) && r + mr >= idx) return true;
    }
  }
  return false;
}

function promoteRowToHeader(row: ElementNode): ElementNode | null {
  if (row.name !== 'row') throw new Error(`promoteRowToHeader target is <${row.name}>, not <row>`);
  const section = rowSection(row);
  if (section.name !== 'tbody') throw new Error('this row is already a header row');
  const bodyRows = childrenNamed(section, 'row');
  if (bodyRows[0] !== row) throw new Error('only the first body row can become the header row');
  if (bodyRows.length <= 1) throw new Error('cannot make the only body row a header');
  if (rowHasVerticalSpan(row)) {
    throw new Error('cannot move a row with vertical spans across the header boundary');
  }

  const tgroup = section.parent;
  if (!tgroup || tgroup.name !== 'tgroup') throw new Error('tbody is not inside a tgroup');
  const thead = childrenNamed(tgroup, 'thead')[0] ?? null;
  // Capture the tbody's row indentation BEFORE detaching (for a fresh thead).
  const rowWs = leadingWsOfFirstNamed(section, 'row');
  const closeWs = trailingWs(section);
  removeWithLeadingWs(row);
  if (thead) {
    const headRows = childrenNamed(thead, 'row');
    if (headRows.length) insertAfter(headRows[headRows.length - 1], row);
    else appendChild(thead, rowWs, row);
  } else {
    const theadEl = makeElement('thead', [], [makeRawText(rowWs), row, makeRawText(closeWs)]);
    insertBefore(section, theadEl);
  }
  return firstEntry(row);
}

function demoteRowFromHeader(row: ElementNode): ElementNode | null {
  if (row.name !== 'row') throw new Error(`demoteRowFromHeader target is <${row.name}>, not <row>`);
  const section = rowSection(row);
  if (section.name !== 'thead') throw new Error('this row is not a header row');
  const headRows = childrenNamed(section, 'row');
  if (headRows[headRows.length - 1] !== row) {
    throw new Error('only the last header row can move into the body');
  }
  if (rowHasVerticalSpan(row)) {
    throw new Error('cannot move a row with vertical spans across the header boundary');
  }
  if (spanFromAboveReaches(section, headRows.indexOf(row))) {
    throw new Error('cannot move this row — a merged cell above spans into it');
  }

  const tgroup = section.parent;
  if (!tgroup || tgroup.name !== 'tgroup') throw new Error('thead is not inside a tgroup');
  const tbody = childrenNamed(tgroup, 'tbody')[0];
  const firstBody = tbody ? childrenNamed(tbody, 'row')[0] : undefined;
  if (!firstBody) throw new Error('table has no body rows');
  removeWithLeadingWs(row);
  insertBefore(firstBody, row);
  if (childrenNamed(section, 'row').length === 0) removeWithLeadingWs(section);
  return firstEntry(row);
}

// --- Column reorder (move left/right; no-span tables only) -------------------
//
// Swaps two ADJACENT columns: the higher-index colspec moves before the lower
// one (renumberColspecs then restores canonical c1..cN while colwidth rides
// with the moved node), and every row swaps its two cells the same way. Like
// the other column edits this refuses merged tables; it additionally refuses
// entries pinned to a named column (@colname), which a positional swap would
// silently re-map.

function moveColumn(doc: Document, entry: ElementNode, dir: -1 | 1): ElementNode | null {
  const tgroup = tgroupOf(entry);
  if (hasMergedCells(tgroup)) throw new Error('column editing unsupported on merged-cell tables');
  const cols = Number(attrOf(tgroup, 'cols') ?? '0');
  for (const row of tableRows(tgroup)) {
    const cells = childrenNamed(row, 'entry');
    if (cells.length !== cols) throw new Error('table rows are inconsistent with @cols');
    if (cells.some((e) => attrOf(e, 'colname'))) {
      throw new Error('column reorder unsupported when cells are pinned to named columns');
    }
  }
  const i = columnIndexOf(entry);
  if (i < 0) throw new Error('entry is not a direct cell of its row');
  const j = i + dir;
  if (j < 0) throw new Error('already the first column');
  if (j >= cols) throw new Error('already the last column');

  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  const colspecs = childrenNamed(tgroup, 'colspec');
  if (colspecs.length > hi) {
    const movedSpec = colspecs[hi];
    removeWithLeadingWs(movedSpec);
    insertBefore(colspecs[lo], movedSpec);
    renumberColspecs(tgroup, doc.source);
  }
  for (const row of tableRows(tgroup)) {
    const cells = childrenNamed(row, 'entry');
    const moved = cells[hi];
    removeWithLeadingWs(moved);
    insertBefore(cells[lo], moved);
  }
  return entry;
}

// --- Table title -------------------------------------------------------------

/** Insert an empty <title> as the FIRST child of a <table> (CALS model is
 *  (title?, desc?, tgroup+)). Mirrors the first child's leading whitespace when
 *  it sits on its own line; for the corpus's jammed `<table><tgroup>` form the
 *  title is spliced in with no new whitespace (minimal diff either way). */
function addTableTitle(table: ElementNode): ElementNode {
  if (table.name !== 'table') throw new Error(`addTableTitle target is <${table.name}>, not <table>`);
  if (childrenNamed(table, 'title').length) throw new Error('this table already has a title');
  const first = childElements(table)[0];
  const title = makeElement('title', [], []);
  if (!first) {
    appendChild(table, '\n', title);
    return title;
  }
  const idx = table.children.indexOf(first);
  const prev = table.children[idx - 1];
  if (prev && prev.type === 'text') {
    insertBefore(first, title); // mirrors the existing leading indentation
  } else {
    insertNode(table, idx, title); // jammed form: splice with no extra bytes
  }
  return title;
}

// --- List indent / outdent (nested lists) ----------------------------------
//
// DITA allows a <ul>/<ol> nested inside a <li>, so "indenting" a list item is just
// MOVING it into a sublist under the item above it, and "outdenting" is moving a
// nested item back out one level. Tab => indent, Shift+Tab => outdent (wired in the
// canvas). Both reuse the surgical primitives; the moved item keeps its own (verbatim)
// children — only its position changes — and the structVersion guard in the host makes
// rapid Tab safe the same way it does rapid Enter.

/** The indentation (chars since the last newline) of el's leading whitespace text. */
function indentOf(el: ElementNode): string {
  const parent = el.parent;
  if (!parent) return '';
  const prev = parent.children[parent.children.indexOf(el) - 1];
  if (prev && prev.type === 'text') {
    const m = /[^\n]*$/.exec(prev.raw);
    if (m) return m[0];
  }
  return '';
}

function clonedAttrs(el: ElementNode): Array<{ name: string; value: string; quote?: '"' | "'" }> {
  return el.attrs.map((attr) => ({ name: attr.name, value: attr.value, quote: attr.quote }));
}

/** Tab: demote <li> into a sublist under its previous sibling item. Refuses the first
 *  item of a list (nothing above to nest under). */
function indentItem(li: ElementNode): ElementNode {
  if (li.name !== 'li') throw new Error(`indentItem target is <${li.name}>, not a list item`);
  const list = li.parent;
  if (!list || (list.name !== 'ul' && list.name !== 'ol')) {
    throw new Error('indentItem: item is not inside a list');
  }
  const items = childrenNamed(list, 'li');
  const pos = items.indexOf(li);
  if (pos <= 0) {
    throw new Error('Cannot indent the first item — there is no item above to nest it under.');
  }
  const prevLi = items[pos - 1];
  const prevKids = childElements(prevLi);
  const trailing = prevKids[prevKids.length - 1];
  const existingSublist = trailing && (trailing.name === 'ul' || trailing.name === 'ol') ? trailing : null;
  const nestedStyle = existingSublist ? listStyle(existingSublist) : nextNestedListStyle(listStyle(list));
  const nestedKind = listNameForStyle(nestedStyle);
  const existing = existingSublist;
  removeWithLeadingWs(li); // detach from the current list (+ its leading whitespace)

  if (existing) {
    // Preserve prevLi's authored trailing sublist style and append as its last item.
    const subItems = childrenNamed(existing, 'li');
    insertAfter(subItems[subItems.length - 1], li);
  } else {
    // Create a fresh nested list one marker level deeper. Bullets stay bullets;
    // alphabetic lists nest as numbered, and numbered lists nest as bullets.
    const inner = indentOf(prevLi) + '  ';
    const nested = makeElement(nestedKind, listAttrsForStyle(nestedStyle), [
      makeRawText('\n' + inner + '  '),
      li,
      makeRawText('\n' + inner),
    ]);
    appendChild(prevLi, '\n' + inner, nested);
  }
  return li;
}

/** Shift+Tab: promote a nested <li> out one level. Its FOLLOWING siblings move with it
 *  as its own sublist (so visual order is preserved). Refuses a top-level item. */
function outdentItem(li: ElementNode): ElementNode {
  if (li.name !== 'li') throw new Error(`outdentItem target is <${li.name}>, not a list item`);
  const list = li.parent;
  if (!list || (list.name !== 'ul' && list.name !== 'ol')) {
    throw new Error('outdentItem: item is not inside a list');
  }
  const parentLi = list.parent;
  if (!parentLi || parentLi.name !== 'li') {
    throw new Error('Cannot outdent — this item is already at the top level.');
  }
  const outerList = parentLi.parent;
  if (!outerList || (outerList.name !== 'ul' && outerList.name !== 'ol')) {
    throw new Error('outdentItem: parent item is not inside a list');
  }

  const items = childrenNamed(list, 'li');
  const tail = items.slice(items.indexOf(li) + 1);

  removeWithLeadingWs(li); // detach the item being promoted
  if (tail.length) {
    // Trailing siblings follow the promoted item, nested under it (order preserved).
    for (const t of tail) removeWithLeadingWs(t);
    const inner = indentOf(parentLi) + '  '; // li lands at parentLi's level
    const kids: CstNode[] = [];
    for (const t of tail) {
      kids.push(makeRawText('\n' + inner + '  '));
      kids.push(t);
    }
    kids.push(makeRawText('\n' + inner));
    appendChild(li, '\n' + inner, makeElement(list.name, clonedAttrs(list), kids));
  }
  if (childrenNamed(list, 'li').length === 0) {
    removeWithLeadingWs(list); // the nested list is now empty (invalid) — remove it
  }
  insertAfter(parentLi, li); // promote to a sibling right after the parent item
  return li;
}
