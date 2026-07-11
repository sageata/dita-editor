import { describe, expect, test } from 'bun:test';
import { indexDocument } from '../src/commands/validity';
import type { ElementNode } from '../src/cst/types';
import {
  applyMultiTransformAction,
  applyStructuralAction,
  applyTransformAction,
  type StructuralActionContext,
} from '../src/host/structural-actions';
import type { ApplyMinimalHistory } from '../src/host/action-contexts';

function idOf(src: string, name: string, text?: string): string {
  const idx = indexDocument(src);
  for (const [id, el] of idx.byId) {
    if ((el as ElementNode).name !== name) continue;
    if (text !== undefined) {
      const actual = el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim();
      if (actual !== text) continue;
    }
    return id;
  }
  throw new Error(`no <${name}>`);
}

function elementNameAt(src: string, id: string | null): string | undefined {
  if (id == null) return undefined;
  return indexDocument(src).byId.get(id)?.name;
}

function makeContext(source: string, startVersion = 0): StructuralActionContext & {
  applied: string[];
  announced: string[];
  errors: string[];
  diagnostics: string[];
  pushed: Array<[string | null, number | null]>;
  histories: Array<ApplyMinimalHistory | undefined>;
  cleared: number;
  version(): number;
} {
  let structVersion = startVersion;
  const ctx = {
    applied: [] as string[],
    announced: [] as string[],
    errors: [] as string[],
    diagnostics: [] as string[],
    pushed: [] as Array<[string | null, number | null]>,
    histories: [] as Array<ApplyMinimalHistory | undefined>,
    cleared: 0,
    document: {
      getText: () => source,
    },
    applyMinimal: async (newSource: string, history?: ApplyMinimalHistory) => {
      ctx.applied.push(newSource);
      ctx.histories.push(history);
      source = newSource;
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
    setRefusedDiagnostic: (op: string) => {
      ctx.diagnostics.push(op);
    },
    getStructVersion: () => structVersion,
    bumpStructVersion: () => {
      structVersion++;
    },
    version: () => structVersion,
  };
  return ctx;
}

describe('structural host actions', () => {
  test('applyStructuralAction applies one structural edit, bumps the render-cycle version, and announces confirmed success', async () => {
    const src = '<body><p>one</p></body>';
    const ctx = makeContext(src);

    await applyStructuralAction(ctx, 'addParaAfter', idOf(src, 'p'), {}, 0, 'Paragraph added.');

    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0]).toContain('<p>');
    expect(ctx.pushed).toHaveLength(1);
    expect(typeof ctx.pushed[0][0]).toBe('string');
    expect(ctx.pushed[0][1]).toBe(0);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['Paragraph added.']);
  });

  test('applyStructuralAction rejects stale render-cycle ids without applying bytes', async () => {
    const src = '<body><p>one</p></body>';
    const ctx = makeContext(src, 2);

    await applyStructuralAction(ctx, 'addParaAfter', idOf(src, 'p'), {}, 1);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(2);
  });

  test('applyStructuralAction surfaces refused operations as diagnostics, announcements, and visible errors', async () => {
    const src = '<topic id="t"><title>T</title><body><p>x</p></body></topic>';
    const ctx = makeContext(src);

    await applyStructuralAction(ctx, 'deleteTitle', idOf(src, 'title'), {}, 0);

    expect(ctx.applied).toEqual([]);
    expect(ctx.diagnostics).toEqual(['deleteTitle']);
    expect(ctx.announced[0]).toMatch(/required/i);
    expect(ctx.errors[0]).toBe(ctx.announced[0]);
    expect(ctx.pushed).toEqual([[null, null]]);
  });

  test('applyTransformAction resolves a focused list item to its list for list-kind transforms', async () => {
    const src = '<body><ul><li>a</li></ul></body>';
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'toOrderedList', idOf(src, 'li', 'a'));

    expect(ctx.applied).toEqual(['<body><ol><li>a</li></ol></body>']);
    expect(ctx.pushed).toHaveLength(1);
    expect(elementNameAt(ctx.applied[0], ctx.pushed[0][0])).toBe('li');
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['List converted to numbered list.']);
  });

  test('applyTransformAction announces list-item to paragraph conversion after the host write', async () => {
    const src = '<body><ul><li>a</li></ul></body>';
    const ctx = makeContext(src);
    const beforeId = idOf(src, 'li', 'a');

    await applyTransformAction(ctx, 'itemToParagraph', beforeId);

    expect(ctx.applied).toEqual(['<body><p>a</p></body>']);
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.histories[0]).toEqual({
      beforeFocusId: beforeId,
      beforeCaretOffset: null,
      afterFocusId: ctx.pushed[0][0],
      afterCaretOffset: ctx.pushed[0][1],
    });
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['List item converted to paragraph.']);
  });

  test('applyTransformAction joins a paragraph before a list as its first item', async () => {
    const src = `<body>
  <p>x</p>
  <ul>
    <li>a</li>
  </ul>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'paragraphToItem', idOf(src, 'p', 'x'));

    expect(ctx.applied).toEqual([`<body>
  <ul>
    <li>x</li>
    <li>a</li>
  </ul>
</body>`]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['Paragraph converted to list item.']);
  });

  test('applyTransformAction joins a paragraph after a list as its last item', async () => {
    const src = `<body>
  <ul>
    <li>a</li>
  </ul>
  <p>x</p>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'paragraphToItem', idOf(src, 'p', 'x'));

    expect(ctx.applied).toEqual([`<body>
  <ul>
    <li>a</li>
    <li>x</li>
  </ul>
</body>`]);
    expect(ctx.announced).toEqual(['Paragraph converted to list item.']);
  });

  test('applyTransformAction converts a paragraph into a one-item unordered list', async () => {
    const src = `<body>
  <p>x</p>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'paragraphToUnorderedList', idOf(src, 'p', 'x'));

    expect(ctx.applied).toEqual([`<body>
  <ul>
    <li>x</li>
  </ul>
</body>`]);
    expect(ctx.announced).toEqual(['Paragraph converted to bulleted list.']);
  });

  test('applyTransformAction converts a paragraph into a note block', async () => {
    const src = `<body>
  <p>x</p>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'paragraphToNote', idOf(src, 'p', 'x'));

    expect(ctx.applied).toEqual([`<body>
  <note>
    <p>x</p>
  </note>
</body>`]);
    expect(ctx.announced).toEqual(['Paragraph converted to note.']);
  });

  test('applyTransformAction converts direct table-cell text into a bulleted list', async () => {
    const bullet = '\u2022';
    const src = `<table><tgroup cols="1"><tbody><row><entry>${bullet} A ${bullet} B</entry></row></tbody></tgroup></table>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'entryToUnorderedList', idOf(src, 'entry'));

    expect(ctx.applied).toEqual([
      '<table><tgroup cols="1"><tbody><row><entry><ul><li>A</li><li>B</li></ul></entry></row></tbody></tgroup></table>',
    ]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['Cell content converted to bulleted list.']);
  });

  test('applyTransformAction converts focused lines into a paragraph', async () => {
    const src = `<body>
  <lines>a
b</lines>
</body>`;
    const ctx = makeContext(src);
    const beforeId = idOf(src, 'lines');

    await applyTransformAction(ctx, 'linesToParagraph', beforeId);

    expect(ctx.applied).toEqual([`<body>
  <p>a b</p>
</body>`]);
    expect(ctx.histories[0]).toEqual({
      beforeFocusId: beforeId,
      beforeCaretOffset: null,
      afterFocusId: ctx.pushed[0][0],
      afterCaretOffset: ctx.pushed[0][1],
    });
    expect(ctx.announced).toEqual(['Lines converted to paragraph.']);
  });

  test('applyTransformAction converts a middle list-item to a paragraph by splitting the list', async () => {
    const src = `<body>
  <ul>
    <li>a</li>
    <li>b</li>
    <li>c</li>
  </ul>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'itemToParagraph', idOf(src, 'li', 'b'));

    expect(ctx.applied).toEqual([`<body>
  <ul>
    <li>a</li>
  </ul>
  <p>b</p>
  <ul>
    <li>c</li>
  </ul>
</body>`]);
    expect(ctx.diagnostics).toEqual([]);
    expect(ctx.announced).toEqual(['List item converted to paragraph.']);
    expect(ctx.version()).toBe(1);
  });

  test('applyTransformAction rejoins a paragraph split from the middle of a list', async () => {
    const src = `<body>
  <ul>
    <li>a</li>
    <li>b</li>
    <li>c</li>
  </ul>
</body>`;
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'itemToParagraph', idOf(src, 'li', 'b'));
    await applyTransformAction(ctx, 'paragraphToItem', idOf(ctx.applied[0], 'p', 'b'));

    expect(ctx.applied[1]).toBe(`<body>
  <ul>
    <li>a</li>
    <li>b</li>
    <li>c</li>
  </ul>
</body>`);
    expect(elementNameAt(ctx.applied[1], ctx.pushed[1][0])).toBe('li');
    expect(ctx.announced).toEqual(['List item converted to paragraph.', 'Paragraph converted to list item.']);
    expect(ctx.version()).toBe(2);
  });

  test('applyTransformAction resyncs and diagnoses no-op transforms without writing bytes', async () => {
    const src = '<body><ol><li>a</li></ol></body>';
    const ctx = makeContext(src);

    await applyTransformAction(ctx, 'toOrderedList', idOf(src, 'li', 'a'));

    expect(ctx.applied).toEqual([]);
    expect(ctx.diagnostics).toEqual(['toOrderedList']);
    expect(ctx.announced).toEqual(['List is already numbered']);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(0);
  });

  test('applyMultiTransformAction converts multiple selected list items through their parent lists', async () => {
    const src = '<body><ul><li>a</li></ul><p>gap</p><ul><li>b</li></ul></body>';
    const ctx = makeContext(src);

    await applyMultiTransformAction(ctx, 'toOrderedList', [idOf(src, 'li', 'a'), idOf(src, 'li', 'b')], 0);

    expect(ctx.applied).toEqual(['<body><ol><li>a</li></ol><p>gap</p><ol><li>b</li></ol></body>']);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['2 lists converted to numbered lists.']);
  });

  test('applyMultiTransformAction dedupes several selected items from the same list', async () => {
    const src = '<body><ul><li>a</li><li>b</li></ul></body>';
    const ctx = makeContext(src);

    await applyMultiTransformAction(ctx, 'toOrderedList', [idOf(src, 'li', 'a'), idOf(src, 'li', 'b')], 0);

    expect(ctx.applied).toEqual(['<body><ol><li>a</li><li>b</li></ol></body>']);
    expect(ctx.announced).toEqual(['List converted to numbered list.']);
    expect(ctx.version()).toBe(1);
  });

  test('applyMultiTransformAction reports all-noop list conversions without writing bytes', async () => {
    const src = '<body><ol><li>a</li></ol><ol><li>b</li></ol></body>';
    const ctx = makeContext(src);

    await applyMultiTransformAction(ctx, 'toOrderedList', [idOf(src, 'li', 'a'), idOf(src, 'li', 'b')], 0);

    expect(ctx.applied).toEqual([]);
    expect(ctx.diagnostics).toEqual(['toOrderedList']);
    expect(ctx.announced).toEqual(['Selected lists are already numbered.']);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(0);
  });

  test('applyMultiTransformAction converts multiple selected paragraphs through the batch transform path', async () => {
    const src = '<body><p>a</p><p>b</p><p>c</p></body>';
    const ctx = makeContext(src);

    await applyMultiTransformAction(ctx, 'paragraphToUnorderedList', [idOf(src, 'p', 'a'), idOf(src, 'p', 'c')], 0);

    expect(ctx.applied).toEqual(['<body><ul>\n  <li>a</li>\n</ul><p>b</p><ul>\n  <li>c</li>\n</ul></body>']);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.cleared).toBe(1);
    expect(ctx.version()).toBe(1);
    expect(ctx.announced).toEqual(['2 paragraphs converted to bulleted lists.']);
  });

  test('applyMultiTransformAction rejects stale render-cycle ids without applying bytes', async () => {
    const src = '<body><ul><li>a</li></ul></body>';
    const ctx = makeContext(src, 3);

    await applyMultiTransformAction(ctx, 'toOrderedList', [idOf(src, 'li', 'a')], 2);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pushed).toEqual([[null, null]]);
    expect(ctx.version()).toBe(3);
  });

  test('applyMultiTransformAction refuses content-moving transforms for multi-selection', async () => {
    const src = '<body><ul><li>a</li></ul><p>b</p></body>';
    const ctx = makeContext(src);

    await applyMultiTransformAction(ctx, 'paragraphToItem', [idOf(src, 'p', 'b')], 0);

    expect(ctx.applied).toEqual([]);
    expect(ctx.diagnostics).toEqual(['paragraphToItem']);
    expect(ctx.announced).toEqual(['That transform is not available for multi-selection yet.']);
    expect(ctx.pushed).toEqual([[null, null]]);
  });
});
