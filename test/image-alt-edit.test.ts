// P1-4 image alt edit — pure CST contract for the host prompt path.
// The VS Code input box is runtime-only; these tests pin the real DITA mutation:
// parse -> resolve selected <image> by canvas id -> add/update/remove child <alt> -> serialize.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyImageAlt, imageAltText } from '../src/cst/image-alt';
import { assignElementIds, findElementById } from '../src/cst/element-ids';
import type { Document, ElementNode } from '../src/cst/types';

const SRC =
  '<topic id="t"><body>\n' +
  '  <fig><image href="images/img_005.jpeg" placement="break"/></fig>\n' +
  '  <p>after</p>\n' +
  '</body></topic>\n';

function imageId(doc: Document): string {
  for (const [el, id] of assignElementIds(doc)) if (el.name === 'image') return id;
  throw new Error('no image element in fixture');
}

function imageById(doc: Document): ElementNode {
  const el = findElementById(doc, imageId(doc));
  if (!el || el.name !== 'image') throw new Error('image id did not resolve to <image>');
  return el;
}

describe('image alt edit (host transform contract)', () => {
  test('round-trips byte-for-byte before any edit', () => {
    expect(serialize(parse(SRC))).toBe(SRC);
  });

  test('adding alt promotes a self-closing image and preserves sibling attrs', () => {
    const doc = parse(SRC);
    const result = applyImageAlt(imageById(doc), 'Cabin & seat photo');

    expect(result).toBe('added');
    expect(serialize(doc)).toBe(
      SRC.replace(
        '<image href="images/img_005.jpeg" placement="break"/>',
        '<image href="images/img_005.jpeg" placement="break"><alt>Cabin &amp; seat photo</alt></image>',
      ),
    );
  });

  test('reading and updating existing alt uses decoded text and re-escapes on write', () => {
    const src = SRC.replace(
      '<image href="images/img_005.jpeg" placement="break"/>',
      '<image href="images/img_005.jpeg" placement="break"><alt>Cabin &amp; seat photo</alt></image>',
    );
    const doc = parse(src);
    const image = imageById(doc);

    expect(imageAltText(image)).toBe('Cabin & seat photo');
    expect(applyImageAlt(image, 'Updated <meal> & seat photo')).toBe('updated');
    expect(serialize(doc)).toBe(
      src.replace('Cabin &amp; seat photo', 'Updated &lt;meal&gt; &amp; seat photo'),
    );
  });

  test('clearing alt removes the child and returns to the self-closing image form', () => {
    const src = SRC.replace(
      '<image href="images/img_005.jpeg" placement="break"/>',
      '<image href="images/img_005.jpeg" placement="break"><alt>Cabin photo</alt></image>',
    );
    const doc = parse(src);

    expect(applyImageAlt(imageById(doc), '')).toBe('cleared');
    expect(serialize(doc)).toBe(SRC);
  });

  test('unchanged alt is a no-op', () => {
    const src = SRC.replace(
      '<image href="images/img_005.jpeg" placement="break"/>',
      '<image href="images/img_005.jpeg" placement="break"><alt>Cabin photo</alt></image>',
    );
    const doc = parse(src);

    expect(applyImageAlt(imageById(doc), 'Cabin photo')).toBe('unchanged');
    expect(serialize(doc)).toBe(src);
  });
});
