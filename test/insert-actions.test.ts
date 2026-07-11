import { describe, expect, test } from 'bun:test';
import { indexDocument } from '../src/commands/validity';
import type { ElementNode } from '../src/cst/types';
import {
  applyInsertAction,
  type InsertActionContext,
} from '../src/host/insert-actions';

function idOf(src: string, name: string): string {
  const idx = indexDocument(src);
  for (const [id, el] of idx.byId) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no <${name}>`);
}

function makeContext(source: string): InsertActionContext & {
  applied: string[];
  announced: string[];
  diagnostics: string[];
  pushed: Array<[string | null, number | null]>;
  cleared: number;
  version(): number;
} {
  let structVersion = 0;
  const ctx = {
    applied: [] as string[],
    announced: [] as string[],
    diagnostics: [] as string[],
    pushed: [] as Array<[string | null, number | null]>,
    cleared: 0,
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
    setRefusedDiagnostic: (op: string) => {
      ctx.diagnostics.push(op);
    },
    bumpStructVersion: () => {
      structVersion++;
    },
    version: () => structVersion,
  };
  return ctx;
}

describe('applyInsertAction', () => {
  test('applies a block insert, clears diagnostics, bumps version, and focuses the new element', async () => {
    const src = '<body><p>intro</p></body>';
    const ctx = makeContext(src);

    await applyInsertAction(ctx, 'paragraph', { mode: 'after', refId: idOf(src, 'p') });

    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0]).toContain('<p></p>');
    expect(ctx.pushed).toHaveLength(1);
    expect(typeof ctx.pushed[0][0]).toBe('string');
    expect(ctx.pushed[0][1]).toBe(0);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['Paragraph inserted.']);
    expect(ctx.diagnostics).toEqual([]);
  });

  test('announces the concrete inserted structure after a successful host write', async () => {
    const src = '<body><p>intro</p></body>';
    const ctx = makeContext(src);

    await applyInsertAction(ctx, 'table', { mode: 'after', refId: idOf(src, 'p') });

    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0]).toContain('<table>');
    expect(ctx.announced).toEqual(['Table inserted.']);
  });

  test('refuses stale ids without applying bytes', async () => {
    const src = '<body><p>intro</p></body>';
    const ctx = makeContext(src);

    await applyInsertAction(ctx, 'paragraph', { mode: 'after', refId: 'e999' });

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.announced).toEqual(['That insert target is no longer available. Select the element again and retry.']);
    expect(ctx.diagnostics).toEqual(['paragraph']);
    expect(ctx.cleared).toBe(0);
    expect(ctx.version()).toBe(0);
  });

  test('announces the exact content-model refusal from the insert core', async () => {
    const src = '<body><table><tgroup cols="1"><tbody><row><entry>cell</entry></row></tbody></tgroup></table></body>';
    const ctx = makeContext(src);

    await applyInsertAction(ctx, 'section', { mode: 'into', containerId: idOf(src, 'entry') });

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.announced).toEqual(['<section> is not permitted inside <entry>']);
    expect(ctx.diagnostics).toEqual(['section']);
    expect(ctx.cleared).toBe(0);
    expect(ctx.version()).toBe(0);
  });
});
