// Redline (track-changes) HTML for a block diff: Word-style merged view where
// unchanged blocks render verbatim, insertions/deletions/format changes are
// wrapped in redline-* divs (styled by media/redline.css), and a modified
// container keeps its own rendered shell with the diffed children interleaved
// inside it — deleted children spliced in at their diff position.
//
// Pure core: no vscode, no Node APIs — CST + block-diff + the render core only.

import type { Attr, CstNode, Document, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { escapeTextValue, renderFragment } from '../render/to-html';
import { diffTopics, type BlockChange } from './block-diff';
import { renderWordDiff } from './word-diff';

export interface RedlineOptions {
  /** outputclass token → author-facing style name (from the workspace author-styles CSS). */
  styleNames?: ReadonlyMap<string, string>;
}

export interface RedlineResult {
  html: string;
  changeCount: number;
}

/** outputclass tokens of one side (empty when the attr or the element is absent). */
function classTokens(el: ElementNode | undefined): string[] {
  const value = el?.attrs.find((a) => a.name === 'outputclass')?.value ?? '';
  return value.split(/\s+/).filter((token) => token !== '');
}

/** Friendly label for a formatChanged block: name the applied/removed style
 *  tokens (mapped through styleNames, raw token as fallback); no outputclass
 *  delta keeps the generic per-tag wording. HTML-escaped at the source. */
function formatLabel(
  oldEl: ElementNode | undefined,
  newEl: ElementNode | undefined,
  styleNames?: ReadonlyMap<string, string>,
): string {
  const oldTokens = classTokens(oldEl);
  const newTokens = classTokens(newEl);
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const parts: string[] = [];
  for (const token of newTokens) {
    if (!oldSet.has(token)) parts.push(`${styleNames?.get(token) ?? token} applied`);
  }
  for (const token of oldTokens) {
    if (!newSet.has(token)) parts.push(`${styleNames?.get(token) ?? token} removed`);
  }
  if (parts.length === 0) {
    const el = newEl ?? oldEl;
    return el?.name === 'table' ? 'Table layout changed' : 'Formatting changed';
  }
  return escapeTextValue('Formatting: ' + parts.join(', '));
}

function wrap(kindClass: string, inner: string): string {
  return `<div class="redline-block ${kindClass}">${inner}</div>`;
}

/** Mirror HtmlRenderer.children()'s edge trim of joined child HTML, so the
 *  fragment-rendered children match their in-container rendering byte-for-byte. */
function trimLayoutEdges(html: string): string {
  return html.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
}

interface Shell {
  open: string;
  close: string;
}

/** Derive a container's open/close shell without hardcoding tag markup: render the
 *  whole container, render ALL its children (text nodes included, so interstitial
 *  whitespace collapses identically), and split at the children substring. Null when
 *  the renderer does not embed the children verbatim (e.g. <table> rebuilds
 *  colgroup/thead/tbody) or the container is empty — callers must fall back. */
function splitShell(el: ElementNode): Shell | null {
  const containerHtml = renderFragment([el]);
  const innerJoin = trimLayoutEdges(renderFragment(el.children));
  if (innerJoin === '') return null;
  const at = containerHtml.indexOf(innerJoin);
  if (at < 0) {
    // Rendering text children without their parent collapses whitespace, while
    // codeblock/lines render their real content inside <pre> byte-for-byte.
    // Recover those shells from the already-rendered outer tag so word-level
    // marks can preserve newlines instead of falling back to whole-block pairs.
    if (el.name !== 'codeblock' && el.name !== 'lines') return null;
    const openEnd = containerHtml.indexOf('>');
    const closeStart = containerHtml.lastIndexOf('</');
    if (openEnd < 0 || closeStart <= openEnd) return null;
    return {
      open: containerHtml.slice(0, openEnd + 1),
      close: containerHtml.slice(closeStart),
    };
  }
  return {
    open: containerHtml.slice(0, at),
    close: containerHtml.slice(at + innerJoin.length),
  };
}

/* ── Merged table: ONE table with per-row/per-cell marks ─────────────────────
 * splitShell cannot split a <table> (the renderer rebuilds colgroup/thead/tbody),
 * so a content-modified table is rendered from a SYNTHETIC merged CST instead of
 * stacking two whole tables: deleted rows are spliced back in at their diff
 * position (struck via a redline-row-del marker on @outputclass, which classAttr
 * folds into the emitted class), inserted rows are tinted, and a modified cell
 * stacks its old content (struck) above the new INSIDE the same cell. Original
 * parsed nodes are never mutated — only shallow clones and synthetic wrappers. */

const SYNTH_RANGE = { start: 0, end: 0 };

function synthAttr(name: string, value: string): Attr {
  return { name, value, quote: '"', valueRange: SYNTH_RANGE, range: SYNTH_RANGE };
}

/** Synthetic wrapper element: the render core's default case emits it as
 *  <span class="{name}">; media/redline.css styles the redline-cell-* names
 *  as stacked blocks. */
function synthElement(name: string, children: CstNode[]): ElementNode {
  return {
    type: 'element',
    name,
    attrs: [],
    selfClosing: false,
    openTagRange: SYNTH_RANGE,
    closeTagRange: SYNTH_RANGE,
    children,
    range: SYNTH_RANGE,
    synthetic: true,
  };
}

/** Shallow clone with a redline marker appended to @outputclass. */
function withMarkClass(el: ElementNode, mark: string): ElementNode {
  const existing = el.attrs.find((a) => a.name === 'outputclass');
  const attrs = existing
    ? el.attrs.map((a) => (a === existing ? synthAttr('outputclass', `${existing.value} ${mark}`) : a))
    : [...el.attrs, synthAttr('outputclass', mark)];
  return { ...el, attrs };
}

/** Merged content of a MODIFIED cell, finest grain first: recursed block
 *  children render through renderChange (word-level marks per block); inline
 *  or text cell content word-diffs directly (only the edited words/atoms
 *  marked); anything else stacks old (struck) above new inside the cell. */
function mergedCellHtml(c: BlockChange, styleNames?: ReadonlyMap<string, string>): string {
  const oldEl = c.oldEl as ElementNode;
  const newEl = c.newEl as ElementNode;
  if (c.children) {
    const inner = c.children.map((ch) => renderChange(ch, styleNames)).join('');
    if (inner !== '') return inner;
  }
  const wordLevel = renderWordDiff(oldEl, newEl);
  if (wordLevel !== null) return wordLevel;
  return `<span class="redline-cell-del">${trimLayoutEdges(renderFragment(oldEl.children))}</span>`
    + `<span class="redline-cell-ins">${trimLayoutEdges(renderFragment(newEl.children))}</span>`;
}

/** Merged <row>: same cells verbatim; a modified cell keeps ONE <td> whose
 *  content is filled in post-render via a slot placeholder (the cell's merged
 *  HTML — word-level runs where possible — cannot be expressed as CST);
 *  a formatChanged cell renders its new state flagged amber. */
function mergeRow(
  change: BlockChange,
  slots: string[],
  styleNames?: ReadonlyMap<string, string>,
): ElementNode {
  const cells = (change.children ?? []).map((c): CstNode => {
    if (c.kind === 'formatChanged' && c.newEl) return withMarkClass(c.newEl, 'redline-entry-fmt');
    if (c.kind !== 'modified' || !c.oldEl || !c.newEl) return (c.newEl ?? c.oldEl) as CstNode;
    const slot = slots.length;
    slots.push(mergedCellHtml(c, styleNames));
    return { ...c.newEl, children: [synthElement(`redline-slot-${slot}`, [])] };
  });
  return { ...(change.newEl as ElementNode), children: cells };
}

/** Merged clone of a modified table-family container (table/tgroup/thead/tbody).
 *  Null when the change lacks its pair or children — caller falls back. */
function mergeTableTree(
  change: BlockChange,
  slots: string[],
  styleNames?: ReadonlyMap<string, string>,
): ElementNode | null {
  const newEl = change.newEl;
  if (!newEl || !change.children) return null;
  const out: CstNode[] = [];
  for (const c of change.children) {
    switch (c.kind) {
      case 'same':
        if (c.newEl) out.push(c.newEl);
        break;
      case 'formatChanged':
        // Never render an attr-only changed row unmarked — flag it amber like
        // block-level formatChanged (non-row containers pass through: their
        // tags emit no styled element of their own inside the table render).
        if (c.newEl) out.push(c.newEl.name === 'row' ? withMarkClass(c.newEl, 'redline-row-fmt') : c.newEl);
        break;
      case 'inserted':
      case 'movedTo':
        if (c.newEl) out.push(withMarkClass(c.newEl, 'redline-row-ins'));
        break;
      case 'deleted':
      case 'movedFrom':
        if (c.oldEl) out.push(withMarkClass(c.oldEl, 'redline-row-del'));
        break;
      case 'modified': {
        if (c.children && c.oldEl && c.newEl) {
          if (c.oldEl.name === 'row') {
            out.push(mergeRow(c, slots, styleNames));
          } else {
            const sub = mergeTableTree(c, slots, styleNames); // tgroup/thead/tbody recursion
            out.push(sub ?? c.newEl);
          }
        } else if (c.oldEl && c.newEl) {
          // Leaf modified pair (e.g. a row whose entry count changed): honest
          // old-struck + new-tinted row pair inside the ONE merged table.
          out.push(withMarkClass(c.oldEl, 'redline-row-del'));
          out.push(withMarkClass(c.newEl, 'redline-row-ins'));
        } else if (c.newEl) {
          out.push(c.newEl);
        }
        break;
      }
    }
  }
  return { ...newEl, children: out };
}

/** Modified leaf: word-level merged block inside the NEW side's real shell when
 *  both the shell split and the word diff succeed; otherwise Word's "replaced"
 *  presentation — old block struck (del) stacked above new (ins). */
function renderModifiedLeaf(oldEl: ElementNode, newEl: ElementNode): string {
  const shell = splitShell(newEl);
  if (shell) {
    const inner = renderWordDiff(oldEl, newEl);
    if (inner !== null) {
      return `<div class="redline-block redline-block-mod">${shell.open}${inner}${shell.close}</div>`;
    }
  }
  return wrap('redline-block-del', renderFragment([oldEl]))
    + wrap('redline-block-ins', renderFragment([newEl]));
}

function renderChange(change: BlockChange, styleNames?: ReadonlyMap<string, string>): string {
  switch (change.kind) {
    case 'same':
      return change.newEl ? renderFragment([change.newEl]) : '';
    case 'inserted':
      return change.newEl ? wrap('redline-block-ins', renderFragment([change.newEl])) : '';
    case 'deleted':
      return change.oldEl ? wrap('redline-block-del', renderFragment([change.oldEl])) : '';
    case 'movedTo':
      return change.newEl
        ? `<div class="redline-block redline-block-moved"><span class="redline-move-label">Moved</span>${renderFragment([change.newEl])}</div>`
        : '';
    case 'movedFrom':
      // Slim marker only: the relocated content renders ONCE, at its movedTo spot.
      return '<div class="redline-block redline-block-moved-from"><span class="redline-move-label">Moved from here</span></div>';
    case 'formatChanged': {
      const el = change.newEl ?? change.oldEl;
      if (!el) return '';
      return `<div class="redline-block redline-block-fmt"><span class="redline-fmt-label">${formatLabel(change.oldEl, change.newEl, styleNames)}</span>${renderFragment([el])}</div>`;
    }
    case 'modified': {
      const { oldEl, newEl } = change;
      // Contract guarantees both sides; degrade to pure ins/del rather than throw.
      if (!oldEl || !newEl) {
        if (newEl) return wrap('redline-block-ins', renderFragment([newEl]));
        if (oldEl) return wrap('redline-block-del', renderFragment([oldEl]));
        return '';
      }
      if (!change.children) return renderModifiedLeaf(oldEl, newEl);
      if (newEl.name === 'table') {
        // A table shell cannot be split — render ONE merged table (per-row and
        // per-cell marks) instead of stacking the whole old and new tables.
        // Modified cells render as slot placeholders, substituted afterwards
        // with their merged HTML (word-level runs where the content allows).
        try {
          const slots: string[] = [];
          const merged = mergeTableTree(change, slots, styleNames);
          if (merged) {
            let html = renderFragment([merged]);
            slots.forEach((content, i) => {
              html = html.split(`<span class="redline-slot-${i}"></span>`).join(content);
            });
            return wrap('redline-block-mod', html);
          }
        } catch (err) {
          console.error('dita-editor: merged table redline failed, falling back to stacked', err);
        }
        return renderModifiedLeaf(oldEl, newEl);
      }
      const shell = splitShell(newEl);
      if (!shell) return renderModifiedLeaf(oldEl, newEl);
      return shell.open + change.children.map((c) => renderChange(c, styleNames)).join('') + shell.close;
    }
  }
}

/** Non-same changes at the finest grain: a recursed container counts only its
 *  descendants' non-same leaves, never itself. A move counts once (its movedTo
 *  side); the movedFrom marker is skipped. */
function countChanges(changes: BlockChange[]): number {
  let count = 0;
  for (const change of changes) {
    if (change.kind === 'same' || change.kind === 'movedFrom') continue;
    if (change.kind === 'modified' && change.children) count += countChanges(change.children);
    else count += 1;
  }
  return count;
}

function rootElement(doc: Document): ElementNode | undefined {
  return doc.children.find((node: CstNode): node is ElementNode => isElement(node));
}

export function renderRedline(oldDoc: Document, newDoc: Document, options?: RedlineOptions): RedlineResult {
  const changes = diffTopics(oldDoc, newDoc);
  const inner = changes.map((c) => renderChange(c, options?.styleNames)).join('');
  // Root shell from the NEW topic (old when everything was deleted): the diffed
  // children are interleaved inside the root's real rendered shell.
  const root = rootElement(newDoc) ?? rootElement(oldDoc);
  const shell = root ? splitShell(root) : null;
  const html = shell ? shell.open + inner + shell.close : inner;
  return { html, changeCount: countChanges(changes) };
}
