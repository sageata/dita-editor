import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { findElement, findElements, childrenNamed, firstTextChild } from '../src/cst/query';
import { computeGrid, isGridValid, gridCellFor } from '../src/cst/table-grid';
import { mergeRight, mergeDown, mergeLeft, mergeUp, splitCell } from '../src/cst/table-merge';
import type { Document, ElementNode } from '../src/cst/types';
import { loadCorpusFiles } from './corpus';

// An indented 3-column table so indentation mirroring is exercised.
function table3(rowsXml: string): string {
  return (
    '<topic><body>\n  <table><tgroup cols="3">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n' +
    '    <colspec colname="c3" colnum="3"/>\n' +
    `    <tbody>\n${rowsXml}\n    </tbody>\n  </tgroup></table>\n</body></topic>`
  );
}
function row(...cells: string[]): string {
  return '      <row>\n' + cells.map((c) => `        ${c}`).join('\n') + '\n      </row>';
}

function entryByText(doc: Document, text: string): ElementNode {
  const el = findElements(doc, 'entry').find((e) => firstTextChild(e)?.raw === text);
  if (!el) throw new Error(`no <entry> with text ${JSON.stringify(text)}`);
  return el;
}
const gridOf = (doc: Document) => computeGrid(findElement(doc, 'tgroup')!);
const valid = (s: string) => isGridValid(gridOf(parse(s)));
const stable = (s: string) => serialize(parse(s)) === s;

