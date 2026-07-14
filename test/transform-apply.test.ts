// P1-3b transform-apply core. Drives the REAL parser/serializer (no mocks) and
// addresses elements by their real e{N} ids. Every transform asserts the EXACT
// output bytes so that anything outside the intentional transform is provably
// byte-identical to the input.

import { test, expect, describe } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import { applyTransform } from '../src/cst/structural';
import type { Document, ElementNode } from '../src/cst/types';

/** Real e{N} id of the first element matching name (+ optional trimmed text). */
function idOf(source: string, name: string, text?: string): string {
  const doc = parse(source);
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name !== name) continue;
    if (text !== undefined && innerText(el) !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

function idsOf(source: string, name: string): string[] {
  const doc = parse(source);
  const ids: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === name) ids.push(id);
  }
  return ids;
}

function innerText(el: ElementNode): string {
  return el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim();
}

/** Re-parse a result and return the element at id (to verify focus targets). */
function elAt(doc: Document, id: string): ElementNode | undefined {
  for (const [el, eid] of assignElementIds(doc)) if (eid === id) return el;
  return undefined;
}

const UL_DOC = `<body>
  <ul>
    <li>alpha</li>
    <li>beta</li>
  </ul>
</body>`;

describe('list-kind rename (ul <-> ol)', () => {
  test('ul -> ol changes only the two tag names, byte-exact elsewhere', () => {
    const r = applyTransform(UL_DOC, { transform: 'toOrderedList', targetId: idOf(UL_DOC, 'ul') });
    expect(r.source).toBe(`<body>
  <ol>
    <li>alpha</li>
    <li>beta</li>
  </ol>
</body>`);
    // focus lands on the renamed list, and it is now an <ol>.
    expect(r.focusId).not.toBeNull();
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('ol');
  });

  test('ol -> ul is the inverse', () => {
    const OL_DOC = UL_DOC.replace('<ul>', '<ol>').replace('</ul>', '</ol>');
    const r = applyTransform(OL_DOC, { transform: 'toUnorderedList', targetId: idOf(OL_DOC, 'ol') });
    expect(r.source).toBe(UL_DOC);
  });

  test('rename preserves the list element attributes (only the tag name changes)', () => {
    const SRC = `<body>\n  <ul outputclass="bullet" id="L1">\n    <li>x</li>\n  </ul>\n</body>`;
    const r = applyTransform(SRC, { transform: 'toOrderedList', targetId: idOf(SRC, 'ul') });
    expect(r.source).toBe(`<body>\n  <ol outputclass="bullet" id="L1">\n    <li>x</li>\n  </ol>\n</body>`);
  });

  test('toAlphabeticList writes lower-alpha outputclass and toOrderedList removes only that token', () => {
    const alpha = applyTransform(UL_DOC, { transform: 'toAlphabeticList', targetId: idOf(UL_DOC, 'ul') });
    expect(alpha.source).toBe(`<body>
  <ol outputclass="lower-alpha">
    <li>alpha</li>
    <li>beta</li>
  </ol>
</body>`);

    const styled = `<body>\n  <ol outputclass="keep lower-alpha">\n    <li>x</li>\n  </ol>\n</body>`;
    const numbered = applyTransform(styled, { transform: 'toOrderedList', targetId: idOf(styled, 'ol') });
    expect(numbered.source).toBe(`<body>\n  <ol outputclass="keep">\n    <li>x</li>\n  </ol>\n</body>`);
  });

  test('renaming to the same kind is a no-op on the bytes', () => {
    const r = applyTransform(UL_DOC, { transform: 'toUnorderedList', targetId: idOf(UL_DOC, 'ul') });
    expect(r.source).toBe(UL_DOC);
  });

  test('list-kind rename can keep focus on the edited list item', () => {
    const r = applyTransform(UL_DOC, {
      transform: 'toOrderedList',
      targetId: idOf(UL_DOC, 'ul'),
      focusId: idOf(UL_DOC, 'li', 'beta'),
    });

    expect(r.source).toContain('<ol>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
    expect(innerText(elAt(parse(r.source), r.focusId!)!)).toBe('beta');
  });
});

describe('paragraphToItem (p -> li)', () => {
  const SRC = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>x</p>
</body>`;

  test('append: the paragraph becomes the last <li>, p removed, indentation mirrored', () => {
    const r = applyTransform(SRC, {
      transform: 'paragraphToItem',
      paragraphId: idOf(SRC, 'p', 'x'),
      listId: idOf(SRC, 'ul'),
      position: 'append',
    });
    expect(r.source).toBe(`<body>
  <ul>
    <li>a</li>
    <li>x</li>
  </ul>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('prepend: the paragraph becomes the first <li>', () => {
    const PRE = `<body>
  <p>x</p>
  <ol>
    <li>a</li>
  </ol>
</body>`;
    const r = applyTransform(PRE, {
      transform: 'paragraphToItem',
      paragraphId: idOf(PRE, 'p', 'x'),
      listId: idOf(PRE, 'ol'),
      position: 'prepend',
    });
    expect(r.source).toBe(`<body>
  <ol>
    <li>x</li>
    <li>a</li>
  </ol>
</body>`);
  });

  test('inline content inside the paragraph is carried into the <li> verbatim', () => {
    const SRC2 = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>say <b>hi</b></p>
</body>`;
    const r = applyTransform(SRC2, {
      transform: 'paragraphToItem',
      paragraphId: idOf(SRC2, 'p'),
      listId: idOf(SRC2, 'ul'),
      position: 'append',
    });
    expect(r.source).toBe(`<body>
  <ul>
    <li>a</li>
    <li>say <b>hi</b></li>
  </ul>
</body>`);
  });

  test('merge-between: a paragraph between matching lists becomes one middle item', () => {
    const SRC2 = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>b</p>
  <ul>
    <li>c</li>
  </ul>
</body>`;
    const listIds = idsOf(SRC2, 'ul');
    const r = applyTransform(SRC2, {
      transform: 'paragraphToItem',
      paragraphId: idOf(SRC2, 'p', 'b'),
      listId: listIds[0],
      mergeListId: listIds[1],
      position: 'merge-between',
    });

    expect(r.source).toBe(`<body>
  <ul>
    <li>a</li>
    <li>b</li>
    <li>c</li>
  </ul>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
    expect(innerText(elAt(parse(r.source), r.focusId!)!)).toBe('b');
  });
});

describe('paragraphToList (p -> one-item ul/ol)', () => {
  test('paragraphToUnorderedList wraps the paragraph in a new bulleted list', () => {
    const SRC = `<body>
  <p>x <b>y</b></p>
  <p>after</p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToUnorderedList',
      paragraphId: idOf(SRC, 'p'),
      listKind: 'ul',
    });
    expect(r.source).toBe(`<body>
  <ul>
    <li>x <b>y</b></li>
  </ul>
  <p>after</p>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('paragraphToOrderedList wraps the paragraph in a new numbered list', () => {
    const SRC = `<body>
  <p>x</p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToOrderedList',
      paragraphId: idOf(SRC, 'p', 'x'),
      listKind: 'ol',
    });
    expect(r.source).toBe(`<body>
  <ol>
    <li>x</li>
  </ol>
</body>`);
  });

  test('paragraphToAlphabeticList wraps the paragraph in a lower-alpha list', () => {
    const SRC = `<body>
  <p>x</p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToAlphabeticList',
      paragraphId: idOf(SRC, 'p', 'x'),
      listKind: 'ol',
      listStyle: 'alpha',
    });
    expect(r.source).toBe(`<body>
  <ol outputclass="lower-alpha">
    <li>x</li>
  </ol>
</body>`);
  });

  test('paragraphToUnorderedList is allowed in DITA concept bodies', () => {
    const SRC = `<conbody>
  <p>x</p>
</conbody>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToUnorderedList',
      paragraphId: idOf(SRC, 'p', 'x'),
      listKind: 'ul',
    });
    expect(r.source).toBe(`<conbody>
  <ul>
    <li>x</li>
  </ul>
</conbody>`);
  });

  test('paragraphToUnorderedList is allowed inside a note and preserves inline content', () => {
    const src = '<body><note><p><b>Business</b> A350 specific</p></note></body>';
    const pId = idOf(src, 'p', 'A350 specific');

    const r = applyTransform(src, { transform: 'paragraphToUnorderedList', paragraphId: pId, listKind: 'ul' });

    expect(r.source).toBe(`<body><note><ul>
  <li><b>Business</b> A350 specific</li>
</ul></note></body>`);
  });
});

