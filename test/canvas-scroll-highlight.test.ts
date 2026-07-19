import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TestDocument, TestElement, TestText } from './canvas-test-dom';

const source = readFileSync(new URL('../media/canvas-scroll-highlight.js', import.meta.url), 'utf8');
const canvasSource = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');

interface FakeRange {
  startNode: unknown;
  startOffset: number;
  endNode: unknown;
  endOffset: number;
}

function loadHelper(): { highlightMatch: (opts: Record<string, unknown>) => boolean } {
  const windowNamespace: Record<string, unknown> = {};
  new Function('window', source)(windowNamespace);
  return windowNamespace.DitaEditorCanvasScrollHighlight as {
    highlightMatch: (opts: Record<string, unknown>) => boolean;
  };
}

function harness(leafTexts: string[]): {
  anchor: TestElement;
  ranges: FakeRange[];
  documentObj: Record<string, unknown>;
  windowObj: Record<string, unknown>;
  leaves: TestElement[];
  centered: TestElement[];
} {
  const doc = new TestDocument();
  const anchor = doc.createElement('div');
  anchor.setAttribute('data-struct-id', 'e5');
  const leaves: TestElement[] = [];
  const centered: TestElement[] = [];
  for (const text of leafTexts) {
    const leaf = doc.createElement('p');
    leaf.setAttribute('data-edit-id', `e${10 + leaves.length}`);
    leaf.append(new TestText(text));
    (leaf as unknown as { scrollIntoView(opts: { block: string }): void }).scrollIntoView = (opts) => {
      if (opts.block === 'center') centered.push(leaf);
    };
    anchor.appendChild(leaf);
    leaves.push(leaf);
  }
  doc.main.appendChild(anchor);
  const ranges: FakeRange[] = [];
  const documentObj = {
    createRange: () => {
      const range: FakeRange & { setStart(node: unknown, offset: number): void; setEnd(node: unknown, offset: number): void } = {
        startNode: null,
        startOffset: -1,
        endNode: null,
        endOffset: -1,
        setStart(node: unknown, offset: number) {
          range.startNode = node;
          range.startOffset = offset;
        },
        setEnd(node: unknown, offset: number) {
          range.endNode = node;
          range.endOffset = offset;
        },
      };
      return range;
    },
  };
  const windowObj = {
    getSelection: () => ({
      removeAllRanges() {
        ranges.length = 0;
      },
      addRange(range: FakeRange) {
        ranges.push(range);
      },
    }),
  };
  return { anchor, ranges, documentObj, windowObj, leaves, centered };
}

describe('canvas scroll highlight helper', () => {
  test('selects the nth occurrence across the anchor leaves', () => {
    const helper = loadHelper();
    const h = harness(['fox fox jumps', 'a fox again']);
    const ok = helper.highlightMatch({
      anchor: h.anchor,
      highlight: { text: 'fox', occurrence: 2, matchCase: false },
      documentObj: h.documentObj,
      windowObj: h.windowObj,
    });
    expect(ok).toBe(true);
    expect(h.ranges.length).toBe(1);
    expect(h.ranges[0].startNode).toBe(h.leaves[1].childNodes[0]);
    expect(h.ranges[0].startOffset).toBe(2);
    expect(h.ranges[0].endOffset).toBe(5);
    // The matched leaf is centered so the selection is not hidden behind the
    // canvas's fixed command bar (same behavior as the in-canvas find bar).
    expect(h.centered).toEqual([h.leaves[1]]);
  });

  test('is case-insensitive unless matchCase is set', () => {
    const helper = loadHelper();
    const h = harness(['The Fox']);
    expect(
      helper.highlightMatch({
        anchor: h.anchor,
        highlight: { text: 'FOX', occurrence: 0, matchCase: false },
        documentObj: h.documentObj,
        windowObj: h.windowObj,
      }),
    ).toBe(true);
    expect(
      helper.highlightMatch({
        anchor: h.anchor,
        highlight: { text: 'FOX', occurrence: 0, matchCase: true },
        documentObj: h.documentObj,
        windowObj: h.windowObj,
      }),
    ).toBe(false);
  });

  test('falls back to the first occurrence when the occurrence index drifted', () => {
    const helper = loadHelper();
    const h = harness(['fox only once']);
    const ok = helper.highlightMatch({
      anchor: h.anchor,
      highlight: { text: 'fox', occurrence: 7, matchCase: false },
      documentObj: h.documentObj,
      windowObj: h.windowObj,
    });
    expect(ok).toBe(true);
    expect(h.ranges[0].startOffset).toBe(0);
  });

  test('returns false and selects nothing when the text is absent', () => {
    const helper = loadHelper();
    const h = harness(['nothing here']);
    const ok = helper.highlightMatch({
      anchor: h.anchor,
      highlight: { text: 'fox', occurrence: 0, matchCase: false },
      documentObj: h.documentObj,
      windowObj: h.windowObj,
    });
    expect(ok).toBe(false);
    expect(h.ranges.length).toBe(0);
  });

  test('never grabs the vscode api (helper script contract)', () => {
    expect(source).not.toContain('acquireVsCodeApi');
  });
});

describe('canvas.js scrollToAnchor hook', () => {
  test('invokes the highlight helper after a successful restore, silently', () => {
    const branch = canvasSource.split("msg.type === 'scrollToAnchor'")[1]?.split("msg.type ===")[0] ?? '';
    expect(branch).toContain('DitaEditorCanvasScrollHighlight');
    expect(branch).toContain('msg.highlight');
    expect(branch).not.toContain('scrollHighlightFailed');
  });

  test('search landings restore centered instead of under the fixed top bar', () => {
    const branch = canvasSource.split("msg.type === 'scrollToAnchor'")[1]?.split("msg.type ===")[0] ?? '';
    expect(branch).toContain("msg.highlight ? 'center' : 'start'");
  });
});
