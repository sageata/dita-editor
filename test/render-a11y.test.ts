// Slice D — accessibility/selection metadata in the renderer. Asserts:
//  • a valid table accessible name (caption from the DITA <table><title>);
//  • deterministic selection hooks (data-selectable + data-selection-kind) that
//    canvas.js can target later WITHOUT guessing selectors — emitted only in the
//    editable render, alongside the existing data-edit-id/data-struct-id/data-cell-id;
//  • native table/list semantics and the H43 header associations are preserved;
//  • NO aria-selected and NO widget-role overreach are introduced.
// Real parser, real DITA shapes — no mock data.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { renderDocument, renderEditable } from '../src/render/to-html';

const TABLE_WITH_TITLE =
  '<table><title>Seat map</title><tgroup cols="2">' +
  '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
  '<thead><row><entry>A</entry><entry>B</entry></row></thead>' +
  '<tbody><row><entry>x</entry><entry>y</entry></row></tbody></tgroup></table>';

const TABLE_NO_TITLE =
  '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
  '<tbody><row><entry>x</entry></row></tbody></tgroup></table>';

const DOC =
  '<topic id="t"><title>T</title><body>' +
  '<p>para</p><ul><li>item</li></ul>' +
  TABLE_WITH_TITLE +
  '<fig><image href="pics/a.png"/></fig>' +
  '</body></topic>';

describe('table accessible name (caption from <title>)', () => {
  test('a table <title> renders into a non-empty <caption>', () => {
    const html = renderDocument(parse(TABLE_WITH_TITLE));
    expect(html).toContain('<caption>Seat map</caption>');
    expect(html).not.toContain('<caption></caption>');
  });

  test('a table without a <title> emits no caption at all (not an empty one)', () => {
    const html = renderDocument(parse(TABLE_NO_TITLE));
    expect(html).not.toContain('<caption');
  });

  test('the caption is present in the editable render too (now with edit/struct hooks — F10)', () => {
    const html = renderEditable(parse(TABLE_WITH_TITLE));
    expect(html).toMatch(
      /<caption contenteditable="true" data-edit-id="[^"]+"[^>]*data-struct-kind="title"[^>]*>Seat map<\/caption>/,
    );
  });
});

describe('derived table accessible name (no <title>) — editable render, render-only (P0-3)', () => {
  test('a no-title table gets an aria-label from the nearest topic title + position', () => {
    const html = renderEditable(
      parse('<topic id="t"><title>Cut-off points</title><body>' + TABLE_NO_TITLE + '</body></topic>'),
    );
    // editable render now also stamps the table as an insert anchor (P1-2b: data-struct-kind="table")
    expect(html).toMatch(
      /<table class="table" aria-label="Cut-off points, table 1" data-struct-id="e\d+" data-struct-kind="table">/,
    );
  });

  test('a <section> title wins over the topic title for tables inside the section', () => {
    const html = renderEditable(
      parse(
        '<topic id="t"><title>Topic</title><body>' +
          '<section><title>Grids</title>' +
          TABLE_NO_TITLE +
          '</section></body></topic>',
      ),
    );
    expect(html).toContain('aria-label="Grids, table 1"');
  });

  test('positional fallback "Table N" when there is no ancestor title', () => {
    expect(renderEditable(parse(TABLE_NO_TITLE))).toContain('aria-label="Table 1"');
  });

  test('multiple no-title tables under one title get distinct positional ordinals', () => {
    const html = renderEditable(
      parse(
        '<topic id="t"><title>Amenities</title><body>' + TABLE_NO_TITLE + TABLE_NO_TITLE + '</body></topic>',
      ),
    );
    expect(html).toContain('aria-label="Amenities, table 1"');
    expect(html).toContain('aria-label="Amenities, table 2"');
  });

  test('a table WITH a <title> keeps its <caption> and gets NO aria-label (caption is the name)', () => {
    const html = renderEditable(
      parse('<topic id="t"><title>Topic</title><body>' + TABLE_WITH_TITLE + '</body></topic>'),
    );
    expect(html).toMatch(/<caption[^>]*>Seat map<\/caption>/);
    expect(html).not.toMatch(/<table[^>]*aria-label/);
  });

  test('entities in a title stay valid in the derived aria-label', () => {
    const html = renderEditable(
      parse('<topic id="t"><title>Tea &amp; Coffee</title><body>' + TABLE_NO_TITLE + '</body></topic>'),
    );
    expect(html).toContain('aria-label="Tea &amp; Coffee, table 1"');
  });

  test('the derived name is render-only: both render paths emit it and serialize stays byte-exact', () => {
    const src = '<topic id="t"><title>T</title><body>' + TABLE_NO_TITLE + '</body></topic>';
    const doc = parse(src);
    // the read-only preview now derives names too, so its tables are not anonymous to AT
    expect(renderDocument(doc)).toContain('aria-label="T, table 1"');
    expect(serialize(doc)).toBe(src); // ...but the read-only render never mutates the CST
    renderEditable(doc);
    expect(serialize(doc)).toBe(src); // editable render does not mutate the CST either
  });
});