describe('noteContentToBlock (direct/mixed note prose -> block in place)', () => {
  test('supports every text-structure choice without appending a second block', () => {
    const cases = [
      ['noteContentToParagraph', '<p>Text</p>'],
      ['noteContentToUnorderedList', '<ul><li>Text</li></ul>'],
      ['noteContentToOrderedList', '<ol><li>Text</li></ol>'],
      ['noteContentToAlphabeticList', '<ol outputclass="lower-alpha"><li>Text</li></ol>'],
      ['noteContentToLines', '<lines>Text</lines>'],
      ['noteContentToCodeblock', '<codeblock>Text</codeblock>'],
    ] as const;

    for (const [transform, expected] of cases) {
      const source = '<body><note>Text</note></body>';
      const result = applyTransform(source, { transform, noteContentId: idOf(source, 'note') });
      expect(result.source).toBe(`<body><note>${expected}</note></body>`);
    }
  });

  test('wraps a direct rich-text note as one bulleted list item', () => {
    const source = '<body><note type="warning">Direct <b>rich</b> note</note></body>';
    const noteId = idOf(source, 'note');
    const result = applyTransform(source, {
      transform: 'noteContentToUnorderedList',
      noteContentId: noteId,
      blockKind: 'ul',
      listStyle: 'unordered',
    });

    expect(result.source).toBe('<body><note type="warning"><ul><li>Direct <b>rich</b> note</li></ul></note></body>');
    expect(elAt(parse(result.source), result.focusId!)?.name).toBe('li');
  });

  test('wraps only the clicked mixed-note run and preserves sibling blocks byte-for-byte', () => {
    const list = '<ul outputclass="keep"><li id="existing">Existing</li></ul>';
    const source = `<body><note>Lead ${list} Tail</note></body>`;
    const noteId = idOf(source, 'note');
    const result = applyTransform(source, {
      transform: 'noteContentToParagraph',
      noteContentId: `${noteId}:t0`,
      blockKind: 'p',
    });

    expect(result.source).toBe(`<body><note><p>Lead </p>${list} Tail</note></body>`);
    expect(result.source).toContain(list);
    expect(elAt(parse(result.source), result.focusId!)?.name).toBe('p');
  });

  test('wraps a styled mixed-note run while preserving its wrapper and source-only siblings', () => {
    const source = '<body><note><b>Lead</b><!--keep--><ul><li>Existing</li></ul></note></body>';
    const noteId = idOf(source, 'note');
    const result = applyTransform(source, {
      transform: 'noteContentToParagraph',
      noteContentId: `${noteId}:t0`,
    });

    expect(result.source).toBe('<body><note><p><b>Lead</b></p><!--keep--><ul><li>Existing</li></ul></note></body>');
  });

  test('refuses a forged run id that points at a note block child', () => {
    const source = '<body><note>Lead<ul><li>Existing</li></ul></note></body>';
    const noteId = idOf(source, 'note');

    expect(() => applyTransform(source, {
      transform: 'noteContentToParagraph',
      noteContentId: `${noteId}:t1`,
      blockKind: 'p',
    })).toThrow(/editable note content/i);
  });
});

