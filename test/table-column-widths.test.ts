import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyTableColumnWidths, formatColumnWidthRatio } from '../src/cst/table-column-widths';
import type { ElementNode } from '../src/cst/types';

function firstId(src: string, name: string): string {
  const doc = parse(src);
  for (const [el, id] of assignElementIds(doc)) {
    if ((el as ElementNode).name === name) return id;
  }
  throw new Error(`no <${name}> found`);
}

describe('table column widths', () => {
  const src =
    '<topic><body>\n' +
    '  <table frame="all"><tgroup cols="3">\n' +
    '    <colspec colname="c1" colnum="1"/>\n' +
    '    <colspec colname="c2" colnum="2" align="center"/>\n' +
    '    <colspec colname="c3" colnum="3" colwidth="3*"/>\n' +
    '    <tbody><row><entry>A</entry><entry>B</entry><entry>C</entry></row></tbody>\n' +
    '  </tgroup></table>\n' +
    '</body></topic>';

  test('formats readable decimal star ratios', () => {
    expect(formatColumnWidthRatio(1)).toBe('1*');
    expect(formatColumnWidthRatio(1.5)).toBe('1.5*');
    expect(formatColumnWidthRatio(0.33333)).toBe('0.333*');
  });

  test('sets every colspec to normalized fractional colwidth values without dropping attrs', () => {
    const out = applyTableColumnWidths(src, firstId(src, 'table'), [120, 240, 240]);

    expect(out).toContain('<colspec colname="c1" colnum="1" colwidth="0.6*"/>');
    expect(out).toContain('<colspec colname="c2" colnum="2" align="center" colwidth="1.2*"/>');
    expect(out).toContain('<colspec colname="c3" colnum="3" colwidth="1.2*"/>');
    expect(out).toContain('<tbody><row><entry>A</entry><entry>B</entry><entry>C</entry></row></tbody>');
    expect(serialize(parse(out))).toBe(out);
  });

  test('refuses stale or mismatched targets without synthesizing partial widths', () => {
    expect(() => applyTableColumnWidths(src, firstId(src, 'body'), [1, 1, 1])).toThrow(/not <table>/);
    expect(() => applyTableColumnWidths(src, firstId(src, 'table'), [1, 1])).toThrow(/does not match/);
    expect(() => applyTableColumnWidths(src, firstId(src, 'table'), [1, Number.NaN, 1])).toThrow(/positive finite/);
  });
});
