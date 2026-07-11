import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import {
  applyInlineFormat,
  applyInlineInsert,
  applyInlineFormatBlocks,
  removeInlineFormat,
  removeInlineFormatBlocks,
} from '../src/cst/inline-edit';
import { editableElementIds, mixedEditableParents } from '../src/cst/text-targets';
import { assignElementIds } from '../src/cst/element-ids';
import type { ElementNode } from '../src/cst/types';

/** The struct/element ids (e{N}) of every element named `name`, in document order. */
function elIds(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) out.push(id);
  }
  return out;
}

/** The edit id of the first editable text-only leaf named `name`. */
function editId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of editableElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no editable <${name}>`);
}

/** The id of the first mixed text+element leaf named `name` (its runs are `${id}:t<idx>`). */
function mixedId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of mixedEditableParents(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no mixed <${name}>`);
}

const TOPIC = (body: string) =>
  `<topic id="t"><title>T</title><body>${body}</body></topic>`;

describe('applyInlineFormat — wrap a selection in a phrase element', () => {
  test('wraps a word in the middle of a plain paragraph', () => {
    const src = TOPIC('<p>foo bar baz</p>');
    const out = applyInlineFormat(src, editId(src, 'p'), 'b', 'foo ', 'bar', ' baz');
    expect(out).toContain('<p>foo <b>bar</b> baz</p>');
  });

  test('wraps at the start (empty before)', () => {
    const src = TOPIC('<p>foo bar</p>');
    const out = applyInlineFormat(src, editId(src, 'p'), 'i', '', 'foo', ' bar');
    expect(out).toContain('<p><i>foo</i> bar</p>');
  });

  test('wraps at the end (empty after)', () => {
    const src = TOPIC('<p>foo bar</p>');
    const out = applyInlineFormat(src, editId(src, 'p'), 'sup', 'foo ', 'bar', '');
    expect(out).toContain('<p>foo <sup>bar</sup></p>');
  });

  test('each format op emits its own element', () => {
    for (const op of ['b', 'i', 'u', 'line-through', 'codeph', 'sub', 'sup']) {
      const src = TOPIC('<p>x y z</p>');
      const out = applyInlineFormat(src, editId(src, 'p'), op, 'x ', 'y', ' z');
      expect(out).toContain(`<${op}>y</${op}>`);
    }
  });

  test('the rest of the document is byte-for-byte preserved', () => {
    const src = TOPIC('<p>keep me</p>\n<p>foo bar baz</p>');
    // Target the SECOND paragraph.
    const doc = parse(src);
    let secondId = '';
    let seen = 0;
    for (const [el, id] of editableElementIds(doc)) {
      if ((el as ElementNode).name === 'p') {
        seen++;
        if (seen === 2) secondId = id;
      }
    }
    const out = applyInlineFormat(src, secondId, 'b', 'foo ', 'bar', ' baz');
    expect(out).toContain('<p>keep me</p>'); // untouched paragraph unchanged
    expect(out).toContain('<title>T</title>');
    expect(out).toContain('<p>foo <b>bar</b> baz</p>');
  });
});

describe('applyInlineFormat — mixed leaf (run-targeted), siblings preserved', () => {
  test('wrapping a run inside a <li> with a nested list keeps the list verbatim', () => {
    const src = TOPIC('<ul><li>Do this <ul><li>sub</li></ul></li></ul>');
    const lid = mixedId(src, 'li'); // the OUTER li (it has text + nested ul)
    const out = applyInlineFormat(src, `${lid}:t0`, 'b', 'Do ', 'this', ' ');
    expect(out).toContain('<b>this</b>');
    expect(out).toContain('<ul><li>sub</li></ul>'); // nested list untouched
  });
});