describe('paragraphToBlock (p -> section/note/codeblock)', () => {
  test('paragraphToNote wraps the paragraph in a note and preserves inline content', () => {
    const SRC = `<body>
  <p>x <b>y</b></p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToNote',
      paragraphId: idOf(SRC, 'p'),
      blockKind: 'note',
    });
    expect(r.source).toBe(`<body>
  <note>
    <p>x <b>y</b></p>
  </note>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('paragraphToSection wraps the paragraph in a section', () => {
    const SRC = `<body>
  <p>x</p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToSection',
      paragraphId: idOf(SRC, 'p', 'x'),
      blockKind: 'section',
    });
    expect(r.source).toBe(`<body>
  <section>
    <p>x</p>
  </section>
</body>`);
  });

  test('paragraphToCodeblock replaces the paragraph with a codeblock', () => {
    const SRC = `<body>
  <p>x</p>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'paragraphToCodeblock',
      paragraphId: idOf(SRC, 'p', 'x'),
      blockKind: 'codeblock',
    });
    expect(r.source).toBe(`<body>
  <codeblock>x</codeblock>
</body>`);
  });

  test('paragraphToCodeblock is allowed inside a note without allowing a nested note', () => {
    const src = '<body><note><p>warning</p></note></body>';
    const pId = idOf(src, 'p', 'warning');

    expect(applyTransform(src, { transform: 'paragraphToCodeblock', paragraphId: pId, blockKind: 'codeblock' }).source)
      .toBe('<body><note><codeblock>warning</codeblock></note></body>');
    expect(() => applyTransform(src, { transform: 'paragraphToNote', paragraphId: pId, blockKind: 'note' }))
      .toThrow('paragraphToBlock: <note> is not permitted inside <note>');
  });
});

