// P1-4 (image @href edit) — the host transform CONTRACT this slice depends on.
// The webview (media/canvas.js) and the VS Code QuickPick wiring in src/extension.ts are not
// headlessly testable (no DOM / no vscode module), so they are runtime-verified. This pins the
// pure transform extension.ts performs when an author picks a new image source:
//   parse -> resolve the image by the SAME id canvas/renderEditable use (assignElementIds) ->
//   setAttr('href', newHref) -> serialize.
// It guards the byte-minimal guarantee (only the href value changes) and the id contract (a
// canvas data-struct-id resolves to the right CST node). Real parser/serializer, real DITA
// shapes; no mock data.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { setAttr } from '../src/cst/edit';
import { assignElementIds, findElementById } from '../src/cst/element-ids';
import type { Document } from '../src/cst/types';

// A self-closing <image> with a sibling attribute (placement) so the test proves the value splice
// touches only href, plus an unrelated <p> so a wrong id would land on a non-image element.
const SRC =
  '<topic id="t"><body>\n' +
  '  <fig><image href="images/img_005.jpeg" placement="break"/></fig>\n' +
  '  <p>after</p>\n' +
  '</body></topic>\n';

function imageId(doc: Document): string {
  for (const [el, id] of assignElementIds(doc)) if (el.name === 'image') return id;
  throw new Error('no image element in fixture');
}

describe('image @href edit (host transform contract)', () => {
  test('round-trips byte-for-byte before any edit (serialize===source)', () => {
    expect(serialize(parse(SRC))).toBe(SRC);
  });

  test("a canvas data-struct-id resolves to the image node (assignElementIds === findElementById)", () => {
    const doc = parse(SRC);
    const id = imageId(doc);
    expect(id).toMatch(/^e\d+$/);
    const el = findElementById(doc, id);
    expect(el?.name).toBe('image');
  });

  test('changing the href rewrites ONLY the href value (every other byte preserved)', () => {
    const doc = parse(SRC);
    const el = findElementById(doc, imageId(doc));
    expect(el).toBeTruthy();
    setAttr(el!, 'href', 'images/img_006.jpeg', SRC);
    const out = serialize(doc);
    expect(out).toBe(SRC.replace('images/img_005.jpeg', 'images/img_006.jpeg'));
    expect(out).toContain('placement="break"'); // the sibling attribute is untouched
  });

  test('reverting the href restores the document byte-for-byte', () => {
    const doc = parse(SRC);
    setAttr(findElementById(doc, imageId(doc))!, 'href', 'images/img_006.jpeg', SRC);
    const changed = serialize(doc);
    expect(changed).not.toBe(SRC);
    // Mirror a second QuickPick round-trip: re-parse the edited doc and set the href back.
    const doc2 = parse(changed);
    setAttr(findElementById(doc2, imageId(doc2))!, 'href', 'images/img_005.jpeg', changed);
    expect(serialize(doc2)).toBe(SRC);
  });
});