describe('applyInlineInsert — drop a self-contained inline element at the caret', () => {
  test('inserts a self-closing empty <image> at the caret', () => {
    const src = TOPIC('<p>foobar</p>');
    const out = applyInlineInsert(src, editId(src, 'p'), 'foo', 'bar', {
      name: 'image',
      attrs: [{ name: 'href', value: '' }],
      selfClosing: true,
    });
    expect(out).toContain('<p>foo<image href=""/>bar</p>');
  });

  test('inserts an <xref> with href + label', () => {
    const src = TOPIC('<p>see  here</p>');
    const out = applyInlineInsert(src, editId(src, 'p'), 'see ', ' here', {
      name: 'xref',
      attrs: [{ name: 'href', value: 'topic.dita#t/x' }],
      innerText: 'the section',
    });
    expect(out).toContain('<xref href="topic.dita#t/x">the section</xref>');
  });

  test('inserts a conref\'d <ph> (self-closing) and preserves surrounding text', () => {
    const src = TOPIC('<p>ab</p>');
    const out = applyInlineInsert(src, editId(src, 'p'), 'a', 'b', {
      name: 'ph',
      attrs: [{ name: 'conref', value: 'warn.dita#w/e' }],
      selfClosing: true,
    });
    expect(out).toContain('<p>a<ph conref="warn.dita#w/e"/>b</p>');
  });

  test('inserting into a mixed run keeps sibling elements verbatim', () => {
    const src = TOPIC('<ul><li>Do this <ul><li>sub</li></ul></li></ul>');
    const lid = mixedId(src, 'li');
    const out = applyInlineInsert(src, `${lid}:t0`, 'Do this ', '', {
      name: 'image',
      attrs: [{ name: 'href', value: '' }],
      selfClosing: true,
    });
    expect(out).toContain('<image href=""/>');
    expect(out).toContain('<ul><li>sub</li></ul>'); // nested list untouched
  });

  test('inserting into a rich inline block preserves existing marks', () => {
    const src = TOPIC('<p>a <b>b</b> c</p>');
    const out = applyInlineInsert(src, elIds(src, 'p')[0], 'a ', 'b c', {
      name: 'image',
      attrs: [{ name: 'href', value: '' }],
      selfClosing: true,
    });
    expect(out).toContain('<p>a <image href=""/><b>b</b> c</p>');
  });
});

describe('applyInlineFormatBlocks — format a multi-element selection', () => {
  test('bolds the text of every selected list item', () => {
    const src = TOPIC('<ul><li>one</li><li>two</li><li>three</li></ul>');
    const ids = elIds(src, 'li');
    const out = applyInlineFormatBlocks(src, ids, 'b');
    expect(out).toContain('<li><b>one</b></li>');
    expect(out).toContain('<li><b>two</b></li>');
    expect(out).toContain('<li><b>three</b></li>');
  });

  test('only the selected subset is wrapped', () => {
    const src = TOPIC('<ul><li>one</li><li>two</li></ul>');
    const ids = elIds(src, 'li');
    const out = applyInlineFormatBlocks(src, [ids[1]], 'i'); // only the second li
    expect(out).toContain('<li>one</li>'); // untouched
    expect(out).toContain('<li><i>two</i></li>');
  });

  test('a mixed block wraps its text run but leaves a nested list verbatim', () => {
    const src = TOPIC('<ul><li>parent <ul><li>kid</li></ul></li></ul>');
    const outerLi = elIds(src, 'li')[0];
    const out = applyInlineFormatBlocks(src, [outerLi], 'b');
    expect(out).toContain('<b>parent </b>');
    expect(out).toContain('<ul><li>kid</li></ul>'); // nested list untouched
  });

  test('preserves entities (no double-encoding)', () => {
    const src = TOPIC('<ul><li>a &amp; b</li></ul>');
    const out = applyInlineFormatBlocks(src, elIds(src, 'li'), 'b');
    expect(out).toContain('<li><b>a &amp; b</b></li>');
  });

  test('a block with no direct text (the <ul>) is skipped — no change', () => {
    const src = TOPIC('<ul><li>one</li></ul>');
    const ulId = elIds(src, 'ul')[0];
    expect(applyInlineFormatBlocks(src, [ulId], 'b')).toBe(src);
  });

  test('re-applying TOGGLES off — bolding then bolding again removes the <b> (round-trip)', () => {
    const src = TOPIC('<ul><li>one</li><li>two</li></ul>');
    const ids = elIds(src, 'li');
    const once = applyInlineFormatBlocks(src, ids, 'b'); // bold both
    expect(once).toContain('<li><b>one</b></li>');
    const twice = applyInlineFormatBlocks(once, elIds(once, 'li'), 'b'); // toggle off
    expect(twice).toBe(src); // back to the original, byte-for-byte
  });

  test('unwraps a fully-bold selection (toggle off)', () => {
    const src = TOPIC('<ul><li><b>done</b></li></ul>');
    const out = applyInlineFormatBlocks(src, elIds(src, 'li'), 'b');
    expect(out).toContain('<li>done</li>');
    expect(out).not.toContain('<b>');
  });

  test('a mixed selection (some bold, some not) wraps ALL (first press makes uniform)', () => {
    const src = TOPIC('<ul><li><b>bold</b></li><li>plain</li></ul>');
    const out = applyInlineFormatBlocks(src, elIds(src, 'li'), 'b');
    expect(out).toContain('<li><b>bold</b></li>'); // already-bold stays single-bold (no double-wrap)
    expect(out).toContain('<li><b>plain</b></li>'); // the plain one becomes bold
  });

  test('unknown op throws', () => {
    const src = TOPIC('<ul><li>one</li></ul>');
    expect(() => applyInlineFormatBlocks(src, elIds(src, 'li'), 'blink')).toThrow();
  });
});

