// P1 multi-selection command planner. Tests parse REAL DITA with the production
// parser and address elements by their real e{N} ids (via indexDocument). No mock
// data; no document is mutated (a purity test re-serializes to prove it).

import { test, expect, describe } from 'bun:test';
import { serialize } from '../src/cst/serialize';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { planMultiCommand } from '../src/commands/multi-command';

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
const TWO_UL = '<body><ul><li>x</li></ul><ul><li>y</li></ul></body>';

describe('doc-order + dedup', () => {
  test('ids are processed in document order regardless of input order, deduped', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const p2 = idOf(idx, 'p', 'p2');
    const p3 = idOf(idx, 'p', 'p3');
    const plan = planMultiCommand({ family: 'delete' }, [p3, p1, p2, p1], idx); // shuffled + dup
    expect(plan.summary).toBe('ok');
    expect(plan.applyIds).toEqual([p1, p2, p3]); // document order, deduped
    expect(plan.items.map((i) => i.id)).toEqual([p1, p2, p3]);
    expect(plan.items.every((i) => i.decision === 'apply' && i.op === 'deletePara')).toBe(true);
    expect(plan.homogeneous).toBe(true);
  });
});

describe('stale ids', () => {
  test('an unknown id is pruned/skipped with stale-id; real ids still plan', () => {
    const idx = indexDocument(FOUR_P);
    const p1 = idOf(idx, 'p', 'p1');
    const plan = planMultiCommand({ family: 'delete' }, [p1, 'e999'], idx);
    const stale = plan.items.find((i) => i.id === 'e999')!;
    expect(stale.decision).toBe('skip');
    expect(stale.code).toBe('stale-id');
    expect(plan.applyIds).toEqual([p1]);
  });
});

describe('heterogeneous selection', () => {
  const MIXED =
    '<body><p>p1</p><p>p2</p><ul><li>a</li><li>b</li></ul>' +
    '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>e</entry></row></tbody></tgroup></table>' +
    '</body>';

  test('delete family resolves per kind; an unsupported kind is skipped with reason', () => {
    const idx = indexDocument(MIXED);
    const p1 = idOf(idx, 'p', 'p1');
    const liA = idOf(idx, 'li', 'a');
    const entry = idOf(idx, 'entry', 'e');
    const plan = planMultiCommand({ family: 'delete' }, [p1, liA, entry], idx);
    expect(plan.homogeneous).toBe(false);
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    expect(byId.get(p1)).toMatchObject({ decision: 'apply', op: 'deletePara' });
    expect(byId.get(liA)).toMatchObject({ decision: 'apply', op: 'deleteItem' });
    expect(byId.get(entry)).toMatchObject({ decision: 'skip', code: 'unsupported-kind' });
    expect(plan.applyIds).toEqual([p1, liA]); // doc order
  });

  test('a single concrete structural op skips the kinds it does not target', () => {
    const idx = indexDocument(MIXED);
    const p1 = idOf(idx, 'p', 'p1');
    const liA = idOf(idx, 'li', 'a');
    const plan = planMultiCommand({ family: 'structural', op: 'deletePara' }, [p1, liA], idx);
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    expect(byId.get(p1)!.decision).toBe('apply');
    expect(byId.get(liA)).toMatchObject({ decision: 'skip', code: 'invalid' });
    expect(byId.get(liA)!.reason).toMatch(/paragraph/i); // wrong-kind reason from isValid
  });
});

describe('would-empty-container guard', () => {
  test('selecting every <li> of a list refuses the whole group', () => {
    const idx = indexDocument(LIST3);
    const all = ['a', 'b', 'c'].map((t) => idOf(idx, 'li', t));
    const plan = planMultiCommand({ family: 'delete' }, all, idx);
    expect(plan.summary).toBe('all-skipped');
    expect(plan.applyIds).toEqual([]);
    expect(plan.items.every((i) => i.code === 'would-empty-container')).toBe(true);
  });

  test('selecting a strict subset still deletes (container keeps a child)', () => {
    const idx = indexDocument(LIST3);
    const plan = planMultiCommand({ family: 'delete' }, [idOf(idx, 'li', 'a'), idOf(idx, 'li', 'b')], idx);
    expect(plan.summary).toBe('ok');
    expect(plan.applyIds.length).toBe(2);
  });

  test('deleting 3 of 4 paragraphs is allowed', () => {
    const idx = indexDocument(FOUR_P);
    const ids = ['p1', 'p2', 'p3'].map((t) => idOf(idx, 'p', t));
    const plan = planMultiCommand({ family: 'delete' }, ids, idx);
    expect(plan.applyIds.length).toBe(3);
  });
});

