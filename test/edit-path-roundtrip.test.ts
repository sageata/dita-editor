// EDIT-PATH REGRESSION GUARD for the 4 once-latent serializer data-loss paths.
//
// The byte-exact "no-op gate" (corpus-noop.test.ts) only proves parse->serialize
// of UNEDITED files; it never drives the EDIT path. These four constructs are
// INERT on the real corpus (0 instances), so they are exercised here with
// DELIBERATE in-memory fixtures: build the at-risk shape, run the real edit op,
// serialize, and assert the construct SURVIVES.
//
// Paths 1-3 are FIXED and must stay preserved (these tests PASS). Path 4 is a
// deliberate WONTFIX: its test asserts the CURRENT (lossy) behavior with the
// rationale inline, so a future change there is caught and reconsidered.

import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyTextEdit } from '../src/cst/edit-bridge';
import { applyStructuralEdit, applyTransform } from '../src/cst/structural';
import { editableElementIds } from '../src/cst/text-targets';
import { assignElementIds } from '../src/cst/element-ids';
import { mergeRight, mergeDown } from '../src/cst/table-merge';
import { findElements, firstTextChild } from '../src/cst/query';
import type { Document, ElementNode } from '../src/cst/types';

/** The eN edit id of the first editable element with the given tag name. */
function editId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of editableElementIds(doc)) {
    if (el.name === name) return id;
  }
  throw new Error(`no editable <${name}>`);
}

/** True iff at least one element with this tag is reported editable. */
function hasEditable(src: string, name: string): boolean {
  const doc = parse(src);
  for (const [el] of editableElementIds(doc)) {
    if (el.name === name) return true;
  }
  return false;
}

function idsNamed(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === name) out.push(id);
  }
  return out;
}

function entryByText(doc: Document, text: string): ElementNode {
  const el = findElements(doc, 'entry').find((e) => firstTextChild(e)?.raw === text);
  if (!el) throw new Error(`no <entry> with text ${JSON.stringify(text)}`);
  return el;
}

const stable = (s: string): boolean => serialize(parse(s)) === s;

