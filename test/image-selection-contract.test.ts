// IMG-1 (canvas image selection) — the render→canvas CONTRACT this slice consumes.
// media/canvas.js can't be unit-tested headlessly (no DOM harness; the selection model is
// runtime-verified), but its image-selection code depends on a precise render output:
// every editable-render <image> must carry a STABLE, UNIQUE data-struct-id with
// data-struct-kind="image". If the render side ever regresses that, canvas image selection
// (unitOf/unitElType/resolveMember/restore) silently breaks — this test is the tripwire.
// Real parser, real DITA shapes; no mock data.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { renderDocument, renderEditable } from '../src/render/to-html';

// Two standalone figure images + an in-cell image, so the contract is checked for the
// fig-level case canvas treats as a unit AND alongside table cells.
const SRC =
  '<topic id="t"><body>' +
  '<fig><image href="images/a.png"/></fig>' +
  '<fig><image href="images/b.png"/></fig>' +
  '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
  '<tbody><row><entry><image href="images/c.png"/></entry></row></tbody></tgroup></table>' +
  '</body></topic>';

describe('editable render stamps a stable addressable id on every image', () => {
  const html = renderEditable(parse(SRC));
  const imgTags = html.match(/<img\b[^>]*>/g) ?? [];

  test('there are three images and each carries data-struct-kind="image"', () => {
    expect(imgTags.length).toBe(3);
    for (const tag of imgTags) {
      expect(tag).toContain('data-struct-kind="image"');
      expect(tag).toMatch(/data-struct-id="e\d+"/);
      expect(tag).toContain('data-selection-kind="image"'); // the canvas selector hook
    }
  });

  test('image ids are UNIQUE (canvas re-resolves each by id after a rerender)', () => {
    const ids = imgTags.map((t) => (t.match(/data-struct-id="(e\d+)"/) ?? [])[1]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the id rides on the SAME <img> as the selection hook (one addressable element)', () => {
    // canvas unitElType matches `img[data-struct-id][data-struct-kind="image"]`; assert that
    // exact attribute co-location (kind+id) on each tag, in either attribute order.
    for (const tag of imgTags) {
      const hasKind = tag.includes('data-struct-kind="image"');
      const hasId = /data-struct-id="e\d+"/.test(tag);
      expect(hasKind && hasId).toBe(true);
    }
  });
});

describe('the image id is editable-render-only (no document bytes, no read-only leakage)', () => {
  test('the plain read-only render carries NO struct id on images', () => {
    const plain = renderDocument(parse(SRC));
    const imgTags = plain.match(/<img\b[^>]*>/g) ?? [];
    expect(imgTags.length).toBe(3);
    for (const tag of imgTags) expect(tag).not.toContain('data-struct-id');
  });
});

describe('image dimensions render from authored DITA attributes', () => {
  test('width is applied as an inline display width in editable and read-only renders', () => {
    const source = '<topic id="t"><body><image href="diagram.svg" width="12.5cm"/></body></topic>';

    expect(renderEditable(parse(source))).toContain('style="width:12.5cm;height:auto"');
    expect(renderDocument(parse(source))).toContain('style="width:12.5cm;height:auto"');
  });

  test('unitless DITA dimensions render as pixels', () => {
    const source = '<topic id="t"><body><image href="diagram.svg" width="320"/></body></topic>';

    expect(renderEditable(parse(source))).toContain('style="width:320px;height:auto"');
  });

  test('height-only and width-plus-height dimensions are honored', () => {
    const heightOnly = '<topic id="t"><body><image href="diagram.svg" height="100px"/></body></topic>';
    const both = '<topic id="t"><body><image href="diagram.svg" width="200px" height="100px"/></body></topic>';

    expect(renderEditable(parse(heightOnly))).toContain('style="width:auto;height:100px"');
    expect(renderEditable(parse(both))).toContain('style="width:200px;height:100px"');
  });
});
