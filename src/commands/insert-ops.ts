// Slice β P1-2a — pure, parallel-safe core for INSERTING new DITA structures.
//
// Sibling adds in src/cst/structural.ts only clone the focused kind (addParaAfter,
// addItemAfter, addRowAfter). This module is the complementary primitive: insert a
// *new* structure — a paragraph, an unordered/ordered list (seeded with one empty
// item), a list item, or a simple CALS table skeleton — and decide FIRST whether the
// target context permits it.
//
// Two layers, mirroring the existing command cores:
//   • canInsert()   — pure predicate over a parsed DocIndex (like validity.ts isValid).
//                     Returns enabled + ditaValid, never mutates.
//   • applyInsert() — pure source→source edit (like structural.ts applyStructuralEdit).
//                     Parses its own source, builds synthetic nodes, splices them in,
//                     and serializes. Because only the inserted nodes are dirty/synthetic
//                     and everything untouched is sliced verbatim, the edit is strictly
//                     ADDITIVE: no original byte changes (test asserts this invariant).
//
// Parallel-safe: every function is a pure transform of its arguments. No module state,
// no shared mutable buffers; applyInsert parses a fresh Document per call, so concurrent
// calls over different sources never interfere.
//
// Content model (grounded in the corpus tag inventory + DITA topic content model):
//   • A list item (<li>) is permitted ONLY inside a list (<ul>/<ol>).
//   • A paragraph / list / table is block-level content, permitted inside a block
//     container (<body>/<conbody>/<refbody>/<section>/<note>/<li>/<entry>) — NOT inside a list (whose
//     children are <li> only) and NOT inside a <p> (inline content only).
// A content-model violation is reported enabled:false, ditaValid:false (performing it
// would yield non-conformant DITA). Operational refusals (nothing/unknown in focus) are
// enabled:false, ditaValid:true — no DITA judgment is made about the document.

import { parse } from '../cst/parse';
import { serialize } from '../cst/serialize';
import { insertNode, makeElement, makeRawText } from '../cst/edit';
import { childElements } from '../cst/query';
import { assignElementIds } from '../cst/element-ids';
import { listAttrsForStyle, type ListStyle } from '../cst/list-style';
import type { CstNode, ElementNode } from '../cst/types';
import type { DocIndex } from './validity';

export type InsertKind =
  | 'paragraph'
  | 'lines'
  | 'unorderedList'
  | 'alphabeticList'
  | 'orderedList'
  | 'listItem'
  | 'table'
  | 'note'
  | 'codeblock'
  | 'section';

/** Where the new structure goes, addressed by stable e{N} ids (validity.ts DocIndex).
 *  - after:  the new node becomes the NEXT sibling of `refId`.
 *  - before: the new node becomes the PREVIOUS sibling of `refId`.
 *  - into:   the new node is appended as the last child of `containerId` (covers an
 *    empty container that has no sibling to anchor against).
 *  For after/before the container that must permit the kind is `refId`'s parent, so they
 *  share content-model validation and differ only in placement (this is the "insert a
 *  paragraph before/after a table/figure/list" path). */
export type InsertPosition =
  | { mode: 'after'; refId: string }
  | { mode: 'before'; refId: string }
  | { mode: 'into'; containerId: string };

/** Optional shape for the table skeleton. Defaults to a CALS table with one empty
 *  header row (<thead>) plus 2×2 body rows; `rows` counts body rows only. */
export interface TableShape {
  cols?: number;
  rows?: number;
}

export interface InsertValidity {
  enabled: boolean;
  reason?: string;
  ditaValid: boolean;
}

export interface InsertResult {
  source: string;
  /** e{N} id (re-assigned over the mutated tree) of the element to focus: the new
   *  paragraph/list-item, or the first <li>/<entry> of a new list/table. */
  focusId: string | null;
  /** Caret offset inside the focused element (always 0 for a fresh empty node). */
  caretOffset: number | null;
}

// ---- content model ----------------------------------------------------------

