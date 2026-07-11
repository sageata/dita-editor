// DE-RISK PROOF (plan "day-1 experiment"): on a real, complex CALS table from
// the corpus — multi-column, thead+tbody, a mixed-content cell with an embedded
// <image> — perform the three representative edits and assert each produces a
// MINIMAL, well-formed change: only the intended spans differ; every PDF artifact
// (&amp;, U+2011 hyphens, dashes, the DOCTYPE) and untouched element survives.
//
// The target file is selected dynamically rather than hardcoded: the corpus is a
// moving target (the pdf2dita chunking pipeline reorganizes files), so the test
// finds a file matching the required shape at runtime.

import { beforeAll, describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { insertNode, makeElement, makeRawText, removeNode, setAttr, setText } from '../src/cst/edit';
import {
  childElements,
  childrenNamed,
  findElement,
  firstChildNamed,
} from '../src/cst/query';
import { applyStructuralEdit } from '../src/cst/structural';
import { applyInlineHtmlEdit } from '../src/cst/edit-bridge';
import { assignElementIds } from '../src/cst/element-ids';
import type { CstNode, Document, ElementNode, TextNode } from '../src/cst/types';
import { countOccurrences } from './helpers';
import { loadCorpusFiles } from './corpus';

/** First entry (depth-first, within the first table) that mixes non-empty text
 *  with an embedded <image> — the round-trip-hardest cell shape. */
function firstMixedEntry(table: ElementNode): ElementNode | undefined {
  return findElementsIn(table, 'entry').find(
    (e) =>
      e.children.some((c): c is TextNode => c.type === 'text' && c.raw.trim().length > 0) &&
      childElements(e).some((c) => c.name === 'image'),
  );
}

function findElementsIn(root: ElementNode, name: string): ElementNode[] {
  const out: ElementNode[] = [];
  const stack: CstNode[] = [...root.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'element') {
      if (n.name === name) out.push(n);
      stack.push(...n.children);
    }
  }
  return out;
}

function nonEmptyTextChild(el: ElementNode): TextNode | undefined {
  return el.children.find((c): c is TextNode => c.type === 'text' && c.raw.trim().length > 0);
}

function rowsOf(tgroup: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  for (const section of childElements(tgroup)) {
    if (section.name === 'thead' || section.name === 'tbody') {
      rows.push(...childrenNamed(section, 'row'));
    }
  }
  return rows;
}

/** Find a corpus file whose FIRST table has: a tgroup with @cols, a tbody with
 *  >=2 rows, and a mixed-content (text + image) cell. */
function pickTarget(): { file: string; source: string } {
  for (const file of loadCorpusFiles()) {
    const source = file.source;
    let doc: Document;
    try {
      doc = parse(source);
    } catch (error) {
      console.error(`[surgical-edit] failed to parse ${file.rel}: ${String(error)}`);
      continue;
    }
    const table = findElement(doc, 'table');
    if (!table) continue;
    const tgroup = findElement(doc, 'tgroup');
    if (!tgroup || !tgroup.attrs.some((a) => a.name === 'cols')) continue;
    const tbody = firstChildNamed(tgroup, 'tbody');
    if (!tbody || childrenNamed(tbody, 'row').length < 2) continue;
    if (!firstMixedEntry(table)) continue;
    return { file: file.abs, source };
  }
  throw new Error('no corpus file matched the required CALS table shape');
}

let original: string;
let targetFile: string;

beforeAll(() => {
  const picked = pickTarget();
  targetFile = picked.file;
  original = picked.source;
});

function freshDoc(): Document {
  return parse(original);
}

/** Re-parse + re-serialize must be a no-op: the edit produced well-formed, stable XML. */
function expectStable(serialized: string): void {
  expect(serialize(parse(serialized))).toBe(serialized);
}

function hasDoctype(s: string): boolean {
  return /<!DOCTYPE\s/.test(s);
}

describe('de-risk target', () => {
  test('a suitable complex CALS table was found and round-trips clean', () => {
    expect(targetFile).toBeTruthy();
    expect(serialize(freshDoc())).toBe(original);
  });
});

