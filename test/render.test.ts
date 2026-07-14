// Verifies the CST -> HTML render core emits the exact DITA-OT 4.2.1 tag+class
// contract consumed by the built-in theme and configured workspace stylesheets.
// Expected class strings follow DITA-OT output.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { renderDocument, renderEditable } from '../src/render/to-html';

function render(src: string): string {
  return renderDocument(parse(src));
}

describe('block + inline element class contract', () => {
  test('concept: title / shortdesc / conbody / p / codeph', () => {
    const src =
      '<concept id="introduction"><title>Introduction</title>' +
      '<shortdesc>An overview.</shortdesc>' +
      '<conbody><p>Content in <codeph>src/dita</codeph> here.</p></conbody></concept>';
    const html = render(src);
    expect(html).toContain('role="article"');
    expect(html).toContain('<h1 class="title topictitle1">Introduction</h1>');
    expect(html).toContain('<p class="shortdesc">An overview.</p>');
    expect(html).toContain('<div class="body conbody">');
    expect(html).toContain('<p class="p">Content in <code class="ph codeph">src/dita</code> here.</p>');
  });

  test('generic topic body, lists', () => {
    const src =
      '<topic id="t"><title>T</title><body>' +
      '<ul><li>one<ul><li>nested bullet</li></ul></li><li>two</li></ul>' +
      '<ol><li>a</li></ol><ol outputclass="lower-alpha"><li>b</li></ol></body></topic>';
    const html = render(src);
    expect(html).toContain('<div class="body">');
    expect(html).toContain('<ul class="ul"><li class="li">one<ul class="ul"><li class="li">nested bullet</li></ul></li><li class="li">two</li></ul>');
    expect(html).toContain('<ol class="ol"><li class="li">a</li></ol>');
    expect(html).toContain('<ol class="ol lower-alpha"><li class="li">b</li></ol>');
  });

  test('outputclass is emitted as an HTML class for CSS-backed author styles', () => {
    const src =
      '<topic id="t"><title outputclass="dc-title-display">T</title><body>' +
      '<p outputclass="keep dc-heading-gold">Content</p></body></topic>';
    const html = render(src);

    expect(html).toContain('<h1 class="title topictitle1 dc-title-display">T</h1>');
    expect(html).toContain('<p class="p keep dc-heading-gold">Content</p>');
  });

  test('outputclass is emitted on lists, table rows, cells, and inline phrase elements', () => {
    const src =
      '<topic><body><ul outputclass="dc-list-spacious"><li outputclass="dc-list-item-accent">One</li></ul>' +
      '<p><b outputclass="dc-all-muted">Bold</b></p>' +
      '<table outputclass="dc-table-ruled"><tgroup cols="1"><tbody>' +
      '<row outputclass="dc-all-muted"><entry outputclass="dc-cell-shaded">Cell</entry></row>' +
      '</tbody></tgroup></table></body></topic>';
    const html = render(src);

    expect(html).toContain('<ul class="ul dc-list-spacious">');
    expect(html).toContain('<li class="li dc-list-item-accent">One</li>');
    expect(html).toContain('<strong class="ph b dc-all-muted">Bold</strong>');
    expect(html).toContain('<table class="table dc-table-ruled"');
    expect(html).toContain('<tr class="row dc-all-muted">');
    expect(html).toContain('<td class="entry dc-cell-shaded"');
  });

  test('lines: line-preserving <pre>, source newlines kept verbatim', () => {
    const html = render('<topic><body><lines>a\nb\nc</lines></body></topic>');
    expect(html).toContain('<pre class="lines">a\nb\nc</pre>');
  });

  test('multi-<p> table cell renders both paragraphs in order', () => {
    const html = render(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry><p>a</p><p>b</p></entry></row>' +
        '</tbody></tgroup></table>',
    );
    expect(html).toContain('<td class="entry"><p class="p">a</p><p class="p">b</p></td>');
  });

  test('figure + image', () => {
    const html = render('<topic><body><fig><image href="images/img_119.jpeg" placement="break"/></fig></body></topic>');
    expect(html).toContain('<figure class="fig fignone">');
    // alt = basename (render-only): a broken/missing image shows a label, not a blank box.
    expect(html).toContain('<img class="image" src="images/img_119.jpeg" alt="img_119.jpeg">');
  });
});

