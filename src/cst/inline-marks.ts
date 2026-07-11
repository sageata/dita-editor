import type { CstNode, ElementNode, TextNode } from './types';
import { parse } from './parse';
import { serialize } from './serialize';
import { makeElement, makeText, markDirty } from './edit';
import { findElementById } from './element-ids';

export type Mark = 'b' | 'i' | 'u' | 'line-through' | 'codeph' | 'sup' | 'sub';
export type MarkMode = 'add' | 'remove' | 'toggle';

export interface TextSpan {
  kind: 'text';
  text: string;
  marks: Set<Mark>;
}

export interface AtomSpan {
  kind: 'atom';
  node: ElementNode;
  length: number;
  marks: Set<Mark>;
}

export type Span = TextSpan | AtomSpan;

const HIGHLIGHT_MARKS = new Set<Mark>(['b', 'i', 'u', 'line-through', 'codeph', 'sup', 'sub']);
const CANONICAL_MARK_ORDER: Mark[] = ['b', 'i', 'u', 'line-through', 'codeph', 'sup', 'sub'];

export function isInlineMark(name: string): name is Mark {
  return HIGHLIGHT_MARKS.has(name as Mark);
}

function cloneMarks(marks: Set<Mark>): Set<Mark> {
  return new Set(marks);
}

function sameMarks(a: Set<Mark>, b: Set<Mark>): boolean {
  if (a.size !== b.size) return false;
  for (const mark of a) if (!b.has(mark)) return false;
  return true;
}

function sortedMarks(marks: Set<Mark>): Mark[] {
  return CANONICAL_MARK_ORDER.filter((mark) => marks.has(mark));
}

export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#x')) {
          const code = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (entity.startsWith('#')) {
          const code = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return whole;
    }
  });
}

function decodedText(node: TextNode): string {
  return node.newText !== undefined ? node.newText : decodeEntities(node.raw);
}

function textLength(nodes: CstNode[]): number {
  let length = 0;
  for (const node of nodes) {
    if (node.type === 'text') length += decodedText(node).length;
    else if (node.type === 'element') length += textLength(node.children);
  }
  return length;
}

export function inlineTextLength(spans: Span[]): number {
  return spans.reduce((total, span) => total + (span.kind === 'text' ? span.text.length : span.length), 0);
}

export function flattenInline(el: ElementNode): Span[] {
  const spans: Span[] = [];
  const walk = (nodes: CstNode[], marks: Set<Mark>): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = decodedText(node);
        if (text !== '') spans.push({ kind: 'text', text, marks: cloneMarks(marks) });
      } else if (node.type === 'element') {
        if (isInlineMark(node.name)) {
          const next = cloneMarks(marks);
          next.add(node.name);
          walk(node.children, next);
        } else {
          spans.push({ kind: 'atom', node, length: textLength(node.children), marks: cloneMarks(marks) });
        }
      }
    }
  };
  walk(el.children, new Set());
  return mergeAdjacentText(spans);
}

function mergeAdjacentText(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (span.kind === 'text' && span.text === '') continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text' && span.kind === 'text' && sameMarks(prev.marks, span.marks)) {
      prev.text += span.text;
    } else {
      out.push(span.kind === 'text' ? { ...span, marks: cloneMarks(span.marks) } : { ...span, marks: cloneMarks(span.marks) });
    }
  }
  return out;
}

function selectedAtom(rangeStart: number, rangeEnd: number, pos: number, length: number): boolean {
  if (length === 0) return rangeStart < rangeEnd && rangeStart <= pos && rangeEnd >= pos;
  return rangeStart <= pos && rangeEnd >= pos + length;
}

function selectedState(spans: Span[], start: number, end: number, mark?: Mark): { any: boolean; allHaveMark: boolean } {
  let pos = 0;
  let any = false;
  let allHaveMark = true;
  for (const span of spans) {
    const len = span.kind === 'text' ? span.text.length : span.length;
    const spanStart = pos;
    const spanEnd = pos + len;
    if (span.kind === 'text') {
      const overlapStart = Math.max(start, spanStart);
      const overlapEnd = Math.min(end, spanEnd);
      if (overlapStart < overlapEnd) {
        const selected = span.text.slice(overlapStart - spanStart, overlapEnd - spanStart);
        if (selected.trim() !== '') {
          any = true;
          if (mark && !span.marks.has(mark)) allHaveMark = false;
        }
      }
    } else if (selectedAtom(start, end, spanStart, len)) {
      any = true;
      if (mark && !span.marks.has(mark)) allHaveMark = false;
    }
    pos = spanEnd;
  }
  return { any, allHaveMark: any && allHaveMark };
}