describe('mergeRight', () => {
  test('absorbs the right neighbour into a namest/nameend span; neighbour removed; grid stays valid', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    mergeRight(doc, entryByText(doc, 'a'));
    const out = serialize(doc);
    // content is CONCATENATED into the merged cell, never dropped
    expect(out).toContain('<entry namest="c1" nameend="c2">a b</entry>');
    expect(out).not.toContain('<entry>b</entry>'); // 'b' is no longer a separate cell
    expect(out).toContain('<entry>c</entry>');
    expect(findElements(parse(out), 'entry').length).toBe(2);
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('extends an existing span rather than adding a second namest', () => {
    const doc = parse(
      table3(row('<entry namest="c1" nameend="c2">wide</entry>', '<entry>c</entry>')),
    );
    mergeRight(doc, entryByText(doc, 'wide'));
    const out = serialize(doc);
    expect(out).toContain('<entry namest="c1" nameend="c3">wide c</entry>'); // 'c' absorbed
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('refuses at the last column', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    expect(() => mergeRight(doc, entryByText(doc, 'c'))).toThrow();
  });

  test('absorbs an image from the neighbour cell (no content silently dropped)', () => {
    const doc = parse(
      table3(
        row('<entry>a</entry>', '<entry><image href="x.png"/></entry>', '<entry>c</entry>'),
      ),
    );
    mergeRight(doc, entryByText(doc, 'a'));
    const out = serialize(doc);
    // the image moved into the merged cell verbatim; still exactly one image in the table
    expect(out).toContain('<image href="x.png"/>');
    expect((out.match(/<image /g) ?? []).length).toBe(1);
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });
});

describe('mergeLeft', () => {
  test('equals mergeRight issued from the left cell: LEFT absorbs, document order preserved', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    const survivor = mergeLeft(doc, entryByText(doc, 'b'));
    const out = serialize(doc);
    expect(out).toContain('<entry namest="c1" nameend="c2">a b</entry>'); // left first
    expect(firstTextChild(survivor)?.raw).toBe('a'); // focus = the surviving LEFT cell
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('extends when the left cell already spans', () => {
    const doc = parse(
      table3(row('<entry namest="c1" nameend="c2">wide</entry>', '<entry>c</entry>')),
    );
    mergeLeft(doc, entryByText(doc, 'c'));
    const out = serialize(doc);
    expect(out).toContain('<entry namest="c1" nameend="c3">wide c</entry>');
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('refuses at the first column', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    expect(() => mergeLeft(doc, entryByText(doc, 'a'))).toThrow(/left/i);
  });

  test('refuses when the left cell is not row-aligned', () => {
    const doc = parse(
      table3(
        row('<entry morerows="1">tall</entry>', '<entry>b</entry>', '<entry>c</entry>') +
          '\n' +
          row('<entry>e</entry>', '<entry>f</entry>'),
      ),
    );
    // 'e' sits right of the 2-row 'tall' span: not row-aligned with it.
    expect(() => mergeLeft(doc, entryByText(doc, 'e'))).toThrow(/aligned/i);
  });
});

describe('mergeUp', () => {
  test('equals mergeDown issued from the cell above: TOP absorbs, document order preserved', () => {
    const doc = parse(
      table3(
        row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>') +
          '\n' +
          row('<entry>d</entry>', '<entry>e</entry>', '<entry>f</entry>'),
      ),
    );
    const survivor = mergeUp(doc, entryByText(doc, 'd'));
    const out = serialize(doc);
    expect(out).toContain('<entry morerows="1">a d</entry>'); // top first
    expect(firstTextChild(survivor)?.raw).toBe('a');
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('refuses on the first row of a section (no cell above within the section)', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    expect(() => mergeUp(doc, entryByText(doc, 'a'))).toThrow(/above/i);
  });

  test('mergeUp from the first tbody row of a thead table refuses (sections never merge)', () => {
    const src =
      '<topic><body>\n  <table><tgroup cols="1">\n' +
      '    <colspec colname="c1" colnum="1"/>\n' +
      '    <thead>\n      <row>\n        <entry>H</entry>\n      </row>\n    </thead>\n' +
      '    <tbody>\n      <row>\n        <entry>a</entry>\n      </row>\n' +
      '      <row>\n        <entry>b</entry>\n      </row>\n    </tbody>\n' +
      '  </tgroup></table>\n</body></topic>';
    const doc = parse(src);
    expect(() => mergeUp(doc, entryByText(doc, 'a'))).toThrow(/above/i);
  });

  test('refuses when the cell above is not column-aligned', () => {
    const doc = parse(
      table3(
        row('<entry namest="c1" nameend="c2">wide</entry>', '<entry>c</entry>') +
          '\n' +
          row('<entry>d</entry>', '<entry>e</entry>', '<entry>f</entry>'),
      ),
    );
    expect(() => mergeUp(doc, entryByText(doc, 'd'))).toThrow(/aligned/i);
  });
});

describe('mergeDown', () => {
  test('absorbs the cell below into a morerows span; below removed; grid valid', () => {
    const doc = parse(
      table3(
        row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>') +
          '\n' +
          row('<entry>d</entry>', '<entry>e</entry>', '<entry>f</entry>'),
      ),
    );
    mergeDown(doc, entryByText(doc, 'a'));
    const out = serialize(doc);
    expect(out).toContain('<entry morerows="1">a d</entry>'); // 'd' absorbed, not dropped
    expect(out).not.toContain('<entry>d</entry>');
    const rows = findElements(parse(out), 'row');
    expect(childrenNamed(rows[1], 'entry').length).toBe(2); // c1 covered -> e, f
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });
});

describe('splitCell', () => {
  test('un-merges a horizontal span, re-adding an empty cell, grid valid, indented (not jammed)', () => {
    const doc = parse(
      table3(row('<entry namest="c1" nameend="c2">wide</entry>', '<entry>c</entry>')),
    );
    splitCell(doc, entryByText(doc, 'wide'));
    const out = serialize(doc);
    expect(out).not.toContain('namest');
    expect(out).toContain('<entry>wide</entry>');
    expect(findElements(parse(out), 'entry').length).toBe(3); // wide, empty, c
    expect(out).toContain('\n        <entry></entry>'); // re-added cell keeps indentation
    expect(out).not.toContain('</entry><entry>');
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('un-merges a vertical span, re-adding the covered cell in the row below', () => {
    const doc = parse(
      table3(
        row('<entry morerows="1">tall</entry>', '<entry>b</entry>', '<entry>c</entry>') +
          '\n' +
          row('<entry>e</entry>', '<entry>f</entry>'), // row 1: c1 covered by 'tall'
      ),
    );
    splitCell(doc, entryByText(doc, 'tall'));
    const out = serialize(doc);
    expect(out).not.toContain('morerows');
    const rows = findElements(parse(out), 'row');
    expect(childrenNamed(rows[1], 'entry').length).toBe(3); // re-added c1 empty + e + f
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });

  test('refuses a non-merged 1x1 cell', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    expect(() => splitCell(doc, entryByText(doc, 'a'))).toThrow();
  });
});

describe('merge then split round-trips to a valid grid', () => {
  test('mergeRight + splitCell restores three cells', () => {
    const doc = parse(table3(row('<entry>a</entry>', '<entry>b</entry>', '<entry>c</entry>')));
    mergeRight(doc, entryByText(doc, 'a'));
    const merged = serialize(doc);
    const doc2 = parse(merged);
    // merge concatenated 'a'+'b' into the spanned cell; split re-adds an empty cell.
    splitCell(doc2, entryByText(doc2, 'a b'));
    const out = serialize(doc2);
    expect(findElements(parse(out), 'entry').length).toBe(3);
    expect(out).toContain('<entry>a b</entry>'); // content preserved through merge->split
    expect(valid(out)).toBe(true);
    expect(stable(out)).toBe(true);
  });
});

describe('refuses malformed tables', () => {
  test('splitCell throws on an inconsistent morerows/entry-count table', () => {
    const src =
      '<topic><body><table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry morerows="1">x</entry><entry>y</entry></row>' +
      '<row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table></body></topic>';
    const doc = parse(src);
    expect(() => splitCell(doc, entryByText(doc, 'x'))).toThrow();
  });
});

describe('corpus: split a spanned cell', () => {
  const files = loadCorpusFiles();

  const isSpanned = (e: ElementNode) =>
    e.attrs.some((a) => a.name === 'namest' || a.name === 'nameend' || a.name === 'morerows');
  const tgroupOfEntry = (entry: ElementNode): ElementNode => {
    let n: ElementNode | null | undefined = entry.parent;
    while (n && n.name !== 'tgroup') n = n.parent;
    return n!;
  };

  function findRealSpannedCell(): { source: string; entryText: string } | null {
    for (const file of files) {
      let doc: Document;
      try {
        doc = parse(file.source);
      } catch (error) {
        console.error(`[table-merge] failed to parse ${file.rel}: ${String(error)}`);
        continue;
      }
      for (const tgroup of findElements(doc, 'tgroup')) {
        const grid = computeGrid(tgroup);
        if (!isGridValid(grid)) continue;
        const spanned = grid.cells.find(
          (c) => (c.colEnd > c.colStart || c.rowSpan > 1) && firstTextChild(c.entry),
        );
        if (spanned) {
          return { source: file.source, entryText: firstTextChild(spanned.entry)!.raw };
        }
      }
    }
    return null;
  }

  test('splitting a real spanned cell yields a valid, byte-stable table', () => {
    const found = findRealSpannedCell();
    expect(found).not.toBeNull();
    const doc = parse(found!.source);
    // The actual spanned <entry> with that text (text may repeat; pick the merged one).
    const entry = findElements(doc, 'entry').find(
      (e) => firstTextChild(e)?.raw === found!.entryText && isSpanned(e),
    )!;
    const tg = tgroupOfEntry(entry);
    const tgIndex = findElements(doc, 'tgroup').indexOf(tg); // the file may hold other (even malformed) tables
    const before = gridCellFor(computeGrid(tg), entry)!;
    expect(before.colEnd > before.colStart || before.rowSpan > 1).toBe(true); // really merged

    splitCell(doc, entry);
    const out = serialize(doc);
    // The EDITED table is valid CALS geometry, and the whole file round-trips byte-exact.
    const editedTgroup = findElements(parse(out), 'tgroup')[tgIndex];
    expect(isGridValid(computeGrid(editedTgroup))).toBe(true);
    expect(stable(out)).toBe(true);
  });
});