describe('CALS table -> HTML', () => {
  const tableSrc =
    '<table frame="all"><tgroup cols="3">' +
    '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/><colspec colname="c3" colnum="3"/>' +
    '<thead><row><entry>H1</entry><entry>H2</entry><entry>H3</entry></row></thead>' +
    '<tbody>' +
    '<row><entry namest="c1" nameend="c2">spanned</entry><entry>z</entry></row>' +
    '<row><entry morerows="1">tall</entry><entry>b</entry><entry>c</entry></row>' +
    '</tbody></tgroup></table>';

  test('table/colgroup/thead/tbody/row/entry classes and th-vs-td', () => {
    const html = render(tableSrc);
    // No <title> → no caption; but the render now derives an accessible name (render-only).
    expect(html).toContain('<table class="table frame-all" aria-label="Table 1"><colgroup>');
    expect(html).not.toContain('<caption');
    expect(html).toContain('<colgroup><col><col><col></colgroup>');
    expect(html).toContain('<thead class="thead">');
    expect(html).toContain('<tbody class="tbody">');
    expect(html).toContain('<tr class="row">');
    // Header cells are <th>, body cells are <td>.
    expect(html).toContain('<th class="entry">H1</th>');
    expect(html).toContain('<td class="entry">z</td>');
  });

  test('attribute-free tables emit no presentation attrs (corpus renders unchanged)', () => {
    const html = render(tableSrc);
    expect(html).not.toContain('data-colsep');
    expect(html).not.toContain('data-rowsep');
    expect(html).not.toContain('data-align');
    expect(html).not.toContain('data-valign');
  });

  test('entry @align/@valign render as data attrs + inline style (F3/F4)', () => {
    const html = render(
      '<table><tgroup cols="2">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry align="center" valign="bottom">A</entry><entry>B</entry></row></tbody>' +
        '</tgroup></table>',
    );
    expect(html).toContain(
      '<td class="entry" data-align="center" data-valign="bottom" style="text-align:center;vertical-align:bottom">A</td>',
    );
    expect(html).toContain('<td class="entry">B</td>'); // untouched neighbour stays clean
  });

  test('break image @align renders visibly in the editor', () => {
    const html = render('<topic><body><image href="diagram.svg" placement="break" align="center"/></body></topic>');

    expect(html).toContain('style="display:block;margin-left:auto;margin-right:auto"');
  });

  test('colspec @align inherits to its column; entry-level wins (CALS precedence)', () => {
    const html = render(
      '<table><tgroup cols="2">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2" align="right"/>' +
        '<tbody><row><entry>A</entry><entry>B</entry></row>' +
        '<row><entry>C</entry><entry align="left">D</entry></row></tbody>' +
        '</tgroup></table>',
    );
    expect(html).toContain('<td class="entry" data-align="right" style="text-align:right">B</td>');
    expect(html).toContain('<td class="entry" data-align="left" style="text-align:left">D</td>');
    expect(html).toContain('<td class="entry">A</td>');
  });

  test('tgroup @colsep/@rowsep defaults inherit; last column and last body row are suppressed (F1)', () => {
    const html = render(
      '<table><tgroup cols="2" colsep="1" rowsep="1">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>A</entry><entry>B</entry></row>' +
        '<row><entry>C</entry><entry>D</entry></row></tbody>' +
        '</tgroup></table>',
    );
    // First column, first row: both seps.
    expect(html).toContain('<td class="entry" data-colsep="1" data-rowsep="1">A</td>');
    // Last column: no colsep (frame's job); still rowsep on the first row.
    expect(html).toContain('<td class="entry" data-rowsep="1">B</td>');
    // Last body row: no rowsep; first column keeps colsep.
    expect(html).toContain('<td class="entry" data-colsep="1">C</td>');
    expect(html).toContain('<td class="entry">D</td>');
  });

  test('entry @colsep="0" overrides a tgroup default (F1)', () => {
    const html = render(
      '<table><tgroup cols="2" colsep="1">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry colsep="0">A</entry><entry>B</entry></row></tbody>' +
        '</tgroup></table>',
    );
    expect(html).toContain('<td class="entry" data-colsep="0">A</td>');
  });

  test('out-of-enum presentation values render nothing (no style injection)', () => {
    const html = render(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
        '<tbody><row><entry align="wonky; background:red">A</entry></row></tbody>' +
        '</tgroup></table>',
    );
    expect(html).not.toContain('data-align');
    expect(html).not.toContain('style=');
  });

  test('table <title> renders as an editable caption in the editable render only (F10)', () => {
    const titled =
      '<table><title>My table</title><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
      '<tbody><row><entry>A</entry></row></tbody></tgroup></table>';
    const ro = render(titled);
    expect(ro).toContain('<caption>My table</caption>'); // read-only: no editing hooks
    expect(ro).not.toContain('contenteditable');
    const ed = renderEditable(parse(titled));
    expect(ed).toMatch(
      /<caption contenteditable="true" data-edit-id="[^"]+"[^>]*data-struct-id="[^"]+" data-struct-kind="title"[^>]*>My table<\/caption>/,
    );
  });

  test('colspec colwidth renders as col styles, including decimal star ratios', () => {
    const html = render(
      '<table><tgroup cols="3">' +
        '<colspec colname="c1" colnum="1" colwidth="0.5*"/>' +
        '<colspec colname="c2" colnum="2" colwidth="1.5*"/>' +
        '<colspec colname="c3" colnum="3" colwidth="3*"/>' +
        '<tbody><row><entry>A</entry><entry>B</entry><entry>C</entry></row></tbody>' +
        '</tgroup></table>',
    );

    expect(html).toContain('<colgroup><col style="width:10%"><col style="width:30%"><col style="width:60%"></colgroup>');
  });

  test('editable tables expose stable resize metadata without serializing it', () => {
    const doc = parse(
      '<table><tgroup cols="2">' +
        '<colspec colname="c1" colnum="1" colwidth="0.75*"/>' +
        '<colspec colname="c2" colnum="2" colwidth="1.25*"/>' +
        '<tbody><row><entry>A</entry><entry>B</entry></row></tbody>' +
        '</tgroup></table>',
    );
    const html = renderEditable(doc);

    expect(html).toContain('data-table-resizable="true"');
    expect(html).toContain('data-table-has-colwidths="true"');
    expect(html).toContain('<col style="width:37.5%" data-col-index="0" data-colwidth="0.75*">');
    expect(html).toContain('<col style="width:62.5%" data-col-index="1" data-colwidth="1.25*">');
  });

  test('horizontal span: namest/nameend -> colspan', () => {
    const html = render(tableSrc);
    expect(html).toContain('<td class="entry" colspan="2">spanned</td>');
  });

  test('horizontal span follows CALS colnum instead of colspec order', () => {
    const html = render(
      '<table><tgroup cols="3">' +
        '<colspec colname="c1" colnum="1"/><colspec colname="c3" colnum="3"/><colspec colname="c2" colnum="2"/>' +
        '<tbody><row><entry>lead</entry><entry namest="c2" nameend="c3">tail span</entry></row></tbody>' +
        '</tgroup></table>',
    );

    expect(html).toContain('<td class="entry" colspan="2">tail span</td>');
  });

  test('vertical span: morerows -> rowspan = morerows + 1', () => {
    const html = render(tableSrc);
    expect(html).toContain('<td class="entry" rowspan="2">tall</td>');
  });

  test('image embedded in a cell renders in place (documented divergence from DITA-OT)', () => {
    const html = render(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry>Weber 5751<image href="images/img_005.jpeg" placement="break"/></entry></row>' +
        '</tbody></tgroup></table>',
    );
    expect(html).toContain('<td class="entry">Weber 5751<img class="image" src="images/img_005.jpeg" alt="img_005.jpeg"></td>');
  });
});

