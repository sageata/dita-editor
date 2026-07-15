import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-command-insert.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasCommandInsert: {
      blockInsertPlacement: (current: Record<string, string | number | boolean | null> | null) => Placement | null;
      payloadForPlacement: (placement: Placement) => Record<string, string>;
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasCommandInsert;
}

interface Placement {
  mode: string;
  idField: string;
  id: string;
  label: string;
}

describe('canvas-command-insert', () => {
  test('uses after placement for supported structural anchors by default', () => {
    const helper = loadHelper();

    const placement = helper.blockInsertPlacement({ kind: 'p', id: 'e4' });

    expect(placement).toEqual({ mode: 'after', idField: 'refId', id: 'e4', label: 'after' });
    expect(helper.payloadForPlacement(placement!)).toEqual({ mode: 'after', refId: 'e4' });
  });

  test('uses before placement at the start of an editable paragraph or list item', () => {
    const helper = loadHelper();

    const paragraph = helper.blockInsertPlacement({ kind: 'p', id: 'e4', isCollapsed: true, caretOffset: 0 });
    const item = helper.blockInsertPlacement({ kind: 'li', id: 'e8', isCollapsed: true, caretOffset: 0 });

    expect(paragraph).toEqual({ mode: 'before', idField: 'refId', id: 'e4', label: 'before' });
    expect(helper.payloadForPlacement(paragraph!)).toEqual({ mode: 'before', refId: 'e4' });
    expect(item).toEqual({ mode: 'before', idField: 'refId', id: 'e8', label: 'before' });
  });

  test('keeps after placement when the caret is not collapsed at the start', () => {
    const helper = loadHelper();

    expect(helper.blockInsertPlacement({ kind: 'p', id: 'e4', isCollapsed: true, caretOffset: 3 })).toEqual({
      mode: 'after',
      idField: 'refId',
      id: 'e4',
      label: 'after',
    });
    expect(helper.blockInsertPlacement({ kind: 'p', id: 'e4', isCollapsed: false, caretOffset: 0 })).toEqual({
      mode: 'after',
      idField: 'refId',
      id: 'e4',
      label: 'after',
    });
  });

  test('uses inside-cell placement when the command bar is focused in a table cell', () => {
    const helper = loadHelper();

    const placement = helper.blockInsertPlacement({ kind: 'row', id: 'e10', cellEntryId: 'e12' });

    expect(placement).toEqual({ mode: 'into', idField: 'containerId', id: 'e12', label: 'inside this cell' });
    expect(helper.payloadForPlacement(placement!)).toEqual({ mode: 'into', containerId: 'e12' });
  });

  test('keeps inside-cell placement when direct cell content is the current entry target', () => {
    const helper = loadHelper();

    const placement = helper.blockInsertPlacement({ kind: 'entry', id: 'e12', cellEntryId: 'e12' });

    expect(placement).toEqual({ mode: 'into', idField: 'containerId', id: 'e12', label: 'inside this cell' });
  });

  test('does not append blocks to the bottom of a direct-text note', () => {
    const helper = loadHelper();

    const placement = helper.blockInsertPlacement({ kind: 'note', id: 'e6' });

    expect(placement).toBeNull();
  });

  test('refuses unsupported anchors instead of relying on host refusal', () => {
    const helper = loadHelper();

    expect(helper.blockInsertPlacement({ kind: 'title', id: 'e1' })).toBeNull();
    expect(helper.blockInsertPlacement({ kind: 'row', id: 'e2', cellEntryId: null })).toBeNull();
    expect(helper.blockInsertPlacement(null)).toBeNull();
  });
});
