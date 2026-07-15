// Block-level structural diff between two parsed DITA topics.
//
// Pure core: no vscode, no Node APIs — only the CST. Alignment is an LCS over
// per-element "content keys" (tag name + normalized descendant text). DEEP
// attribute fingerprints decide what a content-matched pair becomes: equal →
// same; differing on a table → formatChanged leaf (deliberately coarse, covers
// colspec and cell-level attr changes); differing in TAG STRUCTURE (same text,
// rewritten element tree) → modified; differing on another container →
// modified, recursing to pinpoint the changed block; attr-only delta on a
// leaf → formatChanged. Similarity (Dice) pairing aligns reworded blocks in
// gaps; modified containers recurse; modified text-only leaves are flagged
// for the word-diff hook; a final pass rewrites relocated blocks into moves.

import type { Document, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { childElements, childrenNamed } from '../cst/query';

export type ChangeKind =
  | 'same' | 'inserted' | 'deleted' | 'modified' | 'formatChanged'
  | 'movedFrom' | 'movedTo';

export interface BlockChange {
  kind: ChangeKind;
  oldEl?: ElementNode;   // present for deleted | movedFrom | modified | formatChanged
  newEl?: ElementNode;   // present for inserted | movedTo | same | modified | formatChanged
  children?: BlockChange[]; // present when a modified container recursed
  textOnly?: boolean;    // modified leaf where BOTH sides contain only text children
  moveId?: number;       // shared by one movedFrom/movedTo pair (detectMoves)
}

/** Containers whose modified pairs recurse into element children. */
const CONTAINERS = new Set([
  'section', 'body', 'conbody', 'taskbody',
  'ul', 'ol', 'sl', 'dl', 'li',
  'table', 'tgroup', 'thead', 'tbody', 'fig',
]);

/** Above this many element children on either side, skip LCS and align positionally. */
const LCS_GUARD = 200;

function collectText(el: ElementNode, out: string[]): void {
  for (const child of el.children) {
    if (child.type === 'text') out.push(child.newText ?? child.raw);
    else if (isElement(child)) collectText(child, out);
  }
}

/** Whitespace-collapsed, trimmed concatenation of all descendant text (entities raw). */
export function normalizedText(el: ElementNode): string {
  const parts: string[] = [];
  collectText(el, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function attrValue(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function firstDescendantNamed(el: ElementNode, name: string): ElementNode | undefined {
  for (const child of el.children) {
    if (!isElement(child)) continue;
    if (child.name === name) return child;
    const hit = firstDescendantNamed(child, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Identity key used for LCS alignment: tag + normalized text (+ image href). */
function contentKey(el: ElementNode): string {
  let key = el.name + '|' + normalizedText(el);
  if (el.name === 'image' || el.name === 'fig') {
    const image = el.name === 'image' ? el : firstDescendantNamed(el, 'image');
    key += '|' + (image ? attrValue(image, 'href') ?? '' : '');
  }
  return key;
}

function ownAttrFingerprint(el: ElementNode): string {
  return el.attrs
    .map((a) => a.name + '=' + a.value)
    .sort()
    .join(';');
}

/** Deep fingerprint: tag + own sorted attrs, folding in every element child recursively (document order). */
export function attrFingerprint(el: ElementNode): string {
  let fp = el.name + '{' + ownAttrFingerprint(el) + '}';
  for (const child of childElements(el)) fp += attrFingerprint(child);
  return fp;
}

/** Deep TAG-STRUCTURE fingerprint: element names only, no attributes. Two
 *  content-matched blocks that differ here were structurally rewritten (e.g. a
 *  paragraph turned into a bullet list with the same visible text) — that is a
 *  content modification to present, never a mere formatting flag. */
function tagFingerprint(el: ElementNode): string {
  let fp = el.name + '(';
  for (const child of childElements(el)) fp += tagFingerprint(child);
  return fp + ')';
}

function textOnlyChildren(el: ElementNode): boolean {
  return el.children.every((c) => c.type === 'text');
}

/** True when the element holds at least one element child and NO
 *  non-whitespace direct text (i.e. pure block content, layout text only). */
function blockOnlyChildren(el: ElementNode): boolean {
  let hasElement = false;
  for (const c of el.children) {
    if (isElement(c)) hasElement = true;
    else if (c.type === 'text' && (c.newText ?? c.raw).trim() !== '') return false;
  }
  return hasElement;
}

/** LCS match pairs [oldIndex, newIndex] over exact key equality. */
export function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Build a modified pair, recursing when the tag is a container (rows are positional-only). */
function makeModified(oldEl: ElementNode, newEl: ElementNode): BlockChange {
  const change: BlockChange = { kind: 'modified', oldEl, newEl };
  if (oldEl.name === 'row') {
    const oldEntries = childrenNamed(oldEl, 'entry');
    const newEntries = childrenNamed(newEl, 'entry');
    if (oldEntries.length === newEntries.length) {
      change.children = oldEntries.map((oe, i) => comparePair(oe, newEntries[i]));
    }
    return change;
  }
  if (oldEl.name === 'entry' && blockOnlyChildren(oldEl) && blockOnlyChildren(newEl)) {
    // A cell holding pure block content (e.g. <p>s) recurses so the render side
    // can word-diff the changed block INSIDE the cell instead of stacking the
    // whole cell. Inline/text cell content stays a leaf (word-diffed directly);
    // mixed content stays a leaf so direct text is never dropped from view.
    change.children = diffLists(childElements(oldEl), childElements(newEl));
    return change;
  }
  if (CONTAINERS.has(oldEl.name)) {
    change.children = diffLists(childElements(oldEl), childElements(newEl));
    return change;
  }
  if (textOnlyChildren(oldEl) && textOnlyChildren(newEl)) change.textOnly = true;
  return change;
}

/**
 * Compare two same-tag elements directly. Content keys differ → modified.
 * Content-matched with differing deep fingerprints: table → formatChanged leaf
 * (deliberately coarse); a changed TAG STRUCTURE (same visible text, different
 * element tree — e.g. text turned into a list) → modified, because the block
 * was rewritten, not restyled; other container whose OWN attrs are unchanged →
 * modified, recursing to pinpoint the changed block below; anything else
 * (attr-only delta on a leaf, or a container whose own attrs changed) →
 * formatChanged.
 */
function comparePair(oldEl: ElementNode, newEl: ElementNode): BlockChange {
  if (contentKey(oldEl) !== contentKey(newEl)) return makeModified(oldEl, newEl);
  if (attrFingerprint(oldEl) === attrFingerprint(newEl)) return { kind: 'same', oldEl, newEl };
  // A rewritten tag tree dominates everything — including the table-coarse
  // rule, which exists for ATTRIBUTE deltas (colspec widths, cell attrs), not
  // for content restructured inside a cell with the same visible text.
  if (tagFingerprint(oldEl) !== tagFingerprint(newEl)) return makeModified(oldEl, newEl);
  if (oldEl.name === 'table') return { kind: 'formatChanged', oldEl, newEl };
  if (CONTAINERS.has(oldEl.name) && ownAttrFingerprint(oldEl) === ownAttrFingerprint(newEl)) {
    return {
      kind: 'modified',
      oldEl,
      newEl,
      children: diffLists(childElements(oldEl), childElements(newEl)),
    };
  }
  return { kind: 'formatChanged', oldEl, newEl };
}

/** Minimum Dice score for a similarity pairing. */
const SIMILARITY_THRESHOLD = 0.4;
/** Word-set size cap per side when scoring similarity. */
const SIMILARITY_WORD_CAP = 500;
/** Above this many same-tag candidate pairs in one gap, skip similarity scoring
 *  entirely (the cursor pairing below runs verbatim). */
const SIMILARITY_PAIR_GUARD = 1600;

/** Word set of an element's normalized text, capped at SIMILARITY_WORD_CAP words. */
function similarityWordSet(el: ElementNode): Set<string> {
  const out = new Set<string>();
  const text = normalizedText(el);
  if (text === '') return out;
  const words = text.split(' ');
  const cap = Math.min(words.length, SIMILARITY_WORD_CAP);
  for (let k = 0; k < cap; k++) out.add(words[k]);
  return out;
}

/** Dice coefficient over two word sets; 0 when either side is empty. */
function diceScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Pair a gap's removed/added blocks. Phase 1 (guarded): Dice similarity over
 * same-tag candidates, greedy by score desc with (oldIndex, newIndex) tie-break.
 * Phase 2: the original per-name cursor pairing over the leftovers — so per tag
 * name the pair COUNT stays exactly what pure cursor pairing yields (min of the
 * two sides); similarity only improves which blocks pair up. Leftovers are pure.
 */
function pairGap(removed: ElementNode[], added: ElementNode[]): BlockChange[] {
  const pairedAdded = new Array<boolean>(added.length).fill(false);
  const pairFor = new Map<number, number>();

  const addedCountByName = new Map<string, number>();
  for (const el of added) addedCountByName.set(el.name, (addedCountByName.get(el.name) ?? 0) + 1);
  let candidatePairs = 0;
  for (const el of removed) candidatePairs += addedCountByName.get(el.name) ?? 0;
  if (candidatePairs > 0 && candidatePairs <= SIMILARITY_PAIR_GUARD) {
    const removedSets = removed.map(similarityWordSet);
    const addedSets = added.map(similarityWordSet);
    const scored: Array<{ score: number; i: number; j: number }> = [];
    removed.forEach((oldEl, i) => {
      added.forEach((newEl, j) => {
        if (oldEl.name !== newEl.name) return;
        const score = diceScore(removedSets[i], addedSets[j]);
        if (score >= SIMILARITY_THRESHOLD) scored.push({ score, i, j });
      });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    for (const { i, j } of scored) {
      if (pairFor.has(i) || pairedAdded[j]) continue;
      pairFor.set(i, j);
      pairedAdded[j] = true;
    }
  }

  const addedByName = new Map<string, number[]>();
  added.forEach((el, j) => {
    if (pairedAdded[j]) return;
    const list = addedByName.get(el.name);
    if (list) list.push(j);
    else addedByName.set(el.name, [j]);
  });
  const cursor = new Map<string, number>();
  removed.forEach((el, i) => {
    if (pairFor.has(i)) return;
    const list = addedByName.get(el.name);
    if (!list) return;
    const c = cursor.get(el.name) ?? 0;
    if (c < list.length) {
      pairFor.set(i, list[c]);
      pairedAdded[list[c]] = true;
      cursor.set(el.name, c + 1);
    }
  });
  const out: BlockChange[] = [];
  removed.forEach((el, i) => {
    const j = pairFor.get(i);
    out.push(j !== undefined ? makeModified(el, added[j]) : { kind: 'deleted', oldEl: el });
  });
  added.forEach((el, j) => {
    if (!pairedAdded[j]) out.push({ kind: 'inserted', newEl: el });
  });
  return out;
}

/** Positional fallback for a wide unmatched middle (deterministic, no LCS cost). */
function diffPositional(oldEls: ElementNode[], newEls: ElementNode[]): BlockChange[] {
  const out: BlockChange[] = [];
  const shared = Math.min(oldEls.length, newEls.length);
  for (let i = 0; i < shared; i++) {
    const o = oldEls[i];
    const nw = newEls[i];
    if (o.name === nw.name) {
      out.push(comparePair(o, nw));
    } else {
      out.push({ kind: 'deleted', oldEl: o });
      out.push({ kind: 'inserted', newEl: nw });
    }
  }
  for (let i = shared; i < oldEls.length; i++) out.push({ kind: 'deleted', oldEl: oldEls[i] });
  for (let i = shared; i < newEls.length; i++) out.push({ kind: 'inserted', newEl: newEls[i] });
  return out;
}

function diffFromMatches(
  oldEls: ElementNode[],
  newEls: ElementNode[],
  matches: Array<[number, number]>,
): BlockChange[] {
  const out: BlockChange[] = [];
  let oi = 0;
  let ni = 0;
  for (const [mo, mn] of [...matches, [oldEls.length, newEls.length] as [number, number]]) {
    out.push(...pairGap(oldEls.slice(oi, mo), newEls.slice(ni, mn)));
    if (mo < oldEls.length && mn < newEls.length) {
      out.push(comparePair(oldEls[mo], newEls[mn]));
    }
    oi = mo + 1;
    ni = mn + 1;
  }
  return out;
}

function diffLcs(oldEls: ElementNode[], newEls: ElementNode[]): BlockChange[] {
  return diffFromMatches(oldEls, newEls, lcs(oldEls.map(contentKey), newEls.map(contentKey)));
}

/** Bounded Myers exact-match alignment for wide repeated-content gaps. Sparse
 *  insert/delete sequences finish near-linearly even when no key is unique;
 *  highly divergent inputs stop at the bound and retain the positional guard. */
function myersMatches(
  oldEls: ElementNode[],
  newEls: ElementNode[],
  maxDistance = LCS_GUARD,
): Array<[number, number]> | undefined {
  const oldKeys = oldEls.map(contentKey);
  const newKeys = newEls.map(contentKey);
  const n = oldKeys.length;
  const m = newKeys.length;
  const limit = Math.min(n + m, maxDistance);
  const trace: Array<Map<number, number>> = [];
  const frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= limit; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = frontier.get(diagonal - 1) ?? -1;
      let oldIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : right + 1;
      let newIndex = oldIndex - diagonal;
      while (oldIndex < n && newIndex < m && oldKeys[oldIndex] === newKeys[newIndex]) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex < n || newIndex < m) continue;

      trace.push(new Map(frontier));
      const matches: Array<[number, number]> = [];
      let x = n;
      let y = m;
      for (let d = distance; d > 0; d -= 1) {
        const previous = trace[d - 1];
        const k = x - y;
        const previousDown = previous.get(k + 1) ?? -1;
        const previousRight = previous.get(k - 1) ?? -1;
        const previousK = k === -d || (k !== d && previousRight < previousDown) ? k + 1 : k - 1;
        const previousX = Math.max(0, previous.get(previousK) ?? 0);
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          matches.push([x - 1, y - 1]);
          x -= 1;
          y -= 1;
        }
        x = previousX;
        y = previousY;
      }
      while (x > 0 && y > 0) {
        matches.push([x - 1, y - 1]);
        x -= 1;
        y -= 1;
      }
      matches.reverse();
      return matches;
    }
    trace.push(new Map(frontier));
  }
  return undefined;
}

/** Ordered anchors whose exact content key occurs once on each side. The
 *  longest increasing subsequence of new-side positions is a cheap, stable
 *  common subsequence for wide containers (patience-diff style). */
function uniqueOrderedAnchors(oldEls: ElementNode[], newEls: ElementNode[]): Array<[number, number]> {
  const oldKeys = oldEls.map(contentKey);
  const newKeys = newEls.map(contentKey);
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  const newPositions = new Map<string, number>();
  for (const key of oldKeys) oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
  newKeys.forEach((key, index) => {
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
    newPositions.set(key, index);
  });

  const candidates: Array<[number, number]> = [];
  oldKeys.forEach((key, oldIndex) => {
    if (oldCounts.get(key) === 1 && newCounts.get(key) === 1) {
      candidates.push([oldIndex, newPositions.get(key)!]);
    }
  });
  if (candidates.length === 0) return [];

  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  candidates.forEach((candidate, candidateIndex) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]][1] < candidate[1]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[candidateIndex] = tails[low - 1];
    tails[low] = candidateIndex;
  });

  const anchors: Array<[number, number]> = [];
  let cursor = tails[tails.length - 1];
  while (cursor !== undefined && cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();
  return anchors;
}

/** Wide containers peel exact prefixes/suffixes, then use unique ordered
 *  anchors to split the remaining middle before any positional fallback. This
 *  isolates multiple sparse edits without allocating an unbounded LCS matrix. */
function diffWide(oldEls: ElementNode[], newEls: ElementNode[]): BlockChange[] {
  let prefix = 0;
  const shared = Math.min(oldEls.length, newEls.length);
  while (prefix < shared && contentKey(oldEls[prefix]) === contentKey(newEls[prefix])) prefix += 1;

  let suffix = 0;
  while (
    suffix < shared - prefix
    && contentKey(oldEls[oldEls.length - 1 - suffix]) === contentKey(newEls[newEls.length - 1 - suffix])
  ) suffix += 1;

  const oldMiddle = oldEls.slice(prefix, oldEls.length - suffix);
  const newMiddle = newEls.slice(prefix, newEls.length - suffix);
  let middle: BlockChange[];
  if (oldMiddle.length <= LCS_GUARD && newMiddle.length <= LCS_GUARD) {
    middle = diffLcs(oldMiddle, newMiddle);
  } else {
    const anchors = uniqueOrderedAnchors(oldMiddle, newMiddle);
    if (anchors.length === 0) {
      const repeatedMatches = myersMatches(oldMiddle, newMiddle);
      middle = repeatedMatches
        ? diffFromMatches(oldMiddle, newMiddle, repeatedMatches)
        : diffPositional(oldMiddle, newMiddle);
    } else {
      middle = [];
      let oldCursor = 0;
      let newCursor = 0;
      for (const [oldAnchor, newAnchor] of anchors) {
        const oldGap = oldMiddle.slice(oldCursor, oldAnchor);
        const newGap = newMiddle.slice(newCursor, newAnchor);
        middle.push(...(
          oldGap.length > LCS_GUARD || newGap.length > LCS_GUARD
            ? diffWide(oldGap, newGap)
            : diffLcs(oldGap, newGap)
        ));
        middle.push(comparePair(oldMiddle[oldAnchor], newMiddle[newAnchor]));
        oldCursor = oldAnchor + 1;
        newCursor = newAnchor + 1;
      }
      const oldTail = oldMiddle.slice(oldCursor);
      const newTail = newMiddle.slice(newCursor);
      middle.push(...(
        oldTail.length > LCS_GUARD || newTail.length > LCS_GUARD
          ? diffWide(oldTail, newTail)
          : diffLcs(oldTail, newTail)
      ));
    }
  }
  return [
    ...oldEls.slice(0, prefix).map((oldEl, index) => comparePair(oldEl, newEls[index])),
    ...middle,
    ...oldEls.slice(oldEls.length - suffix).map((oldEl, index) =>
      comparePair(oldEl, newEls[newEls.length - suffix + index])
    ),
  ];
}

/** Diff one container's element-children lists. */
function diffLists(oldEls: ElementNode[], newEls: ElementNode[]): BlockChange[] {
  return oldEls.length > LCS_GUARD || newEls.length > LCS_GUARD
    ? diffWide(oldEls, newEls)
    : diffLcs(oldEls, newEls);
}

/** Root topic element: first element child, skipping xmldecl/doctype/whitespace. */
export function rootElement(doc: Document): ElementNode | undefined {
  return doc.children.find(isElement);
}

export interface TopicRootChange {
  kind: 'inserted' | 'deleted' | 'formatChanged' | 'modified';
  label: 'Topic added' | 'Topic deleted' | 'Topic metadata changed' | 'Topic type changed';
  oldEl?: ElementNode;
  newEl?: ElementNode;
}

function ownRootFingerprint(el: ElementNode): string {
  return el.attrs.map((attribute) => `${attribute.name}=${attribute.value}`).sort().join(';');
}

/** Root name/attribute changes sit outside diffTopics' child alignment. Expose
 *  them separately so renderers can mark topic metadata without duplicating the
 *  entire document as an additional block change. */
export function topicRootChange(oldDoc: Document, newDoc: Document): TopicRootChange | undefined {
  const oldEl = rootElement(oldDoc);
  const newEl = rootElement(newDoc);
  if (!oldEl && !newEl) return undefined;
  if (!oldEl) return { kind: 'inserted', label: 'Topic added', newEl: newEl! };
  if (!newEl) return { kind: 'deleted', label: 'Topic deleted', oldEl };
  if (oldEl.name !== newEl.name) {
    return { kind: 'modified', label: 'Topic type changed', oldEl, newEl };
  }
  if (ownRootFingerprint(oldEl) !== ownRootFingerprint(newEl)) {
    return { kind: 'formatChanged', label: 'Topic metadata changed', oldEl, newEl };
  }
  return undefined;
}

/** Move-detection key: same content AND same deep attribute fingerprint only. */
function moveKey(el: ElementNode): string {
  return contentKey(el) + '§' + attrFingerprint(el);
}

/**
 * Post-pass over the finished change tree: a deleted block and an inserted
 * block with the same content key AND deep attr fingerprint are one block
 * relocated. Blocks with empty normalized text never move-pair. Matching is
 * FIFO in document order; matched entries are rewritten in place to
 * movedFrom (keeps oldEl) / movedTo (keeps newEl) sharing a moveId.
 */
function detectMoves(changes: BlockChange[]): void {
  const deletedByKey = new Map<string, BlockChange[]>();
  const inserted: Array<{ change: BlockChange; key: string }> = [];
  const visit = (list: BlockChange[]): void => {
    for (const change of list) {
      if (change.kind === 'deleted' && change.oldEl && normalizedText(change.oldEl) !== '') {
        const key = moveKey(change.oldEl);
        const queue = deletedByKey.get(key);
        if (queue) queue.push(change);
        else deletedByKey.set(key, [change]);
      } else if (change.kind === 'inserted' && change.newEl && normalizedText(change.newEl) !== '') {
        inserted.push({ change, key: moveKey(change.newEl) });
      }
      if (change.children) visit(change.children);
    }
  };
  visit(changes);
  let nextMoveId = 1;
  for (const { change, key } of inserted) {
    const from = deletedByKey.get(key)?.shift();
    if (!from) continue;
    const moveId = nextMoveId++;
    from.kind = 'movedFrom';
    from.moveId = moveId;
    change.kind = 'movedTo';
    change.moveId = moveId;
  }
}

/** Diff the element children of each document's root element, recursively,
 *  then rewrite relocated deleted+inserted pairs into movedFrom/movedTo. */
export function diffTopics(oldDoc: Document, newDoc: Document): BlockChange[] {
  const oldRoot = rootElement(oldDoc);
  const newRoot = rootElement(newDoc);
  let changes: BlockChange[];
  if (!oldRoot && !newRoot) {
    changes = [];
  } else if (!oldRoot) {
    changes = childElements(newRoot as ElementNode).map((el): BlockChange => ({ kind: 'inserted', newEl: el }));
  } else if (!newRoot) {
    changes = childElements(oldRoot).map((el): BlockChange => ({ kind: 'deleted', oldEl: el }));
  } else {
    changes = diffLists(childElements(oldRoot), childElements(newRoot));
  }
  detectMoves(changes);
  return changes;
}
