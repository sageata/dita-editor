// P0-2 — the host→webview command-availability map built from the validity core (SoT).
// buildAvailabilityMap turns isValid() into a per-element op→{enabled,reason} map the canvas
// looks up synchronously to enable/disable toolbar controls (no rule duplication in canvas.js).
// Real parser/validity, real DITA shapes; no mock data.

import { describe, expect, test } from 'bun:test';
import { indexDocument, buildAvailabilityMap } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import type { ElementNode } from '../src/cst/types';

function idOf(idx: DocIndex, pred: (el: ElementNode) => boolean): string {
  for (const [id, el] of idx.byId) if (pred(el)) return id;
  throw new Error('no element matched');
}
const textOf = (el: ElementNode): string =>
  el.children.map((c) => (c.type === 'text' ? (c.newText ?? c.raw) : '')).join('');

describe('buildAvailabilityMap — toolbar command availability from the validity core', () => {
  test('single-row table: deleteRow is disabled with a reason; addRowAfter stays enabled', () => {
    const idx = indexDocument(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
    );
    const map = buildAvailabilityMap(idx);
    const rowId = idOf(idx, (el) => el.name === 'row');
    expect(map[rowId].addRowAfter.enabled).toBe(true);
    expect(map[rowId].addRowBefore.enabled).toBe(true);
    expect(map[rowId].deleteRow.enabled).toBe(false);
    expect(map[rowId].deleteRow.reason).toBeTruthy();
  });

  test('two-row table: deleteRow becomes enabled', () => {
    const idx = indexDocument(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
        '<tbody><row><entry>a</entry></row><row><entry>b</entry></row></tbody></tgroup></table>',
    );
    const map = buildAvailabilityMap(idx);
    const firstRow = idOf(idx, (el) => el.name === 'row');
    expect(map[firstRow].deleteRow.enabled).toBe(true);
  });

  test('a cell with no right neighbour cannot mergeRight; one with an aligned neighbour can', () => {
    const idx = indexDocument(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
    );
    const map = buildAvailabilityMap(idx);
    const aId = idOf(idx, (el) => el.name === 'entry' && textOf(el) === 'a');
    const bId = idOf(idx, (el) => el.name === 'entry' && textOf(el) === 'b');
    expect(map[aId].mergeRight.enabled).toBe(true);
    expect(map[bId].mergeRight.enabled).toBe(false);
    expect(map[bId].mergeRight.reason).toBeTruthy();
  });

  test('merged table: crossed-boundary inserts disabled with reason; safe boundaries stay enabled', () => {
    const idx = indexDocument(
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry namest="c1" nameend="c2">merged</entry></row>' +
        '<row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
    );
    const map = buildAvailabilityMap(idx);
    const aId = idOf(idx, (el) => el.name === 'entry' && textOf(el) === 'a');
    expect(map[aId].addColumnAfter.enabled).toBe(false); // boundary under the span
    expect(map[aId].addColumnAfter.reason).toBeTruthy();
    expect(map[aId].addColumnBefore.enabled).toBe(true); // leftmost boundary is safe
    expect(map[aId].deleteColumn.enabled).toBe(false); // deletes keep the blanket refusal
  });

  test('single-item list: deleteItem disabled; two-item list: enabled', () => {
    const one = indexDocument('<ul><li>one</li></ul>');
    const mOne = buildAvailabilityMap(one);
    const liOne = idOf(one, (el) => el.name === 'li');
    expect(mOne[liOne].addItemAfter.enabled).toBe(true);
    expect(mOne[liOne].deleteItem.enabled).toBe(false);

    const two = indexDocument('<ul><li>one</li><li>two</li></ul>');
    const mTwo = buildAvailabilityMap(two);
    const liTwo = idOf(two, (el) => el.name === 'li');
    expect(mTwo[liTwo].deleteItem.enabled).toBe(true);
  });

  test('generic editable blocks expose deleteElement with host validity reasons', () => {
    const idx = indexDocument(
      '<topic><title>Root</title><shortdesc>summary</shortdesc><body>' +
        '<p>keep</p><lines>a\nb</lines><codeblock>x</codeblock>' +
        '<note><p>n</p></note><section><title>S</title><p>s</p></section>' +
        '</body></topic>',
    );
    const map = buildAvailabilityMap(idx);
    for (const name of ['shortdesc', 'lines', 'codeblock', 'note', 'section']) {
      const id = idOf(idx, (el) => el.name === name);
      expect(map[id].deleteElement.enabled).toBe(true);
    }

    const rootTitle = idOf(idx, (el) => el.name === 'title' && el.parent?.name === 'topic');
    expect(map[rootTitle].deleteTitle.enabled).toBe(false);
    expect(map[rootTitle].deleteTitle.reason).toMatch(/required title/i);

    const sectionTitle = idOf(idx, (el) => el.name === 'title' && el.parent?.name === 'section');
    expect(map[sectionTitle].deleteTitle.enabled).toBe(true);
  });

  test('map is keyed by the e{N} ids the renderer stamps, and only structural/cell elements appear', () => {
    const idx = indexDocument('<ul><li>one</li><li>two</li></ul>');
    const map = buildAvailabilityMap(idx);
    for (const id of Object.keys(map)) {
      expect(id).toMatch(/^e\d+$/);
      expect(idx.byId.has(id)).toBe(true);
    }
    // <ul> itself has no toolbar ops -> absent from the map.
    const ulId = idOf(idx, (el) => el.name === 'ul');
    expect(map[ulId]).toBeUndefined();
  });
});
