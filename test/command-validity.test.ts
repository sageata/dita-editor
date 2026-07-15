// Slice B — pure command-validity predicate. Tests use the REAL parser on real
// DITA shapes (same inline-XML idiom as structural.test.ts / table-grid.test.ts)
// plus a cross-check against the real applyStructuralEdit over selected corpus files.
// No mock data: every document is parsed by the production CST parser.

import { test, expect, describe } from 'bun:test';
import { indexDocument, isValid } from '../src/commands/validity';
import type { DocIndex, StructuralOp } from '../src/commands/validity';
import { applyStructuralEdit } from '../src/cst/structural';
import { loadCorpusFiles, type CorpusFile } from './corpus';

// --- test helpers (resolve the e{N} id of a specific element to focus) ---

/** First element id (in depth-first / render order) whose name matches and, if
 *  given, whose decoded-ish text content matches. Mirrors how the canvas hands a
 *  data-struct-id / data-cell-id to the predicate. */
function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''} found`);
}

describe('focus-state gating', () => {
  const idx = indexDocument('<body><p>a</p></body>');

  test('null focus disables every op', () => {
    const v = isValid('deletePara', { id: null }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/focus/i);
  });

  test('unknown focus id disables', () => {
    const v = isValid('deletePara', { id: 'e9999' }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/not found/i);
  });

  test('op on the wrong element kind is disabled', () => {
    const pId = idOf(idx, 'p');
    // deleteRow targets a <row>; focusing a <p> must refuse.
    const v = isValid('deleteRow', { id: pId }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/row/i);
  });
});

describe('non-destructive add ops are always enabled on the right kind', () => {
  test('addParaAfter on a <p>', () => {
    const idx = indexDocument('<body><p>only</p></body>');
    const v = isValid('addParaAfter', { id: idOf(idx, 'p') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('addItemAfter on a <li>', () => {
    const idx = indexDocument('<ul><li>only</li></ul>');
    const v = isValid('addItemAfter', { id: idOf(idx, 'li') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('addRowAfter on a <row>', () => {
    const idx = indexDocument(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
        '<tbody><row><entry>x</entry></row></tbody></tgroup></table>',
    );
    const v = isValid('addRowAfter', { id: idOf(idx, 'row') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });
});

// --- shared inline fixtures ---
const TWO_ROW =
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry>a</entry><entry>b</entry></row>' +
  '<row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';
const ONE_ROW =
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>';
// c1 spans both columns of its row (a real mergeRight result) -> table has merged cells.
const SPANNED =
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry namest="c1" nameend="c2">ab</entry></row>' +
  '<row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';
const ONE_COL =
  '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
  '<tbody><row><entry>x</entry></row><row><entry>y</entry></row></tbody></tgroup></table>';

describe('destructive delete guards (the predicate is the only gate)', () => {
  test('deleteRow enabled with 2 rows, refused on the last row (ditaValid:false)', () => {
    expect(isValid('deleteRow', { id: idOf(indexDocument(TWO_ROW), 'row') }, indexDocument(TWO_ROW)).enabled).toBe(true);
    const v = isValid('deleteRow', { id: idOf(indexDocument(ONE_ROW), 'row') }, indexDocument(ONE_ROW));
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only row/i), ditaValid: false });
  });

  test('deleteItem refused on the only <li> (ditaValid:false)', () => {
    const multi = indexDocument('<ul><li>one</li><li>two</li></ul>');
    expect(isValid('deleteItem', { id: idOf(multi, 'li', 'one') }, multi).enabled).toBe(true);
    const solo = indexDocument('<ul><li>only</li></ul>');
    const v = isValid('deleteItem', { id: idOf(solo, 'li') }, solo);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only item/i), ditaValid: false });
  });

  test('deleteItem allows the only <li> when its whole list can leave a mixed-content note', () => {
    const idx = indexDocument('<body><note>Keep this warning<ul><li/></ul></note></body>');
    expect(isValid('deleteItem', { id: idOf(idx, 'li') }, idx)).toEqual({
      enabled: true,
      ditaValid: true,
    });
  });

  test('deletePara refused on the only <p>, but reports ditaValid:true (authoring guard)', () => {
    const multi = indexDocument('<body><p>a</p><p>b</p></body>');
    expect(isValid('deletePara', { id: idOf(multi, 'p', 'a') }, multi).enabled).toBe(true);
    const solo = indexDocument('<body><p>only</p></body>');
    const v = isValid('deletePara', { id: idOf(solo, 'p') }, solo);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only paragraph/i), ditaValid: true });
  });
});

describe('whole-block deletes (table / list / fig) refuse the sole block of a container', () => {
  const ulId = (idx: DocIndex): string => {
    for (const [id, el] of idx.byId) if (el.name === 'ul' || el.name === 'ol') return id;
    throw new Error('no list');
  };

  test('deleteTable enabled when a sibling block remains, refused as the only block (ditaValid:false)', () => {
    const multi = indexDocument(
      '<body><p>keep</p><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table></body>',
    );
    expect(isValid('deleteTable', { id: idOf(multi, 'table') }, multi).enabled).toBe(true);
    const solo = indexDocument(
      '<body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table></body>',
    );
    const v = isValid('deleteTable', { id: idOf(solo, 'table') }, solo);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only block/i), ditaValid: false });
  });

  test('deleteList enabled with a sibling, refused as the only block; rejects a non-list focus', () => {
    const multi = indexDocument('<body><p>keep</p><ul><li>x</li></ul></body>');
    expect(isValid('deleteList', { id: ulId(multi) }, multi).enabled).toBe(true);
    const solo = indexDocument('<body><ul><li>x</li></ul></body>');
    expect(isValid('deleteList', { id: ulId(solo) }, solo).ditaValid).toBe(false);
    // wrong focus kind: a <p> is not a list
    const v = isValid('deleteList', { id: idOf(multi, 'p', 'keep') }, multi);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/a list/i);
  });

  test('deleteFig enabled with a sibling block, refused as the only block', () => {
    const multi = indexDocument('<body><p>keep</p><fig><image href="i.png"/></fig></body>');
    expect(isValid('deleteFig', { id: idOf(multi, 'fig') }, multi).enabled).toBe(true);
    const solo = indexDocument('<body><fig><image href="i.png"/></fig></body>');
    expect(isValid('deleteFig', { id: idOf(solo, 'fig') }, solo).enabled).toBe(false);
  });
});

describe('deleteImage / deleteTitle (parent-aware) validity', () => {
  test('deleteImage is enabled and DITA-valid on an <image> (optional everywhere)', () => {
    const idx = indexDocument('<body><fig><image href="i.png"/></fig></body>');
    const v = isValid('deleteImage', { id: idOf(idx, 'image') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('deleteImage refuses the wrong focus kind', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const v = isValid('deleteImage', { id: idOf(idx, 'p') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/an image/i);
  });

  test('deleteTitle enabled on an OPTIONAL <fig> title (ditaValid:true)', () => {
    const idx = indexDocument('<fig><title>F</title><image href="i.png"/></fig>');
    const v = isValid('deleteTitle', { id: idOf(idx, 'title') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('deleteTitle enabled on an OPTIONAL <table> title', () => {
    const idx = indexDocument(
      '<table><title>T</title><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
        '<tbody><row><entry>x</entry></row></tbody></tgroup></table>',
    );
    expect(isValid('deleteTitle', { id: idOf(idx, 'title') }, idx).enabled).toBe(true);
  });

  test('deleteTitle REFUSES a REQUIRED topic-root title (ditaValid:false)', () => {
    const idx = indexDocument('<topic><title>Doc</title><body><p>x</p></body></topic>');
    const v = isValid('deleteTitle', { id: idOf(idx, 'title') }, idx);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/required title/i), ditaValid: false });
  });
});

describe('deleteElement (universal, category-driven) validity reuses canDeleteElement', () => {
  test('enabled + ditaValid on an optional block with a sibling', () => {
    const idx = indexDocument('<body><p>a</p><p>b</p></body>');
    expect(isValid('deleteElement', { id: idOf(idx, 'p', 'a') }, idx)).toEqual({
      enabled: true,
      ditaValid: true,
    });
  });

  test('refuses the sole block of a container with the apply-time reason', () => {
    const idx = indexDocument('<body><p>only</p></body>');
    const v = isValid('deleteElement', { id: idOf(idx, 'p') }, idx);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only block/i), ditaValid: false });
  });

  test('refuses a required topic-root <title>', () => {
    const idx = indexDocument('<topic><title>Doc</title><body><p>x</p></body></topic>');
    const v = isValid('deleteElement', { id: idOf(idx, 'title') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/required <title>/);
  });

  test('a sole <li> cascades to deleting its list (allowed — the body keeps another block)', () => {
    // Deleting a list's only item removes the would-be-empty list itself; here the body still
    // has <p>keep</p>, so the cascade is valid and the universal delete is ENABLED.
    const idx = indexDocument('<body><p>keep</p><ul><li>only</li></ul></body>');
    const v = isValid('deleteElement', { id: idOf(idx, 'li') }, idx);
    expect(v.enabled).toBe(true);
  });

  test('refuses a table cell', () => {
    const idx = indexDocument(TWO_ROW);
    const v = isValid('deleteElement', { id: idOf(idx, 'entry', 'a') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/can't be deleted on its own/);
  });

  test('availability reason equals apply-time throw (single source of truth)', () => {
    const src = '<topic><body>\n  <ul>\n    <li>only</li>\n  </ul>\n</body></topic>';
    const idx = indexDocument(src);
    const v = isValid('deleteElement', { id: idOf(idx, 'li') }, idx);
    expect(v.enabled).toBe(false);
    let thrown = '';
    try {
      applyStructuralEdit(src, 'deleteElement', idOf(idx, 'li'));
    } catch (e) {
      thrown = (e as Error).message;
    }
    expect(v.reason).not.toBeUndefined();
    expect(thrown).toBe(v.reason ?? '');
  });
});

describe('column ops: no-span enabled, spanned refused', () => {
  test('addColumnAfter/addColumnBefore/deleteColumn enabled on a clean (no-span) table', () => {
    const idx = indexDocument(TWO_ROW);
    const id = idOf(idx, 'entry', 'a');
    expect(isValid('addColumnAfter', { id }, idx)).toEqual({ enabled: true, ditaValid: true });
    expect(isValid('addColumnBefore', { id }, idx)).toEqual({ enabled: true, ditaValid: true });
    expect(isValid('deleteColumn', { id }, idx)).toEqual({ enabled: true, ditaValid: true });
  });

  test('column INSERTS are per-boundary on a merged table: crossed boundary refused, safe boundary allowed', () => {
    const idx = indexDocument(SPANNED);
    const cId = idOf(idx, 'entry', 'c');
    const dId = idOf(idx, 'entry', 'd');
    // Interior boundary (between c and d) is crossed by the 'ab' span above.
    const crossed = isValid('addColumnAfter', { id: cId }, idx);
    expect(crossed.enabled).toBe(false);
    expect(crossed.ditaValid).toBe(true);
    expect(crossed.reason).toMatch(/spans across/i);
    expect(isValid('addColumnBefore', { id: dId }, idx).enabled).toBe(false);
    // Outer boundaries are safe even though the table has merged cells.
    expect(isValid('addColumnBefore', { id: cId }, idx)).toEqual({ enabled: true, ditaValid: true });
    expect(isValid('addColumnAfter', { id: dId }, idx)).toEqual({ enabled: true, ditaValid: true });
    // deleteColumn keeps the blanket merged-table refusal.
    const del = isValid('deleteColumn', { id: cId }, idx);
    expect(del.enabled).toBe(false);
    expect(del.reason).toMatch(/merged/i);
  });

  test('deleteColumn refused on a single-column table (ditaValid:false)', () => {
    const idx = indexDocument(ONE_COL);
    const v = isValid('deleteColumn', { id: idOf(idx, 'entry', 'x') }, idx);
    expect(v).toEqual({ enabled: false, reason: expect.stringMatching(/only column/i), ditaValid: false });
  });
});

describe('cell merge/split guards mirror table-merge.ts', () => {
  test('mergeRight enabled on left cell, refused on rightmost (no neighbour)', () => {
    const idx = indexDocument(TWO_ROW);
    expect(isValid('mergeRight', { id: idOf(idx, 'entry', 'a') }, idx).enabled).toBe(true);
    const v = isValid('mergeRight', { id: idOf(idx, 'entry', 'b') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/right/i);
  });

  test('mergeDown enabled top cell, refused bottom cell (no cell below)', () => {
    const idx = indexDocument(TWO_ROW);
    expect(isValid('mergeDown', { id: idOf(idx, 'entry', 'a') }, idx).enabled).toBe(true);
    expect(isValid('mergeDown', { id: idOf(idx, 'entry', 'c') }, idx).enabled).toBe(false);
  });

  test('splitCell enabled on a spanned cell, refused on a 1x1 cell', () => {
    const spanned = indexDocument(SPANNED);
    expect(isValid('splitCell', { id: idOf(spanned, 'entry', 'ab') }, spanned).enabled).toBe(true);
    const plain = indexDocument(TWO_ROW);
    const v = isValid('splitCell', { id: idOf(plain, 'entry', 'a') }, plain);
    expect(v.enabled).toBe(false);
    expect(v.reason).toMatch(/not merged/i);
  });
});

// ---- Cross-check against the real applyStructuralEdit over corpus files. ----
// The predicate's `enabled` must equal whether the real op succeeds (does not throw).
// applyStructuralEdit takes a source STRING and returns a new string; it never
// mutates the input or any file, so this is byte-safe (results are discarded).
const CELL_OPS: StructuralOp[] = ['mergeRight', 'mergeDown', 'splitCell', 'addColumnAfter', 'addColumnBefore', 'deleteColumn'];

function tgroupFiles(limit: number): CorpusFile[] {
  const out: CorpusFile[] = [];
  for (const file of loadCorpusFiles()) {
    if (file.source.includes('<tgroup')) out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

describe('corpus cross-check: predicate.enabled === real-op-succeeds', () => {
  const FILE_CAP = 25;
  const CELLS_PER_FILE = 10; // sampled per file to keep the run bounded
  const files = tgroupFiles(FILE_CAP);

  test('corpus tables exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test(`enabled matches throw/no-throw (≤${FILE_CAP} files, ≤${CELLS_PER_FILE} cells each)`, () => {
    let checked = 0;
    let skippedCells = 0;
    for (const file of files) {
      const source = file.source;
      const idx = indexDocument(source);
      const cellIds: string[] = [];
      for (const [id, el] of idx.byId) if (el.name === 'entry') cellIds.push(id);
      const sample = cellIds.slice(0, CELLS_PER_FILE);
      if (cellIds.length > CELLS_PER_FILE) skippedCells += cellIds.length - CELLS_PER_FILE;
      for (const id of sample) {
        for (const op of CELL_OPS) {
          const predicted = isValid(op, { id }, idx).enabled;
          let succeeded = true;
          try {
            applyStructuralEdit(source, op, id);
          } catch {
            succeeded = false;
          }
          if (predicted !== succeeded) {
            throw new Error(
              `mismatch in ${file.rel} cell ${id} op ${op}: ` +
                `predicted enabled=${predicted} but real op succeeded=${succeeded}`,
            );
          }
          checked++;
        }
      }
    }
    // Surface the bound so a green run is never mistaken for full coverage.
    console.log(`[corpus cross-check] ${checked} (cell,op) pairs across ${files.length} files; ${skippedCells} cells skipped by per-file cap`);
    expect(checked).toBeGreaterThan(0);
  });
});
