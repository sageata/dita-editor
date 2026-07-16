import { describe, expect, test } from 'bun:test';
import {
  anchorAtSourceOffset,
  createScrollHandoffStore,
  openingTagOffsetForAnchor,
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