describe('CALS table header associations (a11y, WCAG H43, render-only)', () => {
  // Valid full-width single-row thead: a plain header (c1) + a colspan header (c2-c3).
  const src =
    '<table><tgroup cols="3">' +
    '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/><colspec colname="c3" colnum="3"/>' +
    '<thead><row><entry>A</entry><entry namest="c2" nameend="c3">BC</entry></row></thead>' +
    '<tbody><row><entry>a1</entry><entry>b1</entry><entry>c1</entry></row></tbody>' +
    '</tgroup></table>';

  test('thead cells get scope + id; a colspan header is scope="colgroup"', () => {
    const html = render(src);
    expect(html).toContain('<th class="entry" scope="col" id="dch0">A</th>');
    expect(html).toContain('<th class="entry" colspan="2" scope="colgroup" id="dch1">BC</th>');
  });

  test('data cells reference their column header(s) via headers=, span-aware', () => {
    const html = render(src);
    expect(html).toContain('<td class="entry" headers="dch0">a1</td>');
    expect(html).toContain('<td class="entry" headers="dch1">b1</td>'); // under the colgroup header
    expect(html).toContain('<td class="entry" headers="dch1">c1</td>');
  });

  test('a header-less table emits no scope/headers (nothing to associate)', () => {
    const html = render(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
        '<tbody><row><entry>x</entry></row></tbody></tgroup></table>',
    );
    expect(html).not.toContain('scope=');
    expect(html).not.toContain('headers=');
  });

  test('a11y attrs are render-only — source still round-trips byte-exact', () => {
    const fileSrc = '<topic id="t"><body>' + src + '</body></topic>';
    const doc = parse(fileSrc);
    renderEditable(doc); // the editing-canvas path also stamps a11y attrs
    expect(serialize(doc)).toBe(fileSrc);
  });
});