const LIST_CONTAINERS = new Set(['ul', 'ol']);
// Block-content containers (body + specialization bodies, sections, notes, list items,
// table cells). These accept the block insert kinds supported by this editor.
// these inserts. <section> is included to match the editor's other lanes — W6 transform-ops
// allows itemToParagraph into <section> and render-a11y has a table-inside-section fixture,
// so refusing inserts there would strand a valid, expected context. Kept conservative on
// purpose: containers not on this list are refused rather than guessed at.
const BLOCK_CONTAINERS = new Set(['body', 'conbody', 'refbody', 'section', 'note', 'li', 'entry']);
// A <section> is a direct child of a topic body only — never nested in a list item, table cell,
// or another section. Stricter than BLOCK_CONTAINERS so the editor never produces invalid nesting.
const SECTION_CONTAINERS = new Set(['body', 'conbody', 'refbody']);

const KIND_NOUN: Record<InsertKind, string> = {
  paragraph: 'a paragraph',
  lines: 'a lines block',
  unorderedList: 'a bulleted list',
  alphabeticList: 'an alphabetic list',
  orderedList: 'a numbered list',
  listItem: 'a list item',
  table: 'a table',
  note: 'a note',
  codeblock: 'a code block',
  section: 'a section',
};

function containerAllows(container: ElementNode, kind: InsertKind): boolean {
  if (kind === 'listItem') return LIST_CONTAINERS.has(container.name);
  if (kind === 'section') return SECTION_CONTAINERS.has(container.name);
  // The DITA note grammar accepts normal blocks but uses basic.block.nonote,
  // so a note must never be inserted inside another note.
  if (container.name === 'note' && kind === 'note') return false;
  return BLOCK_CONTAINERS.has(container.name);
}

function ok(): InsertValidity {
  return { enabled: true, ditaValid: true };
}
function refuse(reason: string, ditaValid: boolean): InsertValidity {
  return { enabled: false, reason, ditaValid };
}

/** Resolve the container an insertion would land in, or an operational refusal. */
function resolveContainer(
  pos: InsertPosition,
  idx: DocIndex,
): { container: ElementNode } | InsertValidity {
  if (pos.mode === 'after' || pos.mode === 'before') {
    const ref = idx.byId.get(pos.refId);
    if (!ref) return refuse('Reference element was not found', true);
    if (!ref.parent) return refuse('Reference element has no container', true);
    return { container: ref.parent };
  }
  const container = idx.byId.get(pos.containerId);
  if (!container) return refuse('Container element was not found', true);
  return { container };
}

/**
 * Can `kind` be inserted at `pos` in the parsed document? Pure: never mutates idx.
 * A content-model violation (wrong container) is enabled:false, ditaValid:false; an
 * operational miss (unknown id) is enabled:false, ditaValid:true.
 */
export function canInsert(kind: InsertKind, pos: InsertPosition, idx: DocIndex): InsertValidity {
  const resolved = resolveContainer(pos, idx);
  if ('enabled' in resolved) return resolved;
  const { container } = resolved;
  if (!containerAllows(container, kind)) {
    return refuse(`Cannot insert ${KIND_NOUN[kind]} into <${container.name}>`, false);
  }
  return ok();
}

/** Which kinds are legal to insert at `pos` (deterministic, possibly empty). */
export function availableInserts(pos: InsertPosition, idx: DocIndex): InsertKind[] {
  const ALL: InsertKind[] = [
    'paragraph', 'lines', 'unorderedList', 'alphabeticList', 'orderedList', 'listItem', 'table', 'note', 'codeblock', 'section',
  ];
  return ALL.filter((kind) => canInsert(kind, pos, idx).enabled);
}

// ---- node builders ----------------------------------------------------------

const INDENT = '  '; // corpus convention (2-space steps)

/** Wrap `nodes` between indentation text so they read as a block: each child on its
 *  own `childLead` line and the close tag back at `closeLead`. */
function layout(childLead: string, closeLead: string, nodes: ElementNode[]): CstNode[] {
  const out: CstNode[] = [];
  for (const n of nodes) {
    out.push(makeRawText(childLead));
    out.push(n);
  }
  out.push(makeRawText(closeLead));
  return out;
}

