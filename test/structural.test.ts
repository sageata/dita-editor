import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit, canDeleteElement } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { editableElementIds } from '../src/cst/text-targets';
import { childrenNamed, findElements } from '../src/cst/query';
import type { ElementNode } from '../src/cst/types';

function firstId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no <${name}> found`);
}

function idOfEntryText(src: string, text: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    const e = el as ElementNode;
    if (e.name === 'entry' && e.children.some((c) => c.type === 'text' && c.raw === text)) return id;
  }
  throw new Error(`no <entry> with text ${JSON.stringify(text)}`);
}

function idsNamed(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) out.push(id);
  }
  return out;
}

const TABLE =
  '<topic><body>\n' +
  '  <table><tgroup cols="2">\n' +
  '    <colspec colname="c1" colnum="1"/>\n' +
  '    <colspec colname="c2" colnum="2"/>\n' +
  '    <tbody>\n' +
  '      <row>\n' +
  '        <entry>a</entry>\n' +
  '        <entry>b</entry>\n' +
  '      </row>\n' +
  '    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

const LIST = '<topic><body>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>\n</body></topic>';
const PARA = '<topic><body>\n  <p>hello</p>\n</body></topic>';

describe('structural: rows', () => {
  test('addRowAfter adds a row of empty cells; focusId points to an editable new cell', () => {
    const res = applyStructuralEdit(TABLE, 'addRowAfter', firstId(TABLE, 'row'));
    const out = res.source;
    const after = parse(out);
    const rows = findElements(after, 'row');
    expect(rows.length).toBe(2);
    expect(childrenNamed(rows[1], 'entry').length).toBe(2);
    expect(out).toContain('<entry></entry>');
    expect(out).toContain('\n        <entry></entry>'); // new cells keep their indentation
    expect(out).not.toContain('</entry><entry>'); // never jammed onto the previous line

    // focusId resolves to an editable (empty) cell in the re-parsed output.
    expect(res.focusId).toBeTruthy();
    expect([...editableElementIds(after).values()]).toContain(res.focusId!);

    const firstRowStart = TABLE.indexOf('<row>');
    expect(out.slice(0, firstRowStart)).toBe(TABLE.slice(0, firstRowStart));
    expect(serialize(parse(out))).toBe(out);
  });

  test('addRowBefore inserts a row of empty cells above; focusId points to an editable new cell', () => {
    const res = applyStructuralEdit(TABLE, 'addRowBefore', firstId(TABLE, 'row'));
    const out = res.source;
    const after = parse(out);
    const rows = findElements(after, 'row');
    expect(rows.length).toBe(2);
    // The NEW row is first; the original (with content) follows.
    expect(childrenNamed(rows[0], 'entry').every((e) => e.children.length === 0)).toBe(true);
    expect(childrenNamed(rows[1], 'entry').length).toBe(2); // original content row intact below
    expect(out).toContain('\n        <entry></entry>'); // new cells keep their indentation
    expect(out).not.toContain('</entry><entry>');
    expect(out.indexOf('<entry></entry>')).toBeLessThan(out.indexOf('<entry>a</entry>'));

    expect(res.focusId).toBeTruthy();
    expect([...editableElementIds(after).values()]).toContain(res.focusId!);

    const tbodyStart = TABLE.indexOf('<tbody>');
    expect(out.slice(0, tbodyStart)).toBe(TABLE.slice(0, tbodyStart)); // nothing before tbody moves
    expect(serialize(parse(out))).toBe(out);
  });

  test('deleteRow removes the row; focusId is null', () => {
    const res = applyStructuralEdit(TABLE, 'deleteRow', firstId(TABLE, 'row'));
    expect(res.focusId).toBeNull();
    expect(findElements(parse(res.source), 'row').length).toBe(0);
    expect(serialize(parse(res.source))).toBe(res.source);
  });
});

describe('structural: table title (F10)', () => {
  test('addTableTitle splices an empty <title> as the FIRST table child (jammed form, minimal diff)', () => {
    const res = applyStructuralEdit(TABLE, 'addTableTitle', firstId(TABLE, 'table'));
    const out = res.source;
    expect(out).toContain('<table><title></title><tgroup cols="2">');
    const doc = parse(out);
    const title = findElements(doc, 'title')[0];
    expect(title.parent?.name).toBe('table');
    expect(res.focusId).toBeTruthy();
    expect(res.caretOffset).toBe(0);
    // Everything after the splice point is byte-identical.
    const spliceEnd = out.indexOf('<tgroup');
    expect(out.slice(spliceEnd)).toBe(TABLE.slice(TABLE.indexOf('<tgroup')));
    expect(serialize(parse(out))).toBe(out);
  });

  test('refuses when the table already has a title (no write)', () => {
    const titled = TABLE.replace('<table><tgroup', '<table><title>T</title><tgroup');
    expect(() => applyStructuralEdit(titled, 'addTableTitle', firstId(titled, 'table'))).toThrow(/already has a title/i);
  });

  test('existing deleteTitle removes a table title (the F10 "remove" path)', () => {
    const titled = TABLE.replace('<table><tgroup', '<table><title>T</title><tgroup');
    const res = applyStructuralEdit(titled, 'deleteTitle', firstId(titled, 'title'));
    expect(res.source).not.toContain('<title>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });
});

describe('structural: list items', () => {
  test('addItemAfter adds an empty <li> and focuses it', () => {
    const res = applyStructuralEdit(LIST, 'addItemAfter', firstId(LIST, 'li'));
    expect(findElements(parse(res.source), 'li').length).toBe(3);
    expect(res.source).toContain('<li></li>');
    expect([...editableElementIds(parse(res.source)).values()]).toContain(res.focusId!);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteItem removes a <li>', () => {
    const res = applyStructuralEdit(LIST, 'deleteItem', firstId(LIST, 'li'));
    expect(findElements(parse(res.source), 'li').length).toBe(1);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteItem removes the list when clearing its sole item inside mixed note content', () => {
    const src = '<body><note>Keep this warning<ul><li/></ul></note></body>';
    const res = applyStructuralEdit(src, 'deleteItem', firstId(src, 'li'));

    expect(res.source).toBe('<body><note>Keep this warning</note></body>');
    expect(findElements(parse(res.source), 'ul')).toHaveLength(0);
    expect(findElements(parse(res.source), 'li')).toHaveLength(0);
    expect(serialize(parse(res.source))).toBe(res.source);
  });
});

describe('structural: paragraphs', () => {
  test('addParaAfter adds an empty <p> and focuses it', () => {
    const res = applyStructuralEdit(PARA, 'addParaAfter', firstId(PARA, 'p'));
    expect(findElements(parse(res.source), 'p').length).toBe(2);
    expect([...editableElementIds(parse(res.source)).values()]).toContain(res.focusId!);
    expect(serialize(parse(res.source))).toBe(res.source);
  });
});

describe('structural: split (Enter at the caret)', () => {
  const HW = '<topic><body>\n  <p>Hello World</p>\n</body></topic>';

  test('splits a paragraph into two at the caret; focuses the new tail at offset 0', () => {
    const res = applyStructuralEdit(HW, 'split', firstId(HW, 'p'), { prefix: 'Hello ', suffix: 'World' });
    const out = res.source;
    expect(out).toContain('<p>Hello </p>');
    expect(out).toContain('<p>World</p>');
    expect(findElements(parse(out), 'p').length).toBe(2);
    expect(res.caretOffset).toBe(0);
    expect([...editableElementIds(parse(out)).values()]).toContain(res.focusId!);
    expect(serialize(parse(out))).toBe(out);
  });

  test('split at the end degrades to adding an empty sibling', () => {
    const res = applyStructuralEdit(PARA, 'split', firstId(PARA, 'p'), { prefix: 'hello', suffix: '' });
    expect(res.source).toContain('<p>hello</p>');
    expect(res.source).toContain('<p></p>');
    expect(findElements(parse(res.source), 'p').length).toBe(2);
  });

  test('split re-escapes entities in both halves (client passes decoded text)', () => {
    const src = '<topic><body><p>a &amp; b &amp; c</p></body></topic>';
    const res = applyStructuralEdit(src, 'split', firstId(src, 'p'), { prefix: 'a & ', suffix: 'b & c' });
    expect(res.source).toContain('<p>a &amp; </p>');
    expect(res.source).toContain('<p>b &amp; c</p>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('split preserves inline markup when the canvas supplies rich HTML fragments', () => {
    const src = '<topic><body>\n  <p>Lead <b>bold</b> tail</p>\n</body></topic>';
    const res = applyStructuralEdit(src, 'split', firstId(src, 'p'), {
      prefixHtml: 'Lead <strong>bo</strong>',
      suffixHtml: '<strong>ld</strong> tail',
    });
    expect(res.source).toBe(
      '<topic><body>\n' +
        '  <p>Lead <b>bo</b></p>\n' +
        '  <p><b>ld</b> tail</p>\n' +
        '</body></topic>',
    );
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('split a list item', () => {
    const res = applyStructuralEdit(LIST, 'split', firstId(LIST, 'li'), { prefix: 'o', suffix: 'ne' });
    expect(res.source).toContain('<li>o</li>');
    expect(res.source).toContain('<li>ne</li>');
    expect(findElements(parse(res.source), 'li').length).toBe(3);
  });
});

describe('structural: pasteBlocks', () => {
  test('pastes HTML blocks as sibling paragraphs and preserves inline marks', () => {
    const src = '<topic><body>\n  <p>Start tail</p>\n</body></topic>';
    const res = applyStructuralEdit(src, 'pasteBlocks', firstId(src, 'p'), {
      prefix: 'Start ',
      suffix: ' tail',
      blocks: ['<strong>First</strong>', '<em>Second</em>'],
    });
    expect(res.source).toBe(
      '<topic><body>\n' +
        '  <p>Start <b>First</b></p>\n' +
        '  <p><i>Second</i> tail</p>\n' +
        '</body></topic>',
    );
    expect(findElements(parse(res.source), 'p').length).toBe(2);
    expect(res.caretOffset).toBe('Second'.length);
    expect([...editableElementIds(parse(res.source)).values()]).toContain(res.focusId!);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('pastes plain text blocks as sibling list items', () => {
    const src = '<topic><body>\n  <ul>\n    <li>One tail</li>\n  </ul>\n</body></topic>';
    const res = applyStructuralEdit(src, 'pasteBlocks', firstId(src, 'li'), {
      prefix: 'One ',
      suffix: ' tail',
      blocks: ['Two &amp; more', 'Three'],
    });
    expect(res.source).toBe(
      '<topic><body>\n' +
        '  <ul>\n' +
        '    <li>One Two &amp; more</li>\n' +
        '    <li>Three tail</li>\n' +
        '  </ul>\n' +
        '</body></topic>',
    );
    expect(findElements(parse(res.source), 'li').length).toBe(2);
    expect(res.caretOffset).toBe('Three'.length);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('replaces selected rich content and preserves rich prefix and suffix fragments', () => {
    const src = '<topic><body>\n  <p>Lead <b>old</b> tail</p>\n</body></topic>';
    const res = applyStructuralEdit(src, 'pasteBlocks', firstId(src, 'p'), {
      prefixHtml: 'Lead ',
      suffixHtml: ' tail',
      blocks: ['<em>New</em>', '<strong>Second</strong>'],
    });
    expect(res.source).toBe(
      '<topic><body>\n' +
        '  <p>Lead <i>New</i></p>\n' +
        '  <p><b>Second</b> tail</p>\n' +
        '</body></topic>',
    );
    expect(res.caretOffset).toBe('Second'.length);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('refuses structural block paste outside paragraphs and list items', () => {
    expect(() =>
      applyStructuralEdit(TABLE, 'pasteBlocks', firstId(TABLE, 'row'), { blocks: ['First', 'Second'] }),
    ).toThrow('not a paragraph or list item');
  });
});

describe('structural: join (Backspace at the start)', () => {
  const TWOP = '<topic><body>\n  <p>Hello</p>\n  <p>World</p>\n</body></topic>';

  test('merges a paragraph into the previous one; caret at the seam', () => {
    const [firstP, secondP] = idsNamed(TWOP, 'p');
    const res = applyStructuralEdit(TWOP, 'join', secondP, {
      prevId: firstP,
      merged: 'HelloWorld',
      boundary: 5,
    });
    expect(res.source).toContain('<p>HelloWorld</p>');
    expect(findElements(parse(res.source), 'p').length).toBe(1);
    expect(res.caretOffset).toBe(5);
    expect(res.focusId).toBeTruthy();
    expect([...editableElementIds(parse(res.source)).values()]).toContain(res.focusId!);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('merges a list item into the previous one', () => {
    const [firstLi, secondLi] = idsNamed(LIST, 'li');
    const res = applyStructuralEdit(LIST, 'join', secondLi, {
      prevId: firstLi,
      merged: 'onetwo',
      boundary: 3,
    });
    expect(res.source).toContain('<li>onetwo</li>');
    expect(findElements(parse(res.source), 'li').length).toBe(1);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('preserves inline markup when joining rich paragraphs', () => {
    const src = '<topic><body>\n  <p>Lead <b>bold</b></p>\n  <p><i>tail</i></p>\n</body></topic>';
    const [firstP, secondP] = idsNamed(src, 'p');
    const res = applyStructuralEdit(src, 'join', secondP, {
      prevId: firstP,
      mergedHtml: 'Lead <strong>bold</strong><em>tail</em>',
      boundary: 'Lead bold'.length,
    });
    expect(res.source).toBe('<topic><body>\n  <p>Lead <b>bold</b><i>tail</i></p>\n</body></topic>');
    expect(res.caretOffset).toBe('Lead bold'.length);
    expect(findElements(parse(res.source), 'p').length).toBe(1);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('throws when the join target id does not resolve', () => {
    expect(() =>
      applyStructuralEdit(TWOP, 'join', firstId(TWOP, 'p'), { prevId: 'e999', merged: 'x', boundary: 0 }),
    ).toThrow();
  });
});

describe('structural: columns (no-span tables)', () => {
  const T3 =
    '<topic><body>\n' +
    '  <table><tgroup cols="3">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n' +
    '    <colspec colname="c3" colnum="3"/>\n' +
    '    <thead>\n' +
    '      <row>\n' +
    '        <entry>H1</entry>\n' +
    '        <entry>H2</entry>\n' +
    '        <entry>H3</entry>\n' +
    '      </row>\n' +
    '    </thead>\n' +
    '    <tbody>\n' +
    '      <row>\n' +
    '        <entry>a</entry>\n' +
    '        <entry>b</entry>\n' +
    '        <entry>c</entry>\n' +
    '      </row>\n' +
    '    </tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  const colnames = (src: string): string[] => {
    const tg = findElements(parse(src), 'tgroup')[0];
    return childrenNamed(tg, 'colspec').map((c) => c.attrs.find((a) => a.name === 'colname')!.value);
  };
  const colnums = (src: string): string[] => {
    const tg = findElements(parse(src), 'tgroup')[0];
    return childrenNamed(tg, 'colspec').map((c) => c.attrs.find((a) => a.name === 'colnum')!.value);
  };
  const colwidths = (src: string): Array<string | undefined> => {
    const tg = findElements(parse(src), 'tgroup')[0];
    return childrenNamed(tg, 'colspec').map((c) => c.attrs.find((a) => a.name === 'colwidth')?.value);
  };
  const colsAttr = (src: string): string =>
    findElements(parse(src), 'tgroup')[0].attrs.find((a) => a.name === 'cols')!.value;
  const rowCellCounts = (src: string): number[] =>
    findElements(parse(src), 'row').map((r) => childrenNamed(r, 'entry').length);

  test('addColumnAfter a middle column: @cols bumps, colspecs renumber c1..c4, every row +1 cell', () => {
    const res = applyStructuralEdit(T3, 'addColumnAfter', idsNamed(T3, 'entry')[0]); // after column 0
    const out = res.source;
    expect(colsAttr(out)).toBe('4');
    expect(colnames(out)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(colnums(out)).toEqual(['1', '2', '3', '4']);
    // T3 has no explicit widths: the insert writes NONE (auto layout absorbs the
    // new column; other columns keep their auto sizes — nothing is forced to 1*).
    expect(colwidths(out)).toEqual([undefined, undefined, undefined, undefined]);
    expect(rowCellCounts(out)).toEqual([4, 4]);
    expect(out).toContain('<entry></entry>');
    expect(out).toContain('<colspec colname="c4" colnum="4"/>');
    expect(out).toContain('\n        <entry></entry>'); // new cell keeps its own indented line
    expect(out).toContain('\n    <colspec colname="c2" colnum="2"/>'); // inserted colspec indented
    expect(out).not.toContain('</entry><entry>'); // entries not jammed together
    expect(out).not.toContain('/><colspec'); // colspecs not jammed together
    expect(res.caretOffset).toBe(0);
    expect([...editableElementIds(parse(out)).values()]).toContain(res.focusId!);
    const tableStart = T3.indexOf('<table>');
    expect(out.slice(0, tableStart)).toBe(T3.slice(0, tableStart)); // nothing before the table moves
    expect(serialize(parse(out))).toBe(out);
  });

  test('addRowBefore the first tbody row inserts a BODY row; thead is untouched', () => {
    const tbodyRows = (src: string): ElementNode[] => {
      const tg = findElements(parse(src), 'tgroup')[0];
      return childrenNamed(childrenNamed(tg, 'tbody')[0], 'row');
    };
    const theadRows = (src: string): ElementNode[] => {
      const tg = findElements(parse(src), 'tgroup')[0];
      return childrenNamed(childrenNamed(tg, 'thead')[0], 'row');
    };
    const doc = parse(T3);
    let firstTbodyRowId: string | null = null;
    for (const [el, id] of assignElementIds(doc)) {
      const e = el as ElementNode;
      if (e.name === 'row' && e.parent?.name === 'tbody') {
        firstTbodyRowId = id;
        break;
      }
    }
    const res = applyStructuralEdit(T3, 'addRowBefore', firstTbodyRowId!);
    const out = res.source;
    expect(theadRows(out).length).toBe(1); // header untouched
    expect(tbodyRows(out).length).toBe(2); // was 1
    expect(childrenNamed(tbodyRows(out)[0], 'entry').every((e) => e.children.length === 0)).toBe(true);
    const theadEnd = T3.indexOf('</thead>');
    expect(out.slice(0, theadEnd)).toBe(T3.slice(0, theadEnd)); // thead bytes identical
    expect(serialize(parse(out))).toBe(out);
  });

  test('addColumnBefore the first column: @cols bumps, colspecs renumber, every row +1 leading cell', () => {
    const res = applyStructuralEdit(T3, 'addColumnBefore', idsNamed(T3, 'entry')[0]); // before column 0
    const out = res.source;
    expect(colsAttr(out)).toBe('4');
    expect(colnames(out)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(colnums(out)).toEqual(['1', '2', '3', '4']);
    expect(colwidths(out)).toEqual([undefined, undefined, undefined, undefined]); // width-free stays width-free
    expect(rowCellCounts(out)).toEqual([4, 4]);
    // The fresh empty cell precedes H1 in every row (leading position).
    expect(out.indexOf('<entry></entry>')).toBeLessThan(out.indexOf('<entry>H1</entry>'));
    expect(out).not.toContain('</entry><entry>');
    expect(out).not.toContain('/><colspec');
    expect(res.caretOffset).toBe(0);
    expect([...editableElementIds(parse(out)).values()]).toContain(res.focusId!);
    expect(serialize(parse(out))).toBe(out);
  });

  test('addColumnBefore at the leftmost edge: the lone neighbour donates half, total preserved', () => {
    const src =
      '<topic><body>\n' +
      '  <table><tgroup cols="2">\n' +
      '    <colspec colname="c1" colnum="1" colwidth="0.75*"/>\n' +
      '    <colspec colname="c2" colnum="2" colwidth="1.25*"/>\n' +
      '    <tbody><row><entry>A</entry><entry>B</entry></row></tbody>\n' +
      '  </tgroup></table>\n' +
      '</body></topic>';

    const out = applyStructuralEdit(src, 'addColumnBefore', idsNamed(src, 'entry')[0]).source;

    expect(colnames(out)).toEqual(['c1', 'c2', 'c3']);
    // take = min(0.75/2, avg 1) = 0.375, all from the displaced first column.
    expect(colwidths(out)).toEqual(['0.375*', '0.375*', '1.25*']);
    expect(serialize(parse(out))).toBe(out);
  });

  test('addColumnAfter the last column appends without inventing widths on a width-free table', () => {
    const res = applyStructuralEdit(T3, 'addColumnAfter', idsNamed(T3, 'entry')[2]); // after column 2
    const out = res.source;
    expect(colsAttr(out)).toBe('4');
    expect(colnames(out)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(colwidths(out)).toEqual([undefined, undefined, undefined, undefined]);
    expect(out).toContain('<colspec colname="c1" colnum="1"/>');
    expect(out).toContain('<colspec colname="c4" colnum="4"/>');
    expect(rowCellCounts(out)).toEqual([4, 4]);
    expect(serialize(parse(out))).toBe(out);
  });

  test('mid-table insert on a width-carrying table: neighbours donate, TOTAL preserved', () => {
    const src =
      '<topic><body>\n' +
      '  <table><tgroup cols="2">\n' +
      '    <colspec colname="c1" colnum="1" colwidth="0.75*"/>\n' +
      '    <colspec colname="c2" colnum="2" colwidth="1.25*"/>\n' +
      '    <tbody><row><entry>A</entry><entry>B</entry></row></tbody>\n' +
      '  </tgroup></table>\n' +
      '</body></topic>';

    const out = applyStructuralEdit(src, 'addColumnAfter', idsNamed(src, 'entry')[0]).source;

    expect(colnames(out)).toEqual(['c1', 'c2', 'c3']);
    // take = min((0.75+1.25)/3, avg 1) = 0.667, donated proportionally by A and B.
    expect(colwidths(out)).toEqual(['0.5*', '0.667*', '0.833*']);
    const sum = colwidths(out).reduce((s, w) => s + Number((w ?? '0').replace('*', '')), 0);
    expect(sum).toBeCloseTo(2, 2); // A + new + B == old A + B
    expect(serialize(parse(out))).toBe(out);
  });

  test('width-carrying table: only the boundary neighbours change — distant columns keep exact bytes', () => {
    const src =
      '<topic><body>\n' +
      '  <table><tgroup cols="4">\n' +
      '    <colspec colname="c1" colnum="1" colwidth="2*"/>\n' +
      '    <colspec colname="c2" colnum="2" colwidth="1*"/>\n' +
      '    <colspec colname="c3" colnum="3" colwidth="1*"/>\n' +
      '    <colspec colname="c4" colnum="4" colwidth="3*"/>\n' +
      '    <tbody><row><entry>a</entry><entry>b</entry><entry>c</entry><entry>d</entry></row></tbody>\n' +
      '  </tgroup></table>\n' +
      '</body></topic>';

    const out = applyStructuralEdit(src, 'addColumnAfter', idsNamed(src, 'entry')[1]).source; // b|c boundary

    // take = min((1+1)/3, avg 7/4=1.75) = 0.667; b and c donate 0.333 each.
    expect(colwidths(out)).toEqual(['2*', '0.667*', '0.667*', '0.667*', '3*']);
    expect(out).toContain('<colspec colname="c1" colnum="1" colwidth="2*"/>'); // untouched bytes
    expect(out).toContain('colwidth="3*"');
    expect(serialize(parse(out))).toBe(out);
  });

  test('deleteColumn removes a middle column, renumbers, drops a cell per row', () => {
    const res = applyStructuralEdit(T3, 'deleteColumn', idsNamed(T3, 'entry')[1]); // column 1 (H2/b)
    const out = res.source;
    expect(colsAttr(out)).toBe('2');
    expect(colnames(out)).toEqual(['c1', 'c2']);
    expect(colnums(out)).toEqual(['1', '2']);
    expect(rowCellCounts(out)).toEqual([2, 2]);
    expect(out).not.toContain('<entry>H2</entry>');
    expect(out).not.toContain('<entry>b</entry>');
    expect(out).toContain('<entry>H1</entry>');
    expect(out).toContain('<entry>H3</entry>');
    expect(res.focusId).toBeTruthy();
    expect(serialize(parse(out))).toBe(out);
  });

  const TSPAN =
    '<topic><body>\n' +
    '  <table><tgroup cols="2">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n' +
    '    <tbody>\n' +
    '      <row><entry namest="c1" nameend="c2">merged</entry></row>\n' +
    '      <row><entry>a</entry><entry>b</entry></row>\n' +
    '    </tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  test('column inserts refuse only when a span CROSSES the boundary; deletes stay blanket-refused', () => {
    const cell = idsNamed(TSPAN, 'entry')[1]; // the <entry>a</entry> cell
    // The a|b boundary sits under the c1-c2 span: refused.
    expect(() => applyStructuralEdit(TSPAN, 'addColumnAfter', cell)).toThrow(/spans across/i);
    // deleteColumn keeps the blanket merged-table refusal.
    expect(() => applyStructuralEdit(TSPAN, 'deleteColumn', cell)).toThrow(/merged/i);
  });

  test('span-aware insert at a SAFE boundary of a merged table renumbers namest/nameend refs', () => {
    const cell = idsNamed(TSPAN, 'entry')[1]; // the <entry>a</entry> cell
    const res = applyStructuralEdit(TSPAN, 'addColumnBefore', cell); // leftmost boundary
    const out = res.source;
    expect(colsAttr(out)).toBe('3');
    expect(colnames(out)).toEqual(['c1', 'c2', 'c3']);
    // The span shifted one column right with the insert.
    expect(out).toContain('namest="c2" nameend="c3"');
    // Every row gained one leading empty cell (the spanned row too).
    expect(rowCellCounts(out)).toEqual([2, 3]);
    expect(out.indexOf('<entry></entry>')).toBeLessThan(out.indexOf('<entry namest'));
    expect([...editableElementIds(parse(out)).values()]).toContain(res.focusId!);
    expect(serialize(parse(out))).toBe(out);
  });

  test('span-aware insert on a morerows table places cells correctly in COVERED rows', () => {
    const TMORE =
      '<topic><body>\n' +
      '  <table><tgroup cols="3">\n' +
      '    <colspec colname="c1" colnum="1"/>\n' +
      '    <colspec colname="c2" colnum="2"/>\n' +
      '    <colspec colname="c3" colnum="3"/>\n' +
      '    <tbody>\n' +
      '      <row><entry morerows="1">tall</entry><entry>b1</entry><entry>c1</entry></row>\n' +
      '      <row><entry>b2</entry><entry>c2</entry></row>\n' +
      '    </tbody>\n' +
      '  </tgroup></table>\n' +
      '</body></topic>';
    // Insert after column 2 (between b and c): vertical span at column 1 is no obstacle.
    const res = applyStructuralEdit(TMORE, 'addColumnAfter', idOfEntryText(TMORE, 'b2'));
    const out = res.source;
    expect(colsAttr(out)).toBe('4');
    // Covered row 2 has entries [b2, NEW, c2]; row 1 [tall, b1, NEW, c1].
    expect(rowCellCounts(out)).toEqual([4, 3]);
    const row2 = out.slice(out.lastIndexOf('<row>'));
    expect(row2.indexOf('<entry>b2</entry>')).toBeLessThan(row2.indexOf('<entry></entry>'));
    expect(row2.indexOf('<entry></entry>')).toBeLessThan(row2.indexOf('<entry>c2</entry>'));
    expect(out).toContain('morerows="1"'); // vertical span untouched
    expect(serialize(parse(out))).toBe(out);
  });

  test('deleteColumn refuses on a single-column table', () => {
    const T1 =
      '<topic><body>\n  <table><tgroup cols="1">\n    <colspec colname="c1" colnum="1"/>\n' +
      '    <tbody>\n      <row><entry>only</entry></row>\n    </tbody>\n  </tgroup></table>\n</body></topic>';
    expect(() => applyStructuralEdit(T1, 'deleteColumn', idsNamed(T1, 'entry')[0])).toThrow();
  });

  // The de-risk corpus table has 13 columns, so a mid-table insert renumbers
  // across c9->c10 (a value-length change). The edit must keep colspecs
  // canonical past the single-digit boundary.
  const wideTable = (cols: number): string => {
    const colspecs = Array.from(
      { length: cols },
      (_, i) => `    <colspec colname="c${i + 1}" colnum="${i + 1}"/>`,
    ).join('\n');
    const cells = Array.from({ length: cols }, (_, i) => `        <entry>v${i + 1}</entry>`).join('\n');
    return (
      `<topic><body>\n  <table><tgroup cols="${cols}">\n${colspecs}\n` +
      `    <tbody>\n      <row>\n${cells}\n      </row>\n    </tbody>\n  </tgroup></table>\n</body></topic>`
    );
  };

  test('renumbering crosses the multi-digit boundary (11 -> 12 columns)', () => {
    const big = wideTable(11);
    const res = applyStructuralEdit(big, 'addColumnAfter', idsNamed(big, 'entry')[0]); // after col 0
    const out = res.source;
    expect(colsAttr(out)).toBe('12');
    expect(colnames(out)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i + 1}`));
    expect(colnums(out)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(colwidths(out)).toEqual(Array.from({ length: 12 }, () => undefined)); // width-free stays width-free
    expect(out).toContain('<colspec colname="c10" colnum="10"/>');
    expect(out).toContain('<colspec colname="c12" colnum="12"/>');
    expect(rowCellCounts(out)).toEqual([12]);
    expect(serialize(parse(out))).toBe(out);
  });
});

