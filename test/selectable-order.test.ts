import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import { walk } from '../src/cst/query';
import { isElement } from '../src/cst/types';
import {
  selectablesInOrder,
  selectableOrderIds,
  selectableKinds,
} from '../src/selection/selectable-order';
import { loadCorpusFiles } from './corpus';

// title + p + image (in a fig) + p + 2-item list + a 2-cell table — every selectable
// kind, with the image sitting BETWEEN two paragraphs to prove interleaved ordering.
const MIXED =
  '<topic><title>T</title><body>' +
  '<p>one</p>' +
  '<fig><image href="a.png"/></fig>' +
  '<p>two</p>' +
  '<ul><li>x</li><li>y</li></ul>' +
  '<table><tgroup cols="2">' +
  '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<tbody><row><entry>c1</entry><entry>c2</entry></row></tbody>' +
  '</tgroup></table>' +
  '</body></topic>';

describe('selectablesInOrder (inline fixture)', () => {
  test('includes title/p/li/entry/image in document order with correct kinds', () => {
    const d = parse(MIXED);
    expect(selectablesInOrder(d).map((s) => s.kind)).toEqual([
      'block', // title
      'block', // p one
      'image', // image
      'block', // p two
      'block', // li x
      'block', // li y
      'cell', // entry c1
      'cell', // entry c2
    ]);
  });

  test('image is ordered BETWEEN its surrounding paragraphs, not appended last', () => {
    const d = parse(MIXED);
    const ids = selectableOrderIds(d);
    const idByEl = assignElementIds(d);
    const firstIdOf = (name: string): string => {
      for (const n of walk(d.children)) if (isElement(n) && n.name === name) return idByEl.get(n)!;
      throw new Error(`no <${name}>`);
    };
    const imgIdx = ids.indexOf(firstIdOf('image'));
    const firstPIdx = ids.indexOf(firstIdOf('p'));
    expect(imgIdx).toBeGreaterThan(firstPIdx); // after p "one"
    expect(imgIdx).toBeLessThan(ids.length - 1); // before the table cells
  });

  test('container elements (fig/table/tgroup/tbody/row/ul) are NOT selectable', () => {
    const d = parse(MIXED);
    const kinds = selectableKinds(d);
    const idByEl = assignElementIds(d);
    for (const n of walk(d.children)) {
      if (isElement(n) && ['fig', 'table', 'tgroup', 'tbody', 'row', 'ul'].includes(n.name)) {
        expect(kinds.has(idByEl.get(n)!)).toBe(false);
      }
    }
  });

  test('order is deterministic across calls', () => {
    const d = parse(MIXED);
    expect(selectableOrderIds(d)).toEqual(selectableOrderIds(d));
  });
});

// ---- portable public corpus by default; optional private corpus via the shared helper. ----
describe('selectablesInOrder — corpus (by shape)', () => {
  const files = loadCorpusFiles();

  test('corpus is present', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('an image-bearing topic includes its image(s) in the selectable order', () => {
    let picked: (typeof files)[number] | undefined;
    for (const file of files) {
      if (file.source.includes('<image') && (file.source.includes('<p>') || file.source.includes('<li>'))) {
        picked = file;
        break;
      }
    }
    expect(picked).toBeDefined();
    const sel = selectablesInOrder(parse(picked!.source));
    expect(sel.some((s) => s.kind === 'image')).toBe(true);
    expect(sel.some((s) => s.kind === 'block')).toBe(true);
    console.log(
      `[selectable-order] shape-picked image topic: ${picked!.rel} (${sel.length} selectables)`,
    );
  });

  test('selectable order is strictly document-ordered (e{N} ascending) on a dense-table topic', () => {
    let picked: (typeof files)[number] | undefined;
    for (const file of files) {
      if ((file.source.match(/<entry/g) || []).length >= 4) {
        picked = file;
        break;
      }
    }
    expect(picked).toBeDefined();
    const ids = selectableOrderIds(parse(picked!.source));
    expect(ids.length).toBeGreaterThan(0);
    const nums = ids.map((id) => Number(id.slice(1))); // e{N} -> N (assignElementIds is depth-first = doc order)
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    console.log(
      `[selectable-order] shape-picked dense-table topic: ${picked!.rel} (${ids.length} selectables)`,
    );
  });
});
