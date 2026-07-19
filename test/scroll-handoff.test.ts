import { describe, expect, test } from 'bun:test';
import {
  anchorAtSourceOffset,
  createScrollHandoffStore,
  deliverScrollAnchor,
  elementRangeForAnchor,
  openingTagOffsetForAnchor,
  type ScrollAnchor,
  type ScrollAnchorPanel,
} from '../src/host/scroll-handoff';

describe('DITA scroll handoff mapping', () => {
  const source = [
    '<topic id="scroll">',
    '  <title>Scroll handoff</title>',
    '  <body>',
    '    <p>First paragraph</p>',
    '    <section>',
    '      <title>Details</title>',
    '      <p>Second paragraph</p>',
    '      <table><tgroup><tbody><row><entry>Cell text</entry></row></tbody></tgroup></table>',
    '    </section>',
    '  </body>',
    '</topic>',
  ].join('\n');

  test('maps a structural anchor to its exact opening-tag offset', () => {
    expect(openingTagOffsetForAnchor(source, 'e3')).toEqual({
      ok: true,
      offset: source.indexOf('<p>First paragraph'),
    });
  });

  test('maps a source position to the most specific containing addressable element', () => {
    expect(anchorAtSourceOffset(source, source.indexOf('Second paragraph'))).toEqual({
      ok: true,
      anchor: { id: 'e6' },
    });
    expect(anchorAtSourceOffset(source, source.indexOf('Cell text'))).toEqual({
      ok: true,
      anchor: { id: 'e11' },
    });
  });

  test('falls forward and then backward when the source position is whitespace outside an addressable element', () => {
    const spaced = '<topic><body>\n  <p>One</p>\n  <p>Two</p>\n</body></topic>';
    expect(anchorAtSourceOffset(spaced, spaced.indexOf('\n'))).toEqual({
      ok: true,
      anchor: { id: 'e2' },
    });
    expect(anchorAtSourceOffset(spaced, spaced.lastIndexOf('\n'))).toEqual({
      ok: true,
      anchor: { id: 'e3' },
    });
    expect(anchorAtSourceOffset(source, source.indexOf('\n      <p>Second') + 1)).toEqual({
      ok: true,
      anchor: { id: 'e6' },
    });
  });

  test('reports invalid XML and unknown anchors instead of guessing', () => {
    expect(anchorAtSourceOffset('<topic><body>', 7)).toEqual({
      ok: false,
      reason: expect.stringContaining('could not be parsed'),
    });
    expect(openingTagOffsetForAnchor(source, 'e999')).toEqual({
      ok: false,
      reason: 'scroll anchor e999 is not present in the current DITA document',
    });
  });
});

describe('URI-keyed scroll handoff store', () => {
  test('retains the latest visual anchor and consumes a queued visual restore once', () => {
    const store = createScrollHandoffStore();
    store.rememberVisualAnchor('file:///topic.dita', { id: 'e3' });
    store.rememberVisualAnchor('file:///topic.dita', { id: 'e7' });
    expect(store.latestVisualAnchor('file:///topic.dita')).toEqual({ id: 'e7' });
    store.forgetVisualAnchor('file:///topic.dita');
    expect(store.latestVisualAnchor('file:///topic.dita')).toBeNull();

    store.queueVisualRestore('file:///topic.dita', { id: 'e7' });
    expect(store.consumeVisualRestore('file:///topic.dita')).toEqual({ id: 'e7' });
    expect(store.consumeVisualRestore('file:///topic.dita')).toBeNull();
  });
});

describe('deliverScrollAnchor', () => {
  function fakePanel(visible: boolean): ScrollAnchorPanel & {
    posted: ScrollAnchor[];
    revealed: number;
  } {
    const posted: ScrollAnchor[] = [];
    const state = {
      visible,
      posted,
      revealed: 0,
      postScrollToAnchor(anchor: ScrollAnchor) {
        posted.push(anchor);
      },
      reveal() {
        state.revealed += 1;
      },
    };
    return state;
  }

  test('posts directly to a visible panel without queueing', () => {
    const panel = fakePanel(true);
    const queued: ScrollAnchor[] = [];
    const result = deliverScrollAnchor(panel, { id: 'e5' }, (anchor) => queued.push(anchor));
    expect(result).toBe('posted');
    expect(panel.posted).toEqual([{ id: 'e5' }]);
    expect(panel.revealed).toBe(1);
    expect(queued).toEqual([]);
  });

  test('queues and reveals a hidden panel so the reload consumes the anchor', () => {
    const panel = fakePanel(false);
    const queued: ScrollAnchor[] = [];
    const result = deliverScrollAnchor(panel, { id: 'e5' }, (anchor) => queued.push(anchor));
    expect(result).toBe('revealed');
    expect(panel.posted).toEqual([]);
    expect(panel.revealed).toBe(1);
    expect(queued).toEqual([{ id: 'e5' }]);
  });

  test('queues for a not-yet-open file and tells the caller to open it', () => {
    const queued: ScrollAnchor[] = [];
    const result = deliverScrollAnchor(null, { id: 'e5' }, (anchor) => queued.push(anchor));
    expect(result).toBe('queued');
    expect(queued).toEqual([{ id: 'e5' }]);
  });

  test('carries a highlight payload through delivery untouched', () => {
    const panel = fakePanel(true);
    const anchor: ScrollAnchor = {
      id: 'e5',
      highlight: { text: 'needle', occurrence: 1, matchCase: false },
    };
    deliverScrollAnchor(panel, anchor, () => {});
    expect(panel.posted).toEqual([anchor]);
  });
});

describe('elementRangeForAnchor', () => {
  const source = '<topic id="t"><title>T</title><body><p>one</p><p>two</p></body></topic>';

  test('returns the full source range of the anchored element', () => {
    const mapping = anchorAtSourceOffset(source, source.indexOf('two'));
    expect(mapping.ok).toBe(true);
    const range = elementRangeForAnchor(source, (mapping as { anchor: ScrollAnchor }).anchor.id);
    expect(range).toEqual({
      ok: true,
      range: { start: source.indexOf('<p>two'), end: source.indexOf('</p>', source.indexOf('<p>two')) + 4 },
    });
  });

  test('reports unknown anchors', () => {
    expect(elementRangeForAnchor(source, 'e999')).toEqual({
      ok: false,
      reason: 'scroll anchor e999 is not present in the current DITA document',
    });
  });
});
