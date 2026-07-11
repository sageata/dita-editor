import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { applyStructuralEdit } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { findElements } from '../src/cst/query';
import type { ElementNode } from '../src/cst/types';

function idsNamed(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) out.push(id);
  }
  return out;
}

const LIST =
  '<topic><body>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n    <li>three</li>\n  </ul>\n</body></topic>';
const BLOCKS =
  '<topic><body>\n  <p>alpha</p>\n  <p>beta</p>\n  <ul>\n    <li>x</li>\n  </ul>\n</body></topic>';
const ROWS =
  '<topic><body>\n' +
  '  <table><tgroup cols="1">\n' +
  '    <colspec colname="c1" colnum="1"/>\n' +
  '    <tbody>\n' +
  '      <row>\n        <entry>r1</entry>\n      </row>\n' +
  '      <row>\n        <entry>r2</entry>\n      </row>\n' +
  '    </tbody>\n' +
  '  </tgroup></table>\n' +
  '</body></topic>';

describe('structural: moveBefore / moveAfter', () => {
  test('moveAfter reorders list items and keeps every byte of the moved item', () => {
    const [first, second] = idsNamed(LIST, 'li');
    const res = applyStructuralEdit(LIST, 'moveAfter', first, { refId: second });
    const items = findElements(parse(res.source), 'li').map((li) =>
      li.children.map((c) => (c.type === 'text' ? c.raw : '')).join(''));
    expect(items).toEqual(['two', 'one', 'three']);
    expect(res.source).toContain('<li>one</li>');
    expect(res.source).toContain('\n    <li>one</li>'); // indentation preserved
    // focus follows the moved element
    expect(res.focusId).toBeTruthy();
  });

  test('moveBefore moves a later item up', () => {
    const ids = idsNamed(LIST, 'li');
    const res = applyStructuralEdit(LIST, 'moveBefore', ids[2], { refId: ids[0] });
    const items = findElements(parse(res.source), 'li').map((li) =>
      li.children.map((c) => (c.type === 'text' ? c.raw : '')).join(''));
    expect(items).toEqual(['three', 'one', 'two']);
  });

  test('moves work across block kinds sharing a parent (p past a list)', () => {
    const doc = parse(BLOCKS);
    const byName = new Map<string, string>();
    for (const [el, id] of assignElementIds(doc)) {
      byName.set((el as ElementNode).name + ':' + id, id);
    }
    const pIds = idsNamed(BLOCKS, 'p');
    const ulId = idsNamed(BLOCKS, 'ul')[0];
    const res = applyStructuralEdit(BLOCKS, 'moveAfter', pIds[1], { refId: ulId });
    const body = res.source;
    expect(body.indexOf('<ul>')).toBeLessThan(body.indexOf('<p>beta</p>'));
    expect(body.indexOf('<p>alpha</p>')).toBeLessThan(body.indexOf('<ul>'));
  });

  test('table rows reorder within tbody', () => {
    const [r1, r2] = idsNamed(ROWS, 'row');
    const res = applyStructuralEdit(ROWS, 'moveAfter', r1, { refId: r2 });
    expect(res.source.indexOf('r2')).toBeLessThan(res.source.indexOf('r1'));
  });

  test('refuses a cross-container move without writing', () => {
    const liId = idsNamed(BLOCKS, 'li')[0];
    const pId = idsNamed(BLOCKS, 'p')[0];
    expect(() => applyStructuralEdit(BLOCKS, 'moveAfter', liId, { refId: pId }))
      .toThrow('same container');
  });

  test('refuses a move without a reference id', () => {
    const [first] = idsNamed(LIST, 'li');
    expect(() => applyStructuralEdit(LIST, 'moveAfter', first, {})).toThrow('reference');
  });

  test('move is byte-stable: moving an item down then back up round-trips', () => {
    const [first, second] = idsNamed(LIST, 'li');
    const moved = applyStructuralEdit(LIST, 'moveAfter', first, { refId: second });
    const backIds = idsNamed(moved.source, 'li');
    // after the first move the original item is at index 1; move it back before index 0
    const res = applyStructuralEdit(moved.source, 'moveBefore', backIds[1], { refId: backIds[0] });
    expect(res.source).toBe(LIST);
  });
});
