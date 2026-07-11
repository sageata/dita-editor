import { describe, expect, test } from 'bun:test';
import { applyInlineHtmlEdit, applyTextEdit, minimalEdit } from '../src/cst/edit-bridge';
import { parse } from '../src/cst/parse';
import { editableElementIds, mixedEditableParents } from '../src/cst/text-targets';
import type { ElementNode } from '../src/cst/types';

function editId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of editableElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no editable <${name}>`);
}

describe('minimalEdit (smallest single-span diff)', () => {
  test('identical -> null', () => expect(minimalEdit('abc', 'abc')).toBeNull());
  test('middle replacement', () => expect(minimalEdit('hello world', 'hello there')).toEqual({ start: 6, end: 11, text: 'there' }));
  test('pure insertion', () => expect(minimalEdit('ac', 'abc')).toEqual({ start: 1, end: 1, text: 'b' }));
  test('pure deletion', () => expect(minimalEdit('abc', 'ac')).toEqual({ start: 1, end: 2, text: '' }));
  test('suffix replacement', () => expect(minimalEdit('test123', 'test456')).toEqual({ start: 4, end: 7, text: '456' }));

  test('span reconstructs the new string', () => {
    const a = '<p class="p">Hello</p>';
    const b = '<p class="p">Goodbye</p>';
    const span = minimalEdit(a, b)!;
    expect(a.slice(0, span.start) + span.text + a.slice(span.end)).toBe(b);
  });
});

describe('applyTextEdit', () => {
  const SRC =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
    '<topic id="t"><title>Old &amp; Title</title><body><p>Hello</p></body></topic>\n';

  test('edits the targeted leaf, escapes entities, leaves everything else byte-exact', () => {
    const out = applyTextEdit(SRC, editId(SRC, 'p'), 'Hi & bye');

    expect(out).toContain('<p>Hi &amp; bye</p>');
    expect(out).toContain('<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">');
    expect(out).toContain('<title>Old &amp; Title</title>'); // untouched

    const span = minimalEdit(SRC, out)!;
    expect(SRC.slice(0, span.start) + span.text + SRC.slice(span.end)).toBe(out);
  });

  test('fills an EMPTY editable element with text (new rows/items are typeable)', () => {
    const src = '<topic><body><p></p></body></topic>';
    const out = applyTextEdit(src, editId(src, 'p'), 'new text');
    expect(out).toContain('<p>new text</p>');
  });

  test('edits a <lines> block with multiline text', () => {
    const src = '<topic><body><lines>old</lines></body></topic>';
    const out = applyTextEdit(src, editId(src, 'lines'), 'First\nSecond & third');
    expect(out).toBe('<topic><body><lines>First\nSecond &amp; third</lines></body></topic>');
  });

  test('clearing an element canonicalizes it to the self-closing empty form', () => {
    const src = '<topic><body><p>x</p></body></topic>';
    const out = applyTextEdit(src, editId(src, 'p'), '');
    expect(out).toContain('<p/>'); // corpus convention for empties; type-then-clear is byte-clean
  });

  // Regression: the corpus stores empty cells as SELF-CLOSING <entry/>. Typing into one
  // must promote it to <entry>text</entry>; the old serializer dropped the text silently.
  test('fills a SELF-CLOSING empty element (corpus <entry/> cells are typeable)', () => {
    const src =
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
      '<tbody><row><entry/></row></tbody></tgroup></table></body></topic>';
    const out = applyTextEdit(src, editId(src, 'entry'), 'typed');
    expect(out).toContain('<entry>typed</entry>');
    expect(out).not.toContain('<entry/>'); // promoted, not left self-closing with lost text
  });

  test('a self-closing empty element cleared again returns to <entry/> (no spurious diff)', () => {
    const src =
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
      '<tbody><row><entry/></row></tbody></tgroup></table></body></topic>';
    expect(applyTextEdit(src, editId(src, 'entry'), '')).toBe(src); // empty stays self-closing
  });

  // The REAL runtime sequence (the earlier test above only cleared the original directly):
  // typing first PERSISTS the cell as paired <entry>X</entry>, so the clear operates on the
  // paired form. It must still canonicalize back to <entry/> -> a net-zero edit is byte-clean.
  test('type then clear a self-closing cell round-trips to the original bytes', () => {
    const src =
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
      '<tbody><row><entry/></row></tbody></tgroup></table></body></topic>';
    const filled = applyTextEdit(src, editId(src, 'entry'), 'X');
    expect(filled).toContain('<entry>X</entry>'); // promoted to paired on type
    const cleared = applyTextEdit(filled, editId(filled, 'entry'), '');
    expect(cleared).toBe(src); // back to <entry/>, byte-identical to the original
  });

  test('throws when the edit id no longer resolves', () => {
    expect(() => applyTextEdit(SRC, 'e999', 'x')).toThrow();
  });
});

describe('applyTextEdit on a block-mixed list item (text-run id)', () => {
  const SRC = '<topic><body><ul><li>Parent <ul><li>Child</li></ul></li></ul></body></topic>';

  // Build the `<parentId>:t<index>` id for the first non-whitespace text run.
  function runId(src: string): string {
    const doc = parse(src);
    const [item, id] = [...mixedEditableParents(doc).entries()][0];
    const idx = item.children.findIndex((c) => c.type === 'text' && c.raw.trim() !== '');
    return `${id}:t${idx}`;
  }

  test('edits only the text run; the nested list is byte-identical', () => {
    const out = applyTextEdit(SRC, runId(SRC), 'Parent edited ');
    expect(out).toContain('<li>Parent edited <ul><li>Child</li></ul></li>');
    expect(out).toBe(SRC.replace('Parent ', 'Parent edited '));
  });

  test('re-escapes entities typed into the run', () => {
    const out = applyTextEdit(SRC, runId(SRC), 'A & B ');
    expect(out).toContain('<li>A &amp; B <ul><li>Child</li></ul></li>');
  });

  test('throws when the run index no longer resolves', () => {
    const id = [...mixedEditableParents(parse(SRC)).values()][0];
    expect(() => applyTextEdit(SRC, `${id}:t9`, 'x')).toThrow();
  });
});

describe('applyInlineHtmlEdit', () => {
  function richPhraseRunId(src: string): string {
    const doc = parse(src);
    const [item, id] = [...mixedEditableParents(doc).entries()][0];
    const idx = item.children.findIndex((c) => c.type === 'element' && c.name === 'b');
    return `${id}:t${idx}`;
  }

  test('commits rich inline HTML back to DITA inline CST', () => {
    const src = '<topic><body><p>a <b>b</b> <xref href="topic.dita#t/x">x</xref></p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      'a <strong class="ph b">B</strong> <a class="xref" data-dita="xref" data-href="topic.dita#t/x">x</a>',
    );
    expect(out).toBe('<topic><body><p>a <b>B</b> <xref href="topic.dita#t/x">x</xref></p></body></topic>');
  });

  test('commits a rich mixed-list phrase run without dropping the nested list', () => {
    const src = '<topic><body><ul><li><b>Parent <i>old</i></b><ul><li>Child</li></ul></li></ul></body></topic>';
    const out = applyInlineHtmlEdit(src, richPhraseRunId(src), 'Parent <em class="ph i">new</em>');

    expect(out).toBe(
      '<topic><body><ul><li><b>Parent <i>new</i></b><ul><li>Child</li></ul></li></ul></body></topic>',
    );
  });

  test('commits underlined HTML back to DITA underline markup', () => {
    const src = '<topic><body><p>a <u>u</u></p></body></topic>';
    const out = applyInlineHtmlEdit(src, editId(src, 'p'), 'a <u class="ph u">U</u>');
    expect(out).toBe('<topic><body><p>a <u>U</u></p></body></topic>');
  });

  test('commits strikethrough HTML back to DITA line-through markup', () => {
    const src = '<topic><body><p>a <line-through>s</line-through></p></body></topic>';
    const out = applyInlineHtmlEdit(src, editId(src, 'p'), 'a <s class="ph line-through">S</s>');
    expect(out).toBe('<topic><body><p>a <line-through>S</line-through></p></body></topic>');
  });

  test('commits pasted CSS styling spans back to DITA inline marks', () => {
    const src = '<topic><body><p>old</p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      [
        '<span style="font-weight:700">B</span>',
        '<span style="font-style:italic">I</span>',
        '<span style="text-decoration: underline">U</span>',
        '<span style="text-decoration-line: line-through">S</span>',
        '<span style="vertical-align: super">2</span>',
        '<span style="vertical-align: sub">2</span>',
        '<span style="font-weight:bold; text-decoration:underline">BU</span>',
      ].join(' '),
    );
    expect(out).toBe(
      '<topic><body><p><b>B</b> <i>I</i> <u>U</u> <line-through>S</line-through> ' +
        '<sup>2</sup> <sub>2</sub> <b><u>BU</u></b></p></body></topic>',
    );
  });

  test('keeps pasted HTML block boundaries as line breaks in an inline target', () => {
    const src = '<topic><body><p>old</p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      '<p>First</p><p><strong>Second</strong></p><div>Third</div>',
    );
    expect(out).toBe('<topic><body><p>First\n<b>Second</b>\nThird</p></body></topic>');
  });

  test('round-trips image and conref atoms from renderer data attributes', () => {
    const src = '<topic><body><p>before <image href="i.jpg"/><ph conref="warn.dita#w/e"/> after</p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      'before <img class="image" src="i.jpg?v=TOKEN" data-dita="image" data-href="i.jpg"><span class="ph conref-ref" data-dita="ph" data-conref="warn.dita#w/e">ignored label</span> after',
    );
    expect(out).toBe('<topic><body><p>before <image href="i.jpg"/><ph conref="warn.dita#w/e"/> after</p></body></topic>');
  });

  test('sanitizes unknown pasted markup to supported inline content', () => {
    const src = '<topic><body><p>old</p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      '<span style="color:red">new</span><script> text</script><code class="ph codeph">&lt;x&gt;</code>',
    );
    expect(out).toBe('<topic><body><p>new text<codeph>&lt;x&gt;</codeph></p></body></topic>');
  });

  test('preserves raw escaped atom attributes and re-escapes edited text', () => {
    const src = '<topic><body><p><xref href="a&amp;b.dita#t/x">A &amp; B</xref></p></body></topic>';
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'p'),
      '<a class="xref" data-dita="xref" data-href="a&amp;b.dita#t/x">A &amp; C</a>',
    );
    expect(out).toBe('<topic><body><p><xref href="a&amp;b.dita#t/x">A &amp; C</xref></p></body></topic>');
  });

  test('commits inline-rich table entry HTML without dropping images', () => {
    const src =
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
      '<row><entry>Label <image href="seat.jpg" placement="break"/> tail</entry></row>' +
      '</tbody></tgroup></table></body></topic>';
    const attrs = encodeURIComponent(JSON.stringify([
      { name: 'href', value: 'seat.jpg' },
      { name: 'placement', value: 'break' },
    ]));
    const out = applyInlineHtmlEdit(
      src,
      editId(src, 'entry'),
      `Seat 1A <img class="image" src="seat.jpg" data-dita="image" data-href="seat.jpg" data-attrs="${attrs}"> tail`,
    );
    expect(out).toBe(
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry>Seat 1A <image href="seat.jpg" placement="break"/> tail</entry></row>' +
        '</tbody></tgroup></table></body></topic>',
    );
  });
});