describe('derived table accessible name in the read-only preview (P0-3, renderDocument)', () => {
  test('a no-title table gets the derived aria-label in the read-only render too', () => {
    const html = renderDocument(
      parse('<topic id="t"><title>Cut-off points</title><body>' + TABLE_NO_TITLE + '</body></topic>'),
    );
    expect(html).toContain('<table class="table" aria-label="Cut-off points, table 1">');
  });

  test('positional fallback "Table N" when there is no ancestor title (read-only)', () => {
    expect(renderDocument(parse(TABLE_NO_TITLE))).toContain('aria-label="Table 1"');
  });

  test('multiple no-title tables get distinct positional ordinals (read-only)', () => {
    const html = renderDocument(
      parse('<topic id="t"><title>Amenities</title><body>' + TABLE_NO_TITLE + TABLE_NO_TITLE + '</body></topic>'),
    );
    expect(html).toContain('aria-label="Amenities, table 1"');
    expect(html).toContain('aria-label="Amenities, table 2"');
  });

  test('a titled table keeps its <caption> and gets NO aria-label in read-only too', () => {
    const html = renderDocument(
      parse('<topic id="t"><title>Topic</title><body>' + TABLE_WITH_TITLE + '</body></topic>'),
    );
    expect(html).toMatch(/<caption[^>]*>Seat map<\/caption>/);
    expect(html).not.toMatch(/<table[^>]*aria-label/);
  });
});

describe('deterministic selection hooks (editable render)', () => {
  const html = renderEditable(parse(DOC));

  test('block elements (p, li) carry data-selectable + data-selection-kind="block"', () => {
    expect(html).toMatch(/<p class="p"[^>]*data-struct-kind="p"[^>]*data-selectable data-selection-kind="block"/);
    expect(html).toMatch(/<li class="li"[^>]*data-struct-kind="li"[^>]*data-selectable data-selection-kind="block"/);
  });

  test('data cells (td) carry data-selection-kind="cell" alongside data-cell-id', () => {
    expect(html).toMatch(/<td class="entry"[^>]*data-selectable data-selection-kind="cell"[^>]*data-cell-id="e\d+"/);
  });

  test('header cells (th) carry data-selection-kind="header"', () => {
    expect(html).toMatch(/<th class="entry"[^>]*data-selectable data-selection-kind="header"/);
  });

  test('images carry data-selection-kind="image"', () => {
    expect(html).toContain('data-selection-kind="image"');
    expect(html).toMatch(/<img class="image"[^>]*data-selectable data-selection-kind="image"/);
  });
});

describe('no semantic regression / no ARIA overreach', () => {
  const editable = renderEditable(parse(DOC));
  const plain = renderDocument(parse(DOC));

  test('native table/list tags remain (no div/grid/listbox substitution)', () => {
    expect(editable).toContain('<table class="table"');
    expect(editable).toContain('<th class="entry"');
    expect(editable).toContain('<td class="entry"');
    expect(editable).toContain('<ul class="ul"');
    expect(editable).toContain('<li class="li"');
    expect(editable).not.toContain('role="grid"');
    expect(editable).not.toContain('role="listbox"');
    expect(editable).not.toContain('role="option"');
    expect(editable).not.toContain('role="gridcell"');
  });

  test('H43 header associations are preserved', () => {
    expect(editable).toMatch(/<th class="entry"[^>]*scope="col"[^>]*id="dch\d+"/);
    expect(editable).toMatch(/<td class="entry"[^>]*headers="dch\d+"/);
  });

  test('no aria-selected is emitted on native elements', () => {
    expect(editable).not.toContain('aria-selected');
    expect(plain).not.toContain('aria-selected');
  });

  test('plain (read-only) render carries no selection hooks and no contenteditable', () => {
    expect(plain).not.toContain('data-selectable');
    expect(plain).not.toContain('contenteditable');
  });
});

describe('image addressable id + empty-image label (IMG-1 + P1-3, render-only)', () => {
  const IMG = '<topic><body><fig><image href="images/p.png"/></fig></body></topic>';

  test('editable images carry a stable data-struct-id + data-struct-kind="image"', () => {
    expect(renderEditable(parse(IMG))).toMatch(
      /<img class="image"[^>]*data-struct-id="e\d+" data-struct-kind="image"/,
    );
  });

  test('image struct-kind is "image" (never p/li) so canvas does not treat it as a block', () => {
    expect(renderEditable(parse(IMG))).not.toMatch(/<img[^>]*data-struct-kind="(?:p|li)"/);
  });

  test('read-only render gives images no struct id (selection hooks are editable-only)', () => {
    expect(renderDocument(parse(IMG))).not.toContain('data-struct-id');
  });

  test('an empty-href image gets alt="Empty image"; a real href keeps its basename', () => {
    expect(renderEditable(parse('<topic><body><fig><image href=""/></fig></body></topic>'))).toContain(
      'alt="Empty image"',
    );
    expect(renderEditable(parse(IMG))).toContain('alt="p.png"');
  });

  test('authored DITA <alt> becomes the HTML image alt instead of the filename', () => {
    const html = renderEditable(
      parse('<topic><body><fig><image href="images/p.png"><alt>Passenger meal photo</alt></image></fig></body></topic>'),
    );
    expect(html).toContain('alt="Passenger meal photo"');
    expect(html).not.toContain('alt="p.png"');
  });

  test('the image id + alt are render-only — source still round-trips byte-exact', () => {
    const src = '<topic id="t"><body><fig><image href="images/p.png"/></fig></body></topic>';
    const doc = parse(src);
    renderEditable(doc);
    expect(serialize(doc)).toBe(src);
  });
});
