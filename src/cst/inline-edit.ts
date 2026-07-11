// Inline formatting: wrap a text selection in a DITA phrase element (b/i/u/line-through/codeph/sub/sup).
// Pure + vscode-free so it is unit-testable; the extension turns the returned source into a
// minimal WorkspaceEdit (the serializer slices every untouched node verbatim, so only the
// edited leaf's bytes change).
//
// Contract — like split/join, the CANVAS supplies DECODED text, so the host never decodes
// entities. The edit replaces the target text run with: <before-text?> <op>mid</op> <after-text?>.
// `mid` must be non-empty (an empty selection is a caller no-op). A direct phrase child inside
// a block-mixed parent can also be addressed through the mixed-run id shape, so styling a
// nested-list parent item does not make its text uneditable.

import type { CstNode, Document, ElementNode } from './types';
import { parse } from './parse';
import { serialize } from './serialize';
import { makeText, makeElement, markDirty } from './edit';
import { findEditableById, isInlinePhrase } from './text-targets';
import { findElementById, assignElementIds } from './element-ids';
import {
  applyInlineMark,
  applyMark,
  flattenInline,
  inlineTextLength,
  isInlineMark,
  rangeMarkState,
  rebuildInline,
  removeAllHighlight,
  removeInlineStyles as removeInlineStylesInBlock,
  setInlineChildren,
  type Mark,
  type Span,
} from './inline-marks';

/** Inline ops the formatting toolbar emits, mapped to their DITA element names (identity here —
 *  the op string IS the element name). Guards against an unexpected op reaching the model. */
function assertFormatOp(op: string): asserts op is Mark {
  if (!isInlineMark(op)) throw new Error(`unknown inline format op: ${op}`);
}

type Target =
  | { kind: 'run'; parent: ElementNode; index: number } // one direct text run inside a mixed leaf (`eN:t<idx>`)
  | { kind: 'leaf'; el: ElementNode }; // a whole text-only/empty editable leaf (`eN`)

function resolveRunChild(doc: Document, editId: string): { parent: ElementNode; index: number; child: CstNode } | null {
  const sep = editId.indexOf(':t');
  if (sep === -1) return null;
  const parent = findElementById(doc, editId.slice(0, sep));
  if (!parent) return null;
  const index = Number(editId.slice(sep + 2));
  const child = parent.children[index];
  return child ? { parent, index, child } : null;
}

function isEditablePhraseRun(node: CstNode): node is ElementNode {
  return node.type === 'element' && isInlinePhrase(node.name) && node.children.every((c) => c.type === 'text');
}

/** Resolve an edit id to the run/leaf to rewrite (mirrors applyTextEdit's two id shapes). */
function resolveTarget(doc: Document, editId: string): Target | null {
  const run = resolveRunChild(doc, editId);
  if (run) {
    const { parent, index, child } = run;
    if (isEditablePhraseRun(child)) {
      return { kind: 'leaf', el: child };
    }
    if (child.type !== 'text') return null;
    return { kind: 'run', parent, index };
  }
  const el = findEditableById(doc, editId);
  if (!el) return null;
  return { kind: 'leaf', el };
}

/** Build the replacement node sequence: [text(before)?, <op>mid</op>, text(after)?]. */
function buildReplacement(op: string, before: string, mid: string, after: string): CstNode[] {
  const seq: CstNode[] = [];
  if (before !== '') seq.push(makeText(before));
  seq.push(makeElement(op, [], [makeText(mid)]));
  if (after !== '') seq.push(makeText(after));
  return seq;
}

/** Splice `replacement` into the target: for a mixed run, replace only that one text node (siblings
 *  round-trip verbatim); for a whole leaf, swap all children (before/mid/after reconstitute its text). */
function applyReplacement(target: Target, replacement: CstNode[]): void {
  if (target.kind === 'run') {
    const { parent, index } = target;
    for (const n of replacement) n.parent = parent;
    parent.children.splice(index, 1, ...replacement);
    markDirty(parent);
  } else {
    const { el } = target;
    for (const n of replacement) n.parent = el;
    el.children = replacement;
    markDirty(el);
  }
}

function clonePhraseWithText(el: ElementNode, text: string): ElementNode {
  return makeElement(
    el.name,
    el.attrs.map((attr) => ({ name: attr.name, value: attr.value, quote: attr.quote })),
    [makeText(text)],
  );
}

function removeInlineFormatFromPhraseRun(
  source: string,
  editId: string,
  before: string,
  mid: string,
  after: string,
): string {
  const doc = parse(source);
  const run = resolveRunChild(doc, editId);
  if (!run) throw new Error(`inline target not found: ${editId}`);
  if (!isEditablePhraseRun(run.child)) return source;
  const replacement: CstNode[] = [];
  if (before !== '') replacement.push(clonePhraseWithText(run.child, before));
  if (mid !== '') replacement.push(makeText(mid));
  if (after !== '') replacement.push(clonePhraseWithText(run.child, after));
  for (const n of replacement) n.parent = run.parent;
  run.parent.children.splice(run.index, 1, ...replacement);
  markDirty(run.parent);
  return serialize(doc);
}

