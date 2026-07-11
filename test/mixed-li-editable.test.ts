// A <li> whose text coexists with a nested <ul>/<ol> (created by indenting an item) is NOT
// whole-element editable — setElementText would destroy the sublist. Instead, each
// non-whitespace direct text run becomes its own editable `:t` span, edited via
// setText so the nested list is preserved verbatim. Regression for "I can't click back and
// keep editing a nested list item".

import { test, expect, describe } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { editableElementIds, mixedEditableParents } from '../src/cst/text-targets';
import { applyTextEdit } from '../src/cst/edit-bridge';
import { applyInlineFormat, removeInlineFormat } from '../src/cst/inline-edit';
import { renderEditable } from '../src/render/to-html';
import { assignElementIds } from '../src/cst/element-ids';
import type { ElementNode } from '../src/cst/types';

const SRC = '<topic><body><ul><li>Top<ul><li>Inner</li></ul></li></ul></body></topic>';
const STYLED_SRC = '<topic><body><ul><li><b>Top</b><ul><li>Inner</li></ul></li></ul></body></topic>';

function firstText(el: ElementNode): string {
  const t = el.children[0];
  return t && t.type === 'text' ? t.raw.trim() : '';
}
function liId(src: string, text: string): string {
  for (const [el, id] of assignElementIds(parse(src))) {
    const e = el as ElementNode;
    if (e.name === 'li' && firstText(e) === text) return id;
  }
  throw new Error(`no <li> "${text}"`);
}
function firstMixedId(src: string): string {
  const first = [...mixedEditableParents(parse(src)).entries()][0];
  if (!first) throw new Error('no mixed editable parent');
  return first[1];
}

describe('mixed list item editing (text + nested list)', () => {
  test('a <li> with a nested list is NOT whole-element editable, but IS a mixed text-run parent', () => {
    const doc = parse(SRC);
    const editable = [...editableElementIds(doc).keys()].map((e) => firstText(e as ElementNode));
    const mixed = [...mixedEditableParents(doc).keys()].map((e) => firstText(e as ElementNode));
    expect(editable).toContain('Inner'); // a text-only nested item is whole-element editable
    expect(editable).not.toContain('Top'); // the parent (has a sublist) is NOT
    expect(mixed).toContain('Top'); // ...its own text is editable as a run instead
  });

  test('renders the parent item’s text as an editable run span, nested list intact', () => {
    const html = renderEditable(parse(SRC));
    const id = liId(SRC, 'Top');
    expect(html).toContain('data-edit-run');
    expect(html).toContain(`data-edit-id="${id}:t0"`); // the "Top" text run
    expect(html).toContain('>Top<'); // text rendered inside the editable span
    expect(html).toContain('>Inner</li>'); // the nested item still renders (and is editable)
  });

  test('editing the parent item’s text run preserves the nested list (byte round-trip)', () => {
    const id = liId(SRC, 'Top');
    const out = applyTextEdit(SRC, `${id}:t0`, 'Top edited');
    expect(out).toContain('Top edited');
    expect(out).toContain('<ul><li>Inner</li></ul>'); // nested list preserved verbatim
    expect(serialize(parse(out))).toBe(out);
  });

  test('a styled parent item stays editable after its direct text run is wrapped', () => {
    const id = firstMixedId(STYLED_SRC);
    const html = renderEditable(parse(STYLED_SRC));

    expect(html).toContain(`<strong class="ph b" contenteditable="true" data-edit-id="${id}:t0" data-edit-run`);
    expect(html).toContain('>Top</strong>');
    expect(html).toContain('>Inner</li>');
  });

  test('editing a styled parent item run preserves the style and nested list', () => {
    const id = firstMixedId(STYLED_SRC);
    const out = applyTextEdit(STYLED_SRC, `${id}:t0`, 'Top edited');

    expect(out).toContain('<li><b>Top edited</b><ul><li>Inner</li></ul></li>');
    expect(serialize(parse(out))).toBe(out);
  });

  test('formatting inside an already-styled parent item run keeps the outer style and nested list', () => {
    const id = firstMixedId(STYLED_SRC);
    const out = applyInlineFormat(STYLED_SRC, `${id}:t0`, 'i', 'Top ', 'edited', '');

    expect(out).toContain('<li><b>Top <i>edited</i></b><ul><li>Inner</li></ul></li>');
    expect(serialize(parse(out))).toBe(out);
  });

  test('a doubly-styled parent item run remains editable and autofocusable', () => {
    const id = firstMixedId(STYLED_SRC);
    const out = applyInlineFormat(STYLED_SRC, `${id}:t0`, 'i', 'Top ', 'edited', '');
    const html = renderEditable(parse(out), `${id}:t0`);

    expect([...mixedEditableParents(parse(out)).values()]).toContain(id);
    expect(html).toContain(`<strong class="ph b" contenteditable="true" data-edit-id="${id}:t0" data-edit-run spellcheck="false" data-inline-html="true" data-autofocus="true">`);
    expect(html).toContain('<em class="ph i">edited</em>');
    expect(html).toContain('>Inner</li>');
  });

  test('clearing styles from a styled parent item run unwraps the phrase and keeps the nested list', () => {
    const id = firstMixedId(STYLED_SRC);
    const out = removeInlineFormat(STYLED_SRC, `${id}:t0`, '', 'Top', '');

    expect(out).toContain('<li>Top<ul><li>Inner</li></ul></li>');
    expect(serialize(parse(out))).toBe(out);
  });

  test('clearing part of a styled parent item run preserves style around the cleared text', () => {
    const id = firstMixedId(STYLED_SRC);
    const out = removeInlineFormat(STYLED_SRC, `${id}:t0`, 'T', 'o', 'p');

    expect(out).toContain('<li><b>T</b>o<b>p</b><ul><li>Inner</li></ul></li>');
    expect(serialize(parse(out))).toBe(out);
  });

  test('a plain text-only <li> stays whole-element editable (no regression)', () => {
    const doc = parse('<topic><body><ul><li>one</li><li>two</li></ul></body></topic>');
    const editable = [...editableElementIds(doc).keys()].map((e) => firstText(e as ElementNode));
    expect(editable).toEqual(expect.arrayContaining(['one', 'two']));
  });
});
