import { describe, expect, test } from 'bun:test';
import { indexDocument } from '../src/commands/validity';
import type { RangeActionAvailability, RangeSelectionPayload } from '../src/webview/canvas-messages';
import type { ElementNode } from '../src/cst/types';
import {
  executeRangeAction,
  queryRangeActions,
  rangeRefusalMessage,
  rangeSuccessMessage,
  type RangeActionContext,
} from '../src/host/range-actions';

const TOPIC = (body: string) => `<topic id="t"><title>T</title><body>${body}</body></topic>`;

function idsByName(src: string, name: string): string[] {
  const idx = indexDocument(src);
  const ids: string[] = [];
  for (const [id, el] of idx.byId) {
    if ((el as ElementNode).name === name) ids.push(id);
  }
  return ids;
}

function blockSelection(ids: string[]): RangeSelectionPayload {
  return {
    kind: 'blockRange',
    ids,
    anchorId: ids[0] ?? null,
    focusId: ids[ids.length - 1] ?? null,
  };
}

function cellSelection(ids: string[]): RangeSelectionPayload {
  return {
    kind: 'cellRect',
    ids,
    anchorId: ids[0] ?? null,
    focusId: ids[ids.length - 1] ?? null,
  };
}

function makeContext(source: string): RangeActionContext & {
  applied: string[];
  announced: string[];
  pushed: Array<[string | null, number | null]>;
  cleared: number;
  posted: Array<{ forIds: string[]; actions: RangeActionAvailability[] }>;
} {
  const ctx = {
    applied: [] as string[],
    announced: [] as string[],
    pushed: [] as Array<[string | null, number | null]>,
    cleared: 0,
    posted: [] as Array<{ forIds: string[]; actions: RangeActionAvailability[] }>,
    document: {
      getText: () => source,
    },
    applyMinimal: async (newSource: string) => {
      ctx.applied.push(newSource);
      source = newSource;
      return true;
    },
    pushBody: (focusId: string | null, caretOffset: number | null) => {
      ctx.pushed.push([focusId, caretOffset]);
    },
    announce: (message: string) => {
      ctx.announced.push(message);
    },
    clearDiagnostics: () => {
      ctx.cleared++;
    },
    postRangeAvailability: (forIds: string[], actions: RangeActionAvailability[]) => {
      ctx.posted.push({ forIds, actions });
    },
  };
  return ctx;
}