/** A self-contained inline element to drop at a caret (image / xref / conref'd phrase). */
export interface InlineInsertSpec {
  name: string;
  attrs: Array<{ name: string; value: string }>;
  /** Inner text (e.g. an xref's link label); omitted/empty -> no text child. */
  innerText?: string;
  selfClosing?: boolean;
}

/**
 * Insert a self-contained inline element at a caret split point and return the new source.
 * The caret splits the focused run into decoded `before`/`after` (supplied by the canvas, like
 * split), and the new element is dropped between them.
 */
export function applyInlineInsert(
  source: string,
  editId: string,
  before: string,
  after: string,
  spec: InlineInsertSpec,
): string {
  const doc = parse(source);
  const target = resolveTarget(doc, editId);
  if (!target) throw new Error(`inline-insert target not found: ${editId}`);
  const inner = spec.innerText && spec.innerText !== '' ? [makeText(spec.innerText)] : [];
  const el = makeElement(spec.name, spec.attrs, inner, !!spec.selfClosing);
  if (target.kind === 'leaf') {
    const spans = flattenInline(target.el);
    const next = insertAtomSpan(spans, before.length, el);
    setInlineChildren(target.el, rebuildInline(next));
    return serialize(doc);
  }
  const replacement: CstNode[] = [];
  if (before !== '') replacement.push(makeText(before));
  replacement.push(el);
  if (after !== '') replacement.push(makeText(after));
  applyReplacement(target, replacement);
  return serialize(doc);
}

/**
 * Apply an inline-format wrap and return the full new source.
 *
 * @param editId  the focused text run (`eN:t<idx>`) or whole leaf (`eN`).
 * @param op      one of b | i | u | line-through | codeph | sub | sup.
 * @param before  decoded text kept before the wrapped span (may be empty).
 * @param mid     decoded text wrapped in <op> (must be non-empty).
 * @param after   decoded text kept after the wrapped span (may be empty).
 */
export function applyInlineFormat(
  source: string,
  editId: string,
  op: string,
  before: string,
  mid: string,
  after: string,
): string {
  assertFormatOp(op);
  if (mid === '') return source; // empty selection: nothing to wrap
  if (!editId.includes(':t')) {
    return applyInlineMark(source, editId, before.length, before.length + mid.length, op, 'toggle');
  }
  const doc = parse(source);
  const target = resolveTarget(doc, editId);
  if (!target) throw new Error(`inline target not found: ${editId}`);

  applyReplacement(target, buildReplacement(op, before, mid, after));
  return serialize(doc);
}

/** Wrap each non-whitespace direct text run of `el` in an `<op>` phrase element, by REPARENTING the
 *  existing text node (so its bytes/entities round-trip verbatim — no re-escape). Element children
 *  (a nested list, an already-formatted phrase, an image) are left untouched, so a run already inside
 *  an `<op>` is never double-wrapped. Returns whether anything changed. */
function wrapElementTextRuns(el: ElementNode, op: string): boolean {
  let changed = false;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.type === 'text' && (child.newText ?? child.raw).trim() !== '') {
      const wrapper = makeElement(op, [], [child]); // makeElement reparents child onto the wrapper
      el.children[i] = wrapper;
      changed = true;
    }
  }
  if (changed) markDirty(el);
  return changed;
}

/** True when `el`'s entire non-whitespace content is a single `<op>` element (e.g. `<li><b>x</b></li>`)
 *  — i.e. the block is already fully formatted, so the toggle should REMOVE it. */
function isFullyWrapped(el: ElementNode, op: string): boolean {
  let opChild: ElementNode | null = null;
  for (const c of el.children) {
    if (c.type === 'text') {
      if ((c.newText ?? c.raw).trim() !== '') return false; // a bare text run -> not fully wrapped
    } else if (c.type === 'element') {
      if (c.name === op && opChild === null) opChild = c;
      else return false; // a second element (or a non-op element) -> not "all inside one <op>"
    }
  }
  return opChild !== null;
}

/** Remove the single `<op>` wrapper, lifting its children back into `el` (`<li><b>x</b></li>` →
 *  `<li>x</li>`). Returns whether anything changed. */
function unwrapElementOp(el: ElementNode, op: string): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.type === 'element' && c.name === op) {
      for (const n of c.children) n.parent = el;
      el.children.splice(i, 1, ...c.children);
      markDirty(el);
      return true;
    }
  }
  return false;
}

/**
 * TOGGLE an inline format across a MULTI-ELEMENT selection (by struct id). If EVERY selected block is
 * already fully wrapped in `<op>`, the whole selection is UNWRAPPED (unbold); otherwise every block's
 * text is wrapped (blocks already wrapped are left as-is, so the result is uniformly formatted). This
 * mirrors a word-processor / DITA-editor Bold toggle. Pure source→source. All ids are resolved to
 * element references up front, so e{N} ids shifting as `<op>` elements are added/removed never
 * mis-targets a later block. Blocks with no direct text (a list, an image) are skipped.
 */
