import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { applyLineBreakEdit } from '../src/cst/line-break-edit';
import { parse } from '../src/cst/parse';

function idOf(source: string, name: string, text?: string): string {
  const doc = parse(source);
  const ids = assignElementIds(doc);
  for (const [el, id] of ids) {
    if (el.name !== name) continue;
    if (text !== undefined) {
      const actual = el.children.map((c) => (c.type === 'text' ? c.raw : '')).join('').trim();
      if (actual !== text) continue;
    }
    return id;
  }
  throw new Error(`no <${name}>`);
}

describe('applyLineBreakEdit', () => {
  test('Shift+Enter in a paragraph converts it to a semantic lines block', () => {
    const src = '<body><p>Hello tail</p></body>';
    const id = idOf(src, 'p', 'Hello tail');

    const out = applyLineBreakEdit(src, id, 'Hello\ntail');

    expect(out.source).toBe('<body><lines>Hello\ntail</lines></body>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });

  test('Shift+Enter in a table cell wraps the text in lines without replacing the entry', () => {
    const src = '<body><table><tgroup cols="1"><tbody><row><entry>Cell text</entry></row></tbody></tgroup></table></body>';
    const id = idOf(src, 'entry', 'Cell text');

    const out = applyLineBreakEdit(src, id, 'Cell\ntext');

    expect(out.source).toContain('<entry><lines>Cell\ntext</lines></entry>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(5);
  });

  test('Shift+Enter inside an existing lines block stays a text edit', () => {
    const src = '<body><lines>First line</lines></body>';
    const id = idOf(src, 'lines', 'First line');

    const out = applyLineBreakEdit(src, id, 'First\nline');

    expect(out.source).toBe('<body><lines>First\nline</lines></body>');
    expect(out.focusId).toBe(idOf(out.source, 'lines'));
    expect(out.caretOffset).toBe(6);
  });
});
