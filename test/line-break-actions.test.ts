import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import { applyLineBreakAction, type LineBreakActionContext } from '../src/host/line-break-actions';

function idOf(source: string, name: string): string {
  const doc = parse(source);
  const ids = assignElementIds(doc);
  for (const [el, id] of ids) if (el.name === name) return id;
  throw new Error(`no <${name}>`);
}

function makeContext(source: string): LineBreakActionContext & {
  applied: string[];
  pushed: Array<[string | null, number | null]>;
  cleared: number;
  version: number;
} {
  const ctx = {
    applied: [] as string[],
    pushed: [] as Array<[string | null, number | null]>,
    cleared: 0,
    version: 0,
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
    clearDiagnostics: () => {
      ctx.cleared++;
    },
    bumpStructVersion: () => {
      ctx.version++;
    },
    setRefusedDiagnostic: () => undefined,
    announce: () => undefined,
  };
  return ctx;
}

describe('applyLineBreakAction', () => {
  test('writes a semantic lines block and restores the caret inside it', async () => {
    const src = '<body><p>Hello tail</p></body>';
    const ctx = makeContext(src);

    await applyLineBreakAction(ctx, idOf(src, 'p'), 'Hello\ntail', 6);

    expect(ctx.applied).toEqual(['<body><lines>Hello\ntail</lines></body>']);
    expect(ctx.pushed).toEqual([[idOf(ctx.applied[0], 'lines'), 6]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version).toBe(1);
  });
});
