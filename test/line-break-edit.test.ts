import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { applyLineBreakEdit } from '../src/cst/line-break-edit';
import { parse } from '../src/cst/parse';

function idOf(source: string, name: string, text?: string): string {
  const doc = parse(source);
  const ids = assignElementIds(doc);
  for (const [el, id] of ids) {
    if (el.name !== name) continue;
    if (text !== undefined) {
      const actual = el.children.map((c) => (c.type === 'text' ? c.raw : '')).join('').trim();
      if (actual !== text) continue;
    }
    return id;
  }
  throw new Error(`no <${name}>`);
}

describe('applyLineBreakEdit', () => {
  test('Shift+Enter in a paragraph converts it to a semantic lines block', () => {
    const src = '<body><p>Hello tail</p></body>';
    const id = idOf(src, 'p', 'Hello tail');

    const out = applyLineBreakEdit(src, id, 'Hello\ntail');

    expect(out.source).toBe('<body><lines>Hello\ntail</lines></body>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });

  test('Shift+Enter in a table cell wraps the text in lines without replacing the entry', () => {
    const src = '<body><table><tgroup cols="1"><tbody><row><entry>Cell text</entry></row></tbody></tgroup></table></body>';
    const id = idOf(src, 'entry', 'Cell text');

    const out = applyLineBreakEdit(src, id, 'Cell\ntext');

    expect(out.source).toContain('<entry><lines>Cell\ntext</lines></entry>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(5);
  });

  test('Shift+Enter inside an existing lines block stays a text edit', () => {
    const src = '<body><lines>First line</lines></body>';
    const id = idOf(src, 'lines', 'First line');

    const out = applyLineBreakEdit(src, id, 'First\nline');

    expect(out.source).toBe('<body><lines>First\nline</lines></body>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });

  test('Shift+Enter in direct note prose wraps that prose in lines inside the note', () => {
    const src = '<body><note type="warning">First second</note></body>';
    const id = idOf(src, 'note', 'First second');

    const out = applyLineBreakEdit(src, id, 'First\nsecond');

    expect(out.source).toBe('<body><note type="warning"><lines>First\nsecond</lines></note></body>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });

  test('Shift+Enter in one mixed-note text run preserves the note sibling blocks', () => {
    const list = '<ul outputclass="keep"><li id="existing">Existing</li></ul>';
    const src = `<body><note>First second${list}Tail</note></body>`;
    const noteId = idOf(src, 'note');

    const out = applyLineBreakEdit(src, `${noteId}:t0`, 'First\nsecond');

    expect(out.source).toBe(`<body><note><lines>First\nsecond</lines>${list}Tail</note></body>`);
    expect(out.source).toContain(list);
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });

  test('Shift+Enter changes only the selected run in a note with several existing elements', () => {
    const paragraph = '<p id="keep-p">Existing paragraph</p>';
    const list = '<ul outputclass="keep"><li id="keep-li">Existing item</li></ul>';
    const table = '<table id="keep-table"><tgroup cols="1"><tbody><row><entry>Existing cell</entry></row></tbody></tgroup></table>';
    const src = `<body><note>Lead ${paragraph}${list}${table}Tail text</note></body>`;
    const noteId = idOf(src, 'note');

    const out = applyLineBreakEdit(src, `${noteId}:t4`, 'Tail\ntext');

    expect(out.source).toBe(
      `<body><note>Lead ${paragraph}${list}${table}<lines>Tail\ntext</lines></note></body>`,
    );
    expect(out.source).toContain(paragraph);
    expect(out.source).toContain(list);
    expect(out.source).toContain(table);
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
  });

  test('Shift+Enter in a paragraph nested in a multi-element note changes only that paragraph', () => {
    const list = '<ul outputclass="keep"><li id="keep-li">Existing item</li></ul>';
    const src = `<body><note><p>First second</p>${list}<p id="keep-p">Keep me</p></note></body>`;
    const paragraphId = idOf(src, 'p', 'First second');

    const out = applyLineBreakEdit(src, paragraphId, 'First\nsecond');

    expect(out.source).toBe(
      `<body><note><lines>First\nsecond</lines>${list}<p id="keep-p">Keep me</p></note></body>`,
    );
    expect(out.source).toContain(list);
    expect(out.source).toContain('<p id="keep-p">Keep me</p>');
  });

  test('Shift+Enter preserves inline formatting already applied inside a direct note', () => {
    const src = '<body><note>Lead <b>bold</b> tail</note></body>';
    const noteId = idOf(src, 'note');

    const out = applyLineBreakEdit(
      src,
      noteId,
      'Lead bold\n tail',
      10,
      'Lead <strong>bold</strong>\n tail',
    );

    expect(out.source).toBe('<body><note><lines>Lead <b>bold</b>\n tail</lines></note></body>');
  });
});
