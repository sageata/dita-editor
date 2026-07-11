import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { editableElementIds, findEditableById, isInlineHtmlEditable, mixedEditableParents } from '../src/cst/text-targets';
import type { ElementNode } from '../src/cst/types';

const SRC =
  '<topic><title>T</title><body>' +
  '<p>para</p>' +
  '<p></p>' + // empty paragraph -> editable
  '<ul><li>one</li><li></li></ul>' + // empty li -> editable
  '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
  '<row><entry>plain</entry></row>' +
  '<row><entry></entry></row>' + // empty entry -> editable
  '<row><entry>txt<image href="i.jpg"/></entry></row>' + // inline-rich entry -> editable
  '</tbody></tgroup></table>' +
  '<lines>one\ntwo</lines>' +
  '<ul><li>parent <ul><li>child</li></ul></li></ul>' +
  '</body></topic>';

describe('editableElementIds', () => {
  test('includes text-only, empty, and inline-rich leaves', () => {
    const names = [...editableElementIds(parse(SRC)).keys()].map((el) => (el as ElementNode).name);
    expect(names).toContain('title');
    expect(names.filter((n) => n === 'p').length).toBe(2); // text + empty
    expect(names.filter((n) => n === 'li').length).toBe(3); // text + empty + nested child
    expect(names.filter((n) => n === 'entry').length).toBe(3); // plain + empty + inline-rich image cell
    expect(names).toContain('lines');
  });

  test('findEditableById resolves to the same element node', () => {
    const doc = parse(SRC);
    const [el, id] = [...editableElementIds(doc).entries()][0];
    expect(findEditableById(doc, id)).toBe(el);
  });

  test('rich inline prose and cells are one editable element, not split into text-run spans', () => {
    const doc = parse(
      '<topic><body><p>a <b>b</b> <xref href="topic.dita#t/x">x</xref></p>' +
        '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row>' +
        '<entry>a<image href="i.jpg"/>b</entry>' +
        '</row></tbody></tgroup></table></body></topic>',
    );
    const editable = [...editableElementIds(doc).keys()];
    expect(editable.map((el) => (el as ElementNode).name)).toEqual(['p', 'entry']);
    expect(isInlineHtmlEditable(editable[0] as ElementNode)).toBe(true);
    expect(isInlineHtmlEditable(editable[1] as ElementNode)).toBe(true);
    expect(mixedEditableParents(doc).size).toBe(0);
  });
});

describe('mixedEditableParents', () => {
  test('captures block-mixed list items, excludes inline-rich/text-only/empty/image-only cells', () => {
    const m = mixedEditableParents(parse(SRC));
    expect([...m.keys()].map((el) => (el as ElementNode).name)).toEqual(['li']);
  });

  test('an image-only cell (no text run) is NOT mixed-editable', () => {
    const doc = parse(
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry><image href="i.jpg"/></entry></row>' +
        '</tbody></tgroup></table></body></topic>',
    );
    expect(mixedEditableParents(doc).size).toBe(0);
  });
});
