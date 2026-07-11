import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const functionNames = {
  selectionAnnouncement: ['describeSelection', 'selectionEditability'],
  selectionSummary: [
    'currentSelectionIds',
    'isMultiSelection',
    'kindOfSelectedId',
    'rangeActionForSelection',
    'selectionCount',
    'selectionCountText',
    'selectionIsAllCells',
    'selectionStateForAnnouncement',
  ],
  selectionClipboard: [
    'clipboardHtml',
    'clipboardText',
    'selectionHtml',
    'selectionPlainText',
    'tabularPasteMatrix',
    'htmlTablePasteMatrix',
    'cellRectPasteValuesFromMatrix',
    'flattenPasteMatrix',
    'singleCellTabularPasteTarget',
    'cellPasteValues',
  ],
  selectionRestore: ['restoreSelectionAfterRerender'],
  selectionRange: ['normalizeAvailability', 'rangeAvailFor', 'rangeQuerySelection', 'sameIds'],
};

function api(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, () => undefined]));
}

function loadHelper() {
  const source = readFileSync(new URL('../media/canvas-selection-dependencies.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasSelectionDependencies: {
      resolveSelectionDependencies(opts: Record<string, unknown>, windowObj: Record<string, unknown>, rootWindow: Record<string, unknown>): {
        selectionAnnouncement: unknown;
        selectionSummary: unknown;
        selectionClipboard: unknown;
        selectionRestore: unknown;
        selectionRange: unknown;
      };
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasSelectionDependencies;
}

function validWindowApis() {
  return {
    DitaEditorCanvasSelectionAnnounce: api(functionNames.selectionAnnouncement),
    DitaEditorCanvasSelectionSummary: api(functionNames.selectionSummary),
    DitaEditorCanvasSelectionClipboard: api(functionNames.selectionClipboard),
    DitaEditorCanvasSelectionRestore: api(functionNames.selectionRestore),
    DitaEditorCanvasSelectionRange: api(functionNames.selectionRange),
  };
}

describe('canvas-selection-dependencies', () => {
  test('resolves the same browser helper APIs consumed by the controller', () => {
    const helper = loadHelper();
    const windowObj = validWindowApis();
    const deps = helper.resolveSelectionDependencies({}, windowObj, {});

    expect(deps.selectionAnnouncement).toBe(windowObj.DitaEditorCanvasSelectionAnnounce);
    expect(deps.selectionSummary).toBe(windowObj.DitaEditorCanvasSelectionSummary);
    expect(deps.selectionClipboard).toBe(windowObj.DitaEditorCanvasSelectionClipboard);
    expect(deps.selectionRestore).toBe(windowObj.DitaEditorCanvasSelectionRestore);
    expect(deps.selectionRange).toBe(windowObj.DitaEditorCanvasSelectionRange);
  });

  test('keeps root-window fallbacks for shared helpers but not announcement', () => {
    const helper = loadHelper();
    const windowObj = { DitaEditorCanvasSelectionAnnounce: api(functionNames.selectionAnnouncement) };
    const rootWindow = {
      DitaEditorCanvasSelectionSummary: api(functionNames.selectionSummary),
      DitaEditorCanvasSelectionClipboard: api(functionNames.selectionClipboard),
      DitaEditorCanvasSelectionRestore: api(functionNames.selectionRestore),
      DitaEditorCanvasSelectionRange: api(functionNames.selectionRange),
    };

    const deps = helper.resolveSelectionDependencies({}, windowObj, rootWindow);

    expect(deps.selectionAnnouncement).toBe(windowObj.DitaEditorCanvasSelectionAnnounce);
    expect(deps.selectionSummary).toBe(rootWindow.DitaEditorCanvasSelectionSummary);
    expect(deps.selectionClipboard).toBe(rootWindow.DitaEditorCanvasSelectionClipboard);
    expect(deps.selectionRestore).toBe(rootWindow.DitaEditorCanvasSelectionRestore);
    expect(deps.selectionRange).toBe(rootWindow.DitaEditorCanvasSelectionRange);
  });

  test('throws the controller-facing error for missing or incomplete dependencies', () => {
    const helper = loadHelper();
    const windowObj = validWindowApis();
    delete (windowObj.DitaEditorCanvasSelectionSummary as Record<string, unknown>).selectionCount;

    expect(() => helper.resolveSelectionDependencies({}, windowObj, {})).toThrow(
      'DitaEditorCanvasSelectionSummary is required before canvas-selection-controller.js',
    );
    expect(() => helper.resolveSelectionDependencies({}, {}, validWindowApis())).toThrow(
      'DitaEditorCanvasSelectionAnnounce is required before canvas-selection-controller.js',
    );
  });
});