describe('applyInlineFormat — guards', () => {
  test('empty selection is a no-op (source unchanged)', () => {
    const src = TOPIC('<p>foo bar</p>');
    expect(applyInlineFormat(src, editId(src, 'p'), 'b', 'foo bar', '', '')).toBe(src);
  });

  test('unknown op throws', () => {
    const src = TOPIC('<p>foo</p>');
    expect(() => applyInlineFormat(src, editId(src, 'p'), 'blink', '', 'foo', '')).toThrow();
  });

  test('unresolved id throws', () => {
    const src = TOPIC('<p>foo</p>');
    expect(() => applyInlineFormat(src, 'e999', 'b', '', 'foo', '')).toThrow();
  });
});

describe('removeInlineFormat — strip highlighting marks', () => {
  test('removes all styles from an exact text range', () => {
    const src = TOPIC('<p><b>foobar</b></p>');
    const out = removeInlineFormat(src, elIds(src, 'p')[0], 'f', 'oob', 'ar');
    expect(out).toContain('<p><b>f</b>oob<b>ar</b></p>');
  });

  test('removes styles across selected blocks and keeps inline atoms', () => {
    const src = TOPIC(
      '<p><b>see <xref href="topic.dita#t/x">label</xref> now</b></p><p><i>next</i></p>',
    );
    const out = removeInlineFormatBlocks(src, elIds(src, 'p'));
    expect(out).toContain('<p>see <xref href="topic.dita#t/x">label</xref> now</p>');
    expect(out).toContain('<p>next</p>');
  });

  test('mixed list items only unwrap direct highlight wrappers and preserve nested lists', () => {
    const src = TOPIC('<ul><li><b>parent </b><ul><li><i>kid</i></li></ul></li></ul>');
    const out = removeInlineFormatBlocks(src, [elIds(src, 'li')[0]]);
    expect(out).toContain('<li>parent <ul><li><i>kid</i></li></ul></li>');
  });

  test('unstyled blocks are no-ops and preserve numeric entity spelling', () => {
    const src = TOPIC('<p>A &#38; B</p>');
    expect(removeInlineFormatBlocks(src, elIds(src, 'p'))).toBe(src);
  });
});