describe('whole-block delete (table / list / figure)', () => {
  const tableXml =
    '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>e</entry></row></tbody></tgroup></table>';
  const P_AND_TABLE = `<body><p>p1</p>${tableXml}</body>`;
  const ONLY_TABLE = `<body>${tableXml}</body>`;
  const TABLE_AND_FIG = `<body>${tableXml}<fig><title>F</title></fig></body>`;

  test('a whole <table> among sibling blocks is applied with deleteTable', () => {
    const idx = indexDocument(P_AND_TABLE);
    const t = idOf(idx, 'table');
    const plan = planMultiCommand({ family: 'delete' }, [t], idx);
    expect(plan.summary).toBe('ok');
    expect(plan.items[0]).toMatchObject({ decision: 'apply', op: 'deleteTable' });
    expect(plan.applyIds).toEqual([t]);
  });

  test('deleting the only block of a container is refused as would-empty-container', () => {
    const idx = indexDocument(ONLY_TABLE);
    const plan = planMultiCommand({ family: 'delete' }, [idOf(idx, 'table')], idx);
    expect(plan.summary).toBe('all-skipped');
    expect(plan.items[0]).toMatchObject({ decision: 'skip', code: 'would-empty-container' });
  });

  test('selecting every block (table + fig) of a container refuses the whole group', () => {
    const idx = indexDocument(TABLE_AND_FIG);
    const ids = [idOf(idx, 'table'), idOf(idx, 'fig')];
    const plan = planMultiCommand({ family: 'delete' }, ids, idx);
    expect(plan.applyIds).toEqual([]);
    expect(plan.items.every((i) => i.code === 'would-empty-container')).toBe(true);
  });

  test('selecting mixed block kinds that would empty a container refuses the whole group', () => {
    const idx = indexDocument('<body><p>p1</p><ul><li>a</li></ul><p>p2</p></body>');
    const ids = [idOf(idx, 'p', 'p1'), idOf(idx, 'ul'), idOf(idx, 'p', 'p2')];
    const plan = planMultiCommand({ family: 'delete' }, ids, idx);
    expect(plan.summary).toBe('all-skipped');
    expect(plan.items.every((i) => i.code === 'would-empty-container')).toBe(true);
  });

  test('a nested list can be deleted from a list item that keeps text content', () => {
    const idx = indexDocument('<body><ul><li>Parent<ul><li>Nested</li></ul></li><li>Keep</li></ul></body>');
    const nestedList = [...idx.byId.entries()].find(([, el]) => el.name === 'ul' && el.parent?.name === 'li')?.[0];
    if (!nestedList) throw new Error('expected nested list id');
    const plan = planMultiCommand({ family: 'delete' }, [nestedList], idx);
    expect(plan.summary).toBe('ok');
    expect(plan.applyIds).toEqual([nestedList]);
  });
});

describe('transform family', () => {
  test('toOrderedList over two ul selections plans both', () => {
    const idx = indexDocument(TWO_UL);
    const uls: string[] = [];
    for (const [id, el] of idx.byId) if (el.name === 'ul') uls.push(id);
    const plan = planMultiCommand({ family: 'transform', transform: 'toOrderedList' }, uls, idx);
    expect(plan.applyIds).toEqual(uls);
    expect(plan.items.every((i) => i.op === 'toOrderedList')).toBe(true);
    expect(plan.homogeneous).toBe(true);
  });

  test('a no-op transform is skipped with code noop', () => {
    const idx = indexDocument(TWO_UL);
    const ul = idOf(idx, 'ul', '');
    const plan = planMultiCommand({ family: 'transform', transform: 'toUnorderedList' }, [ul], idx);
    expect(plan.summary).toBe('all-skipped');
    expect(plan.items[0]).toMatchObject({ decision: 'skip', code: 'noop' });
  });

  test('an invalid transform is skipped carrying the planner reason', () => {
    const idx = indexDocument('<body><p>x</p><p>y</p></body>'); // no adjacent list
    const plan = planMultiCommand(
      { family: 'transform', transform: 'paragraphToItem' },
      [idOf(idx, 'p', 'x')],
      idx,
    );
    expect(plan.items[0]).toMatchObject({ decision: 'skip', code: 'invalid' });
    expect(plan.items[0].reason).toMatch(/adjacent list/i);
  });

  test('linesToParagraph over selected lines plans both line blocks', () => {
    const idx = indexDocument('<body><lines>a</lines><p>middle</p><lines>b</lines></body>');
    const lines = [...idx.byId].filter(([, el]) => el.name === 'lines').map(([id]) => id);
    const plan = planMultiCommand({ family: 'transform', transform: 'linesToParagraph' }, lines, idx);

    expect(plan.applyIds).toEqual(lines);
    expect(plan.items.every((item) => item.op === 'linesToParagraph')).toBe(true);
    expect(plan.homogeneous).toBe(true);
  });
});

describe('summary states', () => {
  test('empty selection → empty', () => {
    const plan = planMultiCommand({ family: 'delete' }, [], indexDocument(FOUR_P));
    expect(plan.summary).toBe('empty');
    expect(plan.items).toEqual([]);
    expect(plan.homogeneous).toBe(false);
  });
});

describe('purity', () => {
  test('planning never mutates the document — it still round-trips byte-exact', () => {
    const idx = indexDocument(FOUR_P);
    planMultiCommand({ family: 'delete' }, [idOf(idx, 'p', 'p1'), idOf(idx, 'p', 'p2')], idx);
    planMultiCommand({ family: 'structural', op: 'deletePara' }, [idOf(idx, 'p', 'p1')], idx);
    expect(serialize(idx.doc)).toBe(FOUR_P);
  });
});