describe('rendering is non-destructive', () => {
  test('rendering does not mutate the CST (source still round-trips byte-exact)', () => {
    const src =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
      '<topic id="t"><title>T &amp; U</title><body><p>x</p></body></topic>\n';
    const doc = parse(src);
    renderDocument(doc);
    expect(serialize(doc)).toBe(src);
  });

  test('image fallback alt is render-only — a topic with an image still round-trips byte-exact', () => {
    const src =
      '<topic id="t"><body><fig><image href="images/sub dir/photo 1.png"/></fig></body></topic>';
    const doc = parse(src);
    const html = renderDocument(doc);
    expect(html).toContain('alt="photo 1.png"'); // no <alt> child -> basename fallback
    expect(serialize(doc)).toBe(src); // the .dita source is untouched by rendering
  });

  test('authored DITA <alt> wins over filename fallback and stays render-only', () => {
    const src =
      '<topic id="t"><body><fig><image href="images/photo.png"><alt>Cabin &amp; seat "photo"</alt></image></fig></body></topic>';
    const doc = parse(src);
    const html = renderDocument(doc);
    expect(html).toContain('alt="Cabin &amp; seat &quot;photo&quot;"');
    expect(html).not.toContain('alt="photo.png"');
    expect(serialize(doc)).toBe(src); // the .dita source is untouched by rendering
  });

  test('entities in text survive into HTML', () => {
    const html = render('<topic><title>Seat model &amp; fleet</title></topic>');
    expect(html).toContain('Seat model &amp; fleet');
  });
});

