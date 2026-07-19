// Rendered-text extraction for the workspace topic search.
//
// Mirrors the canvas renderer's text semantics (src/render/to-html.ts): entities
// decoded, layout whitespace collapsed outside line-preserving contexts,
// comments/PIs/declarations/CDATA and attribute values excluded, block elements
// separated so a match can never span two paragraphs. Every rendered UTF-16 unit
// records the source range that produced it, so a match offset can be handed
// straight to the scroll-anchor pipeline (src/host/scroll-handoff.ts).

import { parse } from '../cst/parse';
import { findElement } from '../cst/query';
import type { CstNode, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { LINE_PRESERVING_ELEMENTS } from '../render/to-html';

export interface RenderedTextIndex {
  /** Decoded, collapse-normalized rendered text. `'\n'` marks block boundaries. */
  text: string;
  /** Per UTF-16 unit: inclusive source start of the producing range. */
  sourceStarts: number[];
  /** Per UTF-16 unit: exclusive source end of the producing range. */
  sourceEnds: number[];
}

/** Elements whose text flows inline with their siblings; everything else is a
 *  block boundary. A conservative approximation of the renderer's inline set —
 *  misclassifying an inline element as block only suppresses cross-element
 *  matches, it never corrupts offsets. */
const INLINE_ELEMENTS = new Set([
  'b', 'i', 'u', 'sub', 'sup', 'tt', 'ph', 'codeph', 'uicontrol', 'userinput',
  'systemoutput', 'varname', 'filepath', 'apiname', 'cmdname', 'wintitle',
  'menucascade', 'term', 'cite', 'q', 'keyword', 'option', 'parmname', 'synph',
  'xref', 'fn',
]);

/** Same alternation as decodeEntities (src/cst/inline-marks.ts) — the two must
 *  stay in lockstep so search text matches what the canvas shows. */
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;

function decodeEntity(entity: string): string | null {
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
    default: {
      const code = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code)) return null;
      try {
        return String.fromCodePoint(code);
      } catch {
        return null; // out-of-range code point: keep the raw entity text
      }
    }
  }
}

class IndexBuilder {
  readonly chars: string[] = [];
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  private pendingSpace: { start: number; end: number } | null = null;
  private preserveDepth = 0;

  get preserved(): boolean {
    return this.preserveDepth > 0;
  }

  enterPreserve(): void {
    this.preserveDepth += 1;
  }

  leavePreserve(): void {
    this.preserveDepth -= 1;
  }

  private emit(units: string, start: number, end: number): void {
    for (const unit of units) {
      // for..of iterates code points; push each UTF-16 unit with the same range.
      for (let i = 0; i < unit.length; i += 1) {
        this.chars.push(unit[i]);
        this.starts.push(start);
        this.ends.push(end);
      }
    }
  }

  private flushPendingSpace(): void {
    if (!this.pendingSpace) return;
    const range = this.pendingSpace;
    this.pendingSpace = null;
    const last = this.chars[this.chars.length - 1];
    if (this.chars.length > 0 && last !== '\n') this.emit(' ', range.start, range.end);
  }

  /** Decoded characters that always render (entity output, preserved text). */
  private emitVerbatim(units: string, start: number, end: number): void {
    this.flushPendingSpace();
    this.emit(units, start, end);
  }

  /** Raw text-node content: decode entities and collapse layout whitespace
   *  (literal whitespace only — entity-encoded whitespace renders verbatim,
   *  matching the renderer which collapses the raw source form). */
  text(raw: string, base: number): void {
    ENTITY_PATTERN.lastIndex = 0;
    let cursor = 0;
    const segment = (upto: number): void => {
      for (let i = cursor; i < upto; i += 1) {
        const ch = raw[i];
        if (!this.preserved && /[ \t\r\n]/.test(ch)) {
          if (!this.pendingSpace) this.pendingSpace = { start: base + i, end: base + i + 1 };
          else this.pendingSpace.end = base + i + 1;
        } else {
          this.emitVerbatim(ch, base + i, base + i + 1);
        }
      }
    };
    for (let match = ENTITY_PATTERN.exec(raw); match; match = ENTITY_PATTERN.exec(raw)) {
      segment(match.index);
      const decoded = decodeEntity(match[1]);
      if (decoded !== null) {
        this.emitVerbatim(decoded, base + match.index, base + match.index + match[0].length);
      } else {
        cursor = match.index;
        segment(match.index + match[0].length);
      }
      cursor = match.index + match[0].length;
    }
    segment(raw.length);
    cursor = raw.length;
  }

  /** Block-element boundary: drop pending layout whitespace and emit a single
   *  `'\n'` separator anchored at the element's tag start. */
  blockBoundary(tagStart: number): void {
    this.pendingSpace = null;
    const last = this.chars[this.chars.length - 1];
    if (this.chars.length > 0 && last !== '\n') this.emit('\n', tagStart, tagStart + 1);
  }

  build(): RenderedTextIndex {
    return { text: this.chars.join(''), sourceStarts: this.starts, sourceEnds: this.ends };
  }
}

function preservesText(el: ElementNode): boolean {
  if (LINE_PRESERVING_ELEMENTS.has(el.name)) return true;
  return el.attrs.some((a) => a.name === 'xml:space' && a.value === 'preserve');
}

function visit(node: CstNode, builder: IndexBuilder): void {
  if (node.type === 'text') {
    builder.text(node.newText !== undefined ? node.newText : node.raw, node.range.start);
    return;
  }
  if (!isElement(node)) return; // comments, PIs, xmldecl, doctype, cdata: not rendered
  const inline = INLINE_ELEMENTS.has(node.name);
  if (!inline) builder.blockBoundary(node.openTagRange.start);
  const preserve = preservesText(node);
  if (preserve) builder.enterPreserve();
  for (const child of node.children) visit(child, builder);
  if (preserve) builder.leavePreserve();
  if (!inline) builder.blockBoundary(node.closeTagRange?.start ?? node.openTagRange.start);
}

/** Extract the rendered text of a DITA source with per-char source ranges.
 *  Throws ParseError on malformed XML (same contract as parse()). */
export function extractRenderedText(source: string): RenderedTextIndex {
  const doc = parse(source);
  const builder = new IndexBuilder();
  for (const child of doc.children) visit(child, builder);
  return builder.build();
}

/** Rendered text of the document's first <title>, for result group headers. */
export function documentTitle(source: string): string | null {
  const doc = parse(source);
  const title = findElement(doc, 'title');
  if (!title) return null;
  const builder = new IndexBuilder();
  for (const child of title.children) visit(child, builder);
  const text = builder.build().text.replace(/\n+/g, ' ').replace(/ +/g, ' ').trim();
  return text === '' ? null : text;
}
