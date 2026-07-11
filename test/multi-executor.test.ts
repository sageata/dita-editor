// P1-a atomic multi-command executor. Every test parses REAL DITA with the
// production parser and selects elements by their real e{N} ids (via indexDocument).
// No mock data. Exact-byte assertions are used where the input has no inter-element
// whitespace (so the result is fully determined); whitespace cases assert structural
// outcome + byte-exact round-trip instead of guessing the serializer's trim.

import { test, expect, describe } from 'bun:test';
import { serialize } from '../src/cst/serialize';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { executeMultiCommand } from '../src/commands/multi-executor';

function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) {
      continue;
    }
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

const FOUR_P = '<body><p>p1</p><p>p2</p><p>p3</p><p>p4</p></body>';
const LIST3 = '<body><ul><li>a</li><li>b</li><li>c</li></ul></body>';
const MIXED = '<body><p>a</p><ul><li>x</li><li>y</li></ul><p>b</p></body>';
const MIXED_LISTS =
  '<body><ul id="one"><li>a</li></ul><p>middle</p><ul outputclass="two"><li>b</li></ul></body>';

describe('batch delete — homogeneous', () => {
  test('deletes a non-contiguous subset of <p> atomically (exact bytes)', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const p3 = idOf(idx, 'p', 'p3');
    const r = executeMultiCommand(FOUR_P, { family: 'delete' }, [p3, p1]); // shuffled input
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><p>p2</p><p>p4</p></body>');
    expect(r.appliedIds).toEqual([p1, p3]); // document order
  });

  test('deleting a strict subset of <li> keeps the container (exact bytes)', () => {
    const idx = indexDocument(LIST3);
    const a = idOf(idx, 'li', 'a');
    const c = idOf(idx, 'li', 'c');
    const r = executeMultiCommand(LIST3, { family: 'delete' }, [a, c]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><ul><li>b</li></ul></body>');
  });
});

describe('batch delete — whole blocks (table / list / fig)', () => {
  const BLOCKS =
    '<body><p>keep</p>' +
    '<ul><li>x</li></ul>' +
    '<fig><image href="i.png"/></fig>' +
    '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table>' +
    '</body>';

  test('deletes a whole <ul> (deleteList) atomically (exact bytes)', () => {
    const idx = indexDocument(BLOCKS);
    const ul = idOf(idx, 'ul');
    const r = executeMultiCommand(BLOCKS, { family: 'delete' }, [ul]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).not.toContain('<ul>');
    expect(r.source).toContain('<p>keep</p>');
    expect(r.source).toContain('<fig>');
    expect(r.source).toContain('<table>');
  });

  test('deletes a <fig> and a <table> in one batch; <p>/<ul> survive verbatim', () => {
    const idx = indexDocument(BLOCKS);
    const fig = idOf(idx, 'fig');
    const table = idOf(idx, 'table');
    const r = executeMultiCommand(BLOCKS, { family: 'delete' }, [table, fig]); // shuffled
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).not.toContain('<fig>');
    expect(r.source).not.toContain('<table>');
    expect(r.source).toContain('<p>keep</p>');
    expect(r.source).toContain('<ul><li>x</li></ul>');
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });

  test('selecting every block in a container → refused (would-empty-container)', () => {
    const ONLY = '<body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>c</entry></row></tbody></tgroup></table></body>';
    const idx = indexDocument(ONLY);
    const r = executeMultiCommand(ONLY, { family: 'delete' }, [idOf(idx, 'table')]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('all-skipped');
    expect(r.plan.items.every((i) => i.code === 'would-empty-container')).toBe(true);
    expect(r.source).toBe(ONLY);
  });
});

