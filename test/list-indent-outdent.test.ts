// Nested-list indent / outdent (Tab / Shift+Tab). DITA allows a <ul>/<ol> inside a
// <li>, so indenting moves an item into a sublist under the item above it, and
// outdenting moves a nested item back out one level. Each case asserts the resulting
// nesting structure AND a byte-exact round-trip (serialize(parse(x)) === x) so the
// produced source is always valid, re-parseable DITA.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { childElements, childrenNamed, findElements } from '../src/cst/query';
import type { ElementNode } from '../src/cst/types';

function firstText(li: ElementNode): string {
  const t = li.children[0];
  return t && t.type === 'text' ? t.raw.trim() : '';
}

/** Edit id of the <li> whose leading text is `text`. */
function liId(src: string, text: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    const e = el as ElementNode;
    if (e.name === 'li' && firstText(e) === text) return id;
  }
  throw new Error(`no <li> starting with "${text}"`);
}

/** Direct <li> texts of the OUTERMOST list. */
function outerLiTexts(src: string): string[] {
  return childrenNamed(outerList(src), 'li').map((li) => firstText(li as ElementNode));
}

function outerList(src: string): ElementNode {
  const doc = parse(src);
  const lists = [...findElements(doc, 'ul'), ...findElements(doc, 'ol')] as ElementNode[];
  const list = lists.find((el) => el.parent?.name === 'body') ?? lists[0];
  if (!list) throw new Error('no list found');
  return list;
}

/** <li> texts of the sublist nested inside the <li> whose text is `parent` (or []). */
function subTexts(src: string, parent: string): string[] {
  const li = findElements(parse(src), 'li').find(
    (e) => firstText(e as ElementNode) === parent,
  ) as ElementNode | undefined;
  if (!li) return [];
  const sub = childElements(li).find((c) => c.name === 'ul' || c.name === 'ol');
  return sub ? childrenNamed(sub, 'li').map((x) => firstText(x as ElementNode)) : [];
}

function subList(src: string, parent: string): ElementNode | null {
  const li = findElements(parse(src), 'li').find(
    (e) => firstText(e as ElementNode) === parent,
  ) as ElementNode | undefined;
  return li ? childElements(li).find((c) => c.name === 'ul' || c.name === 'ol') ?? null : null;
}

function outputclass(el: ElementNode | null): string | undefined {
  return el?.attrs.find((attr) => attr.name === 'outputclass')?.value;
}

const FLAT =
  '<topic><body>\n  <ul>\n    <li>A</li>\n    <li>B</li>\n    <li>C</li>\n  </ul>\n</body></topic>';
const NESTED =
  '<topic><body>\n  <ul>\n    <li>A\n      <ul>\n        <li>B</li>\n      </ul>\n    </li>\n    <li>C</li>\n  </ul>\n</body></topic>';
const ALPHA_NESTED =
  '<topic><body>\n  <ul>\n    <li>A\n      <ol outputclass="lower-alpha">\n        <li>B</li>\n        <li>C</li>\n      </ol>\n    </li>\n  </ul>\n</body></topic>';
const BULLET_WITH_ALPHA_CHILD =
  '<topic><body>\n  <ul>\n    <li>A\n      <ol outputclass="lower-alpha">\n        <li>B</li>\n      </ol>\n    </li>\n    <li>C</li>\n  </ul>\n</body></topic>';
const BULLET_WITH_NUMBERED_CHILD =
  '<topic><body>\n  <ul>\n    <li>A\n      <ol>\n        <li>B</li>\n      </ol>\n    </li>\n    <li>C</li>\n  </ul>\n</body></topic>';
const NUMBERED_NESTED =
  '<topic><body>\n  <ol outputclass="lower-alpha">\n    <li>A\n      <ol>\n        <li>B</li>\n        <li>C</li>\n      </ol>\n    </li>\n  </ol>\n</body></topic>';