describe('(a) edit text of a cell containing an embedded image', () => {
  test('only the cell text span changes; the image and all artifacts survive', () => {
    const doc = freshDoc();
    const table = findElement(doc, 'table')!;
    const entry = firstMixedEntry(table)!;
    const textNode = nonEmptyTextChild(entry)!;
    const image = childElements(entry).find((c) => c.name === 'image')!;
    const imageBytes = original.slice(image.range.start, image.range.end);

    setText(textNode, 'EDITED SEAT MODEL');
    const out = serialize(doc);

    // Exactly the text node's span is replaced; everything else is byte-identical.
    const expected =
      original.slice(0, textNode.range.start) + 'EDITED SEAT MODEL' + original.slice(textNode.range.end);
    expect(out).toBe(expected);

    // The untouched regions (where the DOCTYPE, entities, dashes and the embedded
    // image live) are byte-for-byte identical to the original. Artifacts that
    // happened to sit *inside* the edited cell are legitimately gone — that's the
    // edit; we only guarantee everything outside the edited span.
    const prefix = original.slice(0, textNode.range.start);
    const suffix = original.slice(textNode.range.end);
    expect(out.startsWith(prefix)).toBe(true);
    expect(out.endsWith(suffix)).toBe(true);
    expect(suffix).toContain(imageBytes); // the image follows the text in this cell
    expect(out).toContain(imageBytes);
    expect(hasDoctype(out)).toBe(hasDoctype(original));
    expectStable(out);
  });
});

describe('(b) add a column (no merge/split)', () => {
  test('@cols bumps, one colspec + one entry per row added, bytes outside the table untouched', () => {
    const doc = freshDoc();
    const table = findElement(doc, 'table')!;
    const tgroup = findElement(doc, 'tgroup')!;
    const cols = tgroup.attrs.find((a) => a.name === 'cols')!;
    const newColCount = Number(cols.value) + 1;
    const rows = rowsOf(tgroup);
    const entryCountsBefore = rows.map((r) => childrenNamed(r, 'entry').length);

    // 1) bump @cols by splicing only its value span.
    setAttr(tgroup, 'cols', String(newColCount), doc.source);

    // 2) append a colspec, reusing sibling indentation.
    const colspecs = childrenNamed(tgroup, 'colspec');
    const lastColspec = colspecs[colspecs.length - 1];
    const lastColspecIdx = tgroup.children.indexOf(lastColspec);
    const newColspec = makeElement(
      'colspec',
      [
        { name: 'colname', value: `c${newColCount}` },
        { name: 'colnum', value: String(newColCount) },
      ],
      [],
      true,
    );
    insertNode(tgroup, lastColspecIdx + 1, makeRawText(indentBefore(tgroup.children, lastColspecIdx)));
    insertNode(tgroup, lastColspecIdx + 2, newColspec);

    // 3) append an empty entry to every row.
    for (const row of rows) {
      const entries = childrenNamed(row, 'entry');
      const lastEntry = entries[entries.length - 1];
      const lastEntryIdx = row.children.indexOf(lastEntry);
      insertNode(row, lastEntryIdx + 1, makeRawText(indentBefore(row.children, lastEntryIdx)));
      insertNode(row, lastEntryIdx + 2, makeElement('entry', [], []));
    }

    const out = serialize(doc);

    // Everything before and after the <table> is byte-identical.
    const tailLen = original.length - table.range.end;
    expect(out.slice(0, table.range.start)).toBe(original.slice(0, table.range.start));
    expect(out.slice(out.length - tailLen)).toBe(original.slice(table.range.end));
    expectStable(out);

    // Structure of the re-parsed result.
    const after = parse(out);
    const tgroupAfter = findElement(after, 'tgroup')!;
    expect(tgroupAfter.attrs.find((a) => a.name === 'cols')!.value).toBe(String(newColCount));
    expect(childrenNamed(tgroupAfter, 'colspec').length).toBe(colspecs.length + 1);
    rowsOf(tgroupAfter).forEach((r, i) => {
      expect(childrenNamed(r, 'entry').length).toBe(entryCountsBefore[i] + 1);
    });

    // A purely structural edit touches no existing cell text, so every text
    // artifact in the corpus file is preserved exactly: entities, U+2011
    // non-breaking hyphens, and the DOCTYPE.
    expect(countOccurrences(out, '&amp;')).toBe(countOccurrences(original, '&amp;'));
    expect(countOccurrences(out, '‑')).toBe(countOccurrences(original, '‑'));
    expect(hasDoctype(out)).toBe(hasDoctype(original));
  });
});

