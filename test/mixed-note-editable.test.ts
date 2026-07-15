// A DITA <note> is mixed content: direct text and phrase markup may coexist with
// normal blocks. Editing the direct prose must never flatten or delete those blocks.

import { describe, expect, test } from 'bun:test';
import { applyTextEdit } from '../src/cst/edit-bridge';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { editableElementIds, mixedEditableParents } from '../src/cst/text-targets';
import { renderEditable } from '../src/render/to-html';
import type { ElementNode } from '../src/cst/types';

function noteRoutes(source: string): { whole: string[]; mixed: string[] } {
  const doc = parse(source);
  return {
    whole: [...editableElementIds(doc)]
      .filter(([el]) => (el as ElementNode).name === 'note')
      .map(([, id]) => id),
    mixed: [...mixedEditableParents(doc)]
      .filter(([el]) => (el as ElementNode).name === 'note')
      .map(([, id]) => id),
  };
}

function mixedNoteId(source: string): string {
  const id = noteRoutes(source).mixed[0];
  if (!id) throw new Error('no mixed editable note');
  return id;
}

describe('mixed note editing', () => {
  test('keeps empty, text-only, and inline-only notes on their safe whole-note edit paths', () => {
    const empty = noteRoutes('<topic><body><note/></body></topic>');
    const text = noteRoutes('<topic><body><note>Direct text</note></body></topic>');
    const inline = noteRoutes('<topic><body><note>Direct <b>styled</b> text</note></body></topic>');

    expect(empty.whole).toHaveLength(1);
    expect(text.whole).toHaveLength(1);
    expect(inline.whole).toHaveLength(1);
    expect(empty.mixed).toHaveLength(0);
    expect(text.mixed).toHaveLength(0);
    expect(inline.mixed).toHaveLength(0);
  });

  test('block-only notes delegate editing to their child blocks', () => {
    const routes = noteRoutes('<topic><body><note><p>Paragraph</p><ul><li>Item</li></ul></note></body></topic>');
    expect(routes.whole).toHaveLength(0);
    expect(routes.mixed).toHaveLength(0);
  });

  test('recognizes direct prose beside every DITA basic block family as mixed note content', () => {
    const blocks = [
      '<audio/>',
      '<dl/>',
      '<div/>',
      '<example/>',
      '<fig/>',
      '<lines/>',
      '<lq/>',
      '<object/>',
      '<ol/>',
      '<p/>',
      '<pre/>',
      '<simpletable/>',
      '<sl/>',
      '<table/>',
      '<ul/>',
      '<video/>',
      '<codeblock/>',
    ];

    for (const block of blocks) {
      const source = `<topic><body><note>Lead ${block} tail</note></body></topic>`;
      expect(noteRoutes(source).mixed, block).toHaveLength(1);
    }
  });

  test('renders each direct text/phrase run as editable while block children remain structural', () => {
    const source =
      '<topic><body><note type="warning">Lead <b>styled</b><ul><li>Item</li></ul> tail</note></body></topic>';
    const id = mixedNoteId(source);
    const html = renderEditable(parse(source));

    expect(html).toContain(`data-edit-id="${id}:t0" data-edit-run`);
    expect(html).toContain(`data-edit-id="${id}:t1" data-edit-run`);
    expect(html).toContain(`data-edit-id="${id}:t3" data-edit-run`);
    expect(html).toContain('data-struct-kind="ul"');
    expect(html).toContain('>Item</li>');
  });

  test('editing note prose preserves a non-text block sibling byte-for-byte', () => {
    const block = '<ul outputclass="keep"><li id="one">Item</li><li>Two</li></ul>';
    const source = `<topic><body><note type="warning">Lead ${block} tail</note></body></topic>`;
    const out = applyTextEdit(source, `${mixedNoteId(source)}:t0`, 'Changed ');

    expect(out).toBe(source.replace('Lead ', 'Changed '));
    expect(out).toContain(block);
    expect(serialize(parse(out))).toBe(out);
  });

  test('text beside an XML comment remains editable without dropping the comment', () => {
    const source = '<topic><body><note>Lead <!-- editorial marker --> tail</note></body></topic>';
    const id = mixedNoteId(source);
    const out = applyTextEdit(source, `${id}:t0`, 'Changed ');

    expect(out).toBe('<topic><body><note>Changed <!-- editorial marker --> tail</note></body></topic>');
  });

  test('inline-styled prose beside a source comment uses the preserving run path', () => {
    const source = '<topic><body><note><b>Lead</b><!-- editorial marker --></note></body></topic>';
    const routes = noteRoutes(source);

    expect(routes.whole).toHaveLength(0);
    expect(routes.mixed).toHaveLength(1);
    expect(applyTextEdit(source, `${routes.mixed[0]}:t0`, 'Changed')).toBe(
      '<topic><body><note><b>Changed</b><!-- editorial marker --></note></body></topic>',
    );
  });
});
