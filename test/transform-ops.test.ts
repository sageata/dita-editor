// Slice γ — pure transform-ops planning layer. Tests parse REAL DITA with the
// production parser and address elements by their real e{N} ids (via Slice B's
// indexDocument). No mock UI data; no document is mutated (a byte-safety test
// asserts serialize(doc) === source after planning).

import { test, expect, describe } from 'bun:test';
import { serialize } from '../src/cst/serialize';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { planTransform, availableTransforms } from '../src/commands/transform-ops';

/** Real e{N} id of the first element matching name (+ optional trimmed text). */
function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (
      text !== undefined &&
      el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text
    ) {
      continue;
    }
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

const UL = '<body><ul><li>a</li><li>b</li></ul></body>';
const OL = '<body><ol><li>a</li><li>b</li></ol></body>';
const ALPHA_OL = '<body><ol outputclass="lower-alpha"><li>a</li><li>b</li></ol></body>';

describe('ul ↔ ol list-kind transform', () => {
  test('ul → toOrderedList yields a rename intent (ul→ol), target = the list id', () => {
    const idx = indexDocument(UL);
    const r = planTransform('toOrderedList', { id: idOf(idx, 'ul') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.transform).toBe('toOrderedList');
    if (r.transform !== 'toOrderedList') return;
    expect(r.from).toBe('ul');
    expect(r.to).toBe('ol');
    expect(r.targetId).toBe(idOf(idx, 'ul'));
  });

  test('ul → toUnorderedList is a safe no-op (already unordered)', () => {
    const idx = indexDocument(UL);
    const r = planTransform('toUnorderedList', { id: idOf(idx, 'ul') }, idx);
    expect(r.status).toBe('noop');
    if (r.status !== 'noop') return;
    expect(r.reason).toMatch(/already unordered/i);
  });

  test('ol → toOrderedList is a safe no-op (already ordered)', () => {
    const idx = indexDocument(OL);
    const r = planTransform('toOrderedList', { id: idOf(idx, 'ol') }, idx);
    expect(r.status).toBe('noop');
  });

  test('ul → toAlphabeticList yields an alpha ordered-list intent', () => {
    const idx = indexDocument(UL);
    const r = planTransform('toAlphabeticList', { id: idOf(idx, 'ul') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'toAlphabeticList') return;
    expect(r.to).toBe('ol');
    expect(r.listStyle).toBe('alpha');
  });

  test('alphabetic ol → toOrderedList removes the alpha style instead of no-oping', () => {
    const idx = indexDocument(ALPHA_OL);
    const r = planTransform('toOrderedList', { id: idOf(idx, 'ol') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'toOrderedList') return;
    expect(r.to).toBe('ol');
    expect(r.listStyle).toBe('ordered');
  });

  test('alphabetic ol → toAlphabeticList is a safe no-op', () => {
    const idx = indexDocument(ALPHA_OL);
    const r = planTransform('toAlphabeticList', { id: idOf(idx, 'ol') }, idx);
    expect(r.status).toBe('noop');
  });

  test('ol → toUnorderedList yields a rename intent (ol→ul)', () => {
    const idx = indexDocument(OL);
    const r = planTransform('toUnorderedList', { id: idOf(idx, 'ol') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'toUnorderedList') return;
    expect(r.from).toBe('ol');
    expect(r.to).toBe('ul');
  });

  test('list-kind transform on a non-list is refused (wrong-kind)', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('toOrderedList', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('wrong-kind');
  });
});

describe('p → li transform', () => {
  test('paragraph after a list → append into that list', () => {
    const idx = indexDocument('<body><ul><li>a</li></ul><p>x</p></body>');
    const r = planTransform('paragraphToItem', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToItem') return;
    expect(r.position).toBe('append');
    expect(r.listId).toBe(idOf(idx, 'ul'));
    expect(r.listKind).toBe('ul');
    expect(r.paragraphId).toBe(idOf(idx, 'p', 'x'));
  });

  test('paragraph before a list → prepend into that list', () => {
    const idx = indexDocument('<body><p>x</p><ol><li>a</li></ol></body>');
    const r = planTransform('paragraphToItem', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToItem') return;
    expect(r.position).toBe('prepend');
    expect(r.listKind).toBe('ol');
  });

  test('paragraph between matching lists → merge the lists around the new item', () => {
    const idx = indexDocument('<body><ul><li>a</li></ul><p>b</p><ul><li>c</li></ul></body>');
    const lists = [...idx.byId].filter(([, el]) => el.name === 'ul').map(([id]) => id);
    const r = planTransform('paragraphToItem', { id: idOf(idx, 'p', 'b') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToItem') return;
    expect(r.position).toBe('merge-between');
    expect(r.listId).toBe(lists[0]);
    expect(r.mergeListId).toBe(lists[1]);
  });

  test('paragraph with no adjacent list is refused (no-adjacent-list)', () => {
    const idx = indexDocument('<body><p>x</p><p>y</p></body>');
    const r = planTransform('paragraphToItem', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('no-adjacent-list');
  });

  test('paragraphToItem on a non-paragraph is refused (wrong-kind)', () => {
    const idx = indexDocument(UL);
    const r = planTransform('paragraphToItem', { id: idOf(idx, 'li', 'a') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('wrong-kind');
  });

  test('paragraphToUnorderedList plans a standalone paragraph wrapper', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('paragraphToUnorderedList', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToUnorderedList') return;
    expect(r.listKind).toBe('ul');
    expect(r.paragraphId).toBe(idOf(idx, 'p', 'x'));
  });

  test('paragraphToOrderedList plans a standalone paragraph wrapper', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('paragraphToOrderedList', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToOrderedList') return;
    expect(r.listKind).toBe('ol');
  });

  test('paragraphToAlphabeticList plans a lower-alpha ordered-list wrapper', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('paragraphToAlphabeticList', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToAlphabeticList') return;
    expect(r.listKind).toBe('ol');
    expect(r.listStyle).toBe('alpha');
  });

  test('paragraphToNote plans a paragraph wrapper', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('paragraphToNote', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToNote') return;
    expect(r.blockKind).toBe('note');
  });

  test('paragraphToSection is refused where sections cannot be nested', () => {
    const idx = indexDocument('<body><section><p>x</p></section></body>');
    const r = planTransform('paragraphToSection', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('unsupported-parent');
  });

  test('paragraphToCodeblock plans a paragraph replacement', () => {
    const idx = indexDocument('<body><p>x</p></body>');
    const r = planTransform('paragraphToCodeblock', { id: idOf(idx, 'p', 'x') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'paragraphToCodeblock') return;
    expect(r.blockKind).toBe('codeblock');
  });
});

describe('li → p transform', () => {
  test('first item of a multi-item list → lift a paragraph BEFORE the list', () => {
    const idx = indexDocument(UL);
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li', 'a') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('lift-before');
    expect(r.listId).toBe(idOf(idx, 'ul'));
    expect(r.parentId).toBe(idOf(idx, 'body'));
  });

  test('last item of a multi-item list → lift a paragraph AFTER the list', () => {
    const idx = indexDocument(UL);
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li', 'b') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('lift-after');
  });

  test('sole item → the whole list dissolves into the paragraph', () => {
    const idx = indexDocument('<body><ul><li>only</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li', 'only') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('dissolve-list');
  });

  test('sole item inside a note can dissolve back into a paragraph', () => {
    const idx = indexDocument('<body><note><ul><li><b>Business</b> A350</li></ul></note></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li', 'A350') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('dissolve-list');
    expect(r.parentId).toBe(idOf(idx, 'note'));
  });

  test('middle item splits the list around the paragraph', () => {
    const idx = indexDocument('<body><ul><li>a</li><li>b</li><li>c</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li', 'b') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('split-list');
  });

  test('item wrapping a nested <p> block is refused (block-content)', () => {
    // <li> wraps a <p> — its content cannot collapse into a single paragraph.
    const idx = indexDocument('<body><ul><li><p>a</p></li><li>b</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('block-content');
  });

  test('item wrapping a nested list is refused (block-content)', () => {
    const idx = indexDocument('<body><ul><li>x<ul><li>n</li></ul></li><li>b</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li') }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('block-content');
  });

  test('item with INLINE markup is allowed (inline phrase content is valid in <p>)', () => {
    // <b> is inline/phrase content — a paragraph can carry it, so the action stays on.
    const idx = indexDocument('<body><ul><li>say <b>hi</b> there</li><li>b</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li') }, idx);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'itemToParagraph') return;
    expect(r.mode).toBe('lift-before');
  });

  test('item with an inline <image> is allowed (p can carry an image)', () => {
    const idx = indexDocument('<body><ul><li><image href="x.png"/></li><li>b</li></ul></body>');
    const r = planTransform('itemToParagraph', { id: idOf(idx, 'li') }, idx);
    expect(r.status).toBe('ok');
  });

  test('item whose list sits in a parent that cannot hold <p> is refused (unsupported-parent)', () => {
    // Controlled malformed input (a nested <ul> as a direct child of another <ul>,
    // as PDF extraction can produce): the inner list's parent is <ul>, which the
    // conservative parent allowlist does not accept a <p> in.
    const idx = indexDocument('<body><ul><li>top</li><ul><li>a</li><li>b</li></ul></ul></body>');
    const innerA = idOf(idx, 'li', 'a');
    const r = planTransform('itemToParagraph', { id: innerA }, idx);
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('unsupported-parent');
  });
});

describe('note direct and mixed content transforms', () => {
  test('direct note prose offers the same text-block transforms as normal prose', () => {
    const idx = indexDocument('<body><note>Direct note</note></body>');
    const noteId = idOf(idx, 'note', 'Direct note');

    expect(availableTransforms({ id: noteId }, idx)).toEqual(expect.arrayContaining([
      'noteContentToParagraph',
      'noteContentToUnorderedList',
      'noteContentToOrderedList',
      'noteContentToAlphabeticList',
      'noteContentToLines',
      'noteContentToCodeblock',
    ]));
  });

  test('a note-content transform plans against the note container', () => {
    const idx = indexDocument('<body><note>Direct note</note></body>');
    const noteId = idOf(idx, 'note', 'Direct note');
    const result = planTransform('noteContentToUnorderedList', { id: noteId }, idx);

    expect(result).toMatchObject({
      status: 'ok',
      transform: 'noteContentToUnorderedList',
      noteId,
      blockKind: 'ul',
      listStyle: 'unordered',
    });
  });
});

describe('entry direct content transforms', () => {
  test('direct cell text can be wrapped as a paragraph', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry>Cell text</entry></row></tbody></tgroup></table>');
    const r = planTransform('entryToParagraph', { id: idOf(idx, 'entry', 'Cell text') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'entryToParagraph') return;
    expect(r.entryId).toBe(idOf(idx, 'entry', 'Cell text'));
    expect(r.wrapperKind).toBe('p');
  });

  test('direct cell text offers paragraph, list, lines, note, and code block wrappers', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry>x</entry></row></tbody></tgroup></table>');

    expect(availableTransforms({ id: idOf(idx, 'entry', 'x') }, idx)).toEqual([
      'entryToParagraph',
      'entryToUnorderedList',
      'entryToOrderedList',
      'entryToAlphabeticList',
      'entryToLines',
      'entryToNote',
      'entryToCodeblock',
    ]);
  });

  test('an already paragraph-wrapped cell is a noop for entryToParagraph', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry><p>x</p></entry></row></tbody></tgroup></table>');
    const r = planTransform('entryToParagraph', { id: idOf(idx, 'entry') }, idx);

    expect(r.status).toBe('noop');
    if (r.status !== 'noop') return;
    expect(r.reason).toMatch(/already/i);
  });

  test('a cell with one existing block can be converted to a different wrapper', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry><p>x</p></entry></row></tbody></tgroup></table>');
    const r = planTransform('entryToUnorderedList', { id: idOf(idx, 'entry') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'entryToUnorderedList') return;
    expect(r.wrapperKind).toBe('ul');
  });

  test('entryToAlphabeticList plans a lower-alpha ordered-list wrapper', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry>x</entry></row></tbody></tgroup></table>');
    const r = planTransform('entryToAlphabeticList', { id: idOf(idx, 'entry', 'x') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'entryToAlphabeticList') return;
    expect(r.wrapperKind).toBe('ol');
    expect(r.listStyle).toBe('alpha');
  });

  test('a cell with mixed block content is refused as ambiguous', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry><p>x</p><note>y</note></entry></row></tbody></tgroup></table>');
    const r = planTransform('entryToUnorderedList', { id: idOf(idx, 'entry') }, idx);

    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('block-content');
  });
});

describe('lines block transforms', () => {
  test('top-level lines offer paragraph, list, section, note, and code block conversions', () => {
    const idx = indexDocument('<body><lines>one\ntwo</lines></body>');

    expect(availableTransforms({ id: idOf(idx, 'lines') }, idx)).toEqual([
      'linesToParagraph',
      'linesToUnorderedList',
      'linesToOrderedList',
      'linesToAlphabeticList',
      'linesToSection',
      'linesToNote',
      'linesToCodeblock',
    ]);
  });

  test('lines inside a table cell offer valid cell-block conversions but not section', () => {
    const idx = indexDocument('<table><tgroup cols="1"><tbody><row><entry><lines>one\ntwo</lines></entry></row></tbody></tgroup></table>');

    expect(availableTransforms({ id: idOf(idx, 'lines') }, idx)).toEqual([
      'linesToParagraph',
      'linesToUnorderedList',
      'linesToOrderedList',
      'linesToAlphabeticList',
      'linesToNote',
      'linesToCodeblock',
    ]);
    const section = planTransform('linesToSection', { id: idOf(idx, 'lines') }, idx);
    expect(section.status).toBe('invalid');
    if (section.status !== 'invalid') return;
    expect(section.code).toBe('unsupported-parent');
  });

  test('linesToUnorderedList plans the focused lines block as the source', () => {
    const idx = indexDocument('<body><lines>one\ntwo</lines></body>');
    const r = planTransform('linesToUnorderedList', { id: idOf(idx, 'lines') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'linesToUnorderedList') return;
    expect(r.linesId).toBe(idOf(idx, 'lines'));
    expect(r.blockKind).toBe('ul');
  });

  test('linesToAlphabeticList plans an alpha ordered-list replacement', () => {
    const idx = indexDocument('<body><lines>one\ntwo</lines></body>');
    const r = planTransform('linesToAlphabeticList', { id: idOf(idx, 'lines') }, idx);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.transform !== 'linesToAlphabeticList') return;
    expect(r.linesId).toBe(idOf(idx, 'lines'));
    expect(r.blockKind).toBe('ol');
    expect(r.listStyle).toBe('alpha');
  });
});

describe('focus guards', () => {
  test('null focus is refused (no-focus)', () => {
    const r = planTransform('toOrderedList', { id: null }, indexDocument(UL));
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('no-focus');
  });

  test('unknown id is refused (unknown-id)', () => {
    const r = planTransform('toOrderedList', { id: 'e999' }, indexDocument(UL));
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') return;
    expect(r.code).toBe('unknown-id');
  });
});

describe('availableTransforms', () => {
  test('a <ul> offers numbered and alphabetic list transforms (toUnordered is a noop)', () => {
    const idx = indexDocument(UL);
    expect(availableTransforms({ id: idOf(idx, 'ul') }, idx)).toEqual(['toOrderedList', 'toAlphabeticList']);
  });

  test('an alphabetic <ol> offers numbered and bulleted list transforms', () => {
    const idx = indexDocument(ALPHA_OL);
    expect(availableTransforms({ id: idOf(idx, 'ol') }, idx)).toEqual(['toOrderedList', 'toUnorderedList']);
  });

  test('a first <li> offers only itemToParagraph', () => {
    const idx = indexDocument(UL);
    expect(availableTransforms({ id: idOf(idx, 'li', 'a') }, idx)).toEqual(['itemToParagraph']);
  });

  test('a paragraph adjacent to a list offers paragraph structure transforms and paragraphToItem', () => {
    const idx = indexDocument('<body><ul><li>a</li></ul><p>x</p></body>');
    expect(availableTransforms({ id: idOf(idx, 'p', 'x') }, idx)).toEqual([
      'paragraphToOrderedList',
      'paragraphToUnorderedList',
      'paragraphToAlphabeticList',
      'paragraphToSection',
      'paragraphToNote',
      'paragraphToCodeblock',
      'paragraphToItem',
    ]);
  });

  test('a paragraph with no adjacent list offers paragraph structure transforms', () => {
    const idx = indexDocument('<body><p>x</p><p>y</p></body>');
    expect(availableTransforms({ id: idOf(idx, 'p', 'x') }, idx)).toEqual([
      'paragraphToOrderedList',
      'paragraphToUnorderedList',
      'paragraphToAlphabeticList',
      'paragraphToSection',
      'paragraphToNote',
      'paragraphToCodeblock',
    ]);
  });
});

describe('purity / serialization invariant', () => {
  test('planning never mutates the document — it still round-trips byte-exact', () => {
    const idx = indexDocument(UL);
    const ul = idOf(idx, 'ul');
    const liA = idOf(idx, 'li', 'a');
    planTransform('toOrderedList', { id: ul }, idx);
    planTransform('toUnorderedList', { id: ul }, idx);
    planTransform('itemToParagraph', { id: liA }, idx);
    planTransform('paragraphToItem', { id: liA }, idx);
    availableTransforms({ id: ul }, idx);
    expect(serialize(idx.doc)).toBe(UL);
  });
});
