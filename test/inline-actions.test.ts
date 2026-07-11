import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import { editableElementIds } from '../src/cst/text-targets';
import type { ElementNode } from '../src/cst/types';
import {
  editInlineText,
  formatInlineBlocks,
  formatInlineSelection,
  insertInlineElement,
  removeInlineStylesFromBlocks,
  removeInlineStylesFromSelection,
  type InlineActionContext,
} from '../src/host/inline-actions';

const TOPIC = (body: string) => `<topic id="t"><title>T</title><body>${body}</body></topic>`;

function elIds(src: string, name: string): string[] {
  const doc = parse(src);
  const out: string[] = [];
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) out.push(id);
  }
  return out;
}

function editId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of editableElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no editable <${name}>`);
}

function makeContext(source: string, startVersion = 0): InlineActionContext & {
  applied: string[];
  announced: string[];
  pushed: Array<[string | null, number | null]>;
  cleared: number;
  version(): number;
} {
  let structVersion = startVersion;
  const ctx = {
    applied: [] as string[],
    announced: [] as string[],
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
    getStructVersion: () => structVersion,
    bumpStructVersion: () => {
      structVersion++;
    },
    version: () => structVersion,
  };
  return ctx;
}

describe('inline host actions', () => {
  test('editInlineText applies plain text without forcing a rerender', async () => {
    const src = TOPIC('<p>old</p>');
    const ctx = makeContext(src);

    await editInlineText(ctx, editId(src, 'p'), 'new & value', null);

    expect(ctx.applied).toEqual([TOPIC('<p>new &amp; value</p>')]);
    expect(ctx.pushed).toEqual([]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(0);
  });

  test('formatInlineSelection wraps the selected run, bumps the structure version, and focuses the leaf', async () => {
    const src = TOPIC('<p>foo bar</p>');
    const id = editId(src, 'p');
    const ctx = makeContext(src);

    await formatInlineSelection(ctx, id, 'b', 'foo ', 'bar', '', 0);

    expect(ctx.applied).toEqual([TOPIC('<p>foo <b>bar</b></p>')]);
    expect(ctx.pushed).toEqual([[id, 7]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
  });

  test('formatInlineSelection can restore the original caret inside an expanded word', async () => {
    const src = TOPIC('<p>foo bar</p>');
    const id = editId(src, 'p');
    const ctx = makeContext(src);

    await formatInlineSelection(ctx, id, 'b', 'foo ', 'bar', '', 0, 5);

    expect(ctx.applied).toEqual([TOPIC('<p>foo <b>bar</b></p>')]);
    expect(ctx.pushed).toEqual([[id, 5]]);
    expect(ctx.version()).toBe(1);
  });

  test('formatInlineSelection keeps a mixed text-run focus id so the caret restores inside the run', async () => {
    const src = TOPIC('<li>alpha<ul><li>nested</li></ul></li>');
    const runId = `${elIds(src, 'li')[0]}:t0`;
    const ctx = makeContext(src);

    await formatInlineSelection(ctx, runId, 'b', '', 'alpha', '', 0);

    expect(ctx.applied[0]).toContain('<li><b>alpha</b><ul><li>nested</li></ul></li>');
    expect(ctx.pushed).toEqual([[runId, 5]]);
    expect(ctx.version()).toBe(1);
  });

  test('formatInlineBlocks rejects stale render-cycle ids without applying bytes', async () => {
    const src = TOPIC('<p>one</p><p>two</p>');
    const ids = elIds(src, 'p');
    const ctx = makeContext(src, 3);

    await formatInlineBlocks(ctx, ids, 'b', 2);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(3);
  });

  test('formatInlineBlocks applies one multi-block edit and resyncs selection maps', async () => {
    const src = TOPIC('<p>one</p><p>two</p>');
    const ids = elIds(src, 'p');
    const ctx = makeContext(src);

    await formatInlineBlocks(ctx, ids, 'i', 0);

    expect(ctx.applied[0]).toContain('<p><i>one</i></p>');
    expect(ctx.applied[0]).toContain('<p><i>two</i></p>');
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
  });

  test('removeInlineStylesFromSelection unwraps only the selected text range', async () => {
    const src = TOPIC('<p><b>foobar</b></p>');
    const id = elIds(src, 'p')[0];
    const ctx = makeContext(src);

    await removeInlineStylesFromSelection(ctx, id, 'f', 'oob', 'ar', 0);

    expect(ctx.applied).toEqual([TOPIC('<p><b>f</b>oob<b>ar</b></p>')]);
    expect(ctx.pushed).toEqual([[id, 4]]);
    expect(ctx.version()).toBe(1);
  });

  test('removeInlineStylesFromSelection can restore the original caret inside an expanded word', async () => {
    const src = TOPIC('<p><b>foobar</b></p>');
    const id = elIds(src, 'p')[0];
    const ctx = makeContext(src);

    await removeInlineStylesFromSelection(ctx, id, '', 'foobar', '', 0, 2);

    expect(ctx.applied).toEqual([TOPIC('<p>foobar</p>')]);
    expect(ctx.pushed).toEqual([[id, 2]]);
    expect(ctx.version()).toBe(1);
  });

  test('removeInlineStylesFromBlocks applies one multi-block style removal', async () => {
    const src = TOPIC('<p><b>one</b></p><p><i>two</i></p>');
    const ids = elIds(src, 'p');
    const ctx = makeContext(src);

    await removeInlineStylesFromBlocks(ctx, ids, 0);

    expect(ctx.applied).toEqual([TOPIC('<p>one</p><p>two</p>')]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(1);
  });

  test('insertInlineElement waits until after the stale guard before resolving prompts', async () => {
    const src = TOPIC('<p>ab</p>');
    const ctx = makeContext(src, 2);
    let prompts = 0;

    await insertInlineElement(ctx, editId(src, 'p'), 'a', 'b', 1, async () => {
      prompts++;
      return {
        spec: { name: 'image', attrs: [{ name: 'href', value: '' }], selfClosing: true },
      };
    });

    expect(prompts).toBe(0);
    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
  });

  test('insertInlineElement applies a resolved inline image and announces insertion', async () => {
    const src = TOPIC('<p>ab</p>');
    const id = editId(src, 'p');
    const ctx = makeContext(src);

    await insertInlineElement(ctx, id, 'a', 'b', 0, async () => ({
      spec: { name: 'image', attrs: [{ name: 'href', value: '../images/img_062.jpeg' }], selfClosing: true },
      successAnnouncement: 'Image inserted: img_062.jpeg.',
    }));

    expect(ctx.applied).toEqual([TOPIC('<p>a<image href="../images/img_062.jpeg"/>b</p>')]);
    expect(ctx.pushed).toEqual([[id, null]]);
    expect(ctx.announced).toEqual(['Image inserted: img_062.jpeg.']);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
  });

  test('insertInlineElement keeps mixed text-run focus ids after insertion', async () => {
    const src = TOPIC('<li>ab<ul><li>nested</li></ul></li>');
    const runId = `${elIds(src, 'li')[0]}:t0`;
    const ctx = makeContext(src);

    await insertInlineElement(ctx, runId, 'a', 'b', 0, async () => ({
      spec: { name: 'xref', attrs: [{ name: 'href', value: 'target.dita' }], innerText: 'target' },
    }));

    expect(ctx.applied[0]).toContain('<li>a<xref href="target.dita">target</xref>b<ul><li>nested</li></ul></li>');
    expect(ctx.pushed).toEqual([[runId, null]]);
  });
});
