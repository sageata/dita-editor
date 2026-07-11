// Deleting nested-list content. Two content-model fixes in canDeleteElement / deleteElement:
//   1. A list's SOLE <li> cascades to deleting the whole (would-be-empty) list — so removing
//      the last item of a nested sublist removes the sublist (and its descendants) with it.
//   2. A <li>/<entry> is a mixed model (text allowed, no required block), so deleting its only
//      block-level child (e.g. a nested <ul>) is allowed — no "only block in <li>" refusal.
// Regression for the user-reported "Cannot delete the only <li> in <ul>" on a nested selection.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit, canDeleteElement } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import { childElements, findElements } from '../src/cst/query';
import type { ElementNode } from '../src/cst/types';

function firstText(el: ElementNode): string {
  const t = el.children[0];
  return t && t.type === 'text' ? t.raw.trim() : '';
}
function pick(src: string, pred: (el: ElementNode) => boolean): ElementNode {
  for (const [el] of assignElementIds(parse(src))) if (pred(el as ElementNode)) return el as ElementNode;
  throw new Error('no element matched');
}
function idOf(src: string, pred: (el: ElementNode) => boolean): string {
  for (const [el, id] of assignElementIds(parse(src))) if (pred(el as ElementNode)) return id;
  throw new Error('no element matched');
}
const liText = (t: string) => (el: ElementNode) => el.name === 'li' && firstText(el) === t;
function allLiTexts(src: string): string[] {
  return findElements(parse(src), 'li').map((e) => firstText(e as ElementNode)).sort();
}
function hasChildList(src: string, parentText: string): boolean {
  const li = findElements(parse(src), 'li').find((e) => firstText(e as ElementNode) === parentText) as
    | ElementNode
    | undefined;
  return !!li && childElements(li).some((c) => c.name === 'ul' || c.name === 'ol');
}

// "Top" holds a nested sublist whose sole item "sole-nested" itself holds a deeper sublist.
const NESTED =
  '<topic><body>\n  <ul>\n    <li>Top\n      <ul>\n        <li>sole-nested\n          <ul>\n            <li>deep</li>\n          </ul>\n        </li>\n      </ul>\n    </li>\n    <li>Other</li>\n  </ul>\n</body></topic>';
const ONLY_BLOCK =
  '<topic><body>\n  <ul>\n    <li>Only</li>\n  </ul>\n</body></topic>';
const LIST_PLUS_P =
  '<topic><body>\n  <p>keep</p>\n  <ul>\n    <li>Only</li>\n  </ul>\n</body></topic>';

describe('delete nested list content', () => {
  test('deleting a sublist’s sole <li> cascades to removing the whole sublist (and its descendants)', () => {
    const r = applyStructuralEdit(NESTED, 'deleteElement', idOf(NESTED, liText('sole-nested')));
    expect(allLiTexts(r.source)).toEqual(['Other', 'Top']); // sole-nested + deep gone
    expect(hasChildList(r.source, 'Top')).toBe(false); // Top's sublist removed with it
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('a sublist’s sole <li> is reported deletable (the guard mirrors the cascade)', () => {
    const li = pick(NESTED, liText('sole-nested'));
    expect(canDeleteElement(li, li.parent ?? null).canDelete).toBe(true);
  });

  test('a nested <ul> can be deleted directly — it is not a required child of its <li>', () => {
    const nestedUl = (e: ElementNode) =>
      (e.name === 'ul' || e.name === 'ol') && firstText(e.parent as ElementNode) === 'Top';
    const ul = pick(NESTED, nestedUl);
    expect(canDeleteElement(ul, ul.parent ?? null).canDelete).toBe(true);
    const r = applyStructuralEdit(NESTED, 'deleteElement', idOf(NESTED, nestedUl));
    expect(hasChildList(r.source, 'Top')).toBe(false);
    expect(serialize(parse(r.source))).toBe(r.source);
  });

  test('the only <li> of the only list in a body is refused (surfaces the list’s real reason)', () => {
    expect(() => applyStructuralEdit(ONLY_BLOCK, 'deleteElement', idOf(ONLY_BLOCK, liText('Only')))).toThrow(
      /only block in <body>/,
    );
  });

  test('the only <li> of a top list cascades when the body keeps another block', () => {
    const r = applyStructuralEdit(LIST_PLUS_P, 'deleteElement', idOf(LIST_PLUS_P, liText('Only')));
    expect(findElements(parse(r.source), 'ul').length).toBe(0); // the emptied list is gone
    expect(findElements(parse(r.source), 'p').length).toBe(1); // the paragraph is kept
    expect(serialize(parse(r.source))).toBe(r.source);
  });
});