function withMarkSet(marks: Set<Mark>, mark: Mark, add: boolean): Set<Mark> {
  const next = cloneMarks(marks);
  if (add) next.add(mark);
  else next.delete(mark);
  return next;
}

function clearMarks(marks: Set<Mark>): Set<Mark> {
  return marks.size === 0 ? marks : new Set();
}

export function applyMark(spans: Span[], start: number, end: number, mark: Mark, mode: MarkMode = 'toggle'): Span[] {
  if (!isInlineMark(mark)) throw new Error(`unknown inline mark: ${mark}`);
  const total = inlineTextLength(spans);
  const rangeStart = Math.max(0, Math.min(start, total));
  const rangeEnd = Math.max(0, Math.min(end, total));
  if (rangeStart >= rangeEnd) return mergeAdjacentText(spans);

  const state = selectedState(spans, rangeStart, rangeEnd, mark);
  if (!state.any) return mergeAdjacentText(spans);

  const add = mode === 'add' || (mode === 'toggle' && !state.allHaveMark);
  const remove = mode === 'remove' || (mode === 'toggle' && state.allHaveMark);
  if (!add && !remove) return mergeAdjacentText(spans);

  const out: Span[] = [];
  let pos = 0;
  for (const span of spans) {
    const len = span.kind === 'text' ? span.text.length : span.length;
    const spanStart = pos;
    const spanEnd = pos + len;
    if (span.kind === 'text') {
      const overlapStart = Math.max(rangeStart, spanStart);
      const overlapEnd = Math.min(rangeEnd, spanEnd);
      if (overlapStart <= spanStart || overlapStart >= spanEnd) {
        if (overlapEnd <= spanStart || overlapStart >= spanEnd) {
          out.push({ ...span, marks: cloneMarks(span.marks) });
        } else {
          out.push({ kind: 'text', text: span.text.slice(0, overlapEnd - spanStart), marks: withMarkSet(span.marks, mark, add) });
          const after = span.text.slice(overlapEnd - spanStart);
          if (after !== '') out.push({ kind: 'text', text: after, marks: cloneMarks(span.marks) });
        }
      } else {
        const before = span.text.slice(0, overlapStart - spanStart);
        const selected = span.text.slice(overlapStart - spanStart, overlapEnd - spanStart);
        const after = span.text.slice(overlapEnd - spanStart);
        if (before !== '') out.push({ kind: 'text', text: before, marks: cloneMarks(span.marks) });
        if (selected !== '') out.push({ kind: 'text', text: selected, marks: withMarkSet(span.marks, mark, add) });
        if (after !== '') out.push({ kind: 'text', text: after, marks: cloneMarks(span.marks) });
      }
    } else {
      out.push(selectedAtom(rangeStart, rangeEnd, spanStart, len) ? { ...span, marks: withMarkSet(span.marks, mark, add) } : { ...span, marks: cloneMarks(span.marks) });
    }
    pos = spanEnd;
  }
  return mergeAdjacentText(out);
}

export function rangeMarkState(spans: Span[], start: number, end: number, mark: Mark): { any: boolean; allHaveMark: boolean } {
  if (!isInlineMark(mark)) throw new Error(`unknown inline mark: ${mark}`);
  const total = inlineTextLength(spans);
  const rangeStart = Math.max(0, Math.min(start, total));
  const rangeEnd = Math.max(0, Math.min(end, total));
  if (rangeStart >= rangeEnd) return { any: false, allHaveMark: false };
  return selectedState(spans, rangeStart, rangeEnd, mark);
}

