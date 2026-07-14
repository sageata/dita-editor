import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import type { Document } from '../src/cst/types';
import { buildInsertMap, buildTransformMap, resolveTransformFocus } from '../src/webview/state-maps';
import { indexDocument } from '../src/commands/validity';

function idOf(doc: Document, name: string, text?: string): string {
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name !== name) continue;
    if (text !== undefined && !el.children.some((child) => child.type === 'text' && child.raw.includes(text))) continue;
    return id;
  }
  throw new Error(`no <${name}>${text ? ` containing ${text}` : ''}`);
}

function avail(
  map: ReturnType<typeof buildInsertMap>,
  id: string,
  mode: 'before' | 'after' | 'into',
  kind: string,
): { kind: string; enabled: boolean; reason?: string } {
  const entry = map[id]?.[mode]?.find((item) => item.kind === kind);
  if (!entry) throw new Error(`no ${mode} availability for ${kind} at ${id}`);
  return entry;
}

describe('buildInsertMap', () => {
  test('publishes truthful inside-cell insert availability for table entry ids', () => {
    const doc = parse(
      '<body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
        '<row><entry>cell text</entry></row>' +
        '</tbody></tgroup></table></body>',
    );
    const map = buildInsertMap(doc);
    const entryId = idOf(doc, 'entry', 'cell text');

    expect(avail(map, entryId, 'into', 'paragraph')).toEqual({ kind: 'paragraph', enabled: true });
    expect(avail(map, entryId, 'into', 'table')).toEqual({ kind: 'table', enabled: true });
    expect(avail(map, entryId, 'into', 'section')).toMatchObject({
      enabled: false,
      reason: 'Cannot insert a section into <entry>',
    });
    expect(map[entryId]?.before).toBeUndefined();
    expect(map[entryId]?.after).toBeUndefined();
  });

  test('publishes every supported block insertion inside a note without invalid nesting', () => {
    const doc = parse('<body><note type="note">Direct note</note></body>');
    const map = buildInsertMap(doc);
    const noteId = idOf(doc, 'note', 'Direct note');

    for (const kind of [
      'paragraph',
      'lines',
      'unorderedList',
      'alphabeticList',
      'orderedList',
      'table',
      'codeblock',
    ] as const) {
      expect(avail(map, noteId, 'into', kind)).toEqual({ kind, enabled: true });
    }
    expect(avail(map, noteId, 'into', 'note')).toMatchObject({
      enabled: false,
      reason: 'Cannot insert a note into <note>',
    });
    expect(avail(map, noteId, 'into', 'section')).toMatchObject({ enabled: false });
    expect(avail(map, noteId, 'into', 'listItem')).toMatchObject({ enabled: false });
  });

  test('publishes in-place transforms for direct note prose', () => {
    const doc = parse('<body><note>Direct note</note></body>');
    const map = buildTransformMap(doc);
    const noteId = idOf(doc, 'note', 'Direct note');

    for (const transform of [
      'noteContentToParagraph',
      'noteContentToUnorderedList',
      'noteContentToOrderedList',
      'noteContentToAlphabeticList',
      'noteContentToLines',
      'noteContentToCodeblock',
    ] as const) {
      expect(map[noteId]?.[transform]).toEqual({ status: 'ok' });
    }
  });
});

describe('buildTransformMap', () => {
  test('publishes list-item to paragraph conversion inside a note', () => {
    const doc = parse('<body><note><ul><li><b>Business</b> A350</li></ul></note></body>');
    const map = buildTransformMap(doc);
    const itemId = idOf(doc, 'li', 'A350');

    expect(map[itemId]?.itemToParagraph).toEqual({ status: 'ok' });
  });

  test('publishes legal paragraph conversions inside a note without allowing nested notes or sections', () => {
    const doc = parse('<body><note><p>Business A350 specific</p></note></body>');
    const map = buildTransformMap(doc);
    const paragraphId = idOf(doc, 'p', 'Business A350');

    expect(map[paragraphId]?.paragraphToUnorderedList).toEqual({ status: 'ok' });
    expect(map[paragraphId]?.paragraphToOrderedList).toEqual({ status: 'ok' });
    expect(map[paragraphId]?.paragraphToAlphabeticList).toEqual({ status: 'ok' });
    expect(map[paragraphId]?.paragraphToCodeblock).toEqual({ status: 'ok' });
    expect(map[paragraphId]?.paragraphToSection).toMatchObject({ status: 'invalid' });
    expect(map[paragraphId]?.paragraphToNote).toMatchObject({ status: 'invalid' });
  });

  test('publishes line-block conversions for focused lines in prose and table cells', () => {
    const doc = parse(
      '<body><lines>one\ntwo</lines><table><tgroup cols="1"><tbody><row><entry><lines>cell</lines></entry></row></tbody></tgroup></table></body>',
    );
    const map = buildTransformMap(doc);
    const proseLines = idOf(doc, 'lines', 'one');
    const cellLines = idOf(doc, 'lines', 'cell');

    expect(map[proseLines]?.linesToParagraph).toEqual({ status: 'ok' });
    expect(map[proseLines]?.linesToUnorderedList).toEqual({ status: 'ok' });
    expect(map[proseLines]?.linesToSection).toEqual({ status: 'ok' });
    expect(map[cellLines]?.linesToParagraph).toEqual({ status: 'ok' });
    expect(map[cellLines]?.linesToOrderedList).toEqual({ status: 'ok' });
    expect(map[cellLines]?.linesToSection).toMatchObject({
      status: 'invalid',
      reason: '<section> is not allowed in <entry>',
    });
  });

  test('entry transforms resolve from a focused single block inside a cell back to the entry', () => {
    const source = '<body><table><tgroup cols="1"><tbody><row><entry><lines>cell</lines></entry></row></tbody></tgroup></table></body>';
    const idx = indexDocument(source);
    const lineId = [...idx.byId].find(([, el]) => el.name === 'lines')?.[0];
    const entryId = [...idx.byId].find(([, el]) => el.name === 'entry')?.[0];
    if (!lineId || !entryId) throw new Error('expected entry and lines ids');

    expect(resolveTransformFocus('entryToParagraph', lineId, idx)).toEqual({ id: entryId });
  });
});
