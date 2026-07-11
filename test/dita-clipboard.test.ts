import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import { insertDitaFragment, sliceElements } from '../src/host/dita-clipboard';
import type { ElementNode } from '../src/cst/types';

function idsNamed(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) out.push(id);
  }
  return out;
}

const DOC =
  '<topic><body>\n' +
  '  <p>alpha &amp; beta</p>\n' +
  '  <table><tgroup cols="1">\n' +
  '    <colspec colname="c1" colnum="1"/>\n' +
  '    <tbody>\n      <row>\n        <entry>x</entry>\n      </row>\n    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

describe('dita-clipboard', () => {
  test('sliceElements returns the exact original bytes (entities untouched)', () => {
    const pId = idsNamed(DOC, 'p')[0];
    expect(sliceElements(DOC, [pId])).toBe('<p>alpha &amp; beta</p>');
    const tableId = idsNamed(DOC, 'table')[0];
    const slice = sliceElements(DOC, [tableId])!;
    expect(slice.startsWith('<table>')).toBe(true);
    expect(slice.endsWith('</table>')).toBe(true);
    expect(slice).toContain('<colspec colname="c1" colnum="1"/>');
  });

  test('sliceElements returns null for an unknown id', () => {
    expect(sliceElements(DOC, ['nope'])).toBeNull();
  });

  test('insertDitaFragment pastes a block verbatim after the reference', () => {
    const pId = idsNamed(DOC, 'p')[0];
    const res = insertDitaFragment(DOC, pId, 'after', '<p>pasted &amp; kept</p>');
    expect(res.source).toContain('<p>alpha &amp; beta</p>\n  <p>pasted &amp; kept</p>');
    expect(res.focusId).toBeTruthy();
    // the rest of the document is untouched
    expect(res.source.endsWith('</body></topic>')).toBe(true);
  });

  test('insertDitaFragment pastes before with mirrored indentation', () => {
    const pId = idsNamed(DOC, 'p')[0];
    const res = insertDitaFragment(DOC, pId, 'before', '<p>first</p>');
    expect(res.source).toContain('\n  <p>first</p>\n  <p>alpha &amp; beta</p>');
  });

  test('a whole table pastes next to a paragraph (block next to block)', () => {
    const pId = idsNamed(DOC, 'p')[0];
    const tableId = idsNamed(DOC, 'table')[0];
    const fragment = sliceElements(DOC, [tableId])!;
    const res = insertDitaFragment(DOC, pId, 'after', fragment);
    expect((res.source.match(/<table>/g) || []).length).toBe(2);
  });

  test('refuses non-XML and non-block-compatible fragments', () => {
    const pId = idsNamed(DOC, 'p')[0];
    expect(() => insertDitaFragment(DOC, pId, 'after', 'plain words')).toThrow('DITA XML');
    expect(() => insertDitaFragment(DOC, pId, 'after', '<row><entry>r</entry></row>'))
      .toThrow('Cannot paste');
  });
});
