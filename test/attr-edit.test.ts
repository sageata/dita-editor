import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { setAttr, removeAttrs } from '../src/cst/edit';
import { findElements } from '../src/cst/query';
import { attrValueError } from '../src/commands/attr-validity';
import type { ElementNode } from '../src/cst/types';

const TOPIC = (body: string) => `<topic id="t"><title>T</title><body>${body}</body></topic>`;

function firstP(src: string): { doc: ReturnType<typeof parse>; p: ElementNode } {
  const doc = parse(src);
  const p = findElements(doc, 'p')[0];
  return { doc, p };
}

describe('attribute editing primitives (Properties panel back-end)', () => {
  test('setAttr on an existing value splices only the value span (byte-minimal)', () => {
    const src = TOPIC('<p audience="dev">x</p>');
    const { doc, p } = firstP(src);
    setAttr(p, 'audience', 'admin', src);
    const out = serialize(doc);
    expect(out).toBe(TOPIC('<p audience="admin">x</p>'));
  });

  test('setAttr adds an absent attribute before the close bracket', () => {
    const src = TOPIC('<p>x</p>');
    const { doc, p } = firstP(src);
    setAttr(p, 'status', 'draft', src);
    expect(serialize(doc)).toBe(TOPIC('<p status="draft">x</p>'));
  });

  test('removeAttrs deletes the whole attribute incl. its leading space', () => {
    const src = TOPIC('<p audience="dev" status="draft">x</p>');
    const { doc, p } = firstP(src);
    removeAttrs(p, ['audience'], src);
    expect(serialize(doc)).toBe(TOPIC('<p status="draft">x</p>'));
  });

  test('the rest of the document is untouched by an attribute edit', () => {
    const src = TOPIC('<p>keep</p>\n<p id="second">x</p>');
    const doc = parse(src);
    const second = findElements(doc, 'p').find((e) => e.attrs.some((a) => a.name === 'id'))!;
    setAttr(second, 'platform', 'web', src);
    const out = serialize(doc);
    expect(out).toContain('<p>keep</p>'); // untouched
    expect(out).toContain('<p id="second" platform="web">x</p>');
  });
});

describe('attrValueError — id NCName validation', () => {
  test('a valid id passes', () => {
    expect(attrValueError('id', 'setup-account_1.2')).toBeNull();
  });
  test('an id with a space is rejected', () => {
    expect(attrValueError('id', 'bad id')).toMatch(/XML name/i);
  });
  test('an id starting with a digit is rejected', () => {
    expect(attrValueError('id', '1abc')).toMatch(/XML name/i);
  });
  test('non-id metadata attributes are unconstrained', () => {
    expect(attrValueError('audience', 'cabin crew, pilots')).toBeNull();
    expect(attrValueError('status', 'in review')).toBeNull();
  });
  test('an empty value is always allowed (it means "remove")', () => {
    expect(attrValueError('id', '')).toBeNull();
  });
});
