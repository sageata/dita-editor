import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, TestText } from './canvas-test-dom';

function installHelpers(selection: unknown) {
  const metricsSource = readFileSync(new URL('../media/canvas-text-metrics.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../media/canvas-command-format.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi(');
  const doc = new TestDocument();
  const win = {
    getSelection: () => selection,
  } as {
    getSelection(): unknown;
    DitaEditorCanvasCommandFormat: {
      createCommandFormatHelpers(opts: Record<string, unknown>): {
        currentFormatTarget(): unknown;
        currentInlineInsertTarget(): unknown;
      };
    };
  };
  new Function('window', metricsSource)(win);
  new Function('window', 'document', source)(win, doc);
  return win.DitaEditorCanvasCommandFormat.createCommandFormatHelpers({
    document: doc,
    window: win,
    getCanvasSelection: () => null,
    fmtSelector: {},
  });
}

function conrefFixture() {
  const root = new TestElement('p', undefined, { 'data-edit-id': 'e1' });
  const before = new TestText('a ');
  const chip = new TestElement('span', undefined, { 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' });
  chip.append(new TestText('reuse.dita#r/x'));
  const after = new TestText(' b');
  root.append(before, chip, after);
  return { root, after };
}

describe('canvas-command-format', () => {
  test('collapsed word formatting keeps the original caret restore offset', () => {
    const root = new TestElement('p', undefined, { 'data-edit-id': 'e1' });
    const text = new TestText('alpha beta');
    root.append(text);
    const selection = {
      rangeCount: 1,
      anchorNode: text,
      focusNode: text,
      getRangeAt: () => ({
        startContainer: text,
        startOffset: 8,
        endContainer: text,
        endOffset: 8,
      }),
    };

    const helpers = installHelpers(selection);

    expect(helpers.currentFormatTarget()).toEqual({
      editId: 'e1',
      before: 'alpha ',
      mid: 'beta',
      after: '',
      caretOffset: 8,
    });
  });

  test('format target offsets ignore render-only conref chip labels', () => {
    const { after } = conrefFixture();
    const selection = {
      rangeCount: 1,
      anchorNode: after,
      focusNode: after,
      getRangeAt: () => ({
        startContainer: after,
        startOffset: 1,
        endContainer: after,
        endOffset: 2,
      }),
    };

    const helpers = installHelpers(selection);

    expect(helpers.currentFormatTarget()).toEqual({
      editId: 'e1',
      before: 'a  ',
      mid: 'b',
      after: '',
      caretOffset: 4,
    });
  });

  test('inline insert target treats conref chips as zero-length source atoms', () => {
    const { after } = conrefFixture();
    const selection = {
      rangeCount: 1,
      anchorNode: after,
      focusNode: after,
      getRangeAt: () => ({
        startContainer: after,
        startOffset: 1,
        endContainer: after,
        endOffset: 1,
      }),
    };

    const helpers = installHelpers(selection);

    expect(helpers.currentInlineInsertTarget()).toEqual({
      editId: 'e1',
      before: 'a  ',
      after: 'b',
    });
  });
});
