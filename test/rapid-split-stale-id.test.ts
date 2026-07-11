// Root-cause regression for the "rapid Enter in a list duplicates text into the file" bug.
//
// data-struct-id is a POSITIONAL depth-first index (src/cst/element-ids.ts) that is only
// valid within a single render cycle — every structural edit reassigns all ids. The pure
// structural core (applyStructuralEdit) is faithful but staleness-BLIND: it applies whatever
// id it is handed against the document it is handed.
//
// Before the fix, the canvas posted a SECOND `split` carrying ids from the SUPERSEDED render
// cycle when the user pressed Enter again before the first re-render landed. The host applied
// both, so the second split's stale id duplicated content into the .dita file. This test pins
// that mechanism: applying the same positional split id twice DOES duplicate content — which is
// exactly why the host now rejects a structural op whose baseStructVersion is stale
// (the structVersion optimistic-concurrency guard in src/extension.ts).

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyStructuralEdit } from '../src/cst/structural';
import { assignElementIds } from '../src/cst/element-ids';
import type { ElementNode } from '../src/cst/types';

function firstId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no <${name}> found`);
}

const LIST = '<topic><body>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>\n</body></topic>';

describe('rapid-split stale-id race', () => {
  test('a single split is faithful (one logical Enter)', () => {
    const id = firstId(LIST, 'li'); // the first <li>, "one"
    const r1 = applyStructuralEdit(LIST, 'split', id, { prefix: '', suffix: 'one' });
    // one split at offset 0: an empty <li> then the "one" <li>. "one" still appears exactly once.
    expect((r1.source.match(/one/g) ?? []).length).toBe(1);
    expect(serialize(parse(r1.source))).toBe(r1.source); // valid, round-trips
  });

  test('re-applying the SAME positional id (rapid Enter before re-render) duplicates content', () => {
    const id = firstId(LIST, 'li');
    const payload = { prefix: '', suffix: 'one' };
    const r1 = applyStructuralEdit(LIST, 'split', id, payload);
    // The canvas DOM did not update after the first post, so the second Enter re-sends the SAME
    // id + payload. Replaying it against the now-shifted document re-injects "one":
    const r2 = applyStructuralEdit(r1.source, 'split', id, payload);
    expect((r2.source.match(/one/g) ?? []).length).toBe(2); // <-- the corruption the guard prevents
  });
});