describe('renderEditable', () => {
  test('marks plain-text leaves contenteditable with a data-edit-id', () => {
    const doc = parse('<topic><title>T</title><body><p>hello</p><ul><li>x</li></ul></body></topic>');
    const html = renderEditable(doc);
    expect(html).toContain('<h1 class="title topictitle1" contenteditable="true" data-edit-id="');
    expect(html).toContain('<p class="p" contenteditable="true" data-edit-id="');
    expect(html).toContain('<li class="li" contenteditable="true" data-edit-id="');
  });

  test('editable output exposes current outputclass for the Styles panel', () => {
    const doc = parse('<topic id="t"><title outputclass="dc-title-display">T</title><body><p outputclass="dc-heading-gold">hello</p></body></topic>');
    const html = renderEditable(doc);

    expect(html).toMatch(/<h1 class="title topictitle1 dc-title-display"[^>]*data-outputclass="dc-title-display"[^>]*>T<\/h1>/);
    expect(html).toMatch(/<p class="p dc-heading-gold"[^>]*data-outputclass="dc-heading-gold"[^>]*>hello<\/p>/);
  });

  test('editable topic title exposes heading style outputclass for author CSS', () => {
    const doc = parse('<topic id="t"><title outputclass="dc-heading-compact">T</title></topic>');
    const html = renderEditable(doc);

    expect(html).toMatch(/<h1 class="title topictitle1 dc-heading-compact"[^>]*data-outputclass="dc-heading-compact"[^>]*>T<\/h1>/);
  });

  test('pretty-printed editable list items do not preserve XML formatting whitespace visually', () => {
    const doc = parse('<topic><body><ul><li>\n  One\n</li></ul></body></topic>');
    const html = renderEditable(doc);

    expect(html).toContain('contenteditable="true" data-edit-id="');
    expect(html).not.toContain('data-preserve-lines="true"');
    expect(html).toContain('>One</li>');
    expect(html).not.toContain('>\n  One\n</li>');
  });

  test('normal editable prose collapses source-wrapped internal newlines visually', () => {
    const doc = parse('<topic><body><p>Hello\ntail</p></body></topic>');
    const html = renderEditable(doc);

    expect(html).not.toContain('data-preserve-lines="true"');
    expect(html).toContain('Hello tail</p>');
    expect(html).not.toContain('Hello\ntail</p>');
  });

  test('pretty-printed editable table cells do not show source layout newlines', () => {
    const doc = parse(
      '<topic><body><table><tgroup cols="1"><tbody><row><entry>\n' +
        '  First line\n' +
        '  Second line\n' +
        '</entry></row></tbody></tgroup></table></body></topic>',
    );
    const html = renderEditable(doc);

    expect(html).toMatch(/<td class="entry"[^>]*contenteditable="true"[^>]*>First line Second line<\/td>/);
    expect(html).not.toContain('>\n  First line');
  });

  test('empty editable blocks in table cells render a real caret anchor, not inert text', () => {
    const doc = parse(
      '<topic><body><table><tgroup cols="1"><tbody><row><entry><p>filled</p><p/></entry></row></tbody></tgroup></table></body></topic>',
    );
    const html = renderEditable(doc);

    expect(html).toMatch(
      /<p class="p" contenteditable="true" data-edit-id="e\d+"[^>]*data-empty-placeholder="Empty paragraph"><br data-empty-caret="true" aria-hidden="true"><\/p>/,
    );
    expect(html).not.toContain('>Empty paragraph<');
  });

  test('empty direct table cells render a caret anchor without serializable placeholder text', () => {
    const doc = parse('<topic><body><table><tgroup cols="1"><tbody><row><entry/></row></tbody></tgroup></table></body></topic>');
    const html = renderEditable(doc);

    expect(html).toMatch(
      /<td class="entry"[^>]*contenteditable="true"[^>]*data-empty-placeholder="Empty cell"><br data-empty-caret="true" aria-hidden="true"><\/td>/,
    );
    expect(html).not.toContain('>Empty cell<');
  });

  test('line-respecting blocks keep hard line breaks semantically', () => {
    const doc = parse('<topic><body><lines>Hello\ntail</lines></body></topic>');
    const html = renderEditable(doc);

    expect(html).toMatch(
      /<pre class="lines" contenteditable="true" data-edit-id="e\d+" spellcheck="false"/,
    );
    expect(html).toContain('Hello\ntail</pre>');
  });

  test('direct-text notes are editable while block notes delegate editing to their children', () => {
    const html = renderEditable(
      parse('<topic><body><note type="note">Direct note</note><note><p>Block note</p></note></body></topic>'),
    );

    expect(html).toMatch(
      /<div class="note note_note" contenteditable="true" data-edit-id="e\d+" spellcheck="false" data-struct-id="e\d+" data-struct-kind="note">Direct note<\/div>/,
    );
    expect(html).toMatch(
      /<div class="note note_note" data-struct-id="e\d+" data-struct-kind="note"><p class="p" contenteditable="true"/,
    );
  });

  test('marks mixed text runs as autofocus targets by full run id', () => {
    const doc = parse('<topic><body><li>Intro<ul><li>Nested</li></ul></li></body></topic>');
    const html = renderEditable(doc, 'e2:t0');

    expect(html).toContain('data-edit-id="e2:t0" data-edit-run spellcheck="false" data-autofocus="true"');
  });

  test('inline-rich text+image cell renders as one editable surface', () => {
    const doc = parse(
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry>a<image href="i.jpg"/>b</entry></row>' +
        '</tbody></tgroup></table></body></topic>',
    );
    const html = renderEditable(doc);
    expect(html).toMatch(/<td class="entry" data-selectable data-selection-kind="cell" data-cell-id="e\d+" contenteditable="true" data-edit-id="e\d+" data-inline-html="true" spellcheck="false">a<img/);
    expect(html).toMatch(/<img class="image" src="i\.jpg" alt="i\.jpg"[^>]*data-dita="image"[^>]*data-href="i\.jpg"[^>]*data-attrs=/);
    expect(html).toMatch(/<img class="image"[^>]*data-struct-id="e\d+" data-struct-kind="image" data-selectable data-selection-kind="image">/);
    expect(html).not.toContain('data-edit-run');
  });

  test('rich inline prose renders as one editable surface with inline markup inside', () => {
    const doc = parse('<topic><body><p>a <b>b</b> <xref href="topic.dita#t/x">x</xref></p></body></topic>');
    const html = renderEditable(doc);
    expect(html).toMatch(
      /<p class="p" contenteditable="true" data-edit-id="e\d+" data-inline-html="true" spellcheck="false" data-struct-id="e\d+" data-struct-kind="p" data-selectable data-selection-kind="block">a <strong class="ph b">b<\/strong> <a class="xref"[^>]*data-dita="xref"[^>]*data-href="topic\.dita#t\/x"[^>]*>x<\/a><\/p>/,
    );
    expect(html).not.toContain('data-edit-run');
  });

  test('conref phrase chips stay atomic inside inline-editable prose', () => {
    const doc = parse('<topic><body><p>a <ph conref="reuse.dita#r/x"/> b</p></body></topic>');
    const html = renderEditable(doc);
    expect(html).toMatch(
      /<p class="p" contenteditable="true" data-edit-id="e\d+" data-inline-html="true" spellcheck="false" data-struct-id="e\d+" data-struct-kind="p" data-selectable data-selection-kind="block">a <span class="ph conref-ref"[^>]*data-dita="ph"[^>]*data-conref="reuse\.dita#r\/x"[^>]*contenteditable="false"[^>]*>.*<\/span> b<\/p>/,
    );
  });

  test('underline phrase renders visibly and stays inline-editable', () => {
    const doc = parse('<topic><body><p>a <u>u</u></p></body></topic>');
    const html = renderEditable(doc);
    expect(html).toMatch(
      /<p class="p" contenteditable="true" data-edit-id="e\d+" data-inline-html="true" spellcheck="false" data-struct-id="e\d+" data-struct-kind="p" data-selectable data-selection-kind="block">a <u class="ph u">u<\/u><\/p>/,
    );
  });

  test('line-through phrase renders visibly and stays inline-editable', () => {
    const doc = parse('<topic><body><p>a <line-through>s</line-through></p></body></topic>');
    const html = renderEditable(doc);
    expect(html).toMatch(
      /<p class="p" contenteditable="true" data-edit-id="e\d+" data-inline-html="true" spellcheck="false" data-struct-id="e\d+" data-struct-kind="p" data-selectable data-selection-kind="block">a <span class="ph line-through" style="text-decoration:line-through">s<\/span><\/p>/,
    );
  });

  test('lines is addressable and editable as a line-preserving text block', () => {
    // <lines> is both a structural block target and a typeable leaf. The <pre>
    // renderer preserves user-entered newlines while the host writes them back
    // through the same decoded text path as paragraphs/code blocks.
    const doc = parse('<topic><body><lines>x\ny</lines></body></topic>');
    const html = renderEditable(doc);
    expect(html).toMatch(
      /<pre class="lines" contenteditable="true" data-edit-id="e\d+" spellcheck="false" data-struct-id="e\d+" data-struct-kind="lines" data-selectable data-selection-kind="block">x\ny<\/pre>/,
    );
  });

  test('plain read-only render carries no editable attributes', () => {
    expect(render('<topic><body><p>x</p></body></topic>')).not.toContain('contenteditable');
  });

  test('imageVersion cache-busts non-empty image src (and only when provided)', () => {
    const doc = parse('<topic><body><fig><image href="images/p.png"/></fig></body></topic>');
    // no token -> src unchanged (back-compat; existing assertions keep passing)
    expect(renderEditable(doc)).toMatch(
      /<img class="image" src="images\/p\.png" alt="p\.png"[^>]*data-dita="image"[^>]*data-href="images\/p\.png"[^>]*data-struct-id="e\d+" data-struct-kind="image" data-selectable data-selection-kind="image">/,
    );
    // token -> ?v=… appended to src; alt stays the bare basename
    expect(renderEditable(doc, null, 'TOKEN123')).toMatch(
      /<img class="image" src="images\/p\.png\?v=TOKEN123" alt="p\.png"[^>]*data-dita="image"[^>]*data-href="images\/p\.png"[^>]*data-struct-id="e\d+" data-struct-kind="image" data-selectable data-selection-kind="image">/,
    );
  });

  test('imageVersion does NOT touch an empty href (keeps src="" for the placeholder CSS)', () => {
    const doc = parse('<topic><body><fig><image href=""/></fig></body></topic>');
    expect(renderEditable(doc, null, 'TOKEN123')).toMatch(
      /<img class="image" src="" alt="Empty image"[^>]*data-dita="image"[^>]*data-href=""[^>]*data-struct-id="e\d+" data-struct-kind="image" data-selectable data-selection-kind="image">/,
    );
  });

  test('stamps data-struct-id/kind on title, rows, list items, paragraphs, lists, tables, and figures', () => {
    const doc = parse(
      '<topic><title>T</title><body><p>p</p><ul><li>x</li></ul><ol><li>y</li></ol>' +
        '<fig><image href="i.png"/></fig>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table>' +
        '</body></topic>',
    );
    const html = renderEditable(doc);
    // <title> carries data-struct-id with a DISTINCT kind (never p/li) so the canvas can target
    // the topic/section title structurally (e.g. deleteTitle).
    expect(html).toMatch(/<h1 class="title topictitle1"[^>]*data-struct-id="e\d+" data-struct-kind="title">/);
    expect(html).toContain('data-struct-kind="p"');
    expect(html).toContain('data-struct-kind="li"');
    expect(html).toContain('data-struct-kind="row"');
    expect(html).toMatch(/<tr class="row" data-struct-id="e\d+" data-struct-kind="row">/);
    // P1-2b: <table> and <fig> become addressable insert anchors with DISTINCT kinds (never p/li),
    // so the canvas can target "insert after this table/figure".
    expect(html).toMatch(/<table class="table" aria-label="[^"]*" data-struct-id="e\d+" data-struct-kind="table">/);
    expect(html).toMatch(/<figure class="fig fignone" data-struct-id="e\d+" data-struct-kind="fig">/);
    // <ul>/<ol> carry data-struct-id with a DISTINCT kind (never p/li) so the canvas can target
    // "delete this whole list" (deleteList).
    expect(html).toMatch(/<ul class="ul" data-struct-id="e\d+" data-struct-kind="ul">/);
    expect(html).toMatch(/<ol class="ol" data-struct-id="e\d+" data-struct-kind="ol">/);
  });

  test('universal: section, shortdesc, and lines are all stamped with data-struct-id/kind=tag', () => {
    // Generalized addressability: every block-level structural kind (not just the old
    // p/li/row/title/ul/ol/fig/image/table list) carries data-struct-id with kind === its tag,
    // so the canvas can select/delete ANY of them generically.
    const doc = parse(
      '<topic><title>T</title><shortdesc>overview</shortdesc><body>' +
        '<section><title>S</title><p>p</p></section>' +
        '<lines>a\nb</lines>' +
        '</body></topic>',
    );
    const html = renderEditable(doc);
    // shortdesc is editable (contenteditable) AND now addressable (struct-id with kind="shortdesc")
    expect(html).toMatch(
      /<p class="shortdesc"[^>]*data-struct-id="e\d+" data-struct-kind="shortdesc">/,
    );
    expect(html).toMatch(/<section class="section" data-struct-id="e\d+" data-struct-kind="section">/);
    expect(html).toMatch(/<pre class="lines"[^>]*data-struct-id="e\d+" data-struct-kind="lines"/);
    // both the topic title and the nested section title are stamped (kind="title")
    expect(html.match(/data-struct-kind="title"/g)?.length).toBe(2);
  });

  test('excluded kinds are never stamped while editable cmd is addressable for Backspace joins', () => {
    const doc = parse(
      '<topic><body>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry>a<image href="i.jpg"/>b</entry></row>' +
        '</tbody></tgroup></table>' +
        '<steps><step><cmd>do it</cmd></step></steps>' +
        '</body></topic>',
    );
    const html = renderEditable(doc);
    // cells use data-cell-id, not data-struct-id
    expect(html).not.toMatch(/<t[dh] class="entry"[^>]*data-struct-id/);
    expect(html).toMatch(/<span class="ph cmd"[^>]*data-struct-id="e\d+" data-struct-kind="cmd"/);
    // mixed-cell text-run spans keep their synthetic edit-only ids, never a struct-id
    expect(html).not.toMatch(/<span[^>]*data-edit-run[^>]*data-struct-id/);
    // table scaffolding containers (tgroup/thead/tbody/colspec) are not separately deletable
    // and never reach a struct-id-bearing tag (they have no dedicated render tag here)
    expect(html).not.toContain('data-struct-kind="entry"');
    expect(html).toContain('data-struct-kind="cmd"');
  });

  test('read-only render does NOT stamp struct ids on table/fig (editable-only, like images)', () => {
    const html = render(
      '<topic><body><fig><image href="i.png"/></fig>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table>' +
        '</body></topic>',
    );
    expect(html).not.toContain('data-struct-id');
    expect(html).not.toContain('data-struct-kind');
  });

  test('read-only render stamps NO struct ids on the newly-universal kinds, and serialize stays byte-exact', () => {
    const src =
      '<topic id="t"><title>T</title><shortdesc>overview</shortdesc><body>' +
      '<section><title>S</title><p>p</p></section><lines>a\nb</lines></body></topic>';
    const doc = parse(src);
    const html = render(src);
    expect(html).not.toContain('data-struct-id');
    expect(html).not.toContain('data-struct-kind');
    expect(html).not.toContain('data-selectable');
    expect(serialize(doc)).toBe(src); // read-only render never mutates the CST
    renderEditable(doc);
    expect(serialize(doc)).toBe(src); // ...and neither does the editable render
  });
});