describe('structural: whole-block deletes (table / list / figure)', () => {
  // A body with sibling blocks around the deletable element, so the would-empty
  // guard never fires and we can assert the removed span is the only byte diff.
  const wrap = (block: string): string =>
    `<topic><body>\n  <p>intro</p>\n${block}\n  <p>outro</p>\n</body></topic>`;
  const withoutBlock = '<topic><body>\n  <p>intro</p>\n  <p>outro</p>\n</body></topic>';

  const TABLE_BLOCK =
    '  <table><tgroup cols="1">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <tbody>\n      <row><entry>x</entry></row>\n    </tbody>\n' +
    '  </tgroup></table>';
  const LIST_BLOCK = '  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>';
  const FIG_BLOCK = '  <fig>\n    <title>F</title>\n  </fig>';

  const nameOfFocus = (res: { source: string; focusId: string | null }): string | undefined => {
    if (!res.focusId) return undefined;
    const doc = parse(res.source);
    for (const [el, id] of assignElementIds(doc)) if (id === res.focusId) return (el as ElementNode).name;
    return undefined;
  };

  test('deleteTable removes exactly the <table> (and its leading ws); rest byte-identical', () => {
    const src = wrap(TABLE_BLOCK);
    const res = applyStructuralEdit(src, 'deleteTable', firstId(src, 'table'));
    expect(res.source).toBe(withoutBlock);
    expect(findElements(parse(res.source), 'table').length).toBe(0);
    expect(serialize(parse(res.source))).toBe(res.source);
    expect(nameOfFocus(res)).toBe('p'); // caret lands on the following block
  });

  test('deleteList removes a whole <ul> byte-exactly', () => {
    const src = wrap(LIST_BLOCK);
    const res = applyStructuralEdit(src, 'deleteList', firstId(src, 'ul'));
    expect(res.source).toBe(withoutBlock);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteFig removes a whole <fig> byte-exactly', () => {
    const src = wrap(FIG_BLOCK);
    const res = applyStructuralEdit(src, 'deleteFig', firstId(src, 'fig'));
    expect(res.source).toBe(withoutBlock);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('focus falls back to the previous block when the deleted block is last', () => {
    const src = `<topic><body>\n  <p>intro</p>\n${TABLE_BLOCK}\n</body></topic>`;
    const res = applyStructuralEdit(src, 'deleteTable', firstId(src, 'table'));
    expect(res.source).toBe('<topic><body>\n  <p>intro</p>\n</body></topic>');
    expect(nameOfFocus(res)).toBe('p');
  });

  test('would-empty-body guard refuses deleting the only block (throws, no write)', () => {
    const onlyTable = `<topic><body>\n${TABLE_BLOCK}\n</body></topic>`;
    expect(() => applyStructuralEdit(onlyTable, 'deleteTable', firstId(onlyTable, 'table'))).toThrow(
      /only block/,
    );
  });

  test('deleteList rejects a non-list target kind', () => {
    const src = wrap(TABLE_BLOCK);
    expect(() => applyStructuralEdit(src, 'deleteList', firstId(src, 'table'))).toThrow(/not <ul> or <ol>/);
  });
});

describe('structural: deleteImage / deleteTitle', () => {
  const nameOfFocus = (res: { source: string; focusId: string | null }): string | undefined => {
    if (!res.focusId) return undefined;
    const doc = parse(res.source);
    for (const [el, id] of assignElementIds(doc)) if (id === res.focusId) return (el as ElementNode).name;
    return undefined;
  };

  const FIG =
    '<topic><body>\n  <fig>\n    <title>F</title>\n    <image href="i.png"/>\n  </fig>\n</body></topic>';

  test('deleteImage removes exactly the <image> (and its leading ws); rest byte-identical', () => {
    const res = applyStructuralEdit(FIG, 'deleteImage', firstId(FIG, 'image'));
    expect(res.source).toBe(
      '<topic><body>\n  <fig>\n    <title>F</title>\n  </fig>\n</body></topic>',
    );
    expect(findElements(parse(res.source), 'image').length).toBe(0);
    expect(serialize(parse(res.source))).toBe(res.source);
    expect(nameOfFocus(res)).toBe('title'); // focus falls back to the sibling title
  });

  test('deleteImage rejects a non-image target kind', () => {
    expect(() => applyStructuralEdit(FIG, 'deleteImage', firstId(FIG, 'title'))).toThrow(/not <image>/);
  });

  test('deleteTitle removes an OPTIONAL <fig> title byte-exactly; focus to the next sibling', () => {
    const res = applyStructuralEdit(FIG, 'deleteTitle', firstId(FIG, 'title'));
    expect(res.source).toBe(
      '<topic><body>\n  <fig>\n    <image href="i.png"/>\n  </fig>\n</body></topic>',
    );
    expect(findElements(parse(res.source), 'title').length).toBe(0);
    expect(serialize(parse(res.source))).toBe(res.source);
    expect(nameOfFocus(res)).toBe('image');
  });

  test('deleteTitle removes an OPTIONAL <table> title byte-exactly', () => {
    const T =
      '<topic><body>\n  <table>\n    <title>T</title>\n    <tgroup cols="1">\n' +
      '      <colspec colname="c1" colnum="1"/>\n' +
      '      <tbody>\n        <row><entry>x</entry></row>\n      </tbody>\n' +
      '    </tgroup>\n  </table>\n</body></topic>';
    const res = applyStructuralEdit(T, 'deleteTitle', firstId(T, 'title'));
    expect(res.source).toBe(
      '<topic><body>\n  <table>\n    <tgroup cols="1">\n' +
        '      <colspec colname="c1" colnum="1"/>\n' +
        '      <tbody>\n        <row><entry>x</entry></row>\n      </tbody>\n' +
        '    </tgroup>\n  </table>\n</body></topic>',
    );
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteTitle REFUSES a REQUIRED topic-root title (throws, no write)', () => {
    const TOPIC_TITLE =
      '<topic>\n  <title>Doc</title>\n  <body>\n    <p>x</p>\n  </body>\n</topic>';
    expect(() => applyStructuralEdit(TOPIC_TITLE, 'deleteTitle', firstId(TOPIC_TITLE, 'title'))).toThrow(
      /required <title>/,
    );
  });
});

describe('structural: errors', () => {
  test('throws on an unknown id', () => {
    expect(() => applyStructuralEdit(TABLE, 'addRowAfter', 'e999')).toThrow();
  });
});

// --- Universal, category-driven deletion (canDeleteElement + deleteElement) ---

describe('canDeleteElement: category table', () => {
  /** First <name> element in source, with its live parent link. */
  const elem = (src: string, name: string): ElementNode => {
    const el = findElements(parse(src), name)[0];
    if (!el) throw new Error(`no <${name}>`);
    return el;
  };
  const check = (src: string, name: string) => {
    const el = elem(src, name);
    return canDeleteElement(el, el.parent ?? null);
  };

  test('REQUIRED_SINGLETON: a <title> under a topic root is refused', () => {
    const v = check('<topic><title>Doc</title><body><p>x</p></body></topic>', 'title');
    expect(v.canDelete).toBe(false);
    expect(v.reason).toMatch(/required <title>/);
  });

  test('an OPTIONAL <title> under a <fig> is deletable', () => {
    expect(check('<fig><title>F</title><image href="i.png"/></fig>', 'title').canDelete).toBe(true);
  });

  test('a list’s only <li> cascades to its list — refused only when the list itself can’t go', () => {
    // The sole <li> of a list defers to whether THE LIST is deletable (deleting the item would
    // leave an invalid empty list). When the list is the sole block of its container, the cascade
    // hits the list's own sole-block guard and surfaces THAT reason.
    const solo = check('<body><ul><li>only</li></ul></body>', 'li');
    expect(solo.canDelete).toBe(false);
    expect(solo.reason).toMatch(/only block in <body>/);
    // A non-last <li> is independently deletable.
    expect(check('<ul><li>one</li><li>two</li></ul>', 'li').canDelete).toBe(true);
    // A sole <li> whose list IS removable (the body keeps another block) deletes via the cascade.
    expect(check('<body><p>keep</p><ul><li>only</li></ul></body>', 'li').canDelete).toBe(true);
  });

  test('MIN_ONE_IN_PARENT: the only <row> of a section is refused', () => {
    const v = check(
      '<tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>x</entry></row></tbody></tgroup>',
      'row',
    );
    expect(v.canDelete).toBe(false);
    expect(v.reason).toMatch(/only <row> in <tbody>/);
  });

  test('entry: a table cell is never deletable on its own', () => {
    const v = check(
      '<tgroup cols="2"><tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup>',
      'entry',
    );
    expect(v.canDelete).toBe(false);
    expect(v.reason).toMatch(/can't be deleted on its own/);
  });

  test('SOLE_BLOCK: the only block-level child of a container is refused', () => {
    const v = check('<body><p>only</p></body>', 'p');
    expect(v.canDelete).toBe(false);
    expect(v.reason).toMatch(/only block in <body>/);
  });

  test('SOLE_BLOCK: a block with a block sibling is deletable', () => {
    expect(check('<body><p>a</p><p>b</p></body>', 'p').canDelete).toBe(true);
  });

  test('<image> is optional everywhere → always deletable (never sole-block)', () => {
    expect(check('<body><fig><image href="i.png"/></fig></body>', 'image').canDelete).toBe(true);
  });

  test('a top-level element (no parent) refuses', () => {
    const el = findElements(parse('<topic><body><p>x</p></body></topic>'), 'topic')[0];
    expect(canDeleteElement(el, null).canDelete).toBe(false);
  });
});

describe('structural: deleteElement (universal, byte-exact apply)', () => {
  const wrap = (block: string): string =>
    `<topic><body>\n  <p>intro</p>\n${block}\n  <p>outro</p>\n</body></topic>`;
  const withoutBlock = '<topic><body>\n  <p>intro</p>\n  <p>outro</p>\n</body></topic>';
  const TABLE_BLOCK =
    '  <table><tgroup cols="1">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <tbody>\n      <row><entry>x</entry></row>\n    </tbody>\n' +
    '  </tgroup></table>';
  const LIST_BLOCK = '  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>';
  const FIG_BLOCK = '  <fig>\n    <image href="i.png"/>\n  </fig>';

  test.each([
    ['table', TABLE_BLOCK, 'table'],
    ['list', LIST_BLOCK, 'ul'],
    ['figure', FIG_BLOCK, 'fig'],
  ])('deleteElement removes an optional %s byte-exactly + reparses', (_label, block, name) => {
    const src = wrap(block);
    const res = applyStructuralEdit(src, 'deleteElement', firstId(src, name));
    expect(res.source).toBe(withoutBlock);
    expect(findElements(parse(res.source), name).length).toBe(0);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteElement removes an optional <p> byte-exactly (middle of three)', () => {
    const src = wrap('  <p>middle</p>');
    const res = applyStructuralEdit(src, 'deleteElement', idsNamed(src, 'p')[1]); // the middle <p>
    expect(res.source).toBe(withoutBlock);
    expect(findElements(parse(res.source), 'p').length).toBe(2);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteElement removes an <image> byte-exactly (optional everywhere)', () => {
    const FIG =
      '<topic><body>\n  <fig>\n    <title>F</title>\n    <image href="i.png"/>\n  </fig>\n</body></topic>';
    const res = applyStructuralEdit(FIG, 'deleteElement', firstId(FIG, 'image'));
    expect(res.source).toBe('<topic><body>\n  <fig>\n    <title>F</title>\n  </fig>\n</body></topic>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteElement removes an OPTIONAL <fig> title byte-exactly', () => {
    const FIG =
      '<topic><body>\n  <fig>\n    <title>F</title>\n    <image href="i.png"/>\n  </fig>\n</body></topic>';
    const res = applyStructuralEdit(FIG, 'deleteElement', firstId(FIG, 'title'));
    expect(res.source).toBe(
      '<topic><body>\n  <fig>\n    <image href="i.png"/>\n  </fig>\n</body></topic>',
    );
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteElement REFUSES the required topic title (throws, no write)', () => {
    const src = '<topic>\n  <title>Doc</title>\n  <body>\n    <p>x</p>\n  </body>\n</topic>';
    expect(() => applyStructuralEdit(src, 'deleteElement', firstId(src, 'title'))).toThrow(
      /required <title>/,
    );
  });

  test('deleteElement REFUSES the sole block of a container (throws, no write)', () => {
    const src = `<topic><body>\n${TABLE_BLOCK}\n</body></topic>`;
    expect(() => applyStructuralEdit(src, 'deleteElement', firstId(src, 'table'))).toThrow(
      /only block/,
    );
  });

  test('deleteElement removes a <lines> block and leaves sibling content byte-stable', () => {
    const src = '<topic><body>\n  <p>keep</p>\n  <lines>a\nb</lines>\n</body></topic>';
    const res = applyStructuralEdit(src, 'deleteElement', firstId(src, 'lines'));
    expect(res.source).toBe('<topic><body>\n  <p>keep</p>\n</body></topic>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('deleteElement on the only <li> of a list CASCADES to removing the list', () => {
    // Deleting the last item removes the would-be-empty list with it; the body keeps <p>keep</p>,
    // so the cascade is valid and writes a byte-stable result (no throw).
    const src = '<topic><body>\n  <p>keep</p>\n  <ul>\n    <li>only</li>\n  </ul>\n</body></topic>';
    const r = applyStructuralEdit(src, 'deleteElement', firstId(src, 'li'));
    expect(r.source).not.toContain('<ul>'); // the emptied list is gone
    expect(r.source).toContain('<p>keep</p>'); // the paragraph is kept
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('deleteElement REFUSES the only <row> of a section', () => {
    const src =
      '<topic><body>\n  <p>keep</p>\n' +
      '  <table><tgroup cols="1">\n    <colspec colname="c1" colnum="1"/>\n' +
      '    <tbody>\n      <row><entry>x</entry></row>\n    </tbody>\n  </tgroup></table>\n</body></topic>';
    expect(() => applyStructuralEdit(src, 'deleteElement', firstId(src, 'row'))).toThrow(/only <row>/);
  });

  test('deleteElement REFUSES a table cell (delete row/column instead)', () => {
    const src =
      '<topic><body>\n' +
      '  <table><tgroup cols="2">\n    <colspec colname="c1" colnum="1"/>\n    <colspec colname="c2" colnum="2"/>\n' +
      '    <tbody>\n      <row><entry>a</entry><entry>b</entry></row>\n    </tbody>\n  </tgroup></table>\n</body></topic>';
    expect(() => applyStructuralEdit(src, 'deleteElement', firstId(src, 'entry'))).toThrow(
      /can't be deleted on its own/,
    );
  });

  test('deleteElement on a non-last <li> removes just that item', () => {
    const src = '<topic><body>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>\n</body></topic>';
    const res = applyStructuralEdit(src, 'deleteElement', firstId(src, 'li'));
    expect(findElements(parse(res.source), 'li').length).toBe(1);
    expect(res.source).toContain('<li>two</li>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });

});

describe('structural: broad Backspace joins', () => {
  test('joins a sole list item into the paragraph immediately before its list wrapper', () => {
    const src = '<topic><body><p>Lead</p><ul><li>Tail</li></ul><ul><li>Keep</li></ul></body></topic>';
    const res = applyStructuralEdit(src, 'join', idsNamed(src, 'li')[0], {
      prevId: idsNamed(src, 'p')[0],
    });
    expect(res.source).toBe('<topic><body><p>LeadTail</p><ul><li>Keep</li></ul></body></topic>');
    expect(res.caretOffset).toBe(4);
  });

  test.each([
    ['list attributes', '<topic><body><p>Lead</p><ul outputclass="keep"><li>Tail</li></ul></body></topic>'],
    ['item attributes', '<topic><body><p>Lead</p><ul><li id="tail">Tail</li></ul></body></topic>'],
    ['wrapper comment', '<topic><body><p>Lead</p><ul><!--audit--><li>Tail</li></ul></body></topic>'],
    ['wrapper processing instruction', '<topic><body><p>Lead</p><ul><?audit keep?><li>Tail</li></ul></body></topic>'],
    ['nested list', '<topic><body><p>Lead</p><ul><li>Tail<ul><li>Nested</li></ul></li></ul></body></topic>'],
  ])('refuses a cross-wrapper join that would discard %s', (_label, src) => {
    const before = serialize(parse(src));
    expect(() => applyStructuralEdit(src, 'join', idsNamed(src, 'li')[0], {
      prevId: idsNamed(src, 'p')[0],
    })).toThrow(/adjacent sibling/);
    expect(serialize(parse(src))).toBe(before);
  });

  test.each([
    ['paragraph into note', '<topic><body><note>A</note><p>B</p></body></topic>', 'p', 'note', '<note>AB</note>'],
    ['note into paragraph', '<topic><body><p>A</p><note>B</note></body></topic>', 'note', 'p', '<p>AB</p>'],
    ['short description into title', '<topic><title>A</title><shortdesc>B</shortdesc><body><p>X</p></body></topic>', 'shortdesc', 'title', '<title>AB</title>'],
    ['lines into lines', '<topic><body><lines>A</lines><lines>B</lines></body></topic>', 'lines', 'lines', '<lines>AB</lines>'],
    ['code block into code block', '<topic><body><codeblock>A</codeblock><codeblock>B</codeblock></body></topic>', 'codeblock', 'codeblock', '<codeblock>AB</codeblock>'],
    ['command into command', '<task><taskbody><steps><step><cmd>A</cmd><cmd>B</cmd></step></steps></taskbody></task>', 'cmd', 'cmd', '<cmd>AB</cmd>'],
  ])('joins compatible direct siblings: %s', (_label, src, currentName, previousName, expected) => {
    const current = idsNamed(src, currentName)[currentName === previousName ? 1 : 0];
    const previous = idsNamed(src, previousName)[0];
    const res = applyStructuralEdit(src, 'join', current, { prevId: previous, merged: 'AB', boundary: 1 });
    expect(res.source).toContain(expected);
    expect(res.caretOffset).toBe(1);
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('removes an empty compatible wrapper through the join path', () => {
    const src = '<topic><body><p>A</p><note></note></body></topic>';
    const res = applyStructuralEdit(src, 'join', idsNamed(src, 'note')[0], {
      prevId: idsNamed(src, 'p')[0], merged: 'A', boundary: 1,
    });
    expect(res.source).toBe('<topic><body><p>A</p></body></topic>');
  });

  test('preserves nested sublists when joining list items', () => {
    const src = '<topic><body><ul><li>A<ul><li>A1</li></ul></li><li>B<ol><li>B1</li></ol></li></ul></body></topic>';
    const listIds = idsNamed(src, 'li');
    const firstLi = listIds[0];
    const secondLi = listIds[2];
    const res = applyStructuralEdit(src, 'join', secondLi, { prevId: firstLi, merged: 'AB', boundary: 1 });
    expect(res.source).toContain('<li>AB<ul><li>A1</li></ul><ol><li>B1</li></ol></li>');
    expect(serialize(parse(res.source))).toBe(res.source);
  });

  test('ignores forged merged text and HTML while joining valid adjacent ids', () => {
    const src = '<topic><body><p>A<b>bold</b></p><note><i>B</i></note></body></topic>';
    const res = applyStructuralEdit(src, 'join', idsNamed(src, 'note')[0], {
      prevId: idsNamed(src, 'p')[0],
      merged: 'FORGED',
      mergedHtml: '<b>FORGED</b>',
      boundary: 999,
    });
    expect(res.source).toBe('<topic><body><p>A<b>bold</b><i>B</i></p></body></topic>');
    expect(res.caretOffset).toBe('Abold'.length);
  });

  test.each([
    ['non-adjacent target', '<topic><body><p>A</p><p>B</p><p>C</p></body></topic>', 'p', 2, 'p', 0],
    ['different parents', '<topic><body><section><p>A</p></section><p>B</p></body></topic>', 'p', 1, 'p', 0],
    ['table cell', '<topic><body><table><tgroup cols="2"><tbody><row><entry>A</entry><entry>B</entry></row></tbody></tgroup></table></body></topic>', 'entry', 1, 'entry', 0],
    ['rich content into plain block', '<topic><body><codeblock>A</codeblock><p><b>B</b></p></body></topic>', 'p', 0, 'codeblock', 0],
  ])('refuses unsafe joins without producing bytes: %s', (_label, src, currentName, currentIndex, previousName, previousIndex) => {
    const current = idsNamed(src, currentName)[currentIndex];
    const previous = idsNamed(src, previousName)[previousIndex];
    expect(() => applyStructuralEdit(src, 'join', current, { prevId: previous, merged: 'AB' })).toThrow();
    expect(serialize(parse(src))).toBe(src);
  });
});