// ---------------------------------------------------------------------------
// PATH 1 (FIXED) — a leaf holding a comment / PI / CDATA is NON-editable, so its
// source is preserved verbatim (preserve-over-edit). Fix: isEditable now requires
// EVERY child to be a text node, so a non-text child (comment/PI/CDATA) makes the
// leaf non-editable instead of letting setElementText rebuild it from text alone.
// ---------------------------------------------------------------------------
describe('PATH 1: leaf with comment / PI / CDATA is non-editable and preserved', () => {
  test('comment-bearing <p> is not editable and round-trips verbatim', () => {
    const src = '<topic><body><p>before<!-- keep -->after</p></body></topic>';
    expect(hasEditable(src, 'p')).toBe(false); // no data-edit-id stamped
    expect(serialize(parse(src))).toBe(src); // preserved byte-for-byte
    expect(serialize(parse(src))).toContain('<!-- keep -->');
  });

  test('PI-bearing <p> is not editable and round-trips verbatim', () => {
    const src = '<topic><body><p>x<?keep me?>y</p></body></topic>';
    expect(hasEditable(src, 'p')).toBe(false);
    expect(serialize(parse(src))).toBe(src);
    expect(serialize(parse(src))).toContain('<?keep me?>');
  });

  test('CDATA-bearing <p> is not editable and round-trips verbatim', () => {
    const src = '<topic><body><p>x<![CDATA[<raw> & stuff]]>y</p></body></topic>';
    expect(hasEditable(src, 'p')).toBe(false);
    expect(serialize(parse(src))).toBe(src);
    expect(serialize(parse(src))).toContain('<![CDATA[<raw> & stuff]]>');
  });

  // Guard the boundary: the fix must NOT over-restrict. Text-only and EMPTY leaves
  // (freshly-added rows/items/cells) stay editable; inline-rich cells are whole-cell
  // editable through the HTML inline bridge.
  test('text-only and empty leaves remain editable', () => {
    expect(hasEditable('<topic><body><p>plain</p></body></topic>', 'p')).toBe(true);
    expect(hasEditable('<topic><body><p></p></body></topic>', 'p')).toBe(true);
  });

  test('an inline-rich text+image cell is whole-cell editable', () => {
    const src =
      '<topic><body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody>' +
      '<row><entry>Label <image href="seat.jpg"/></entry></row>' +
      '</tbody></tgroup></table></body></topic>';
    expect(hasEditable(src, 'entry')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATH 2 (FIXED) — a comment / PI / CDATA in a merged cell survives.
//   * ABSORBED cell: absorbContent moves "preserved" nodes (contentful +
//     comment/PI/CDATA), not just "contentful" ones.
//   * TARGET (surviving) cell: mergeRight only setAttr's the open tag and APPENDS
//     to the target's children — it never rebuilds them — so the target's own
//     comment is preserved by construction (no code change needed).
// The TARGET case is also driven through the actual runtime entry point
// (applyStructuralEdit('mergeRight', leftCellId)) to close the headless/runtime gap.
// ---------------------------------------------------------------------------
describe('PATH 2: cell merge preserves a comment/PI in the absorbed cell', () => {
  const tableWith = (rightCell: string): string =>
    '<topic><body>\n' +
    '  <table><tgroup cols="2">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n' +
    '    <tbody>\n' +
    '      <row>\n' +
    '        <entry>L</entry>\n' +
    `        ${rightCell}\n` +
    '      </row>\n' +
    '    </tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  test('comment in the right cell survives mergeRight', () => {
    const doc = parse(tableWith('<entry>x<!-- m --></entry>'));
    mergeRight(doc, entryByText(doc, 'L'));
    const out = serialize(doc);
    expect(out).toContain('x'); // visible text carried over (space-separated)
    expect(out).toContain('<!-- m -->'); // comment carried over too
    expect(out).toContain('<entry namest="c1" nameend="c2">L x<!-- m --></entry>');
    expect(stable(out)).toBe(true);
  });

  test('PI in the right cell survives mergeRight', () => {
    const doc = parse(tableWith('<entry>x<?keep?></entry>'));
    mergeRight(doc, entryByText(doc, 'L'));
    const out = serialize(doc);
    expect(out).toContain('<?keep?>');
    expect(stable(out)).toBe(true);
  });

  // --- TARGET-cell comment, through the REAL runtime entry point ------------
  // Reported runtime case: the comment is in the LEFT (target/surviving) cell;
  // the RIGHT (Standard) cell is absorbed. Driven exactly as the webview does:
  // postStructural('mergeRight', leftCellId) -> applyStructuralEdit(...).
  const row2 = (leftCell: string, rightCell: string): string =>
    '<topic><body>\n' +
    '  <table><tgroup cols="2">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n' +
    '    <tbody>\n' +
    '      <row>\n' +
    `        ${leftCell}\n` +
    `        ${rightCell}\n` +
    '      </row>\n' +
    '    </tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  test('comment in the LEFT (target) cell survives mergeRight via applyStructuralEdit', () => {
    const src = row2('<entry>Economy<!-- TODO confirm --></entry>', '<entry>Standard</entry>');
    const leftId = idsNamed(src, 'entry')[0]; // depth-first: the left cell
    const out = applyStructuralEdit(src, 'mergeRight', leftId).source;
    expect(out).toContain('<!-- TODO confirm -->');
    expect(out).toContain(
      '<entry namest="c1" nameend="c2">Economy<!-- TODO confirm --> Standard</entry>',
    );
    expect(stable(out)).toBe(true);
  });

  test('comment in the RIGHT (absorbed) cell survives mergeRight via applyStructuralEdit', () => {
    const src = row2('<entry>L</entry>', '<entry>x<!-- m --></entry>');
    const leftId = idsNamed(src, 'entry')[0];
    const out = applyStructuralEdit(src, 'mergeRight', leftId).source;
    expect(out).toContain('<!-- m -->');
    expect(stable(out)).toBe(true);
  });

  // Root cause of the reported evidence (`Economy Standard`, comment dropped, single
  // space): a comment-bearing cell must be NON-editable (path 1), so no stray
  // pre-merge focus/blur text-edit can strip the comment via setElementText BEFORE
  // the merge runs. With the path-1 fix that cell is non-editable, so the strip
  // cannot happen — only the text-only sibling stays editable.
  test('a comment-bearing cell is non-editable; only the text-only sibling is editable', () => {
    const doc = parse(row2('<entry>Economy<!-- TODO confirm --></entry>', '<entry>Standard</entry>'));
    const commentCell = findElements(doc, 'entry').find((e) =>
      e.children.some((c) => c.type === 'comment'),
    )!;
    const editable = new Set([...editableElementIds(doc).keys()]);
    expect(editable.has(commentCell)).toBe(false); // comment cell: not editable
    const standard = findElements(doc, 'entry').find((e) => firstTextChild(e)?.raw === 'Standard')!;
    expect(editable.has(standard)).toBe(true); // text-only sibling: still editable
  });
});

// ---------------------------------------------------------------------------
// PATH 3 (FIXED) — a non-canonical colspec attr (colwidth/align) on a SHIFTED
// colspec survives column edits. Fix: renumberColspecs updates colname/colnum in
// place via setAttr (value-span splice) instead of rebuilding a bare colspec, so
// every other attr is preserved.
// ---------------------------------------------------------------------------
describe('PATH 3: column edit preserves non-canonical colspec attrs', () => {
  // c2 carries colwidth + align. addColumnAfter(col 0) shifts it to c3; deleteColumn(col 0)
  // shifts it to c1 — either way it is renumbered and must keep its extra attrs.
  const T3 =
    '<topic><body>\n' +
    '  <table><tgroup cols="3">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2" colwidth="2*" align="center"/>\n' +
    '    <colspec colname="c3" colnum="3"/>\n' +
    '    <tbody>\n' +
    '      <row>\n' +
    '        <entry>a</entry>\n' +
    '        <entry>b</entry>\n' +
    '        <entry>c</entry>\n' +
    '      </row>\n' +
    '    </tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  test('addColumnAfter renumbers the shifted colspec but keeps its extra attrs', () => {
    const res = applyStructuralEdit(T3, 'addColumnAfter', idsNamed(T3, 'entry')[0]);
    const out = res.source;
    // c2 -> c3 with @align intact and attribute ORDER unchanged (values spliced in
    // place). Its colwidth changes VALUE by design: as the boundary's right
    // neighbour it donates width to the inserted column (2* -> 1.333*, total kept).
    expect(out).toContain('<colspec colname="c3" colnum="3" colwidth="1.333*" align="center"/>');
    expect(stable(out)).toBe(true);
  });

  test('deleteColumn renumbers the shifted colspec but keeps colwidth + align', () => {
    const res = applyStructuralEdit(T3, 'deleteColumn', idsNamed(T3, 'entry')[0]);
    const out = res.source;
    // col 0 removed: c2 -> c1, extras intact.
    expect(out).toContain('<colspec colname="c1" colnum="1" colwidth="2*" align="center"/>');
    expect(stable(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATH 4 (WONTFIX) — a numeric character entity on a leaf edit normalizes to the
// literal character. This test asserts the CURRENT behavior on purpose:
//
//   * Inert on the corpus: there are 0 numeric character entities in the corpus;
//     the pdf2dita pipeline stores such characters as literal UTF-8, encoding ONLY
//     &amp; / &lt; / &gt; as entities.
//   * Literal-char output therefore MATCHES the corpus convention.
//   * Preserving the numeric encoding would require entity-tracking machinery on
//     the edit path for a 0-instance case, and would DIVERGE from corpus style.
//
// So the leaf editor intentionally emits the literal char. If this assertion ever
// flips, revisit the cost/benefit above before "fixing" it.
// ---------------------------------------------------------------------------
describe('PATH 4 (WONTFIX): leaf edit normalizes a numeric entity to a literal char', () => {
  test('&#160; becomes a literal NBSP on a leaf edit (intended, corpus-aligned)', () => {
    const src = '<topic><body><p>a&#160;b</p></body></topic>';
    // Client decodes &#160; to NBSP and sends the textContent back unchanged.
    const out = applyTextEdit(src, editId(src, 'p'), 'a b');
    expect(out).toContain('a b'); // literal NBSP (U+00A0) — matches corpus convention
    expect(out).not.toContain('&#160;'); // numeric encoding intentionally not preserved
  });
});

// ---------------------------------------------------------------------------
// P2.1 HARDENING — regression guards for named latent-loss constructs that the
// code ALREADY handles (isPreserved/absorbContent for merges; clean-node slicing
// for the transform edit path) but that the suite above never exercised: CDATA on
// the merge path, the merge-DOWN direction, and the block/list TRANSFORM ops.
//
// No production code was changed for this slice: each case was probed first and
// found already-green, so there was no failure class to "flip". These lock the
// behavior so a future serializer/edit change cannot silently regress it — the
// same preserve-over-edit guarantee Paths 1-3 give, extended to the constructs the
// task named (comments / PIs / CDATA / table metadata) on the remaining edit ops.
// ---------------------------------------------------------------------------
describe('P2.1: CDATA survives a cell merge (mergeRight, both cell roles)', () => {
  const tbl = (left: string, right: string): string =>
    '<topic><body>\n  <table><tgroup cols="2">\n    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2"/>\n    <tbody>\n      <row>\n        ' +
    left + '\n        ' + right + '\n      </row>\n    </tbody>\n  </tgroup></table>\n</body></topic>';

  test('CDATA in the absorbed (right) cell survives mergeRight', () => {
    const doc = parse(tbl('<entry>L</entry>', '<entry>x<![CDATA[<raw> & y]]></entry>'));
    mergeRight(doc, entryByText(doc, 'L'));
    const out = serialize(doc);
    expect(out).toContain('<![CDATA[<raw> & y]]>');
    expect(stable(out)).toBe(true);
  });

  test('CDATA in the target (left) cell survives mergeRight via applyStructuralEdit', () => {
    const src = tbl('<entry>L<![CDATA[<raw>]]></entry>', '<entry>R</entry>');
    const out = applyStructuralEdit(src, 'mergeRight', idsNamed(src, 'entry')[0]).source;
    expect(out).toContain('<![CDATA[<raw>]]>');
    expect(stable(out)).toBe(true);
  });

  test('text + comment + CDATA in the absorbed cell all survive, in document order', () => {
    const doc = parse(tbl('<entry>L</entry>', '<entry>t<!-- c --><![CDATA[<z>]]></entry>'));
    mergeRight(doc, entryByText(doc, 'L'));
    const out = serialize(doc);
    expect(out).toContain('L t<!-- c --><![CDATA[<z>]]>');
    expect(stable(out)).toBe(true);
  });
});

describe('P2.1: merge-DOWN preserves comment / PI / CDATA in the absorbed cell', () => {
  const tbl = (top: string, bottom: string): string =>
    '<topic><body>\n  <table><tgroup cols="1">\n    <colspec colname="c1" colnum="1"/>\n' +
    '    <tbody>\n      <row>\n        ' + top + '\n      </row>\n      <row>\n        ' +
    bottom + '\n      </row>\n    </tbody>\n  </tgroup></table>\n</body></topic>';

  const cases: Array<[string, string, string]> = [
    ['comment', '<entry>b<!-- c --></entry>', '<!-- c -->'],
    ['PI', '<entry>b<?pi?></entry>', '<?pi?>'],
    ['CDATA', '<entry>b<![CDATA[z]]></entry>', '<![CDATA[z]]>'],
  ];
  for (const [label, bottom, needle] of cases) {
    test(`${label} in the absorbed (below) cell survives mergeDown`, () => {
      const doc = parse(tbl('<entry>T</entry>', bottom));
      mergeDown(doc, entryByText(doc, 'T'));
      const out = serialize(doc);
      expect(out).toContain(needle);
      expect(stable(out)).toBe(true);
    });
  }
});

describe('P2.1: block/list transforms preserve comment / PI / CDATA', () => {
  test('ul -> ol rename keeps a comment sitting between two items', () => {
    const src = '<body>\n  <ul>\n    <li>a</li>\n    <!-- mid -->\n    <li>b</li>\n  </ul>\n</body>';
    const out = applyTransform(src, { transform: 'toOrderedList', targetId: idsNamed(src, 'ul')[0] }).source;
    expect(out).toContain('<!-- mid -->');
    expect(out).toContain('<ol>');
    expect(out).toContain('</ol>');
    expect(stable(out)).toBe(true);
  });

  test('paragraphToItem carries a comment from the <p> into the new <li>', () => {
    const src = '<body>\n  <ul>\n    <li>a</li>\n  </ul>\n  <p>x<!-- keep --></p>\n</body>';
    const out = applyTransform(src, {
      transform: 'paragraphToItem',
      paragraphId: idsNamed(src, 'p')[0],
      listId: idsNamed(src, 'ul')[0],
      position: 'append',
    }).source;
    expect(out).toContain('<!-- keep -->');
    expect(stable(out)).toBe(true);
  });

  test('itemToParagraph carries CDATA from the <li> into the new <p>', () => {
    const src = '<body>\n  <ul>\n    <li>only<![CDATA[<z>]]></li>\n  </ul>\n</body>';
    const out = applyTransform(src, {
      transform: 'itemToParagraph',
      itemId: idsNamed(src, 'li')[0],
      mode: 'dissolve-list',
    }).source;
    expect(out).toContain('<![CDATA[<z>]]>');
    expect(stable(out)).toBe(true);
  });
});
