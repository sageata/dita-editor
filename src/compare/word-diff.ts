// Word-level inline diff between two paired leaf blocks (e.g. the old and new
// side of a modified <p>): tokenize each side's inline content, LCS over token
// keys, and emit merged inner HTML where deleted runs are wrapped in
// <del class="redline"> and inserted runs in <ins class="redline"> while
// unchanged tokens render bare. Returns null whenever a faithful word-level
// merge is not possible — callers keep the stacked old/new fallback.
//
// Text tokens are escaped EXACTLY like HtmlRenderer.node() escapes text
// (newText via escapeTextValue, raw source verbatim — entities stay intact,
// never double-escaped). Inline element children are ONE atomic token each
// (an edit inside <b> marks the whole phrase), rendered via renderFragment so
// the emitted HTML is always balanced.
//
// Pure core: no vscode, no Node APIs — CST + render core + block-diff exports.

import type { ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { escapeTextValue, renderFragment } from '../render/to-html';
import { attrFingerprint, lcs, normalizedText } from './block-diff';

/** Above this many tokens on either side, give up (null → stacked fallback). */
export const WORD_DIFF_TOKEN_CAP = 2000;

/** Inline elements that become one atomic token; any other element child
 *  aborts the word diff (block-ish content keeps the stacked presentation). */
const INLINE_TOKEN_ELEMENTS = new Set([
  'b', 'i', 'u', 'ph', 'codeph', 'xref', 'uicontrol', 'cmd', 'sub', 'sup',
  'line-through', 'term', 'keyword', 'filepath', 'userinput', 'systemoutput',
  'varname', 'apiname', 'menucascade', 'image',
]);

interface Token {
  /** LCS identity: the escaped word, ' ' for any whitespace run, or
   *  name|attrFingerprint|normalizedText for an atomic inline element. */
  key: string;
  html: string;
  ws: boolean;
}

function preservesSpace(el: ElementNode): boolean {
  return el.attrs.some((a) => a.name === 'xml:space' && a.value === 'preserve');
}

/** Token list for one side, or null when the side cannot be word-diffed
 *  (non-inline element child, or more than WORD_DIFF_TOKEN_CAP tokens). */
function tokenize(el: ElementNode): Token[] | null {
  const out: Token[] = [];
  for (const child of el.children) {
    if (child.type === 'text') {
      const escaped = child.newText !== undefined ? escapeTextValue(child.newText) : child.raw;
      for (const piece of escaped.split(/(\s+)/)) {
        if (piece === '') continue;
        const ws = /^\s/.test(piece);
        out.push({ key: ws ? ' ' : piece, html: piece, ws });
      }
    } else if (isElement(child)) {
      if (!INLINE_TOKEN_ELEMENTS.has(child.name)) return null;
      out.push({
        key: child.name + '|' + attrFingerprint(child) + '|' + normalizedText(child),
        html: renderFragment([child]),
        ws: false,
      });
    }
    // comments/PIs/cdata render nothing on the canvas: no token.
  }
  return out.length > WORD_DIFF_TOKEN_CAP ? null : out;
}

/** Drop leading/trailing whitespace tokens (mirrors the renderer's edge trim). */
function trimEdges(tokens: Token[]): Token[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start].ws) start++;
  while (end > start && tokens[end - 1].ws) end--;
  return tokens.slice(start, end);
}

interface MergedOp {
  op: 'same' | 'del' | 'ins';
  token: Token;
}

/** Merge two token streams along the LCS into one document-order op stream. */
function mergeOps(a: Token[], b: Token[]): MergedOp[] {
  const matches = lcs(a.map((t) => t.key), b.map((t) => t.key));
  const ops: MergedOp[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [a.length, b.length] as [number, number]]) {
    while (i < mi) ops.push({ op: 'del', token: a[i++] });
    while (j < mj) ops.push({ op: 'ins', token: b[j++] });
    if (mi < a.length && mj < b.length) {
      ops.push({ op: 'same', token: b[mj] }); // matched: emit the NEW side's html
      i = mi + 1;
      j = mj + 1;
    }
  }
  return ops;
}

/** Group consecutive del/ins ops into single <del>/<ins> runs; unchanged
 *  whitespace between two tokens of the SAME op joins that run, unchanged
 *  whitespace elsewhere renders bare. */
function renderOps(ops: MergedOp[]): string {
  let html = '';
  let runOp: 'del' | 'ins' | null = null;
  let runHtml = '';
  let pending = ''; // unchanged whitespace held while a run is open

  const flushRun = (): void => {
    if (runOp === null) return;
    html += runOp === 'del'
      ? `<del class="redline">${runHtml}</del>`
      : `<ins class="redline">${runHtml}</ins>`;
    runOp = null;
    runHtml = '';
  };

  for (const { op, token } of ops) {
    if (op === 'same') {
      if (token.ws && runOp !== null) {
        pending += token.html; // joins the run iff the same op continues
        continue;
      }
      flushRun();
      html += pending + token.html;
      pending = '';
    } else if (op === runOp) {
      runHtml += pending + token.html;
      pending = '';
    } else {
      flushRun();
      html += pending;
      pending = '';
      runOp = op;
      runHtml = token.html;
    }
  }
  flushRun();
  return html + pending;
}

/**
 * Word-level merged HTML for a modified leaf pair, or null when the pair is
 * not word-diffable: xml:space="preserve" on either side, a non-inline element
 * child on either side, either side over WORD_DIFF_TOKEN_CAP tokens, or no
 * visible difference (both sides tokenize to identical keys after edge trim).
 */
export function renderWordDiff(oldEl: ElementNode, newEl: ElementNode): string | null {
  if (preservesSpace(oldEl) || preservesSpace(newEl)) return null;
  const oldTokens = tokenize(oldEl);
  const newTokens = tokenize(newEl);
  if (!oldTokens || !newTokens) return null;
  const a = trimEdges(oldTokens);
  const b = trimEdges(newTokens);
  if (a.length === b.length && a.every((t, idx) => t.key === b[idx].key)) return null;
  return renderOps(mergeOps(a, b));
}