describe('entryToBlock (direct <entry> content -> block wrapper)', () => {
  test('entryToParagraph wraps direct cell content in a paragraph', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>Plain <b>rich</b></entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToParagraph',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'p',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><p>Plain <b>rich</b></p></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('entryToUnorderedList splits existing bullet glyph text into list items', () => {
    const bullet = '\u2022';
    const SRC = `<table><tgroup cols="1"><tbody><row><entry>${bullet} Stand tall ${bullet} Maintain posture</entry></row></tbody></tgroup></table>`;
    const r = applyTransform(SRC, {
      transform: 'entryToUnorderedList',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'ul',
    });

    expect(r.source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry><ul><li>Stand tall</li><li>Maintain posture</li></ul></entry></row></tbody></tgroup></table>',
    );
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('entryToOrderedList wraps direct cell content in a numbered list', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>Step one</entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToOrderedList',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'ol',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><ol><li>Step one</li></ol></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('entryToAlphabeticList wraps direct cell content in a lower-alpha list', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>Step one</entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToAlphabeticList',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'ol',
      listStyle: 'alpha',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><ol outputclass="lower-alpha"><li>Step one</li></ol></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('entryToLines wraps direct cell content in a line-preserving block', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>Line 1\nLine 2</entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToLines',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'lines',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><lines>Line 1\nLine 2</lines></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('lines');
  });

  test('entryToNote wraps direct cell content in note paragraph structure', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>x</entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToNote',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'note',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><note><p>x</p></note></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('entryToCodeblock wraps direct cell content in a code block', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry>Line 1\nLine 2</entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToCodeblock',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'codeblock',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><codeblock>Line 1\nLine 2</codeblock></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('codeblock');
  });

  test('entryToUnorderedList converts an existing lines wrapper into list items', () => {
    const bullet = '\u2022';
    const SRC = `<table><tgroup cols="1"><tbody><row><entry><lines>${bullet} Stand tall ${bullet} Maintain posture</lines></entry></row></tbody></tgroup></table>`;
    const r = applyTransform(SRC, {
      transform: 'entryToUnorderedList',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'ul',
    });

    expect(r.source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry><ul><li>Stand tall</li><li>Maintain posture</li></ul></entry></row></tbody></tgroup></table>',
    );
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('entryToParagraph converts an existing lines wrapper into a paragraph', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry><lines>Cell text</lines></entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'entryToParagraph',
      entryId: idOf(SRC, 'entry'),
      wrapperKind: 'p',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><p>Cell text</p></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });
});

describe('linesToBlock (<lines> -> paragraph/list/note/section/codeblock)', () => {
  test('linesToParagraph collapses authored line breaks into prose spacing', () => {
    const SRC = `<body>
  <lines>one
two</lines>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'linesToParagraph',
      linesId: idOf(SRC, 'lines'),
      blockKind: 'p',
    });

    expect(r.source).toBe(`<body>
  <p>one two</p>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('linesToUnorderedList splits authored lines into list items', () => {
    const SRC = `<body>
  <lines>one
two</lines>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'linesToUnorderedList',
      linesId: idOf(SRC, 'lines'),
      blockKind: 'ul',
    });

    expect(r.source).toBe(`<body>
  <ul>
    <li>one</li>
    <li>two</li>
  </ul>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('linesToOrderedList in a table cell keeps the cell compact and splits lines into items', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry><lines>one\ntwo</lines></entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'linesToOrderedList',
      linesId: idOf(SRC, 'lines'),
      blockKind: 'ol',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><ol><li>one</li><li>two</li></ol></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('linesToAlphabeticList keeps a table cell compact and writes lower-alpha', () => {
    const SRC = '<table><tgroup cols="1"><tbody><row><entry><lines>one\ntwo</lines></entry></row></tbody></tgroup></table>';
    const r = applyTransform(SRC, {
      transform: 'linesToAlphabeticList',
      linesId: idOf(SRC, 'lines'),
      blockKind: 'ol',
      listStyle: 'alpha',
    });

    expect(r.source).toBe('<table><tgroup cols="1"><tbody><row><entry><ol outputclass="lower-alpha"><li>one</li><li>two</li></ol></entry></row></tbody></tgroup></table>');
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('li');
  });

  test('linesToNote wraps paragraph-style content and linesToCodeblock preserves hard breaks', () => {
    const SRC = `<body>
  <lines>one
two</lines>
  <lines>alpha
beta</lines>
</body>`;
    const first = applyTransform(SRC, {
      transform: 'linesToNote',
      linesId: idOf(SRC, 'lines', 'one\ntwo'),
      blockKind: 'note',
    });

    expect(first.source).toBe(`<body>
  <note>
    <p>one two</p>
  </note>
  <lines>alpha
beta</lines>
</body>`);

    const second = applyTransform(first.source, {
      transform: 'linesToCodeblock',
      linesId: idOf(first.source, 'lines', 'alpha\nbeta'),
      blockKind: 'codeblock',
    });
    expect(second.source).toBe(`<body>
  <note>
    <p>one two</p>
  </note>
  <codeblock>alpha
beta</codeblock>
</body>`);
  });

  test('linesToSection is allowed in topic body but refused inside a table cell', () => {
    const SRC = `<body>
  <lines>section intro</lines>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'linesToSection',
      linesId: idOf(SRC, 'lines'),
      blockKind: 'section',
    });

    expect(r.source).toBe(`<body>
  <section>
    <p>section intro</p>
  </section>
</body>`);

    const CELL = '<table><tgroup cols="1"><tbody><row><entry><lines>x</lines></entry></row></tbody></tgroup></table>';
    expect(() =>
      applyTransform(CELL, {
        transform: 'linesToSection',
        linesId: idOf(CELL, 'lines'),
        blockKind: 'section',
      }),
    ).toThrow(/not permitted inside <entry>/);
  });
});

describe('itemToParagraph (li -> p)', () => {
  test('dissolve-list: a sole-item list becomes a paragraph at the list position', () => {
    const SRC = `<body>
  <ul>
    <li>only</li>
  </ul>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'itemToParagraph',
      itemId: idOf(SRC, 'li', 'only'),
      mode: 'dissolve-list',
    });
    expect(r.source).toBe(`<body>
  <p>only</p>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('dissolve-list inside a note preserves inline content', () => {
    const source = '<body><note><ul><li><b>Business</b> A350</li></ul></note></body>';
    const result = applyTransform(source, {
      transform: 'itemToParagraph',
      itemId: idOf(source, 'li', 'A350'),
      mode: 'dissolve-list',
    });

    expect(result.source).toBe('<body><note><p><b>Business</b> A350</p></note></body>');
    expect(elAt(parse(result.source), result.focusId!)?.name).toBe('p');
  });

  test('lift-before: the first item lifts out as a <p> before the list', () => {
    const r = applyTransform(UL_DOC, {
      transform: 'itemToParagraph',
      itemId: idOf(UL_DOC, 'li', 'alpha'),
      mode: 'lift-before',
    });
    expect(r.source).toBe(`<body>
  <p>alpha</p>
  <ul>
    <li>beta</li>
  </ul>
</body>`);
  });

  test('lift-after: the last item lifts out as a <p> after the list', () => {
    const r = applyTransform(UL_DOC, {
      transform: 'itemToParagraph',
      itemId: idOf(UL_DOC, 'li', 'beta'),
      mode: 'lift-after',
    });
    expect(r.source).toBe(`<body>
  <ul>
    <li>alpha</li>
  </ul>
  <p>beta</p>
</body>`);
  });

  test('split-list: a middle item becomes a paragraph between two lists', () => {
    const SRC = `<body>
  <ul>
    <li>alpha</li>
    <li>beta</li>
    <li>gamma</li>
  </ul>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'itemToParagraph',
      itemId: idOf(SRC, 'li', 'beta'),
      mode: 'split-list',
    });

    expect(r.source).toBe(`<body>
  <ul>
    <li>alpha</li>
  </ul>
  <p>beta</p>
  <ul>
    <li>gamma</li>
  </ul>
</body>`);
    expect(elAt(parse(r.source), r.focusId!)?.name).toBe('p');
  });

  test('split-list preserves list attributes on both sides', () => {
    const SRC = `<body>
  <ol outputclass="steps">
    <li>one</li>
    <li>two</li>
    <li>three</li>
  </ol>
</body>`;
    const r = applyTransform(SRC, {
      transform: 'itemToParagraph',
      itemId: idOf(SRC, 'li', 'two'),
      mode: 'split-list',
    });

    expect(r.source).toBe(`<body>
  <ol outputclass="steps">
    <li>one</li>
  </ol>
  <p>two</p>
  <ol outputclass="steps">
    <li>three</li>
  </ol>
</body>`);
  });
});

describe('surrounding content is byte-exact', () => {
  test('sibling blocks outside the transformed list are untouched', () => {
    const SRC = `<body>
  <p>intro</p>
  <ul>
    <li>a</li>
    <li>b</li>
  </ul>
  <p>outro &amp; done</p>
</body>`;
    const r = applyTransform(SRC, { transform: 'toOrderedList', targetId: idOf(SRC, 'ul') });
    expect(r.source).toBe(`<body>
  <p>intro</p>
  <ol>
    <li>a</li>
    <li>b</li>
  </ol>
  <p>outro &amp; done</p>
</body>`);
  });
});

describe('apply-time guards', () => {
  test('a mismatched target kind throws rather than corrupting the document', () => {
    expect(() =>
      applyTransform(UL_DOC, { transform: 'toOrderedList', targetId: idOf(UL_DOC, 'li', 'alpha') }),
    ).toThrow(/not a list/);
  });

  test('an unknown id throws', () => {
    expect(() =>
      applyTransform(UL_DOC, { transform: 'toOrderedList', targetId: 'e999' }),
    ).toThrow(/not found/);
  });
});

// applyTransform is the CST write boundary reached from host/webview wiring. Ids are
// reassigned on every edit, so a stale/malformed spec must be refused HERE — it cannot
// rely on the planner. Each guard throws without producing a mutated document.
describe('apply-time structural precondition guards', () => {
  test('paragraphToItem append refuses a non-adjacent list', () => {
    const SRC = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>between</p>
  <p>x</p>
</body>`;
    // The <ul> is NOT the immediate previous sibling of <p>x</p> (the "between" p is).
    expect(() =>
      applyTransform(SRC, {
        transform: 'paragraphToItem',
        paragraphId: idOf(SRC, 'p', 'x'),
        listId: idOf(SRC, 'ul'),
        position: 'append',
      }),
    ).toThrow(/previous sibling/);
  });

  test('paragraphToItem prepend refuses a wrong-side (previous, not next) list', () => {
    const SRC = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>x</p>
</body>`;
    // The <ul> is the previous sibling, but prepend requires it to be the NEXT sibling.
    expect(() =>
      applyTransform(SRC, {
        transform: 'paragraphToItem',
        paragraphId: idOf(SRC, 'p', 'x'),
        listId: idOf(SRC, 'ul'),
        position: 'prepend',
      }),
    ).toThrow(/next sibling/);
  });

  test('itemToParagraph dissolve-list refuses a multi-item list', () => {
    expect(() =>
      applyTransform(UL_DOC, {
        transform: 'itemToParagraph',
        itemId: idOf(UL_DOC, 'li', 'alpha'),
        mode: 'dissolve-list',
      }),
    ).toThrow(/exactly one item/);
  });

  test('itemToParagraph lift-before refuses a middle item', () => {
    const SRC = `<body>
  <ul>
    <li>a</li>
    <li>b</li>
    <li>c</li>
  </ul>
</body>`;
    expect(() =>
      applyTransform(SRC, {
        transform: 'itemToParagraph',
        itemId: idOf(SRC, 'li', 'b'),
        mode: 'lift-before',
      }),
    ).toThrow(/first of a multi-item list/);
  });

  test('itemToParagraph lift-after refuses a non-last item', () => {
    expect(() =>
      applyTransform(UL_DOC, {
        transform: 'itemToParagraph',
        itemId: idOf(UL_DOC, 'li', 'alpha'),
        mode: 'lift-after',
      }),
    ).toThrow(/last of a multi-item list/);
  });

  test('a refused transform does not mutate the input source', () => {
    const before = UL_DOC;
    expect(() =>
      applyTransform(UL_DOC, {
        transform: 'itemToParagraph',
        itemId: idOf(UL_DOC, 'li', 'alpha'),
        mode: 'dissolve-list',
      }),
    ).toThrow();
    expect(UL_DOC).toBe(before); // string is untouched; no partial write escaped
  });
});
