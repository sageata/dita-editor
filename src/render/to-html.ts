// DITA CST -> HTML emitting DITA-OT 4.2.1 class names so configured workspace
// stylesheets and the built-in neutral theme can share the published selector
// contract. This is the render core shared by
// the read-only preview and the editable canvas.
//
// Fidelity target is the *tag + class contract*, verified against verbatim
// DITA-OT output in test/render.test.ts — NOT full-document byte parity.
// Deliberate, documented divergences from DITA-OT (better for an editing canvas,
// or not worth replicating):
//   - <shortdesc> is rendered where it sits in source, not hoisted into the body.
//   - <image placement="break"> inside a cell renders in place, not extracted to
//     a sibling <figure>.
//   - <title>/ariaid-title accessibility ids are not generated.
//
// Table cells DO get screen-reader header associations (WCAG H43): thead cells emit
// scope="col"/"colgroup" + a generated id; tbody cells emit headers="<col header ids>"
// resolved span-aware via the grid model. These attributes are RENDER-ONLY — never
// written back to the .dita source, so byte-exactness is unaffected.
//
// When given an editIds map (renderEditable), editable text leaves get
// contenteditable + data-edit-id so the host can map an edit back to a CST node.

import type { CstNode, Document, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { imageDimensionError } from '../commands/attr-validity';
import { childrenNamed, firstChildNamed } from '../cst/query';
import {
  editableElementIds,
  isEditableInlinePhraseRun,
  isInlineHtmlEditable,
  mixedEditableParents,
} from '../cst/text-targets';
import { structuralIds, tableCellIds } from '../cst/element-ids';
import { computeGrid, gridCellFor, isGridValid } from '../cst/table-grid';
import type { GridCell, TableGrid } from '../cst/table-grid';

/** Per-table accessibility header wiring, resolved span-aware from the grid. Null
 *  for header-less or malformed tables (then no scope/headers= is emitted). */
interface TableA11y {
  cellGrid: Map<ElementNode, GridCell>;
  /** thead entry -> its generated id (referenced by data cells' headers=). */
  headerId: Map<ElementNode, string>;
  /** thead entry -> 'col' (single column) or 'colgroup' (spans columns). */
  headerScope: Map<ElementNode, string>;
  /** 1-based column -> header ids covering it (thead-row order). */
  columnHeaders: Map<number, string[]>;
}

interface ColumnRenderAttrs {
  style: string;
  source: string;
}

/** F1/F3/F4: per-table CALS presentation context, resolved once per table so
 *  entry() can apply the entry → colspec → tgroup/table precedence chain. */
interface TablePresentation {
  cols: number;
  /** True when every colspec is positional (canonical c1..cN) so an entry's
   *  index within a span-free row IS its column number (grid-less fallback). */
  positional: boolean;
  colAlign: Map<number, string>;
  colColsep: Map<number, string>;
  colRowsep: Map<number, string>;
  defColsep?: string;
  defRowsep?: string;
  defAlign?: string;
}

const SEP_VALUES = new Set(['0', '1']);
const ALIGN_VALUES = new Set(['left', 'right', 'center', 'justify']);
const IMAGE_ALIGN_VALUES = new Set(['left', 'center', 'right']);
const VALIGN_VALUES = new Set(['top', 'middle', 'bottom']);

/** The value when it is a member of the closed CALS set, else undefined (an
 *  out-of-enum value renders nothing rather than leaking into a style attr). */
function presEnum(value: string | undefined, allowed: Set<string>): string | undefined {
  return value !== undefined && allowed.has(value) ? value : undefined;
}

function buildTablePresentation(
  table: ElementNode,
  tgroup: ElementNode,
  colspecs: ElementNode[],
): TablePresentation {
  const colAlign = new Map<number, string>();
  const colColsep = new Map<number, string>();
  const colRowsep = new Map<number, string>();
  colspecs.forEach((cs, i) => {
    const num = Number(attr(cs, 'colnum') ?? String(i + 1)) || i + 1;
    const align = presEnum(attr(cs, 'align'), ALIGN_VALUES);
    const colsep = presEnum(attr(cs, 'colsep'), SEP_VALUES);
    const rowsep = presEnum(attr(cs, 'rowsep'), SEP_VALUES);
    if (align) colAlign.set(num, align);
    if (colsep) colColsep.set(num, colsep);
    if (rowsep) colRowsep.set(num, rowsep);
  });
  return {
    cols: Number(attr(tgroup, 'cols') ?? '0') || colspecs.length,
    positional: true,
    colAlign,
    colColsep,
    colRowsep,
    defColsep: presEnum(attr(tgroup, 'colsep'), SEP_VALUES) ?? presEnum(attr(table, 'colsep'), SEP_VALUES),
    defRowsep: presEnum(attr(tgroup, 'rowsep'), SEP_VALUES) ?? presEnum(attr(table, 'rowsep'), SEP_VALUES),
    defAlign: presEnum(attr(tgroup, 'align'), ALIGN_VALUES),
  };
}

const TOPIC_ROOTS = new Set(['topic', 'concept', 'task', 'reference']);
const LINE_PRESERVING_ELEMENTS = new Set(['lines', 'codeblock', 'pre', 'msgblock', 'screen']);
const BODY_CLASS: Record<string, string> = {
  body: 'body',
  conbody: 'body conbody',
  taskbody: 'body taskbody',
  refbody: 'body refbody',
};

export interface RenderOptions {
  /** Element -> edit id; present elements get contenteditable + data-edit-id. */
  editIds?: Map<ElementNode, string>;
  /** Element -> structural id+kind; present elements get data-struct-id/kind. */
  structIds?: Map<ElementNode, { id: string; kind: string }>;
  /** Block-mixed parent -> its id; each direct text run renders as an editable
   *  span (`<parentId>:t<index>`) while nested block children stay static. */
  textRunParents?: Map<ElementNode, string>;
  /** Every <entry> -> its id; stamped as data-cell-id so the client can address
   *  any cell for merge/split. */
  cellIds?: Map<ElementNode, string>;
  /** Edit id of an element to mark data-autofocus (focus after a structural add). */
  autofocusId?: string | null;
  /** Cache-bust token appended (`?v=…`) to non-empty image src, so a replaced/removed
   *  image on disk re-fetches on each open/reload instead of serving a stale webview
   *  cache. Stable within a session (no re-fetch on rerender), changes across reloads.
   *  RENDER-ONLY — never written to the .dita. */
  imageVersion?: string | null;
  /** Element(table) -> derived accessible name (aria-label) for tables that have no
   *  <table><title>. renderDocument defaults this to deriveTableNames(doc), so the
   *  read-only preview AND the editable canvas both name their tables; render-only. */
  tableNames?: Map<ElementNode, string>;
}

function attr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function escapeRawAttrValue(value: string): string {
  return value.replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function ditaImageDimensionCss(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || imageDimensionError(trimmed)) return null;
  return /[A-Za-z]$/.test(trimmed) ? trimmed : `${trimmed}px`;
}

export function escapeTextValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function starColumnWidth(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !text.includes('*')) return null;
  const units = text.replace(/\*/g, '').trim();
  const parsed = units === '' ? 1 : Number(units);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function columnRenderAttrs(colspecs: ElementNode[]): ColumnRenderAttrs[] {
  const starWidths = colspecs.map((colspec) => starColumnWidth(attr(colspec, 'colwidth')));
  const starTotal = starWidths.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return colspecs.map((colspec, index) => {
    const colwidth = attr(colspec, 'colwidth')?.trim() ?? '';
    const star = starWidths[index];
    if (star != null && starTotal > 0) {
      return {
        style: `width:${(star / starTotal) * 100}%`,
        source: colwidth,
      };
    }
    return {
      style: colwidth && !colwidth.includes('*') ? `width:${colwidth}` : '',
      source: colwidth,
    };
  });
}

function collapseXmlLayoutWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, ' ');
}

