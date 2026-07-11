// CALS table geometry. A CALS row only lists the <entry> elements that START in
// that row; columns covered by a morerows span from above, or by a namest/nameend
// span to the left, have NO <entry>. To merge/split correctly we must resolve each
// entry's true logical rectangle in the grid. This is the standard occupancy sweep
// (same idea as HTML table layout), computed PER SECTION because a span never
// crosses the thead/tbody boundary in valid CALS.

import { childrenNamed, firstChildNamed } from './query';
import type { ElementNode } from './types';

export type SectionName = 'thead' | 'tbody';

export interface GridCell {
  entry: ElementNode;
  section: SectionName;
  /** 0-based row index within the cell's section. */
  row: number;
  /** 1-based inclusive column range the cell occupies. */
  colStart: number;
  colEnd: number;
  /** morerows + 1. */
  rowSpan: number;
}

export interface TableGrid {
  tgroup: ElementNode;
  cols: number;
  numByColname: Map<string, number>;
  colnameByNum: Map<number, string>;
  cells: GridCell[];
  rowsBySection: Record<SectionName, ElementNode[]>;
}

function attrOf(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function computeGrid(tgroup: ElementNode): TableGrid {
  const colspecs = childrenNamed(tgroup, 'colspec');
  const cols = Number(attrOf(tgroup, 'cols')) || colspecs.length;

  const numByColname = new Map<string, number>();
  const colnameByNum = new Map<number, string>();
  colspecs.forEach((cs, i) => {
    const name = attrOf(cs, 'colname');
    const num = Number(attrOf(cs, 'colnum')) || i + 1;
    if (name) {
      numByColname.set(name, num);
      colnameByNum.set(num, name);
    }
  });

  const cells: GridCell[] = [];
  const rowsBySection: Record<SectionName, ElementNode[]> = { thead: [], tbody: [] };

  for (const sectionName of ['thead', 'tbody'] as SectionName[]) {
    const section = firstChildNamed(tgroup, sectionName);
    if (!section) continue;
    const rows = childrenNamed(section, 'row');
    rowsBySection[sectionName] = rows;

    const occupied = new Set<string>(); // `${row},${col}` covered by a span from above/left
    rows.forEach((row, r) => {
      let col = 1;
      for (const entry of childrenNamed(row, 'entry')) {
        while (occupied.has(`${r},${col}`)) col++;

        const namest = attrOf(entry, 'namest');
        const nameend = attrOf(entry, 'nameend');
        let colStart = col;
        let colEnd = col;
        if (namest && nameend && numByColname.has(namest) && numByColname.has(nameend)) {
          colStart = numByColname.get(namest)!;
          colEnd = numByColname.get(nameend)!;
        }

        const rowSpan = (Number(attrOf(entry, 'morerows')) || 0) + 1;
        cells.push({ entry, section: sectionName, row: r, colStart, colEnd, rowSpan });

        for (let rr = r; rr < r + rowSpan; rr++) {
          for (let cc = colStart; cc <= colEnd; cc++) occupied.add(`${rr},${cc}`);
        }
        col = colEnd + 1;
      }
    });
  }

  return { tgroup, cols, numByColname, colnameByNum, cells, rowsBySection };
}

/** The cell whose rectangle covers (section, row, col), or undefined. */
export function cellAt(
  grid: TableGrid,
  section: SectionName,
  row: number,
  col: number,
): GridCell | undefined {
  return grid.cells.find(
    (c) =>
      c.section === section &&
      row >= c.row &&
      row < c.row + c.rowSpan &&
      col >= c.colStart &&
      col <= c.colEnd,
  );
}

export function gridCellFor(grid: TableGrid, entry: ElementNode): GridCell | undefined {
  return grid.cells.find((c) => c.entry === entry);
}

/** True iff the grid is well-formed: no cell over/under-flows the column count or
 *  section rows, and every (row, col) is covered by EXACTLY one cell. Some
 *  PDF-extracted corpus tables are malformed (inconsistent morerows vs entry
 *  counts) — merge/split must refuse those rather than corrupt them further. */
export function isGridValid(grid: TableGrid): boolean {
  for (const c of grid.cells) {
    if (c.colStart < 1 || c.colEnd > grid.cols || c.colStart > c.colEnd || c.rowSpan < 1) {
      return false;
    }
  }
  for (const section of ['thead', 'tbody'] as const) {
    const nrows = grid.rowsBySection[section].length;
    const sectionCells = grid.cells.filter((c) => c.section === section);
    for (const c of sectionCells) {
      if (c.row + c.rowSpan > nrows) return false; // rowspan runs past the section
    }
    const cover = new Map<string, number>();
    for (const c of sectionCells) {
      for (let r = c.row; r < c.row + c.rowSpan; r++) {
        for (let cc = c.colStart; cc <= c.colEnd; cc++) {
          cover.set(`${r},${cc}`, (cover.get(`${r},${cc}`) ?? 0) + 1);
        }
      }
    }
    for (let r = 0; r < nrows; r++) {
      for (let cc = 1; cc <= grid.cols; cc++) {
        if (cover.get(`${r},${cc}`) !== 1) return false;
      }
    }
  }
  return true;
}