export function removeAllHighlight(spans: Span[], start: number, end: number): Span[] {
  const total = inlineTextLength(spans);
  const rangeStart = Math.max(0, Math.min(start, total));
  const rangeEnd = Math.max(0, Math.min(end, total));
  if (rangeStart >= rangeEnd) return mergeAdjacentText(spans);

  const out: Span[] = [];
  let pos = 0;
  for (const span of spans) {
    const len = span.kind === 'text' ? span.text.length : span.length;
    const spanStart = pos;
    const spanEnd = pos + len;
    if (span.kind === 'text') {
      const overlapStart = Math.max(rangeStart, spanStart);
      const overlapEnd = Math.min(rangeEnd, spanEnd);
      if (overlapStart <= spanStart || overlapStart >= spanEnd) {
        if (overlapEnd <= spanStart || overlapStart >= spanEnd) {
          out.push({ ...span, marks: cloneMarks(span.marks) });
        } else {
          out.push({ kind: 'text', text: span.text.slice(0, overlapEnd - spanStart), marks: clearMarks(span.marks) });
          const after = span.text.slice(overlapEnd - spanStart);
          if (after !== '') out.push({ kind: 'text', text: after, marks: cloneMarks(span.marks) });
        }
      } else {
        const before = span.text.slice(0, overlapStart - spanStart);
        const selected = span.text.slice(overlapStart - spanStart, overlapEnd - spanStart);
        const after = span.text.slice(overlapEnd - spanStart);
        if (before !== '') out.push({ kind: 'text', text: before, marks: cloneMarks(span.marks) });
        if (selected !== '') out.push({ kind: 'text', text: selected, marks: clearMarks(span.marks) });
        if (after !== '') out.push({ kind: 'text', text: after, marks: cloneMarks(span.marks) });
      }
    } else {
      out.push(selectedAtom(rangeStart, rangeEnd, spanStart, len) ? { ...span, marks: clearMarks(span.marks) } : { ...span, marks: cloneMarks(span.marks) });
    }
    pos = spanEnd;
  }
  return mergeAdjacentText(out);
}

function nodesForSpan(span: Span): CstNode[] {
  if (span.kind === 'text') return span.text === '' ? [] : [makeText(span.text)];
  return [span.node];
}

function wrapNodesWithMarks(nodes: CstNode[], marks: Set<Mark>): CstNode[] {
  const ordered = sortedMarks(marks);
  if (ordered.length === 0 || nodes.length === 0) return nodes;
  let wrapped = nodes;
  for (let i = ordered.length - 1; i >= 0; i--) {
    wrapped = [makeElement(ordered[i], [], wrapped)];
  }
  return wrapped;
}

export function rebuildInline(spans: Span[]): CstNode[] {
  const merged = mergeAdjacentText(spans);
  const out: CstNode[] = [];
  let i = 0;
  while (i < merged.length) {
    const marks = merged[i].marks;
    const groupNodes: CstNode[] = [];
    while (i < merged.length && sameMarks(merged[i].marks, marks)) {
      groupNodes.push(...nodesForSpan(merged[i]));
      i++;
    }
    out.push(...wrapNodesWithMarks(groupNodes, marks));
  }
  return out;
}

export function setInlineChildren(el: ElementNode, children: CstNode[]): void {
  for (const child of children) child.parent = el;
  el.children = children;
  el.selfClosing = false;
  markDirty(el);
}

export function applyInlineMark(
  source: string,
  blockId: string,
  start: number,
  end: number,
  mark: Mark,
  mode: MarkMode = 'toggle',
): string {
  const doc = parse(source);
  const el = findElementById(doc, blockId);
  if (!el) throw new Error(`inline mark target not found: ${blockId}`);
  const spans = flattenInline(el);
  const next = applyMark(spans, start, end, mark, mode);
  const before = serializeSpans(spans);
  const after = serializeSpans(next);
  if (before === after) return source;
  setInlineChildren(el, rebuildInline(next));
  return serialize(doc);
}

export function removeInlineStyles(source: string, blockId: string, start: number, end: number): string {
  const doc = parse(source);
  const el = findElementById(doc, blockId);
  if (!el) throw new Error(`inline style target not found: ${blockId}`);
  const spans = flattenInline(el);
  const next = removeAllHighlight(spans, start, end);
  const before = serializeSpans(spans);
  const after = serializeSpans(next);
  if (before === after) return source;
  setInlineChildren(el, rebuildInline(next));
  return serialize(doc);
}

function serializeSpans(spans: Span[]): string {
  return spans
    .map((span) => {
      const marks = sortedMarks(span.marks).join(',');
      return span.kind === 'text' ? `t:${marks}:${span.text}` : `a:${marks}:${span.node.range.start}:${span.node.range.end}`;
    })
    .join('|');
}

function charAt(text: string, index: number): string {
  return index >= 0 && index < text.length ? text[index] : '';
}

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}_]/u.test(ch);
}

export function expandWordRange(text: string, offset: number): { start: number; end: number } {
  const pos = Math.max(0, Math.min(offset, text.length));
  let seed = pos;
  if (!isWordChar(charAt(text, seed)) && isWordChar(charAt(text, seed - 1))) seed = pos - 1;
  if (!isWordChar(charAt(text, seed))) return { start: pos, end: pos };

  let start = seed;
  while (start > 0 && isWordChar(charAt(text, start - 1))) start--;
  let end = seed + 1;
  while (end < text.length && isWordChar(charAt(text, end))) end++;
  return { start, end };
}