describe('(c) delete a row', () => {
  test('last body row removed; one row fewer; nothing outside the tbody changes', () => {
    const doc = freshDoc();
    const tgroup = findElement(doc, 'tgroup')!;
    const tbody = firstChildNamed(tgroup, 'tbody')!;
    const bodyRows = childrenNamed(tbody, 'row');
    const lastRow = bodyRows[bodyRows.length - 1];
    const lastRowIdx = tbody.children.indexOf(lastRow);
    const wsBefore = tbody.children[lastRowIdx - 1];

    const prefixLen = tbody.range.start;
    const suffixLen = original.length - tbody.range.end;

    removeNode(lastRow);
    if (wsBefore && wsBefore.type === 'text') removeNode(wsBefore);

    const out = serialize(doc);

    expect(out.slice(0, prefixLen)).toBe(original.slice(0, prefixLen));
    expect(out.slice(out.length - suffixLen)).toBe(original.slice(original.length - suffixLen));
    expectStable(out);

    const after = parse(out);
    const tbodyAfter = firstChildNamed(findElement(after, 'tgroup')!, 'tbody')!;
    expect(childrenNamed(tbodyAfter, 'row').length).toBe(bodyRows.length - 1);
    expect(hasDoctype(out)).toBe(hasDoctype(original));
  });
});

describe('(e) edit text in a real inline-rich image cell via the HTML bridge', () => {
  test('applyInlineHtmlEdit changes cell text; the <image> attrs + artifacts survive', () => {
    const doc = freshDoc();
    const table = findElement(doc, 'table')!;
    const entry = firstMixedEntry(table)!;
    const cellId = assignElementIds(doc).get(entry)!;
    const image = childElements(entry).find((c) => c.name === 'image')!;
    const attrs = image.attrs.map((a) => ({ name: a.name, value: a.value }));
    const packedAttrs = encodeURIComponent(JSON.stringify(attrs));
    const href = image.attrs.find((a) => a.name === 'href')?.value ?? '';

    const out = applyInlineHtmlEdit(
      original,
      cellId,
      `EDITED CELL RUN <img class="image" data-dita="image" data-href="${href}" data-attrs="${packedAttrs}">`,
    );

    expect(out).toContain('EDITED CELL RUN');
    for (const a of image.attrs) expect(out).toContain(`${a.name}="${a.value}"`);
    // STRICT byte-identity: the change is fully contained within the edited cell —
    // everything before AND after the <entry> is byte-for-byte unchanged.
    expect(out.slice(0, entry.range.start)).toBe(original.slice(0, entry.range.start));
    expect(out.endsWith(original.slice(entry.range.end))).toBe(true);
    expect(hasDoctype(out)).toBe(hasDoctype(original));
    expectStable(out);
  });
});

/** Reuse the whitespace text node preceding child `index` as indentation. */
function indentBefore(children: CstNode[], index: number): string {
  const prev = children[index - 1];
  if (prev && prev.type === 'text') return prev.raw;
  return '\n        ';
}

/** A corpus file whose first tgroup has NO spans and uniform geometry
 *  (every row has exactly @cols entries) — the shape the column ops support. */