function buildList(
  name: 'ul' | 'ol',
  lead: string,
  style: ListStyle = name === 'ul' ? 'unordered' : 'ordered',
): { root: ElementNode; focus: ElementNode } {
  const li = makeElement('li', [], []);
  const root = makeElement(name, listAttrsForStyle(style), layout(lead + INDENT, lead, [li]));
  return { root, focus: li };
}

function buildTable(lead: string, shape: TableShape): { root: ElementNode; focus: ElementNode } {
  const cols = shape.cols ?? 2;
  const rows = shape.rows ?? 2;
  if (cols < 1) throw new Error(`table needs at least 1 column, got ${cols}`);
  if (rows < 1) throw new Error(`table needs at least 1 row, got ${rows}`);

  const tgroupLead = lead + INDENT; // <tgroup> line
  const sectionLead = tgroupLead + INDENT; // <colspec>/<tbody> lines
  const rowLead = sectionLead + INDENT; // <row> lines
  const entryLead = rowLead + INDENT; // <entry> lines

  const colspecs: ElementNode[] = [];
  for (let i = 0; i < cols; i++) {
    colspecs.push(
      makeElement(
        'colspec',
        [
          { name: 'colname', value: `c${i + 1}` },
          { name: 'colnum', value: String(i + 1) },
        ],
        [],
        true,
      ),
    );
  }

  const makeRow = (): { row: ElementNode; first: ElementNode } => {
    const entries: ElementNode[] = [];
    for (let c = 0; c < cols; c++) entries.push(makeElement('entry', [], []));
    return { row: makeElement('row', [], layout(entryLead, rowLead, entries)), first: entries[0] };
  };

  const header = makeRow();
  const thead = makeElement('thead', [], layout(rowLead, sectionLead, [header.row]));

  const bodyRows: ElementNode[] = [];
  for (let r = 0; r < rows; r++) bodyRows.push(makeRow().row);
  const tbody = makeElement('tbody', [], layout(rowLead, sectionLead, bodyRows));

  const tgroup = makeElement(
    'tgroup',
    [{ name: 'cols', value: String(cols) }],
    layout(sectionLead, tgroupLead, [...colspecs, thead, tbody]),
  );
  const table = makeElement('table', [], layout(tgroupLead, lead, [tgroup]));
  return { root: table, focus: header.first };
}

/** Build the synthetic root for `kind`, returning the node to focus afterward. */
function buildInsertion(
  kind: InsertKind,
  lead: string,
  shape: TableShape,
): { root: ElementNode; focus: ElementNode } {
  switch (kind) {
    case 'paragraph': {
      const p = makeElement('p', [], []);
      return { root: p, focus: p };
    }
    case 'lines': {
      const lines = makeElement('lines', [], []);
      return { root: lines, focus: lines };
    }
    case 'listItem': {
      const li = makeElement('li', [], []);
      return { root: li, focus: li };
    }
    case 'unorderedList':
      return buildList('ul', lead);
    case 'alphabeticList':
      return buildList('ol', lead, 'alpha');
    case 'orderedList':
      return buildList('ol', lead);
    case 'table':
      return buildTable(lead, shape);
    case 'codeblock': {
      // Preformatted block (like <lines>): editable as a text leaf (codeblock is in EDITABLE_PARENTS).
      const cb = makeElement('codeblock', [], []);
      return { root: cb, focus: cb };
    }
    case 'note': {
      // A note seeds one empty <p> so there is an editable leaf to type into; focus it.
      const p = makeElement('p', [], []);
      const note = makeElement('note', [], layout(lead + INDENT, lead, [p]));
      return { root: note, focus: p };
    }
    case 'section': {
      // A section seeds an empty <title> (the "section heading"); focus it for typing.
      const title = makeElement('title', [], []);
      const section = makeElement('section', [], layout(lead + INDENT, lead, [title]));
      return { root: section, focus: title };
    }
  }
}

// ---- placement (mirrors structural.ts insertAfter indentation handling) ------

function leadingWs(children: CstNode[], idx: number): string {
  const prev = children[idx - 1];
  return prev && prev.type === 'text' ? prev.raw : '\n';
}

