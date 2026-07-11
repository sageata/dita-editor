// IX-3 structural copy/paste as real DITA. Copy slices the elements' exact
// source bytes (CST ranges) to the system clipboard; paste splices the
// clipboard fragment verbatim next to a reference sibling — byte-exact both
// ways, cross-file via the OS clipboard. Well-formedness and a coarse
// same-category check gate the paste; the render pipeline re-parses after.

import { parse } from '../cst/parse';
import { assignElementIds, findElementById } from '../cst/element-ids';
import type { ElementNode } from '../cst/types';

/** Elements that may sit next to each other inside a (block)+ container. */
const BLOCK_KINDS = new Set([
  'p', 'ul', 'ol', 'dl', 'sl', 'table', 'simpletable', 'fig',
  'section', 'lines', 'pre', 'note', 'codeblock',
]);

/** The exact original text of the given elements, in document order. */
export function sliceElements(source: string, ids: string[]): string | null {
  const doc = parse(source);
  const spans: { start: number; end: number }[] = [];
  for (const id of ids) {
    const el = findElementById(doc, id);
    if (!el) return null;
    spans.push({ start: el.range.start, end: el.range.end });
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a.start - b.start);
  return spans.map((s) => source.slice(s.start, s.end)).join('\n');
}

export interface DitaPasteResult {
  source: string;
  focusId: string | null;
}

/** Top-level elements of a clipboard fragment, or an error explaining why the
 *  fragment is not pasteable. */
function fragmentElements(fragment: string): ElementNode[] {
  const trimmed = fragment.trim();
  if (!trimmed.startsWith('<')) throw new Error('The clipboard does not contain DITA XML.');
  let wrapped;
  try {
    wrapped = parse('<clip>\n' + trimmed + '\n</clip>');
  } catch {
    throw new Error('The clipboard XML is not well-formed.');
  }
  const root = wrapped.children.find((c) => c.type === 'element') as ElementNode | undefined;
  const els = root
    ? (root.children.filter((c) => c.type === 'element') as ElementNode[])
    : [];
  if (!els.length) throw new Error('The clipboard does not contain DITA elements.');
  // A partial parse (e.g. an unclosed tag swallowing the wrapper) shows up as the
  // wrapper not ending where the text does — reject rather than paste garbage.
  if (root && root.closeTagRange == null) throw new Error('The clipboard XML is not well-formed.');
  return els;
}

/** Splice the clipboard fragment verbatim before/after the reference element,
 *  mirroring its leading indentation. */
export function insertDitaFragment(
  source: string,
  refId: string,
  mode: 'before' | 'after',
  fragment: string,
): DitaPasteResult {
  const trimmed = fragment.trim();
  const els = fragmentElements(trimmed);
  const doc = parse(source);
  const ref = findElementById(doc, refId);
  if (!ref) throw new Error('The paste target is no longer in the document.');
  for (const el of els) {
    const compatible =
      el.name === ref.name ||
      (BLOCK_KINDS.has(el.name) && BLOCK_KINDS.has(ref.name));
    if (!compatible) {
      throw new Error(`Cannot paste <${el.name}> ${mode} a <${ref.name}>.`);
    }
  }

  const lineStart = source.lastIndexOf('\n', ref.range.start - 1) + 1;
  const indentRaw = source.slice(lineStart, ref.range.start);
  const indent = /^[ \t]*$/.test(indentRaw) ? indentRaw : '';
  let out: string;
  let insertedAt: number;
  if (mode === 'before') {
    insertedAt = ref.range.start;
    out = source.slice(0, ref.range.start) + trimmed + '\n' + indent + source.slice(ref.range.start);
  } else {
    insertedAt = ref.range.end + 1 + indent.length;
    out = source.slice(0, ref.range.end) + '\n' + indent + trimmed + source.slice(ref.range.end);
  }

  // Focus the first pasted element: it starts exactly at the insertion offset.
  let focusId: string | null = null;
  try {
    const newDoc = parse(out);
    for (const [el, id] of assignElementIds(newDoc)) {
      if ((el as ElementNode).range.start === insertedAt) {
        focusId = id;
        break;
      }
    }
  } catch {
    throw new Error('Pasting here would make the document invalid.');
  }
  return { source: out, focusId };
}