describe('range host actions', () => {
  test('queryRangeActions replies with host-derived availability for the selected ids', () => {
    const src = TOPIC('<p>one</p><p>two</p><p>three</p>');
    const ids = idsByName(src, 'p').slice(0, 2);
    const ctx = makeContext(src);

    queryRangeActions(ctx, blockSelection(ids));

    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0].forIds).toEqual(ids);
    expect(ctx.posted[0].actions).toContainEqual({ action: 'rangeDelete', enabled: true });
    expect(ctx.posted[0].actions.find((a) => a.action === 'cellRectMerge')?.enabled).toBe(false);
  });

  test('queryRangeActions enables clearing a selected table cell', () => {
    const src = TOPIC(
      '<table><tgroup cols="1"><colspec colname="c1" colnum="1"/><tbody><row><entry>one</entry></row></tbody></tgroup></table>',
    );
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    queryRangeActions(ctx, cellSelection(ids));

    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0].actions).toContainEqual({ action: 'cellClear', enabled: true });
  });

  test('executeRangeAction applies a range delete atomically and rerenders maps once', async () => {
    const src = TOPIC('<p>one</p><p>two</p><p>three</p>');
    const ids = idsByName(src, 'p').slice(0, 2);
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'rangeDelete', ids);

    expect(ctx.applied).toEqual([TOPIC('<p>three</p>')]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['2 items deleted.']);
  });

  test('queryRangeActions enables range delete for mixed paragraph and indented-list selections', () => {
    const src = TOPIC('<p>before</p><ul><li>parent<ul><li>child</li></ul></li></ul><p>after</p><p>keep</p>');
    const idx = indexDocument(src);
    const ids = [...idx.byId.entries()]
      .filter(([, el]) => (el.name === 'p' && el.children.some((c) => 'raw' in c && (c.raw === 'before' || c.raw === 'after'))) || el.name === 'li')
      .map(([id]) => id);
    const ctx = makeContext(src);

    queryRangeActions(ctx, blockSelection(ids));

    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0].actions).toContainEqual({ action: 'rangeDelete', enabled: true });
  });

  test('executeRangeAction deletes mixed paragraph plus nested list selections through one fallback edit', async () => {
    const src = TOPIC('<p>before</p><ul><li>parent<ul><li>child</li></ul></li></ul><p>after</p><p>keep</p>');
    const idx = indexDocument(src);
    const ids = [...idx.byId.entries()]
      .filter(([, el]) => (el.name === 'p' && el.children.some((c) => 'raw' in c && (c.raw === 'before' || c.raw === 'after'))) || el.name === 'li')
      .map(([id]) => id);
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'rangeDelete', ids);

    expect(ctx.applied).toEqual([TOPIC('<p>keep</p>')]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['4 items deleted.']);
  });

  test('executeRangeAction refuses a mixed delete that would empty the body', async () => {
    const src = TOPIC('<p>before</p><ul><li>parent<ul><li>child</li></ul></li></ul><p>after</p>');
    const idx = indexDocument(src);
    const ids = [...idx.byId.entries()]
      .filter(([, el]) => (el.name === 'p' && el.children.some((c) => 'raw' in c && (c.raw === 'before' || c.raw === 'after'))) || el.name === 'li')
      .map(([id]) => id);
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'rangeDelete', ids);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.cleared).toBe(0);
    expect(ctx.announced).toEqual(["Can't delete every item in its container."]);
  });

  test('executeRangeAction refuses mixed fallback deletes instead of partially deleting unsupported ids', async () => {
    const src = TOPIC('<p>before</p><image href="seat.png"/><p>after</p><p>keep</p>');
    const idx = indexDocument(src);
    const ids = [...idx.byId.entries()]
      .filter(([, el]) => (el.name === 'p' && el.children.some((c) => 'raw' in c && c.raw === 'before')) || el.name === 'image')
      .map(([id]) => id);
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'rangeDelete', ids);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.cleared).toBe(0);
    expect(ctx.announced).toEqual(['<image> cannot be deleted as a block']);
  });

  test('executeRangeAction announces confirmed cell-rectangle merge success', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a</entry><entry>b</entry></row><row><entry>c</entry><entry>d</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellRectMerge', ids);

    expect(ctx.applied[0]).toContain('<entry namest="c1" nameend="c2" morerows="1">a b c d</entry>');
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['Cells merged.']);
  });

  test('executeRangeAction clears selected table cells atomically', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellClear', ids);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry/><entry/></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['2 cells cleared.']);
  });

  test('executeRangeAction clears later cells after inline children restamp generated ids', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a <image href="seat.jpg"/> tail</entry><entry>b</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellClear', ids);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry/><entry/></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.announced).toEqual(['2 cells cleared.']);
  });

  test('executeRangeAction clears a selected cell containing block children', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry><p>First</p><p>Second</p></entry><entry>keep</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellClear', [ids[0]]);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry/><entry>keep</entry></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['Cell cleared.']);
  });

  test('executeRangeAction replaces selected table cells with pasted text atomically', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellTextReplace', ids, ['A & B', 'C < D']);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry>A &amp; B</entry><entry>C &lt; D</entry></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['2 cells updated.']);
  });

  test('executeRangeAction replaces later cells after inline children restamp generated ids', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a <image href="seat.jpg"/> tail</entry><entry>b</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellTextReplace', ids, ['left', 'right']);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry>left</entry><entry>right</entry></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.announced).toEqual(['2 cells updated.']);
  });

  test('executeRangeAction replaces selected cells that contain block children', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry><p>First</p><p>Second</p></entry><entry><p>Third</p></entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellTextReplace', ids, ['left', 'right']);

    expect(ctx.applied).toEqual([
      TOPIC(
        '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
          '<tbody><row><entry>left</entry><entry>right</entry></row></tbody></tgroup></table>',
      ),
    ]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.announced).toEqual(['2 cells updated.']);
  });

  test('executeRangeAction refuses mismatched cell paste payloads without applying bytes', async () => {
    const table =
      '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
      '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>';
    const src = TOPIC(table);
    const ids = idsByName(src, 'entry');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'cellTextReplace', ids, ['only one value']);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.cleared).toBe(0);
    expect(ctx.announced).toEqual(['The pasted cell data did not match the selected cells.']);
  });

  test('executeRangeAction announces a refusal without applying bytes', async () => {
    const src = TOPIC('<p>one</p><p>two</p>');
    const ids = idsByName(src, 'p');
    const ctx = makeContext(src);

    await executeRangeAction(ctx, 'rangeDelete', ids);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.cleared).toBe(0);
    expect(ctx.announced).toEqual(["Can't delete every item in its container."]);
  });

  test('rangeRefusalMessage maps common execute-time refusals to readable announcements', () => {
    expect(rangeRefusalMessage({ code: 'unsupported-prespanned', reason: 'planner detail' })).toBe(
      'This selection includes an already-merged cell.',
    );
    expect(rangeRefusalMessage({ code: 'not-rectangular', reason: 'planner detail' })).toBe(
      'Select a complete rectangle to merge.',
    );
    expect(rangeRefusalMessage({ code: 'value-count-mismatch', reason: 'planner detail' })).toBe(
      'The pasted cell data did not match the selected cells.',
    );
    expect(rangeRefusalMessage({ code: 'custom', reason: 'Use the original reason.' })).toBe(
      'Use the original reason.',
    );
  });

  test('rangeSuccessMessage maps successful range actions to readable announcements', () => {
    expect(rangeSuccessMessage('rangeDelete', 1)).toBe('Item deleted.');
    expect(rangeSuccessMessage('rangeDelete', 3)).toBe('3 items deleted.');
    expect(rangeSuccessMessage('cellRectMerge', 4)).toBe('Cells merged.');
    expect(rangeSuccessMessage('cellClear', 1)).toBe('Cell cleared.');
    expect(rangeSuccessMessage('cellClear', 2)).toBe('2 cells cleared.');
    expect(rangeSuccessMessage('cellTextReplace', 1)).toBe('Cell updated.');
    expect(rangeSuccessMessage('cellTextReplace', 2)).toBe('2 cells updated.');
  });
});
