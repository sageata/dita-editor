import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { findElement, findElements, firstTextChild } from '../src/cst/query';
import { computeGrid, cellAt, gridCellFor, isGridValid, type TableGrid } from '../src/cst/table-grid';
import { loadCorpusFiles, usesExternalCorpus } from './corpus';

function gridOf(src: string): TableGrid {
  return computeGrid(findElement(parse(src), 'tgroup')!);
}

function cellByText(grid: TableGrid, text: string) {
  return grid.cells.find((c) => firstTextChild(c.entry)?.raw === text);
}

/** Every (row, col) position in every section is covered by EXACTLY one cell. */
function expectTiles(grid: TableGrid): void {
  for (const section of ['thead', 'tbody'] as const) {
    const nrows = grid.rowsBySection[section].length;
    const cover = new Map<string, number>();
    for (const c of grid.cells.filter((c) => c.section === section)) {
      for (let r = c.row; r < c.row + c.rowSpan; r++) {
        for (let cc = c.colStart; cc <= c.colEnd; cc++) {
          cover.set(`${r},${cc}`, (cover.get(`${r},${cc}`) ?? 0) + 1);
        }
      }
    }
    for (let r = 0; r < nrows; r++) {
      for (let cc = 1; cc <= grid.cols; cc++) {
        expect(cover.get(`${r},${cc}`)).toBe(1);
      }
    }
  }
}

describe('computeGrid: positions', () => {
  test('2x2 no-span: each cell occupies its own 1x1 square', () => {
    const grid = gridOf(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>a</entry><entry>b</entry></row><row><entry>c</entry><entry>d</entry></row>' +
        '</tbody></tgroup></table>',
    );
    expect(grid.cells.length).toBe(4);
    expect(cellByText(grid, 'a')).toMatchObject({ row: 0, colStart: 1, colEnd: 1, rowSpan: 1 });
    expect(cellByText(grid, 'd')).toMatchObject({ row: 1, colStart: 2, colEnd: 2, rowSpan: 1 });
    expectTiles(grid);
  });

  test('horizontal span: namest/nameend set colStart/colEnd, next cell shifts right', () => {
    const grid = gridOf(
      '<table><tgroup cols="3"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<colspec colname="c3" colnum="3"/><tbody>' +
        '<row><entry namest="c1" nameend="c2">wide</entry><entry>c</entry></row>' +
        '</tbody></tgroup></table>',
    );
    expect(cellByText(grid, 'wide')).toMatchObject({ colStart: 1, colEnd: 2, rowSpan: 1 });
    expect(cellByText(grid, 'c')).toMatchObject({ colStart: 3, colEnd: 3 });
    expectTiles(grid);
  });

  test('vertical span: morerows makes rowSpan 2 and the covered column is skipped below', () => {
    const grid = gridOf(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody>' +
        '<row><entry morerows="1">tall</entry><entry>b1</entry></row>' +
        '<row><entry>b2</entry></row>' +
        '</tbody></tgroup></table>',
    );
    expect(cellByText(grid, 'tall')).toMatchObject({ row: 0, colStart: 1, colEnd: 1, rowSpan: 2 });
    // b2 is the ONLY entry in row 1, but column 1 is covered by 'tall' -> it lands in column 2.
    expect(cellByText(grid, 'b2')).toMatchObject({ row: 1, colStart: 2, colEnd: 2 });
    expectTiles(grid);
  });

  test('cellAt resolves a covered position to the spanning cell', () => {
    const grid = gridOf(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry morerows="1">tall</entry><entry>b1</entry></row><row><entry>b2</entry></row>' +
        '</tbody></tgroup></table>',
    );
    const tall = cellByText(grid, 'tall')!;
    expect(cellAt(grid, 'tbody', 1, 1)?.entry).toBe(tall.entry); // row 1 col 1 is covered by 'tall'
    expect(gridCellFor(grid, tall.entry)).toBe(tall);
  });
});

describe('isGridValid', () => {
  test('a well-formed spanned table is valid', () => {
    expect(
      isGridValid(
        gridOf(
          '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
            '<tbody><row><entry morerows="1">tall</entry><entry>b1</entry></row><row><entry>b2</entry></row>' +
            '</tbody></tgroup></table>',
        ),
      ),
    ).toBe(true);
  });

  test('flags a malformed table (entry count inconsistent with morerows)', () => {
    // row 1 has 2 entries but c1 is covered by the morerows above -> overflow past cols=2.
    const grid = gridOf(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry morerows="1">x</entry><entry>y</entry></row>' +
        '<row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
    );
    expect(isGridValid(grid)).toBe(false);
  });
});

describe('computeGrid: corpus spanned tables tile exactly', () => {
  const files = loadCorpusFiles();
  const external = usesExternalCorpus();

  test('spanned tables resolve to valid tiled grids', () => {
    let tested = 0;
    let valid = 0;
    const parseFailures: string[] = [];
    for (const file of files) {
      if (tested >= 120) break;
      let doc;
      try {
        doc = parse(file.source);
      } catch (error) {
        parseFailures.push(`${file.rel}: ${String(error)}`);
        continue;
      }
      for (const tgroup of findElements(doc, 'tgroup')) {
        const grid = computeGrid(tgroup);
        const spanned = grid.cells.some((c) => c.rowSpan > 1 || c.colEnd > c.colStart);
        if (!spanned) continue;
        tested++;
        if (isGridValid(grid)) valid++;
        if (tested >= 120) break;
      }
    }
    if (parseFailures.length) {
      console.log(`[table-grid] ${parseFailures.length} parse failures: ${parseFailures.slice(0, 3).join(' | ')}`);
    }

    if (external) {
      // The private corpus is the broad stress gate; a few extracted tables may be malformed.
      expect(tested).toBeGreaterThan(20);
      expect(valid / tested).toBeGreaterThan(0.95);
    } else {
      // Public non-vacuity is backed by the exact shape contract in public-corpus.test.ts.
      expect(tested).toBeGreaterThan(0);
      expect(valid).toBe(tested);
    }
  });
});
