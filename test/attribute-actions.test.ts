import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import {
  applyElementAttribute,
  applyElementAttributeToIds,
  applyTgroupAttributes,
  type AttributeActionContext,
} from '../src/host/attribute-actions';

const TOPIC = (body: string) => `<topic id="t"><title>T</title><body>${body}</body></topic>`;

function firstElementId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === name) return id;
  }
  throw new Error(`missing <${name}>`);
}

function makeContext(source: string): AttributeActionContext & {
  applied: string[];
  announced: string[];
  errors: string[];
  pushed: Array<[string | null, number | null]>;
  cleared: number;
} {
  const ctx = {
    applied: [] as string[],
    announced: [] as string[],
    errors: [] as string[],
    pushed: [] as Array<[string | null, number | null]>,
    cleared: 0,
    document: {
      getText: () => source,
    },
    applyMinimal: async (newSource: string) => {
      ctx.applied.push(newSource);
      return true;
    },
    pushBody: (focusId: string | null, caretOffset: number | null) => {
      ctx.pushed.push([focusId, caretOffset]);
    },
    announce: (message: string) => {
      ctx.announced.push(message);
    },
    postError: (message: string) => {
      ctx.errors.push(message);
    },
    clearDiagnostics: () => {
      ctx.cleared++;
    },
  };
  return ctx;
}

describe('applyElementAttribute', () => {
  test('sets an attribute and re-renders the focused element', async () => {
    const src = TOPIC('<p>x</p>');
    const id = firstElementId(src, 'p');
    const ctx = makeContext(src);

    await applyElementAttribute(ctx, id, 'audience', 'crew');

    expect(ctx.applied).toEqual([TOPIC('<p audience="crew">x</p>')]);
    expect(ctx.pushed).toEqual([[id, null]]);
    expect(ctx.announced).toContain('audience updated.');
    expect(ctx.cleared).toBe(1);
  });

  test('clears an existing attribute', async () => {
    const src = TOPIC('<p status="draft">x</p>');
    const id = firstElementId(src, 'p');
    const ctx = makeContext(src);

    await applyElementAttribute(ctx, id, 'status', '');

    expect(ctx.applied).toEqual([TOPIC('<p>x</p>')]);
    expect(ctx.announced).toContain('status cleared.');
  });

  test('clearing an absent attribute is a no-op', async () => {
    const src = TOPIC('<p>x</p>');
    const id = firstElementId(src, 'p');
    const ctx = makeContext(src);

    await applyElementAttribute(ctx, id, 'status', '');

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.announced).toEqual([]);
  });

  test('invalid id values are refused without applying bytes', async () => {
    const src = TOPIC('<p>x</p>');
    const id = firstElementId(src, 'p');
    const ctx = makeContext(src);

    await applyElementAttribute(ctx, id, 'id', 'bad id');

    expect(ctx.applied).toEqual([]);
    expect(ctx.errors[0]).toMatch(/XML name/);
    expect(ctx.announced[0]).toMatch(/XML name/);
  });

  test('stale ids resync without applying bytes', async () => {
    const src = TOPIC('<p>x</p>');
    const ctx = makeContext(src);

    await applyElementAttribute(ctx, 'e999', 'audience', 'crew');

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
  });

  test('parse errors resync without applying bytes', async () => {
    const ctx = makeContext('<topic><body><p>x</body></topic>');

    await applyElementAttribute(ctx, 'e1', 'audience', 'crew');

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
  });

  test('CALS enum attributes refuse out-of-set values before any bytes change (F1/F3/F4/F5)', async () => {
    const src = TOPIC('<p>x</p>');
    const id = firstElementId(src, 'p');
    for (const [name, bad] of [
      ['frame', 'thick'],
      ['colsep', '2'],
      ['rowsep', 'yes'],
      ['align', 'middle'],
      ['valign', 'center'],
    ] as const) {
      const ctx = makeContext(src);
      await applyElementAttribute(ctx, id, name, bad);
      expect(ctx.applied).toEqual([]);
      expect(ctx.errors.length).toBe(1);
      expect(ctx.errors[0]).toContain(name);
    }
  });

  test('CALS enum attributes accept their enum values', async () => {
    const src = TOPIC('<p>x</p>');
    const id = firstElementId(src, 'p');
    const ctx = makeContext(src);
    await applyElementAttribute(ctx, id, 'align', 'center');
    expect(ctx.applied).toEqual([TOPIC('<p align="center">x</p>')]);
  });
});

const TABLE = TOPIC(
  '<table><tgroup cols="2"><colspec colname="c1" colnum="1"/><colspec colname="c2" colnum="2"/>' +
    '<tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table>',
);

function idsNamed(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === name) out.push(id);
  }
  return out;
}

describe('applyElementAttributeToIds (setAttrMulti)', () => {
  test('sets the attribute on every id in ONE apply', async () => {
    const ids = idsNamed(TABLE, 'entry');
    const ctx = makeContext(TABLE);

    await applyElementAttributeToIds(ctx, ids, 'align', 'center');

    expect(ctx.applied.length).toBe(1);
    expect(ctx.applied[0]).toContain('<entry align="center">a</entry>');
    expect(ctx.applied[0]).toContain('<entry align="center">b</entry>');
    expect(ctx.announced[0]).toContain('2 elements');
  });

  test('all-stale ids resync without applying', async () => {
    const ctx = makeContext(TABLE);
    await applyElementAttributeToIds(ctx, ['e900', 'e901'], 'align', 'center');
    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
  });

  test('invalid enum value refuses before any bytes change', async () => {
    const ctx = makeContext(TABLE);
    await applyElementAttributeToIds(ctx, idsNamed(TABLE, 'entry'), 'valign', 'sideways');
    expect(ctx.applied).toEqual([]);
    expect(ctx.errors.length).toBe(1);
  });
});

describe('applyTgroupAttributes (setTgroupAttr)', () => {
  test('descends from the table id to the (unstamped) tgroup and sets both seps in one apply', async () => {
    const tableId = firstElementId(TABLE, 'table');
    const ctx = makeContext(TABLE);

    await applyTgroupAttributes(ctx, tableId, [
      { name: 'colsep', value: '1' },
      { name: 'rowsep', value: '1' },
    ]);

    expect(ctx.applied.length).toBe(1);
    expect(ctx.applied[0]).toContain('<tgroup cols="2" colsep="1" rowsep="1">');
    expect(ctx.pushed).toEqual([[tableId, null]]);
  });

  test('clearing absent seps is a no-op; unknown table id resyncs', async () => {
    const tableId = firstElementId(TABLE, 'table');
    const noop = makeContext(TABLE);
    await applyTgroupAttributes(noop, tableId, [
      { name: 'colsep', value: '' },
      { name: 'rowsep', value: '' },
    ]);
    expect(noop.applied).toEqual([]);

    const stale = makeContext(TABLE);
    await applyTgroupAttributes(stale, 'e999', [{ name: 'colsep', value: '1' }]);
    expect(stale.applied).toEqual([]);
    expect(stale.pushed).toEqual([[null, null]]);
  });
});