/** Insert `newEl` right after `ref`, mirroring ref's leading indentation. */
function insertAfter(ref: ElementNode, newEl: ElementNode): string {
  const parent = ref.parent;
  if (!parent) throw new Error('cannot insert next to a top-level node');
  const i = parent.children.indexOf(ref);
  const ws = leadingWs(parent.children, i);
  insertNode(parent, i + 1, makeRawText(ws));
  insertNode(parent, i + 2, newEl);
  return ws;
}

/** Insert `newEl` right before `ref`, mirroring ref's leading indentation. The new node
 *  takes ref's existing lead; a fresh copy of that lead is placed between newEl and ref so
 *  ref keeps its indentation on the next line. Symmetric with insertAfter; pure insertion
 *  of synthetic nodes, so it never rewrites an existing byte (additive). */
function insertBefore(ref: ElementNode, newEl: ElementNode): string {
  const parent = ref.parent;
  if (!parent) throw new Error('cannot insert next to a top-level node');
  const i = parent.children.indexOf(ref);
  const ws = leadingWs(parent.children, i);
  insertNode(parent, i, newEl);
  insertNode(parent, i + 1, makeRawText(ws));
  return ws;
}

/** Append `newEl` as the last child of `container`; returns the lead used so nested
 *  builders can indent consistently. */
function appendInto(container: ElementNode, newEl: ElementNode): string {
  const kids = childElements(container);
  if (kids.length > 0) {
    return insertAfter(kids[kids.length - 1], newEl);
  }
  // Empty container: open a fresh indented line.
  const ws = '\n';
  insertNode(container, container.children.length, makeRawText(ws));
  insertNode(container, container.children.length, newEl);
  return ws;
}

/**
 * Insert a new `kind` structure at `pos` and return the new source + focus target.
 * Pure: parses `source` fresh, never mutates a shared structure. Throws on an unknown
 * id or a content-model violation (the predicate canInsert is the pre-flight gate).
 */
export function applyInsert(
  source: string,
  kind: InsertKind,
  pos: InsertPosition,
  opts: { table?: TableShape } = {},
): InsertResult {
  const doc = parse(source);
  const ids = assignElementIds(doc);
  const byId = new Map<string, ElementNode>();
  for (const [el, id] of ids) byId.set(id, el);

  // Resolve the placement target and the container that gates the content model.
  let container: ElementNode;
  let place: (node: ElementNode) => string;
  if (pos.mode === 'after' || pos.mode === 'before') {
    const ref = byId.get(pos.refId);
    if (!ref) throw new Error(`insert reference not found: ${pos.refId}`);
    if (!ref.parent) throw new Error(`insert reference has no container: ${pos.refId}`);
    container = ref.parent;
    place = pos.mode === 'after' ? (node) => insertAfter(ref, node) : (node) => insertBefore(ref, node);
  } else {
    const c = byId.get(pos.containerId);
    if (!c) throw new Error(`insert container not found: ${pos.containerId}`);
    container = c;
    place = (node) => appendInto(c, node);
  }
  if (!containerAllows(container, kind)) {
    throw new Error(`<${kind}> is not permitted inside <${container.name}>`);
  }

  // Compute the insertion-site lead up front (deterministic from the ref/container)
  // so nested builders indent to match, then build and place.
  const lead = leadOf(pos, container, byId);
  const { root, focus } = buildInsertion(kind, lead, opts.table ?? {});
  place(root);

  const focusId = assignElementIds(doc).get(focus) ?? null;
  return { source: serialize(doc), focusId, caretOffset: 0 };
}

/** The indentation lead the new top-level node will sit at, computed before mutation
 *  so nested builders match it. Mirrors insertAfter/appendInto whitespace choice. */
function leadOf(pos: InsertPosition, container: ElementNode, byId: Map<string, ElementNode>): string {
  if (pos.mode === 'after' || pos.mode === 'before') {
    const ref = byId.get(pos.refId) as ElementNode;
    return leadingWs(container.children, container.children.indexOf(ref));
  }
  const kids = childElements(container);
  if (kids.length > 0) {
    const last = kids[kids.length - 1];
    return leadingWs(container.children, container.children.indexOf(last));
  }
  return '\n';
}