export function applyInlineFormatBlocks(source: string, ids: string[], op: string): string {
  assertFormatOp(op);
  const doc = parse(source);
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  const targets: ElementNode[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (el) targets.push(el);
  }
  if (targets.length === 0) return source;

  if (targets.every(canUseInlineMarkEngine)) {
    const editable = targets
      .map((el) => {
        const spans = flattenInline(el);
        const length = inlineTextLength(spans);
        return { el, spans, length };
      })
      .filter((target) => target.length > 0);
    if (editable.length === 0) return source;

    const removing = editable.every((target) => rangeMarkState(target.spans, 0, target.length, op).allHaveMark);
    for (const target of editable) {
      const next = applyMark(target.spans, 0, target.length, op, removing ? 'remove' : 'add');
      if (!sameInlineSpans(target.spans, next)) setInlineChildren(target.el, rebuildInline(next));
    }
    const out = serialize(doc);
    return out === source ? source : out;
  }

  // Toggle direction: unwrap only when EVERY target is already fully wrapped; else wrap.
  const removing = targets.every((el) => isFullyWrapped(el, op));
  let changed = false;
  for (const el of targets) {
    if (removing ? unwrapElementOp(el, op) : wrapElementTextRuns(el, op)) changed = true;
  }
  if (!changed) return source; // nothing selectable carried text -> no bytes change
  return serialize(doc);
}

export function removeInlineFormat(
  source: string,
  editId: string,
  before: string,
  mid: string,
  _after: string,
): string {
  if (mid === '') return source;
  if (editId.includes(':t')) return removeInlineFormatFromPhraseRun(source, editId, before, mid, _after);
  return removeInlineStylesInBlock(source, editId, before.length, before.length + mid.length);
}

export function removeInlineFormatBlocks(source: string, ids: string[]): string {
  const doc = parse(source);
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of assignElementIds(doc)) byId.set(id, el);
  const targets: ElementNode[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (el) targets.push(el);
  }
  if (targets.length === 0) return source;

  let changed = false;
  for (const el of targets) {
    if (canUseInlineMarkEngine(el)) {
      const spans = flattenInline(el);
      const length = inlineTextLength(spans);
      if (length === 0) continue;
      const next = removeAllHighlight(spans, 0, length);
      if (!sameInlineSpans(spans, next)) {
        setInlineChildren(el, rebuildInline(next));
        changed = true;
      }
    } else if (unwrapDirectHighlightWrappers(el)) {
      changed = true;
    }
  }
  if (!changed) return source;
  const out = serialize(doc);
  return out === source ? source : out;
}

function sameInlineSpans(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left.kind !== right.kind) return false;
    if (!sameMarkSet(left.marks, right.marks)) return false;
    if (left.kind === 'text' && right.kind === 'text') {
      if (left.text !== right.text) return false;
    } else if (left.kind === 'atom' && right.kind === 'atom') {
      if (left.node !== right.node || left.length !== right.length) return false;
    }
  }
  return true;
}

function sameMarkSet(a: Set<Mark>, b: Set<Mark>): boolean {
  if (a.size !== b.size) return false;
  for (const mark of a) if (!b.has(mark)) return false;
  return true;
}

function insertAtomSpan(spans: Span[], offset: number, node: ElementNode): Span[] {
  const total = inlineTextLength(spans);
  const at = Math.max(0, Math.min(offset, total));
  const out: Span[] = [];
  let pos = 0;
  let inserted = false;
  const insertWithMarks = (marks: Set<Mark>) => {
    out.push({ kind: 'atom', node, length: inlineTextLength(flattenInline(node)), marks: new Set(marks) });
    inserted = true;
  };
  for (const span of spans) {
    const len = span.kind === 'text' ? span.text.length : span.length;
    const start = pos;
    const end = pos + len;
    if (!inserted && span.kind === 'text' && at >= start && at <= end) {
      const split = at - start;
      const beforeText = span.text.slice(0, split);
      const afterText = span.text.slice(split);
      if (beforeText !== '') out.push({ kind: 'text', text: beforeText, marks: new Set(span.marks) });
      insertWithMarks(span.marks);
      if (afterText !== '') out.push({ kind: 'text', text: afterText, marks: new Set(span.marks) });
    } else {
      if (!inserted && at <= start) insertWithMarks(span.marks);
      out.push(span.kind === 'text' ? { ...span, marks: new Set(span.marks) } : { ...span, marks: new Set(span.marks) });
    }
    pos = end;
  }
  if (!inserted) out.push({ kind: 'atom', node, length: inlineTextLength(flattenInline(node)), marks: new Set() });
  return out;
}

function canUseInlineMarkEngine(el: ElementNode): boolean {
  return el.children.every((child) => {
    if (child.type !== 'element') return true;
    return isInlineMark(child.name) || child.name === 'image' || child.name === 'xref' || child.name === 'ph';
  });
}

function unwrapDirectHighlightWrappers(el: ElementNode): boolean {
  let changed = false;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.type !== 'element' || !isInlineMark(child.name)) continue;
    for (const n of child.children) n.parent = el;
    el.children.splice(i, 1, ...child.children);
    i--;
    changed = true;
  }
  if (changed) markDirty(el);
  return changed;
}