function pickNoSpanTable(): { file: string; source: string } {
  for (const file of loadCorpusFiles()) {
    const source = file.source;
    let doc: Document;
    try {
      doc = parse(source);
    } catch (error) {
      console.error(`[surgical-edit] failed to parse ${file.rel}: ${String(error)}`);
      continue;
    }
    const tgroup = findElement(doc, 'tgroup');
    if (!tgroup) continue;
    const colsAttr = tgroup.attrs.find((a) => a.name === 'cols');
    if (!colsAttr || Number(colsAttr.value) < 2) continue;
    const tbody = firstChildNamed(tgroup, 'tbody');
    if (!tbody || childrenNamed(tbody, 'row').length < 1) continue;
    const rows = rowsOf(tgroup);
    const spanned = rows.some((r) =>
      childrenNamed(r, 'entry').some((e) =>
        e.attrs.some((a) => a.name === 'namest' || a.name === 'nameend' || a.name === 'morerows'),
      ),
    );
    if (spanned) continue;
    const cols = Number(colsAttr.value);
    if (!rows.every((r) => childrenNamed(r, 'entry').length === cols)) continue;
    return { file: file.abs, source };
  }
  throw new Error('no no-span CALS table found in the corpus');
}

describe('(d) add/delete a COLUMN on a real no-span table (structural op)', () => {
  let src: string;
  let foundFile: string;

  beforeAll(() => {
    const picked = pickNoSpanTable();
    foundFile = picked.file;
    src = picked.source;
  });

  function firstBodyCellId(doc: Document): string {
    const tgroup = findElement(doc, 'tgroup')!;
    const tbody = firstChildNamed(tgroup, 'tbody')!;
    const cell = childrenNamed(childrenNamed(tbody, 'row')[0], 'entry')[0];
    return assignElementIds(doc).get(cell)!;
  }

  test('a no-span multi-column CALS table exists in the corpus', () => {
    expect(foundFile).toBeTruthy();
  });

  test('addColumnAfter: @cols+1, colspecs stay canonical, every row +1 cell, artifacts intact, byte-stable', () => {
    const doc = freshFrom(src);
    const tgroup = findElement(doc, 'tgroup')!;
    const cols = Number(tgroup.attrs.find((a) => a.name === 'cols')!.value);
    const cellCountsBefore = rowsOf(tgroup).map((r) => childrenNamed(r, 'entry').length);

    const out = applyStructuralEdit(src, 'addColumnAfter', firstBodyCellId(doc)).source;
    const after = parse(out);
    const tgAfter = findElement(after, 'tgroup')!;

    expect(Number(tgAfter.attrs.find((a) => a.name === 'cols')!.value)).toBe(cols + 1);
    const nums = childrenNamed(tgAfter, 'colspec').map((c) => c.attrs.find((a) => a.name === 'colnum')!.value);
    expect(nums).toEqual(Array.from({ length: cols + 1 }, (_, i) => String(i + 1)));
    rowsOf(tgAfter).forEach((r, i) => {
      expect(childrenNamed(r, 'entry').length).toBe(cellCountsBefore[i] + 1);
    });

    const table = findElement(doc, 'table')!;
    expect(out.slice(0, table.range.start)).toBe(src.slice(0, table.range.start));
    // Purely structural: every text artifact is preserved exactly.
    expect(countOccurrences(out, '&amp;')).toBe(countOccurrences(src, '&amp;'));
    expect(countOccurrences(out, '‑')).toBe(countOccurrences(src, '‑'));
    expect(hasDoctype(out)).toBe(hasDoctype(src));
    expectStable(out);
  });

  test('deleteColumn: @cols-1, every row -1 cell, byte-stable', () => {
    const doc = freshFrom(src);
    const tgroup = findElement(doc, 'tgroup')!;
    const cols = Number(tgroup.attrs.find((a) => a.name === 'cols')!.value);
    const cellCountsBefore = rowsOf(tgroup).map((r) => childrenNamed(r, 'entry').length);

    const out = applyStructuralEdit(src, 'deleteColumn', firstBodyCellId(doc)).source;
    const after = parse(out);
    const tgAfter = findElement(after, 'tgroup')!;

    expect(Number(tgAfter.attrs.find((a) => a.name === 'cols')!.value)).toBe(cols - 1);
    rowsOf(tgAfter).forEach((r, i) => {
      expect(childrenNamed(r, 'entry').length).toBe(cellCountsBefore[i] - 1);
    });
    expectStable(out);
  });
});

function freshFrom(source: string): Document {
  return parse(source);
}
