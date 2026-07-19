import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeEntities } from '../src/cst/inline-marks';
import { documentTitle, extractRenderedText } from '../src/search/rendered-text';

/** Every rendered char must map back to a source slice that re-decodes to it
 *  (plain text and entities), or to layout whitespace (collapsed spaces), or to
 *  an element boundary (block separators). */
function assertOffsetsRoundTrip(source: string): void {
  const index = extractRenderedText(source);
  expect(index.sourceStarts.length).toBe(index.text.length);
  expect(index.sourceEnds.length).toBe(index.text.length);
  for (let i = 0; i < index.text.length; i += 1) {
    const ch = index.text[i];
    const slice = source.slice(index.sourceStarts[i], index.sourceEnds[i]);
    expect(index.sourceStarts[i]).toBeLessThan(index.sourceEnds[i]);
    if (/^[ \t\r\n]$/.test(ch) && /^[ \t\r\n]+$/.test(slice)) {
      // Collapsed or preserved layout whitespace.
    } else if (ch === '\n') {
      // Block separator: anchored at an element boundary ('<' of a tag).
      expect(source[index.sourceStarts[i]]).toBe('<');
    } else {
      const decoded = decodeEntities(slice);
      // Astral chars occupy two UTF-16 units sharing one source range.
      expect(decoded.includes(ch) || decoded === index.text.slice(i - 1, i + 1)).toBe(true);
    }
  }
}

describe('extractRenderedText', () => {
  test('extracts decoded rendered text with title and body separated by block boundaries', () => {
    const source = '<topic id="t"><title>Hello</title><body><p>World</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('Hello');
    expect(index.text).toContain('World');
    expect(index.text).not.toContain('HelloWorld');
    expect(index.text).not.toContain('Hello World');
    assertOffsetsRoundTrip(source);
  });

  test('maps plain characters one-to-one to source offsets', () => {
    const source = '<topic id="t"><title>Hi</title><body><p>abc</p></body></topic>';
    const index = extractRenderedText(source);
    const at = index.text.indexOf('abc');
    const sourceAt = source.indexOf('abc');
    expect(index.sourceStarts[at]).toBe(sourceAt);
    expect(index.sourceEnds[at]).toBe(sourceAt + 1);
    expect(index.sourceStarts[at + 2]).toBe(sourceAt + 2);
  });

  test('decodes named entities with the whole entity as the source range', () => {
    const source = '<topic id="t"><title>T</title><body><p>Fish &amp; chips</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('Fish & chips');
    const amp = index.text.indexOf('&');
    const entityStart = source.indexOf('&amp;');
    expect(index.sourceStarts[amp]).toBe(entityStart);
    expect(index.sourceEnds[amp]).toBe(entityStart + '&amp;'.length);
    assertOffsetsRoundTrip(source);
  });

  test('decodes numeric entities; astral pairs share one source range', () => {
    const source = '<topic id="t"><title>T</title><body><p>A&#x1F600;B</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('A\u{1F600}B');
    const high = index.text.indexOf('\u{1F600}');
    const entityStart = source.indexOf('&#x1F600;');
    expect(index.sourceStarts[high]).toBe(entityStart);
    expect(index.sourceStarts[high + 1]).toBe(entityStart);
    expect(index.sourceEnds[high]).toBe(entityStart + '&#x1F600;'.length);
    expect(index.text[high + 2]).toBe('B');
  });

  test('leaves unknown entities raw, matching decodeEntities semantics', () => {
    const source = '<topic id="t"><title>T</title><body><p>a &copy; b</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('a &copy; b');
    assertOffsetsRoundTrip(source);
  });

  test('collapses layout whitespace so wrapped source lines match single-space queries', () => {
    const source = '<topic id="t"><title>T</title><body><p>foo\n      bar</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('foo bar');
    const space = index.text.indexOf('foo bar') + 3;
    const wsStart = source.indexOf('foo') + 3;
    expect(index.sourceStarts[space]).toBeGreaterThanOrEqual(wsStart);
    expect(index.sourceEnds[space]).toBeLessThanOrEqual(source.indexOf('bar'));
  });

  test('does not break matches across inline elements', () => {
    const source = '<topic id="t"><title>T</title><body><p>foo <b>bar</b> baz</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('foo bar baz');
  });

  test('separates block elements so matches cannot span paragraphs', () => {
    const source = '<topic id="t"><title>T</title><body><p>one</p><p>two</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).not.toContain('onetwo');
    expect(index.text).not.toContain('one two');
    expect(index.text).toMatch(/one\n+two/);
  });

  test('preserves verbatim whitespace inside codeblock', () => {
    const source = '<topic id="t"><title>T</title><body><codeblock>a\n  b</codeblock></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('a\n  b');
    assertOffsetsRoundTrip(source);
  });

  test('preserves whitespace under xml:space="preserve"', () => {
    const source = '<topic id="t"><title>T</title><body><p xml:space="preserve">a   b</p></body></topic>';
    const index = extractRenderedText(source);
    expect(index.text).toContain('a   b');
  });

  test('excludes comments, processing instructions, CDATA, and attribute values', () => {
    const source = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">',
      '<topic id="secret-attr">',
      '<title>T</title>',
      '<body>',
      '<!-- hidden comment --><?pi data?><p audience="secret-audience">visible<![CDATA[raw cdata]]></p>',
      '</body>',
      '</topic>',
    ].join('\n');
    const index = extractRenderedText(source);
    expect(index.text).toContain('visible');
    expect(index.text).not.toContain('hidden comment');
    expect(index.text).not.toContain('pi data');
    expect(index.text).not.toContain('raw cdata');
    expect(index.text).not.toContain('secret-audience');
    expect(index.text).not.toContain('secret-attr');
    expect(index.text).not.toContain('DOCTYPE');
  });

  test('runs over the fixture corpus without throwing and with tiling offsets', () => {
    const corpusDir = join(import.meta.dir, 'fixtures', 'corpus');
    const files = readdirSync(corpusDir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.dita'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(corpusDir, file), 'utf8');
      assertOffsetsRoundTrip(source);
    }
  });
});

describe('documentTitle', () => {
  test('returns the rendered text of the first title', () => {
    const source = '<topic id="t"><title>Fish &amp;\n   chips</title><body><p>x</p></body></topic>';
    expect(documentTitle(source)).toBe('Fish & chips');
  });

  test('returns null when there is no title', () => {
    const source = '<topic id="t"><body><p>x</p></body></topic>';
    expect(documentTitle(source)).toBeNull();
  });
});