function atomAttrData(el: ElementNode): string {
  if (el.attrs.length === 0) return '';
  const attrs = el.attrs.map((a) => ({ name: a.name, value: a.value }));
  return ` data-attrs="${encodeURIComponent(JSON.stringify(attrs))}"`;
}

/** Plain text of a <title> element, escaped for use in an HTML attribute value
 *  (aria-label). Inline markup is stripped to text; source entity-encoding is kept
 *  valid for an attribute (newText is fully escaped; raw is already &-encoded, so
 *  only a stray `"` needs escaping). */
function titleAttrText(titleEl: ElementNode): string {
  let out = '';
  const visit = (n: CstNode): void => {
    if (n.type === 'text') {
      out += n.newText !== undefined ? escapeAttrValue(n.newText) : n.raw.replace(/"/g, '&quot;');
    } else if (isElement(n)) {
      for (const c of n.children) visit(c);
    }
  };
  for (const c of titleEl.children) visit(c);
  return out.replace(/\s+/g, ' ').trim();
}

/** Per-table accessible name for both render surfaces (read-only preview + editing canvas). Corpus tables carry no
 *  <table><title> (so caption-from-title emits nothing), which leaves real tables
 *  anonymous to assistive tech. Derive a non-empty name from the nearest
 *  topic/section <title> plus the table's 1-based document position (the positional
 *  ordinal both disambiguates the common many-tables-per-topic case and serves as the
 *  fallback when no ancestor title exists). The value is pre-escaped for an attribute.
 *  Render-only — emitted as aria-label, never written back to the .dita. */
function deriveTableNames(doc: Document): Map<ElementNode, string> {
  const names = new Map<ElementNode, string>();
  let ordinal = 0;
  const walk = (node: CstNode, context: string): void => {
    if (!isElement(node)) return;
    let ctx = context;
    if (TOPIC_ROOTS.has(node.name) || node.name === 'section') {
      const titleEl = firstChildNamed(node, 'title');
      const text = titleEl ? titleAttrText(titleEl) : '';
      if (text) ctx = text;
    }
    if (node.name === 'table') {
      ordinal += 1;
      names.set(node, ctx ? `${ctx}, table ${ordinal}` : `Table ${ordinal}`);
    }
    for (const child of node.children) walk(child, ctx);
  };
  for (const child of doc.children) walk(child, '');
  return names;
}

class HtmlRenderer {
  constructor(
    private readonly editIds: Map<ElementNode, string> | null,
    private readonly structIds: Map<ElementNode, { id: string; kind: string }> | null,
    private readonly textRunParents: Map<ElementNode, string> | null,
    private readonly cellIds: Map<ElementNode, string> | null,
    private readonly autofocusId: string | null,
    private readonly imageVersion: string | null = null,
    private readonly tableNames: Map<ElementNode, string> | null = null,
  ) {}

  /** Monotonic counter for unique table-header ids across the whole document. */
  private headerSeq = 0;

  private preserveTextDepth = 0;

  private textPreserved(): boolean {
    return this.preserveTextDepth > 0;
  }

  private preservesText(el: ElementNode): boolean {
    return LINE_PRESERVING_ELEMENTS.has(el.name) || attr(el, 'xml:space') === 'preserve';
  }

  private withTextPreservation<T>(preserve: boolean, render: () => T): T {
    if (!preserve) return render();
    this.preserveTextDepth += 1;
    try {
      return render();
    } finally {
      this.preserveTextDepth -= 1;
    }
  }

  /** Editable attributes for an element, or '' when not editable. */
  private editAttr(el: ElementNode): string {
    const id = this.editIds?.get(el);
    if (!id) return '';
    const autofocus = this.autofocusId && this.autofocusId === id ? ' data-autofocus="true"' : '';
    const inlineHtml = isInlineHtmlEditable(el) ? ' data-inline-html="true"' : '';
    return ` contenteditable="true" data-edit-id="${id}"${inlineHtml} spellcheck="false"${autofocus}`;
  }

  /** Structural attributes for an element, or '' when not a structural target. */
  private structAttr(el: ElementNode): string {
    const s = this.structIds?.get(el);
    if (!s) return '';
    const outputclass = attr(el, 'outputclass');
    const outputAttr = outputclass ? ` data-outputclass="${escapeAttrValue(outputclass)}"` : '';
    return ` data-struct-id="${s.id}" data-struct-kind="${s.kind}"${outputAttr}`;
  }

  private tableResizeAttr(el: ElementNode, columnCount: number, hasColumnWidths: boolean): string {
    if (!this.editIds || columnCount < 2) return '';
    const id = this.structIds?.get(el)?.id;
    if (!id) return '';
    const authored = hasColumnWidths ? ' data-table-has-colwidths="true"' : '';
    return ` data-table-resizable="true" data-table-id="${id}"${authored}`;
  }

  private classAttr(el: ElementNode, base: string): string {
    const outputclass = attr(el, 'outputclass');
    const value = outputclass ? `${base} ${outputclass}` : base;
    return ` class="${escapeAttrValue(value)}"`;
  }

  /** Deterministic selection hooks so canvas.js can target selectable units without
   *  guessing selectors. Editable render only (gated on editIds, like data-edit-id);
   *  the id itself rides on the existing data-edit-id/data-struct-id/data-cell-id.
   *  Render-only — never written back to the .dita, so byte-exactness is unaffected.
   *  Deliberately NOT aria-selected: that is invalid on native <li>/<td> roles and is
   *  set dynamically by canvas.js only where a valid role permits it (see P0-3). */
  private selectionAttr(kind: 'block' | 'cell' | 'header' | 'image'): string {
    return this.editIds ? ` data-selectable data-selection-kind="${kind}"` : '';
  }

  node(node: CstNode): string {
    if (node.type === 'text') {
      const text = node.newText !== undefined ? escapeTextValue(node.newText) : node.raw;
      return this.textPreserved() ? text : collapseXmlLayoutWhitespace(text);
    }
    if (isElement(node)) return this.element(node);
    return ''; // comments, PIs, xmldecl, doctype, cdata: not part of the canvas
  }

  private children(el: ElementNode): string {
    const runParentId = this.textRunParents?.get(el);
    const html = runParentId !== undefined
      ? this.mixedChildren(el, runParentId)
      : el.children.map((child) => this.node(child)).join('');
    return this.textPreserved() ? html : html.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
  }

  private editableBody(el: ElementNode, label: string): { attrs: string; html: string } {
    const html = this.children(el);
    if (html !== '' || !this.editIds?.get(el)) return { attrs: '', html };
    return {
      attrs: ` data-empty-placeholder="${label}"`,
      html: '<br data-empty-caret="true" aria-hidden="true">',
    };
  }

  /** Render a block-mixed parent: each non-whitespace direct text run becomes an
   *  independent editable span. Direct inline phrase children are also editable
   *  runs, so formatting text in a parent list item does not freeze that text. */
  private mixedChildren(el: ElementNode, parentId: string): string {
    return el.children
      .map((child, idx) => {
        if (child.type === 'text' && (child.newText ?? child.raw).trim() !== '') {
          const id = `${parentId}:t${idx}`;
          const autofocus = this.autofocusId && this.autofocusId === id ? ' data-autofocus="true"' : '';
          return `<span contenteditable="true" data-edit-id="${id}" data-edit-run spellcheck="false"${autofocus}>${this.node(child).trim()}</span>`;
        }
        if (isElement(child) && isEditableInlinePhraseRun(child)) {
          return this.editableInlinePhrase(child, `${parentId}:t${idx}`);
        }
        return this.node(child);
      })
      .join('');
  }

  private editRunAttr(id: string, inlineHtml = false): string {
    const autofocus = this.autofocusId && this.autofocusId === id ? ' data-autofocus="true"' : '';
    const html = inlineHtml ? ' data-inline-html="true"' : '';
    return ` contenteditable="true" data-edit-id="${id}" data-edit-run spellcheck="false"${html}${autofocus}`;
  }

  private editableInlinePhrase(el: ElementNode, id: string): string {
    const attrs = this.editRunAttr(id, el.children.some(isElement));
    switch (el.name) {
      case 'codeph':
        return `<code${this.classAttr(el, 'ph codeph')}${attrs}>${this.children(el)}</code>`;
      case 'b':
        return `<strong${this.classAttr(el, 'ph b')}${attrs}>${this.children(el)}</strong>`;
      case 'i':
        return `<em${this.classAttr(el, 'ph i')}${attrs}>${this.children(el)}</em>`;
      case 'u':
        return `<u${this.classAttr(el, 'ph u')}${attrs}>${this.children(el)}</u>`;
      case 'line-through':
        return `<span${this.classAttr(el, 'ph line-through')} style="text-decoration:line-through"${attrs}>${this.children(el)}</span>`;
      case 'sub':
        return `<sub${this.classAttr(el, 'ph sub')}${attrs}>${this.children(el)}</sub>`;
      case 'sup':
        return `<sup${this.classAttr(el, 'ph sup')}${attrs}>${this.children(el)}</sup>`;
      default:
        return `<span${this.classAttr(el, el.name)}${attrs}>${this.children(el)}</span>`;
    }
  }

  private element(el: ElementNode): string {
    return this.withTextPreservation(this.preservesText(el), () => this.renderElement(el));
  }

  private renderElement(el: ElementNode): string {
    if (TOPIC_ROOTS.has(el.name)) {
      return `<article role="article"${this.classAttr(el, `nested0 ${el.name}`)}>${this.children(el)}</article>`;
    }
    if (el.name in BODY_CLASS) {
      return `<div${this.classAttr(el, BODY_CLASS[el.name])}>${this.children(el)}</div>`;
    }
    const ed = this.editAttr(el);
    switch (el.name) {
      case 'title':
        // structAttr stamps data-struct-id + data-struct-kind="title" (editable render) so the
        // canvas can target the title structurally (e.g. deleteTitle). Render-only; read-only
        // preview supplies no structIds, so structAttr emits nothing (serialization byte-exact).
        return `<h1${this.classAttr(el, 'title topictitle1')}${ed}${this.structAttr(el)}>${this.children(el)}</h1>`;
      case 'shortdesc':
        // structAttr stamps data-struct-id + data-struct-kind="shortdesc" (editable render) so the
        // canvas can target the short description structurally. Render-only; read-only preview
        // supplies no structIds, so structAttr emits nothing (serialization byte-exact).
        return `<p${this.classAttr(el, 'shortdesc')}${ed}${this.structAttr(el)}>${this.children(el)}</p>`;
      case 'p': {
        const body = this.editableBody(el, 'Empty paragraph');
        return `<p${this.classAttr(el, 'p')}${ed}${this.structAttr(el)}${this.selectionAttr('block')}${body.attrs}>${body.html}</p>`;
      }
      case 'ul':
        // structAttr stamps data-struct-id + data-struct-kind="ul" (editable render) so the
        // canvas can target "delete this whole list" (deleteList). Render-only; read-only
        // preview supplies no structIds, so structAttr emits nothing.
        return `<ul${this.classAttr(el, 'ul')}${this.structAttr(el)}>${this.children(el)}</ul>`;
      case 'ol':
        return `<ol${this.classAttr(el, 'ol')}${this.structAttr(el)}>${this.children(el)}</ol>`;
      case 'li': {
        const body = this.editableBody(el, 'Empty list item');
        return `<li${this.classAttr(el, 'li')}${ed}${this.structAttr(el)}${this.selectionAttr('block')}${body.attrs}>${body.html}</li>`;
      }
      case 'lines':
        // Line-preserving block: <pre> keeps source newlines visible without any
        // whitespace munging (CST text nodes are already verbatim). Wired with the
        // SAME edit/struct/selection attrs as <p>/<li> so editability + addressability
        // stay consistent (the editIds/structIds maps gate what is actually stamped).
        return `<pre${this.classAttr(el, 'lines')}${ed}${this.structAttr(el)}${this.selectionAttr('block')}>${this.children(el)}</pre>`;
      case 'codeph':
        return `<code${this.classAttr(el, 'ph codeph')}>${this.children(el)}</code>`;
      // Inline/phrase formatting (DITA-OT tag+class contract): bold/italic/underline/line-through/sub/sup. Emitted by the
      // inline-formatting op; rendering them here makes the markup visible and round-trips via serialize.
      case 'b':
        return `<strong${this.classAttr(el, 'ph b')}>${this.children(el)}</strong>`;
      case 'i':
        return `<em${this.classAttr(el, 'ph i')}>${this.children(el)}</em>`;
      case 'u':
        return `<u${this.classAttr(el, 'ph u')}>${this.children(el)}</u>`;
      case 'line-through':
        return `<span${this.classAttr(el, 'ph line-through')} style="text-decoration:line-through">${this.children(el)}</span>`;
      case 'sub':
        return `<sub${this.classAttr(el, 'ph sub')}>${this.children(el)}</sub>`;
      case 'sup':
        return `<sup${this.classAttr(el, 'ph sup')}>${this.children(el)}</sup>`;
      case 'xref': {
        // Cross-reference (DITA-OT tag+class contract: <a class="xref">). The @href is intentionally
        // NOT emitted so a click in the editing canvas never navigates away; the label renders inline.
        // An empty xref shows its href as a render-only label so a freshly-inserted link is visible.
        const target = attr(el, 'href') ?? '';
        const body = el.children.length > 0 ? this.children(el) : escapeAttrValue(target).replace(/&quot;/g, '"');
        const data = this.editIds ? ` data-dita="xref" data-href="${escapeRawAttrValue(target)}"${atomAttrData(el)}` : '';
        return `<a${this.classAttr(el, 'xref')}${data}>${body}</a>`;
      }
      case 'ph': {
        // Phrase. A conref'd phrase (content pulled from elsewhere) renders a visible render-only chip
        // showing the target so a freshly-inserted reuse reference is not an invisible empty span.
        const conref = attr(el, 'conref');
        if (conref && el.children.length === 0) {
          const label = escapeAttrValue(conref).replace(/&quot;/g, '"');
          const data = this.editIds ? ` data-dita="ph" data-conref="${escapeRawAttrValue(conref)}"${atomAttrData(el)}` : '';
          const atomic = this.editIds ? ' contenteditable="false"' : '';
          return `<span${this.classAttr(el, 'ph conref-ref')}${data}${atomic} title="Reused content: ${escapeAttrValue(conref)}">↪ ${label}</span>`;
        }
        const data = this.editIds ? ` data-dita="ph"${atomAttrData(el)}` : '';
        return `<span${this.classAttr(el, 'ph')}${data}>${this.children(el)}</span>`;
      }
      case 'codeblock':
        // Preformatted code block: <pre> preserves source whitespace/newlines (text nodes are verbatim).
        // Wired with the same edit/struct/selection attrs as <p>/<lines> so it is editable + addressable.
        return `<pre${this.classAttr(el, 'pre codeblock')}${ed}${this.structAttr(el)}${this.selectionAttr('block')}>${this.children(el)}</pre>`;
      case 'note':
        // A note may contain direct text or block children. Direct text notes use the note itself as
        // the editable leaf; block notes keep their child <p>, etc. as the editable surfaces.
        return `<div${this.classAttr(el, 'note note_note')}${ed}${this.structAttr(el)}>${this.children(el)}</div>`;
      case 'fig':
        // P1-2b: data-struct-id + data-struct-kind="fig" (editable render) make a figure an insert anchor.
        return `<figure${this.classAttr(el, 'fig fignone')}${this.structAttr(el)}>${this.children(el)}</figure>`;
      case 'image':
        return this.image(el);
      case 'table':
        return this.table(el);
      case 'section':
        // structAttr stamps data-struct-id + data-struct-kind="section" (editable render) so the
        // canvas can target a whole section structurally. Render-only; read-only emits nothing.
        return `<section${this.classAttr(el, 'section')}${this.structAttr(el)}>${this.children(el)}</section>`;
      case 'steps':
        return `<ol${this.classAttr(el, 'ol steps')}>${this.children(el)}</ol>`;
      case 'step':
        return `<li${this.classAttr(el, 'li step stepexpand')}>${this.children(el)}</li>`;
      case 'cmd':
        return `<span${this.classAttr(el, 'ph cmd')}${ed}${this.structAttr(el)}>${this.children(el)}</span>`;
      case 'info':
        return `<div${this.classAttr(el, 'itemgroup info')}>${this.children(el)}</div>`;
      default:
        return `<span${this.classAttr(el, el.name)}>${this.children(el)}</span>`;
    }
  }

  private image(el: ElementNode): string {
    const href = attr(el, 'href') ?? '';
    const width = ditaImageDimensionCss(attr(el, 'width'));
    const height = ditaImageDimensionCss(attr(el, 'height'));
    const placement = attr(el, 'placement');
    const authoredAlign = presEnum(attr(el, 'align'), IMAGE_ALIGN_VALUES);
    const align = placement === 'break' ? authoredAlign : undefined;
    const authoredAlt = firstChildNamed(el, 'alt');
    // alt: authored DITA <alt> wins. Without it, a non-empty href falls back to the file's
    // basename (so a broken/missing image has a label), and an empty href becomes "Empty image"
    // at parity with the "Empty paragraph/cell" placeholders. RENDER-ONLY — never written back.
    const alt = authoredAlt ? titleAttrText(authoredAlt) : escapeAttrValue(href ? (href.split(/[\\/]/).pop() ?? '') : 'Empty image');
    // Cache-bust only a non-empty href (keep src="" so the empty-image CSS still matches).
    const src = href && this.imageVersion ? `${href}?v=${this.imageVersion}` : href;
    // structAttr stamps data-struct-id + data-struct-kind="image" (IMG-1) when renderEditable
    // supplies the id, so canvas can re-resolve/restore an image selection after a rerender.
    // Render-only; image() bypasses structAttr otherwise, so without this an image has no id.
    const data = this.editIds
      ? ` data-dita="image" data-href="${escapeRawAttrValue(href)}" data-authored-align="${authoredAlign ?? ''}" data-authored-placement="${escapeAttrValue(placement ?? '')}"${atomAttrData(el)}`
      : '';
    const imageStyles: string[] = [];
    if (align) {
      imageStyles.push('display:block');
      if (align === 'left') imageStyles.push('margin-right:auto');
      if (align === 'center') imageStyles.push('margin-left:auto', 'margin-right:auto');
      if (align === 'right') imageStyles.push('margin-left:auto');
    }
    if (width || height) imageStyles.push(`width:${escapeAttrValue(width ?? 'auto')}`, `height:${escapeAttrValue(height ?? 'auto')}`);
    const size = imageStyles.length ? ` style="${imageStyles.join(';')}"` : '';
    return `<img${this.classAttr(el, 'image')} src="${escapeAttrValue(src)}" alt="${alt}"${size}${data}${this.structAttr(el)}${this.selectionAttr('image')}>`;
  }

  private table(el: ElementNode): string {
    // P1-2b: structAttr stamps data-struct-id + data-struct-kind="table" (editable render) so the
    // canvas can target "insert after this table". Render-only; applies to both <table> forms below.
    const frame = attr(el, 'frame');
    const tableClass = frame ? `table frame-${frame}` : 'table';
    // Accessible name: a real <table><title> renders to <caption> (a native name). When
    // there is no title (the whole corpus) emit a derived aria-label instead so the table
    // is not anonymous to AT — but only when there is no caption, so a caption always wins.
    // tableNames is derived in renderDocument (read-only preview + editable canvas); render-only, not serialized.
    const title = firstChildNamed(el, 'title');
    const derivedName = !title ? this.tableNames?.get(el) : undefined;
    const ariaName = derivedName ? ` aria-label="${derivedName}"` : '';
    const tgroup = firstChildNamed(el, 'tgroup');
    if (!tgroup) return `<table${this.classAttr(el, tableClass)}${ariaName}${this.structAttr(el)}>${this.children(el)}</table>`;

    const colspecs = childrenNamed(tgroup, 'colspec');
    const columns = columnRenderAttrs(colspecs);
    const hasColumnWidths = columns.some((col) => col.source !== '');
    const colgroup = `<colgroup>${columns.map((col, index) => {
      const style = col.style ? ` style="${escapeAttrValue(col.style)}"` : '';
      const resizeData = this.editIds
        ? ` data-col-index="${index}"${col.source ? ` data-colwidth="${escapeAttrValue(col.source)}"` : ''}`
        : '';
      return `<col${style}${resizeData}>`;
    }).join('')}</colgroup>`;

    const grid = this.tableGrid(tgroup);
    const a11y = grid && isGridValid(grid) ? this.buildTableA11y(grid) : null;
    const pres = buildTablePresentation(el, tgroup, colspecs);
    // <title> → <caption> (a valid native accessible name). Emit no caption when there is
    // no title rather than an always-empty one; the derived ariaName above covers that case.
    // In the editable render the caption carries edit/struct hooks (F10): text edits flow
    // through the normal edit path and right-click resolves the title for deleteTitle.
    let caption = '';
    if (title) {
      const body = this.editableBody(title, 'Table title');
      caption = `<caption${this.editAttr(title)}${this.structAttr(title)}${body.attrs}>${body.html}</caption>`;
    }
    let html = `<table${this.classAttr(el, tableClass)}${ariaName}${this.structAttr(el)}${this.tableResizeAttr(el, colspecs.length, hasColumnWidths)}>${caption}${colgroup}`;
    const thead = firstChildNamed(tgroup, 'thead');
    const tbody = firstChildNamed(tgroup, 'tbody');
    if (thead) html += `<thead class="thead">${this.rows(thead, true, grid, a11y, pres)}</thead>`;
    if (tbody) html += `<tbody class="tbody">${this.rows(tbody, false, grid, a11y, pres)}</tbody>`;
    return `${html}</table>`;
  }

  private tableGrid(tgroup: ElementNode): TableGrid | null {
    try {
      return computeGrid(tgroup);
    } catch {
      return null;
    }
  }

  /** Resolve span-aware header associations for one table. Returns null (no a11y
   *  attrs emitted) for header-less or malformed tables. */
  private buildTableA11y(grid: TableGrid): TableA11y | null {
    const heads = grid.cells
      .filter((c) => c.section === 'thead')
      .sort((a, b) => a.row - b.row || a.colStart - b.colStart);
    if (heads.length === 0) return null;

    const cellGrid = new Map<ElementNode, GridCell>();
    for (const c of grid.cells) cellGrid.set(c.entry, c);
    const headerId = new Map<ElementNode, string>();
    const headerScope = new Map<ElementNode, string>();
    const columnHeaders = new Map<number, string[]>();
    for (const h of heads) {
      const id = `dch${this.headerSeq++}`;
      headerId.set(h.entry, id);
      headerScope.set(h.entry, h.colStart === h.colEnd ? 'col' : 'colgroup');
      for (let col = h.colStart; col <= h.colEnd; col++) {
        const list = columnHeaders.get(col) ?? [];
        list.push(id);
        columnHeaders.set(col, list);
      }
    }
    return { cellGrid, headerId, headerScope, columnHeaders };
  }

  private rows(
    section: ElementNode,
    isHead: boolean,
    grid: TableGrid | null,
    a11y: TableA11y | null,
    pres: TablePresentation,
  ): string {
    const rows = childrenNamed(section, 'row');
    return rows
      .map((row, r) => {
        // rowsep on the LAST body row is @frame's job (CALS): suppress it there.
        const lastBodyRow = !isHead && r === rows.length - 1;
        const rowRowsep = presEnum(attr(row, 'rowsep'), SEP_VALUES);
        const rowSepAttr = rowRowsep && !lastBodyRow ? ` data-rowsep="${rowRowsep}"` : '';
        return `<tr${this.classAttr(row, 'row')}${this.structAttr(row)}${rowSepAttr}>${this.entries(row, isHead, grid, a11y, pres, lastBodyRow)}</tr>`;
      })
      .join('');
  }

  private entries(
    row: ElementNode,
    isHead: boolean,
    grid: TableGrid | null,
    a11y: TableA11y | null,
    pres: TablePresentation,
    lastBodyRow: boolean,
  ): string {
    return childrenNamed(row, 'entry')
      .map((entry, i) => this.entry(entry, isHead, grid, a11y, pres, lastBodyRow, i))
      .join('');
  }

  private entry(
    entry: ElementNode,
    isHead: boolean,
    grid: TableGrid | null,
    a11y: TableA11y | null,
    pres: TablePresentation,
    lastBodyRow: boolean,
    indexInRow: number,
  ): string {
    const tag = isHead ? 'th' : 'td';
    let attrs = this.classAttr(entry, 'entry');
    const outputclass = attr(entry, 'outputclass');
    if (outputclass && this.editIds) attrs += ` data-outputclass="${escapeAttrValue(outputclass)}"`;
    if (this.editIds) {
      attrs += ` data-authored-align="${presEnum(attr(entry, 'align'), ALIGN_VALUES) ?? ''}"`;
    }
    const cell = grid ? gridCellFor(grid, entry) : undefined;

    const colspan = cell ? cell.colEnd - cell.colStart + 1 : 1;
    if (colspan > 1) attrs += ` colspan="${colspan}"`;

    const rowspan = cell?.rowSpan ?? ((Number(attr(entry, 'morerows')) || 0) + 1);
    if (Number.isFinite(rowspan) && rowspan > 1) attrs += ` rowspan="${rowspan}"`;

    attrs += this.headerAttrs(entry, isHead, a11y);
    attrs += this.selectionAttr(isHead ? 'header' : 'cell');
    attrs += this.presentationAttrs(entry, cell, pres, lastBodyRow, indexInRow);

    const cellId = this.cellIds?.get(entry);
    const cellAttr = cellId ? ` data-cell-id="${cellId}"` : '';
    const body = this.editableBody(entry, 'Empty cell');
    return `<${tag}${attrs}${cellAttr}${this.editAttr(entry)}${body.attrs}>${body.html}</${tag}>`;
  }

  /** F1/F3/F4 presentation attrs, resolved with CALS precedence (entry → colspec →
   *  tgroup/table for seps and align; entry → row for valign). Emitted ONLY when an
   *  explicit value exists somewhere in the chain, so attribute-free tables (the
   *  whole corpus) render byte-identically. Render-only — never serialized. */
  private presentationAttrs(
    entry: ElementNode,
    cell: GridCell | undefined,
    pres: TablePresentation,
    lastBodyRow: boolean,
    indexInRow: number,
  ): string {
    // Column coordinates: grid when available, positional fallback otherwise
    // (a span-free row's Nth entry is column N+1; without a grid a spanned row
    // simply gets entry-local values only).
    const colStart = cell ? cell.colStart : pres.positional ? indexInRow + 1 : 0;
    const colEnd = cell ? cell.colEnd : colStart;

    let out = '';
    const colsep = presEnum(attr(entry, 'colsep'), SEP_VALUES)
      ?? (colEnd > 0 ? pres.colColsep.get(colEnd) : undefined)
      ?? pres.defColsep;
    if (colsep && colEnd !== pres.cols) out += ` data-colsep="${colsep}"`; // last column: @frame's job

    const row = entry.parent ?? null;
    const rowsep = presEnum(attr(entry, 'rowsep'), SEP_VALUES)
      ?? (row ? presEnum(attr(row, 'rowsep'), SEP_VALUES) : undefined)
      ?? (colStart > 0 ? pres.colRowsep.get(colStart) : undefined)
      ?? pres.defRowsep;
    if (rowsep && !lastBodyRow) out += ` data-rowsep="${rowsep}"`;

    const align = presEnum(attr(entry, 'align'), ALIGN_VALUES)
      ?? (colStart > 0 ? pres.colAlign.get(colStart) : undefined)
      ?? pres.defAlign;
    const valign = presEnum(attr(entry, 'valign'), VALIGN_VALUES)
      ?? (row ? presEnum(attr(row, 'valign'), VALIGN_VALUES) : undefined);

    const style: string[] = [];
    if (align) {
      out += ` data-align="${align}"`;
      style.push(`text-align:${align}`);
    }
    if (valign) {
      out += ` data-valign="${valign}"`;
      style.push(`vertical-align:${valign}`);
    }
    if (style.length) out += ` style="${style.join(';')}"`;
    return out;
  }

  /** scope+id for a header cell, or headers="..." for a data cell (WCAG H43). */
  private headerAttrs(entry: ElementNode, isHead: boolean, a11y: TableA11y | null): string {
    if (!a11y) return '';
    if (isHead) {
      const id = a11y.headerId.get(entry);
      const scope = a11y.headerScope.get(entry);
      return id && scope ? ` scope="${scope}" id="${id}"` : '';
    }
    const gc = a11y.cellGrid.get(entry);
    if (!gc) return '';
    const ids: string[] = [];
    for (let col = gc.colStart; col <= gc.colEnd; col++) {
      for (const hid of a11y.columnHeaders.get(col) ?? []) {
        if (!ids.includes(hid)) ids.push(hid);
      }
    }
    return ids.length ? ` headers="${ids.join(' ')}"` : '';
  }
}

/** Render an arbitrary node list (e.g. a diffed element and its siblings) with the
 *  same renderer as renderDocument. Fragments are not Documents, so tableNames
 *  defaults to an empty map (no derived names) instead of deriveTableNames. */
export function renderFragment(nodes: CstNode[], options?: RenderOptions): string {
  const renderer = new HtmlRenderer(
    options?.editIds ?? null,
    options?.structIds ?? null,
    options?.textRunParents ?? null,
    options?.cellIds ?? null,
    options?.autofocusId ?? null,
    options?.imageVersion ?? null,
    options?.tableNames ?? new Map(),
  );
  return nodes.map((node) => renderer.node(node)).join('');
}

export function renderDocument(doc: Document, options?: RenderOptions): string {
  const renderer = new HtmlRenderer(
    options?.editIds ?? null,
    options?.structIds ?? null,
    options?.textRunParents ?? null,
    options?.cellIds ?? null,
    options?.autofocusId ?? null,
    options?.imageVersion ?? null,
    // Default the table accessible names so the READ-ONLY preview names its tables too
    // (not just the editable canvas). renderEditable still passes its own map, so the
    // `??` keeps this to a single derivation. Render-only — never serialized.
    options?.tableNames ?? deriveTableNames(doc),
  );
  return doc.children.map((node) => renderer.node(node)).join('');
}

/** Render with editable text leaves + structural controls for the editing canvas.
 *  Pass focusId to mark a just-added element data-autofocus, and imageVersion to
 *  cache-bust image URLs (so replaced/removed images reflect on open/reload). */
export function renderEditable(
  doc: Document,
  focusId?: string | null,
  imageVersion?: string | null,
): string {
  // UNIVERSAL addressability: structuralIds() stamps EVERY block-level structural kind
  // (DELETABLE_STRUCT_KINDS in element-ids.ts) with data-struct-id + data-struct-kind=tag,
  // via the SAME e{N} scheme as blocks/cells — so the canvas can target ANY of them (delete,
  // insert-after, image re-resolve) generically, with no per-feature allowlist to keep in sync.
  // Cells (data-cell-id), inline phrases (cmd/codeph) and mixed-cell text-run spans are
  // EXCLUDED there and addressed separately. Render-only — never written back to the .dita.
  return renderDocument(doc, {
    editIds: editableElementIds(doc),
    structIds: structuralIds(doc),
    textRunParents: mixedEditableParents(doc),
    cellIds: tableCellIds(doc),
    autofocusId: focusId ?? null,
    imageVersion: imageVersion ?? null,
    tableNames: deriveTableNames(doc),
  });
}
