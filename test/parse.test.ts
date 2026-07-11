import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { isElement } from '../src/cst/types';
import { findElement } from '../src/cst/query';

function roundtrip(src: string): string {
  return serialize(parse(src));
}

describe('parse + serialize round-trip (clean = byte-identical)', () => {
  const cases: Record<string, string> = {
    'xml decl + doctype + element':
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
      '<topic id="t1">\n  <title>Hi</title>\n</topic>\n',
    'self-closing with attributes and odd spacing':
      '<topic><image href="images/x.jpeg"   placement="break"/></topic>',
    'single-quoted attributes': "<topic id='a' class='b'><p>x</p></topic>",
    'entities kept verbatim': '<p>Seat model &amp; fleet use &lt;ok&gt;</p>',
    'non-breaking hyphen and dashes': '<p>B777‑300ER – — fine</p>',
    'comment and pi': '<topic><!-- note --><?target body ?><p>x</p></topic>',
    'cdata': '<p><![CDATA[ <not parsed> & ]]></p>',
    'mixed content cell with embedded image':
      '<entry>Weber 5751 – B777‑300ER<image href="images/img_005.jpeg" placement="break"/></entry>',
    'leading whitespace and BOM-like text': '﻿\n<topic/>\n',
    'attribute with > forbidden but & ok in value': '<p data-x="a &amp; b">y</p>',
  };

  for (const [name, src] of Object.entries(cases)) {
    test(name, () => {
      expect(roundtrip(src)).toBe(src);
    });
  }
});

describe('structural correctness', () => {
  test('attributes are decomposed with name/value/quote', () => {
    const doc = parse('<image href="images/x.jpeg" placement="break"/>');
    const img = doc.children.find(isElement)!;
    expect(img.name).toBe('image');
    expect(img.selfClosing).toBe(true);
    expect(img.attrs.map((a) => [a.name, a.value, a.quote])).toEqual([
      ['href', 'images/x.jpeg', '"'],
      ['placement', 'break', '"'],
    ]);
  });

  test('node ranges tile the source with no gaps', () => {
    const src =
      '<topic id="t">\n  <p>a</p>\n  <p>b</p>\n</topic>\n';
    const doc = parse(src);
    // Top-level children tile [0, len).
    let cursor = 0;
    for (const node of doc.children) {
      expect(node.range.start).toBe(cursor);
      cursor = node.range.end;
    }
    expect(cursor).toBe(src.length);
  });

  test('mixed content: text then image element as siblings', () => {
    const doc = parse(
      '<entry>Weber<image href="images/img_005.jpeg" placement="break"/></entry>',
    );
    const entry = findElement(doc, 'entry')!;
    expect(entry.children.map((c) => c.type)).toEqual(['text', 'element']);
    expect((entry.children[0] as { raw: string }).raw).toBe('Weber');
  });

  test('CALS table parses into tgroup/colspec/row/entry', () => {
    const src =
      '<table><tgroup cols="2">' +
      '<colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<thead><row><entry>A</entry><entry>B</entry></row></thead>' +
      '<tbody><row><entry>1</entry><entry>2</entry></row></tbody>' +
      '</tgroup></table>';
    const doc = parse(src);
    const tgroup = findElement(doc, 'tgroup')!;
    expect(tgroup.attrs.find((a) => a.name === 'cols')?.value).toBe('2');
    expect(serialize(doc)).toBe(src);
  });
});