describe('list indent (Tab)', () => {
  test('demotes an item into a new sublist under the item above', () => {
    const r = applyStructuralEdit(FLAT, 'indentItem', liId(FLAT, 'B'));
    expect(outerLiTexts(r.source)).toEqual(['A', 'C']); // B left the top level
    expect(subTexts(r.source, 'A')).toEqual(['B']); // ...and is nested under A
    const sub = subList(r.source, 'A');
    expect(sub?.name).toBe('ul');
    expect(outputclass(sub)).toBeUndefined();
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('the first item cannot be indented (nothing above to nest under)', () => {
    expect(() => applyStructuralEdit(FLAT, 'indentItem', liId(FLAT, 'A'))).toThrow(
      /Cannot indent the first item/,
    );
  });

  test('merges into the previous item’s existing sublist of the same marker style', () => {
    const r = applyStructuralEdit(BULLET_WITH_ALPHA_CHILD, 'indentItem', liId(BULLET_WITH_ALPHA_CHILD, 'C'));
    expect(outerLiTexts(r.source)).toEqual(['A']); // C left the top level
    expect(subTexts(r.source, 'A')).toEqual(['B', 'C']); // appended after B in A's sublist
    expect(outputclass(subList(r.source, 'A'))).toBe('lower-alpha');
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('preserves an existing bulleted sublist when appending another indented item', () => {
    const r = applyStructuralEdit(NESTED, 'indentItem', liId(NESTED, 'C'));
    const sub = subList(r.source, 'A');
    expect(sub?.name).toBe('ul');
    expect(outputclass(sub)).toBeUndefined();
    expect(subTexts(r.source, 'A')).toEqual(['B', 'C']);
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('preserves an existing numbered sublist when appending another indented item', () => {
    const r = applyStructuralEdit(BULLET_WITH_NUMBERED_CHILD, 'indentItem', liId(BULLET_WITH_NUMBERED_CHILD, 'C'));
    const sub = subList(r.source, 'A');
    expect(sub?.name).toBe('ol');
    expect(outputclass(sub)).toBeUndefined();
    expect(subTexts(r.source, 'A')).toEqual(['B', 'C']);
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('demotes an alphabetic item into a numbered sublist', () => {
    const r = applyStructuralEdit(ALPHA_NESTED, 'indentItem', liId(ALPHA_NESTED, 'C'));
    const sub = subList(r.source, 'B');
    expect(sub?.name).toBe('ol');
    expect(outputclass(sub)).toBeUndefined();
    expect(subTexts(r.source, 'B')).toEqual(['C']);
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('demotes a numbered item into a bulleted sublist', () => {
    const r = applyStructuralEdit(NUMBERED_NESTED, 'indentItem', liId(NUMBERED_NESTED, 'C'));
    const sub = subList(r.source, 'B');
    expect(sub?.name).toBe('ul');
    expect(outputclass(sub)).toBeUndefined();
    expect(subTexts(r.source, 'B')).toEqual(['C']);
    expect(serialize(parse(r.source))).toBe(r.source);
  });
});

describe('list outdent (Shift+Tab)', () => {
  test('promotes a nested item out one level and removes the now-empty sublist', () => {
    const r = applyStructuralEdit(NESTED, 'outdentItem', liId(NESTED, 'B'));
    expect(outerLiTexts(r.source)).toEqual(['A', 'B', 'C']); // B is now a top-level sibling
    expect(subTexts(r.source, 'A')).toEqual([]); // A's emptied sublist was removed
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('a top-level item cannot be outdented', () => {
    expect(() => applyStructuralEdit(FLAT, 'outdentItem', liId(FLAT, 'A'))).toThrow(
      /already at the top level/,
    );
  });

  test('trailing siblings follow the promoted item, nested under it (order preserved)', () => {
    const r = applyStructuralEdit(ALPHA_NESTED, 'outdentItem', liId(ALPHA_NESTED, 'B'));
    expect(outerLiTexts(r.source)).toEqual(['A', 'B']); // B promoted after A
    expect(subTexts(r.source, 'A')).toEqual([]); // A's sublist consumed
    expect(subTexts(r.source, 'B')).toEqual(['C']); // C now nested under B
    expect(outputclass(subList(r.source, 'B'))).toBe('lower-alpha');
    expect(serialize(parse(r.source))).toBe(r.source);
  });
});
