import { describe, expect, test } from 'bun:test';
import {
  countEmptyLists,
  formatDitaSource,
  introducesEmptyList,
  lintDitaSource,
} from '../src/cst/dita-quality';

describe('lintDitaSource', () => {
  test('flags raw internal newlines in normal prose as source wrapping, not authored breaks', () => {
    const src = '<body><p>First line\nSecond line</p></body>';

    const issues = lintDitaSource(src);

    expect(issues.map((issue) => issue.code)).toContain('raw-prose-newline');
    expect(issues.find((issue) => issue.code === 'raw-prose-newline')?.element).toBe('p');
  });

  test('does not flag hard line breaks inside semantic line-preserving blocks', () => {
    const src = '<body><lines>First line\nSecond line</lines><codeblock>a\nb</codeblock></body>';

    expect(lintDitaSource(src).filter((issue) => issue.code === 'raw-prose-newline')).toEqual([]);
  });

  test('flags literal bullet prose so authoring can become real DITA lists', () => {
    const src = '<body><table><tgroup cols="1"><tbody><row><entry>• One • Two</entry></row></tbody></tgroup></table></body>';

    const issues = lintDitaSource(src);

    expect(issues.map((issue) => issue.code)).toContain('literal-bullet');
  });

  test('flags malformed CALS table grids', () => {
    const src = '<body><table><tgroup cols="2"><tbody><row><entry>Only one cell</entry></row></tbody></tgroup></table></body>';

    const issues = lintDitaSource(src);

    expect(issues.map((issue) => issue.code)).toContain('invalid-table-grid');
  });

  test('flags empty lists that have no visual list item representation', () => {
    const src = '<body><note><p>Visible note text</p><ul>\n</ul><ol></ol></note></body>';

    const issues = lintDitaSource(src).filter((issue) => issue.code === 'empty-list');

    expect(issues.map((issue) => issue.element)).toEqual(['ul', 'ol']);
    expect(countEmptyLists(src)).toBe(2);
  });

  test('detects only edits that increase the number of empty lists', () => {
    const clean = '<body><note><p>Text</p></note></body>';
    const corrupt = '<body><note><p>Text</p><ul></ul></note></body>';

    expect(introducesEmptyList(clean, corrupt)).toBe(true);
    expect(introducesEmptyList(corrupt, corrupt.replace('Text', 'Edited'))).toBe(false);
    expect(introducesEmptyList(corrupt, clean)).toBe(false);
  });
});

describe('formatDitaSource', () => {
  test('preserves XML declaration and DOCTYPE while normalizing prose source wrapping', () => {
    const src =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
      '<topic id="t"><title>T</title><body><p>First line\nSecond line</p></body></topic>';

    expect(formatDitaSource(src)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
        '<topic id="t">\n' +
        '  <title>T</title>\n' +
        '  <body>\n' +
        '    <p>First line Second line</p>\n' +
        '  </body>\n' +
        '</topic>\n',
    );
  });

  test('does not normalize line-preserving block content', () => {
    const src = '<body><lines>one\n  two</lines><p>a\nb</p></body>';

    expect(formatDitaSource(src)).toBe(
      '<body>\n' +
        '  <lines>one\n  two</lines>\n' +
        '  <p>a b</p>\n' +
        '</body>\n',
    );
  });
});
