import { describe, expect, test } from 'bun:test';
import type * as vscode from 'vscode';
import { createVisualActionContexts } from '../src/host/action-contexts';
import type { RangeActionAvailability } from '../src/webview/canvas-messages';

describe('createVisualActionContexts', () => {
  test('wires each host action context to the shared provider callbacks', async () => {
    let source = '<topic/>';
    let version = 2;
    const applied: string[] = [];
    const pushed: Array<[string | null, number | null]> = [];
    const announced: string[] = [];
    const errors: string[] = [];
    const refused: string[] = [];
    const rangePosts: Array<{ ids: string[]; actions: RangeActionAvailability[] }> = [];
    let clears = 0;

    const document = {
      getText: () => source,
    } as vscode.TextDocument;
    const folder = { name: 'workspace' } as vscode.WorkspaceFolder;
    const contexts = createVisualActionContexts({
      document,
      folder,
      applyMinimal: async (newSource: string) => {
        source = newSource;
        applied.push(newSource);
        return true;
      },
      pushBody: (focusId: string | null, caretOffset: number | null) => {
        pushed.push([focusId, caretOffset]);
      },
      announce: (message: string) => {
        announced.push(message);
      },
      postError: (message: string) => {
        errors.push(message);
      },
      clearDiagnostics: () => {
        clears++;
      },
      setRefusedDiagnostic: (op: string) => {
        refused.push(op);
      },
      getStructVersion: () => version,
      bumpStructVersion: () => {
        version++;
      },
      postRangeAvailability: (ids: string[], actions: RangeActionAvailability[]) => {
        rangePosts.push({ ids, actions });
      },
    });

    const image = contexts.imageActionContext();
    expect(image.document.getText()).toBe('<topic/>');
    expect(image.folder).toBe(folder);
    await image.applyMinimal('<topic><title>T</title></topic>');
    image.pushBody('e1', 3);
    image.announce('image changed');
    image.clearDiagnostics();

    const attribute = contexts.attributeActionContext();
    attribute.postError('bad attribute');
    attribute.clearDiagnostics();

    const inline = contexts.inlineActionContext();
    expect(inline.getStructVersion()).toBe(2);
    inline.bumpStructVersion();
    expect(inline.getStructVersion()).toBe(3);

    const range = contexts.rangeActionContext();
    range.postRangeAvailability(['e1'], [{ action: 'rangeDelete', enabled: true }]);

    const insert = contexts.insertActionContext();
    insert.setRefusedDiagnostic('paragraph');
    insert.bumpStructVersion();

    const structural = contexts.structuralActionContext();
    structural.setRefusedDiagnostic('split');
    structural.postError('structural failed');
    structural.bumpStructVersion();

    expect(applied).toEqual(['<topic><title>T</title></topic>']);
    expect(pushed).toEqual([['e1', 3]]);
    expect(announced).toEqual(['image changed']);
    expect(errors).toEqual(['bad attribute', 'structural failed']);
    expect(clears).toBe(2);
    expect(refused).toEqual(['paragraph', 'split']);
    expect(rangePosts).toEqual([{ ids: ['e1'], actions: [{ action: 'rangeDelete', enabled: true }] }]);
    expect(version).toBe(5);
  });
});