describe('batch delete — heterogeneous across containers', () => {
  test('deletes a <p> and an <li> in different parents, in document order (exact bytes)', () => {
    const idx = indexDocument(MIXED);
    const a = idOf(idx, 'p', 'a');
    const x = idOf(idx, 'li', 'x');
    const r = executeMultiCommand(MIXED, { family: 'delete' }, [x, a]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    // <p>a</p> and <li>x</li> gone; <li>y</li> and <p>b</p> survive verbatim.
    expect(r.source).toBe('<body><ul><li>y</li></ul><p>b</p></body>');
    expect(r.appliedIds).toEqual([a, x]);
  });
});

describe('unrelated content stays byte-exact (whitespace / siblings preserved)', () => {
  const DOC =
    '<body>\n  <section>\n    <p>keep-1</p>\n    <p>drop</p>\n    <p>keep-2</p>\n  </section>\n  <p>tail</p>\n</body>';
  test('a delete touches only its own element; everything else round-trips', () => {
    const idx = indexDocument(DOC);
    const drop = idOf(idx, 'p', 'drop');
    const r = executeMultiCommand(DOC, { family: 'delete' }, [drop]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toContain('<p>keep-1</p>');
    expect(r.source).toContain('<p>keep-2</p>');
    expect(r.source).toContain('<p>tail</p>');
    expect(r.source).not.toContain('drop');
    // The result is a real document that itself round-trips byte-exact.
    expect(serialize(indexDocument(r.source).doc)).toBe(r.source);
  });
});

describe('structural family restricted to delete ops', () => {
  test('family:structural op:deletePara behaves like delete for <p> ids', () => {
    const idx = indexDocument(FOUR_P);
    const p2 = idOf(idx, 'p', 'p2');
    const r = executeMultiCommand(FOUR_P, { family: 'structural', op: 'deletePara' }, [p2]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><p>p1</p><p>p3</p><p>p4</p></body>');
  });
});

describe('batch list-kind transforms', () => {
  test('toOrderedList renames multiple <ul> blocks atomically and preserves attributes', () => {
    const idx = indexDocument(MIXED_LISTS);
    const lists = [...idx.byId.entries()].filter(([, el]) => el.name === 'ul').map(([id]) => id);
    const r = executeMultiCommand(MIXED_LISTS, { family: 'transform', transform: 'toOrderedList' }, lists);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe(
      '<body><ol id="one"><li>a</li></ol><p>middle</p><ol outputclass="two"><li>b</li></ol></body>',
    );
    expect(r.appliedIds).toEqual(lists);
  });

  test('toUnorderedList renames nested and sibling <ol> lists without shifting paths', () => {
    const DOC = '<body><ol><li>a<ol><li>b</li></ol></li></ol><p>tail</p><ol><li>c</li></ol></body>';
    const idx = indexDocument(DOC);
    const lists = [...idx.byId.entries()].filter(([, el]) => el.name === 'ol').map(([id]) => id);
    const r = executeMultiCommand(DOC, { family: 'transform', transform: 'toUnorderedList' }, lists);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><ul><li>a<ul><li>b</li></ul></li></ul><p>tail</p><ul><li>c</li></ul></body>');
    expect(r.appliedIds).toEqual(lists);
  });

  test('noop and stale selected ids are skipped while a valid list is renamed', () => {
    const DOC = '<body><ul><li>a</li></ul><ol><li>b</li></ol></body>';
    const idx = indexDocument(DOC);
    const ul = idOf(idx, 'ul');
    const ol = idOf(idx, 'ol');
    const r = executeMultiCommand(DOC, { family: 'transform', transform: 'toOrderedList' }, [ol, 'e999', ul]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><ol><li>a</li></ol><ol><li>b</li></ol></body>');
    expect(r.appliedIds).toEqual([ul]);
    expect(r.plan.items.find((it) => it.id === ol)).toMatchObject({ decision: 'skip', code: 'noop' });
    expect(r.plan.items.find((it) => it.id === 'e999')).toMatchObject({ decision: 'skip', code: 'stale-id' });
  });
});

describe('batch in-place transforms', () => {
  test('paragraphToOrderedList converts adjacent selected paragraphs into one numbered list', () => {
    const idx = indexDocument(FOUR_P);
    const ids = ['p1', 'p2', 'p3', 'p4'].map((text) => idOf(idx, 'p', text));

    const r = executeMultiCommand(FOUR_P, { family: 'transform', transform: 'paragraphToOrderedList' }, ids);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><ol>\n  <li>p1</li>\n  <li>p2</li>\n  <li>p3</li>\n  <li>p4</li>\n</ol></body>');
    expect(r.appliedIds).toEqual(ids);
  });

  test('paragraphToUnorderedList wraps multiple selected paragraphs atomically', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const p3 = idOf(idx, 'p', 'p3');
    const r = executeMultiCommand(FOUR_P, { family: 'transform', transform: 'paragraphToUnorderedList' }, [p3, p1]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe(
      '<body><ul>\n  <li>p1</li>\n</ul><p>p2</p><ul>\n  <li>p3</li>\n</ul><p>p4</p></body>',
    );
    expect(r.appliedIds).toEqual([p1, p3]);
  });

  test('linesToParagraph converts multiple selected lines blocks atomically', () => {
    const DOC = '<body><lines>a\nb</lines><p>middle</p><lines>c\nd</lines></body>';
    const idx = indexDocument(DOC);
    const lines = [...idx.byId].filter(([, el]) => el.name === 'lines').map(([id]) => id);

    const r = executeMultiCommand(DOC, { family: 'transform', transform: 'linesToParagraph' }, lines);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><p>a b</p><p>middle</p><p>c d</p></body>');
    expect(r.appliedIds).toEqual(lines);
  });
});

describe('refusals', () => {
  test('empty selection → refused empty', () => {
    const r = executeMultiCommand(FOUR_P, { family: 'delete' }, []);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('empty');
    expect(r.source).toBe(FOUR_P);
  });

  test('selecting every <li> → refused all-skipped (would-empty-container)', () => {
    const idx = indexDocument(LIST3);
    const all = ['a', 'b', 'c'].map((t) => idOf(idx, 'li', t));
    const r = executeMultiCommand(LIST3, { family: 'delete' }, all);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('all-skipped');
    expect(r.source).toBe(LIST3);
    expect(r.plan.items.every((i) => i.code === 'would-empty-container')).toBe(true);
  });

  test('only-stale ids → refused all-skipped', () => {
    const r = executeMultiCommand(FOUR_P, { family: 'delete' }, ['e999', 'e1000']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('all-skipped');
  });

  test('content-moving transform family → refused unsupported-family', () => {
    const DOC = '<body><ul><li>a</li></ul><p>b</p></body>';
    const idx = indexDocument(DOC);
    const p = idOf(idx, 'p', 'b');
    const r = executeMultiCommand(DOC, { family: 'transform', transform: 'paragraphToItem' }, [p]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('unsupported-family');
    expect(r.source).toBe(DOC);
  });

  test('non-delete structural op → refused unsupported-family', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const r = executeMultiCommand(FOUR_P, { family: 'structural', op: 'addParaAfter' }, [p1]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.refusal.code).toBe('unsupported-family');
  });
});

describe('stale + valid mix still applies the valid ids', () => {
  test('a stale id is skipped; the real <p> is still deleted', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const r = executeMultiCommand(FOUR_P, { family: 'delete' }, [p1, 'e999']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.source).toBe('<body><p>p2</p><p>p3</p><p>p4</p></body>');
    expect(r.appliedIds).toEqual([p1]);
  });
});

describe('purity', () => {
  test('executing never mutates the caller-visible source; original still round-trips', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    executeMultiCommand(FOUR_P, { family: 'delete' }, [p1]);
    // FOUR_P is a const string (immutable); prove the executor produced a *new*
    // source and left a fresh parse of the original intact.
    expect(serialize(indexDocument(FOUR_P).doc)).toBe(FOUR_P);
  });
});
