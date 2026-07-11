// Slice β P1-2a — pure insert-ops core. Tests parse REAL DITA with the production
// parser and address elements by their real e{N} ids (via Slice B's indexDocument).
// No mock UI data: minimal inline DITA command-units for controlled unit input, plus
// a selected corpus file for the serialization-invariant (purely-additive) cross-check.

import { test, expect, describe } from 'bun:test';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { assignElementIds } from '../src/cst/element-ids';
import {
  canInsert,
  applyInsert,
  availableInserts,
  type InsertKind,
} from '../src/commands/insert-ops';
import { loadCorpusFiles } from './corpus';

/** Real e{N} id of the first element matching name (+ optional trimmed text). */
function idOf(idx: DocIndex, name: string, text?: string): string {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

/** Longest common prefix/suffix; for a strictly-additive edit the original is fully
 *  covered (prefix.length + suffix.length === original.length). */
function commonAffixes(a: string, b: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

/** True when the edit is strictly additive: every original byte is preserved (the
 *  common prefix + suffix span the whole original). */
function commonAffixesCover(original: string, edited: string): boolean {
  const { prefix, suffix } = commonAffixes(original, edited);
  return prefix + suffix === original.length && edited.length > original.length;
}

const BODY_P = '<body><p>intro</p></body>';
const LIST = '<body><ul><li>a</li><li>b</li></ul></body>';
const EMPTY_BODY = '<body></body>';
const SECTION = '<body><section><title>S</title><p>sp</p></section></body>';

// ---- canInsert: content-model gating ----------------------------------------

describe('canInsert content model', () => {
  test('paragraph after a <p> in <body> is allowed', () => {
    const idx = indexDocument(BODY_P);
    const v = canInsert('paragraph', { mode: 'after', refId: idOf(idx, 'p') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('list / table after a <p> in <body> are allowed', () => {
    const idx = indexDocument(BODY_P);
    const ref = idOf(idx, 'p');
    for (const kind of ['unorderedList', 'alphabeticList', 'orderedList', 'table'] as InsertKind[]) {
      expect(canInsert(kind, { mode: 'after', refId: ref }, idx).enabled).toBe(true);
    }
  });

  test('list item is refused in <body> (block container, not a list): ditaValid:false', () => {
    const idx = indexDocument(BODY_P);
    const v = canInsert('listItem', { mode: 'after', refId: idOf(idx, 'p') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.ditaValid).toBe(false);
    expect(v.reason).toMatch(/list item/i);
  });

  test('list item after a <li> (container is the list) is allowed', () => {
    const idx = indexDocument(LIST);
    const v = canInsert('listItem', { mode: 'after', refId: idOf(idx, 'li', 'a') }, idx);
    expect(v).toEqual({ enabled: true, ditaValid: true });
  });

  test('paragraph is refused inside a <ul> (list children are <li> only): ditaValid:false', () => {
    const idx = indexDocument(LIST);
    const v = canInsert('paragraph', { mode: 'into', containerId: idOf(idx, 'ul') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.ditaValid).toBe(false);
    expect(v.reason).toMatch(/<ul>/);
  });

  test('anything is refused inside a <p> (inline content only): ditaValid:false', () => {
    const idx = indexDocument(BODY_P);
    const v = canInsert('paragraph', { mode: 'into', containerId: idOf(idx, 'p') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.ditaValid).toBe(false);
  });

  test('block kinds are allowed inside a <section> (after its <p> and into the section)', () => {
    const idx = indexDocument(SECTION);
    const afterP = { mode: 'after', refId: idOf(idx, 'p', 'sp') } as const;
    const intoSection = { mode: 'into', containerId: idOf(idx, 'section') } as const;
    for (const kind of ['paragraph', 'unorderedList', 'alphabeticList', 'orderedList', 'table'] as InsertKind[]) {
      expect(canInsert(kind, afterP, idx)).toEqual({ enabled: true, ditaValid: true });
      expect(canInsert(kind, intoSection, idx)).toEqual({ enabled: true, ditaValid: true });
    }
    // A list item is still refused in a <section> (not a list).
    expect(canInsert('listItem', intoSection, idx).ditaValid).toBe(false);
  });

  test('note / code block after a <p> in <body> are allowed', () => {
    const idx = indexDocument(BODY_P);
    const ref = idOf(idx, 'p');
    for (const kind of ['note', 'codeblock'] as InsertKind[]) {
      expect(canInsert(kind, { mode: 'after', refId: ref }, idx)).toEqual({ enabled: true, ditaValid: true });
    }
  });

  test('a section after a <p> in <body> is allowed but refused inside a list item / section', () => {
    const bodyIdx = indexDocument(BODY_P);
    expect(canInsert('section', { mode: 'after', refId: idOf(bodyIdx, 'p') }, bodyIdx).enabled).toBe(true);
    // Inside a list item: a section is not valid (SECTION_CONTAINERS excludes <li>).
    const listIdx = indexDocument(LIST);
    const inLi = canInsert('section', { mode: 'into', containerId: idOf(listIdx, 'li', 'a') }, listIdx);
    expect(inLi.enabled).toBe(false);
    expect(inLi.ditaValid).toBe(false);
    // Inside another section: also refused (no nested sections).
    const secIdx = indexDocument(SECTION);
    expect(canInsert('section', { mode: 'into', containerId: idOf(secIdx, 'section') }, secIdx).ditaValid).toBe(false);
  });

  test('unknown reference is an operational refusal (ditaValid:true)', () => {
    const idx = indexDocument(BODY_P);
    const v = canInsert('paragraph', { mode: 'after', refId: 'e9999' }, idx);
    expect(v).toMatchObject({ enabled: false, ditaValid: true });
    expect(v.reason).toMatch(/not found/i);
  });

  test('availableInserts reflects the container: <body> offers blocks (incl. section) but not listItem', () => {
    const idx = indexDocument(BODY_P);
    expect(availableInserts({ mode: 'after', refId: idOf(idx, 'p') }, idx).sort()).toEqual(
      ['alphabeticList', 'codeblock', 'lines', 'note', 'orderedList', 'paragraph', 'section', 'table', 'unorderedList'],
    );
  });

  test('availableInserts inside a <ul> offers only listItem', () => {
    const idx = indexDocument(LIST);
    expect(availableInserts({ mode: 'into', containerId: idOf(idx, 'ul') }, idx)).toEqual(['listItem']);
  });
});

// ---- applyInsert: structure produced -----------------------------------------

/** Parse a result and return its DocIndex, asserting it re-serializes idempotently. */
function reindex(source: string): DocIndex {
  const idx = indexDocument(source);
  expect(serialize(parse(source))).toBe(source); // re-parse is stable
  return idx;
}

describe('applyInsert produces valid structures', () => {
  test('paragraph: new empty <p> sibling, focus on it', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'paragraph', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    const paras = [...out.byId.values()].filter((e) => e.name === 'p');
    expect(paras.length).toBe(2);
    expect(r.caretOffset).toBe(0);
    // focusId points at the freshly added (empty) paragraph.
    expect(out.byId.get(r.focusId as string)?.name).toBe('p');
    expect(out.byId.get(r.focusId as string)?.children.length).toBe(0);
  });

  test('unordered list: <ul> seeded with one empty <li>, focus on the <li>', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'unorderedList', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    expect([...out.byId.values()].some((e) => e.name === 'ul')).toBe(true);
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('li');
    expect(focus?.parent?.name).toBe('ul');
  });

  test('ordered list produces an <ol>', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'orderedList', { mode: 'after', refId: idOf(idx, 'p') });
    expect([...reindex(r.source).byId.values()].some((e) => e.name === 'ol')).toBe(true);
  });

  test('alphabetic list produces an <ol outputclass="lower-alpha">', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'alphabeticList', { mode: 'after', refId: idOf(idx, 'p') });
    expect(r.source).toContain('<ol outputclass="lower-alpha">');
    expect([...reindex(r.source).byId.values()].some((e) => e.name === 'ol')).toBe(true);
  });

  test('list item: new <li> appended in the list, focus on it', () => {
    const idx = indexDocument(LIST);
    const r = applyInsert(LIST, 'listItem', { mode: 'after', refId: idOf(idx, 'li', 'b') });
    const out = reindex(r.source);
    expect([...out.byId.values()].filter((e) => e.name === 'li').length).toBe(3);
    expect(out.byId.get(r.focusId as string)?.name).toBe('li');
  });

  test('table skeleton: default CALS with header row + 2x2 body, focus on first header <entry>', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'table', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    const all = [...out.byId.values()];
    expect(all.filter((e) => e.name === 'tgroup').length).toBe(1);
    expect(all.find((e) => e.name === 'tgroup')?.attrs.find((a) => a.name === 'cols')?.value).toBe('2');
    expect(all.filter((e) => e.name === 'colspec').length).toBe(2);
    expect(all.filter((e) => e.name === 'thead').length).toBe(1);
    expect(all.filter((e) => e.name === 'row' && e.parent?.name === 'thead').length).toBe(1);
    expect(all.filter((e) => e.name === 'row' && e.parent?.name === 'tbody').length).toBe(2);
    expect(all.filter((e) => e.name === 'entry').length).toBe(6);
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('entry');
    expect(focus?.parent?.parent?.name).toBe('thead');
  });

  test('code block: new empty <codeblock>, focus on it (editable leaf)', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'codeblock', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('codeblock');
    expect(focus?.children.length).toBe(0);
  });

  test('note: <note> seeded with an empty <p>, focus on the <p>', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'note', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    expect([...out.byId.values()].some((e) => e.name === 'note')).toBe(true);
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('p');
    expect(focus?.parent?.name).toBe('note');
  });

  test('section: <section> seeded with an empty <title>, focus on the title', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'section', { mode: 'after', refId: idOf(idx, 'p') });
    const out = reindex(r.source);
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('title');
    expect(focus?.parent?.name).toBe('section');
  });

  test('table shape override (3 cols x 1 body row) yields matching colspecs/cols', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'table', { mode: 'after', refId: idOf(idx, 'p') }, { table: { cols: 3, rows: 1 } });
    const all = [...reindex(r.source).byId.values()];
    expect(all.find((e) => e.name === 'tgroup')?.attrs.find((a) => a.name === 'cols')?.value).toBe('3');
    expect(all.filter((e) => e.name === 'colspec').length).toBe(3);
    // 3 header entries + 3 body entries (rows counts body rows only)
    expect(all.filter((e) => e.name === 'entry').length).toBe(6);
    expect(all.filter((e) => e.name === 'entry' && e.parent?.parent?.name === 'tbody').length).toBe(3);
  });

  test('into an empty container: first <p> of an empty <body>', () => {
    const idx = indexDocument(EMPTY_BODY);
    const r = applyInsert(EMPTY_BODY, 'paragraph', { mode: 'into', containerId: idOf(idx, 'body') });
    const out = reindex(r.source);
    const p = [...out.byId.values()].find((e) => e.name === 'p');
    expect(p?.parent?.name).toBe('body');
    // focusId resolves to that same new paragraph.
    expect(out.byId.get(r.focusId as string)).toBe(p);
  });

  test('inside a <section>: paragraph and table insert and stay additive', () => {
    const idx = indexDocument(SECTION);
    const ref = idOf(idx, 'p', 'sp');
    const p = applyInsert(SECTION, 'paragraph', { mode: 'after', refId: ref });
    const pOut = reindex(p.source);
    const newP = pOut.byId.get(p.focusId as string);
    expect(newP?.name).toBe('p');
    expect(newP?.parent?.name).toBe('section');
    expect(commonAffixesCover(SECTION, p.source)).toBe(true);

    const t = applyInsert(SECTION, 'table', { mode: 'into', containerId: idOf(idx, 'section') });
    const tOut = reindex(t.source);
    expect(tOut.byId.get(t.focusId as string)?.name).toBe('entry');
    expect([...tOut.byId.values()].find((e) => e.name === 'tgroup')?.parent?.name).toBe('table');
    expect(commonAffixesCover(SECTION, t.source)).toBe(true);
  });

  test('applyInsert throws on a content-model violation (defensive; canInsert is the gate)', () => {
    const idx = indexDocument(LIST);
    expect(() =>
      applyInsert(LIST, 'paragraph', { mode: 'into', containerId: idOf(idx, 'ul') }),
    ).toThrow(/not permitted/i);
  });

  test('applyInsert throws on an unknown reference id', () => {
    expect(() => applyInsert(BODY_P, 'paragraph', { mode: 'after', refId: 'e9999' })).toThrow(/not found/i);
  });
});

// ---- lines block: a basic.block sibling of <p> (line-respecting text) ----------
// <lines> is permitted in exactly the same containers as <p> (body content), so the
// gating reuses containerAllows → BLOCK_CONTAINERS with no new allowance.

describe('applyInsert lines kind', () => {
  test('lines is allowed wherever a paragraph is (same block containers)', () => {
    const idx = indexDocument(BODY_P);
    const ref = idOf(idx, 'p');
    // after a <p> in <body>
    expect(canInsert('lines', { mode: 'after', refId: ref }, idx)).toEqual({ enabled: true, ditaValid: true });
    // refused inside a <ul> (list children are <li> only), exactly like paragraph
    const list = indexDocument(LIST);
    const v = canInsert('lines', { mode: 'into', containerId: idOf(list, 'ul') }, list);
    expect(v.enabled).toBe(false);
    expect(v.ditaValid).toBe(false);
  });

  test('after mode: a new empty <lines></lines> block is added, additive, re-parses', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'lines', { mode: 'after', refId: idOf(idx, 'p') });
    // empty paired tag added as a sibling of the original <p>
    expect(r.source).toContain('<lines></lines>');
    expect(r.source.indexOf('<p>intro</p>')).toBeLessThan(r.source.indexOf('<lines></lines>'));
    expect(commonAffixesCover(BODY_P, r.source)).toBe(true); // strictly additive
    const out = reindex(r.source); // re-parse stable
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('lines');
    expect(focus?.children.length).toBe(0);
    expect(focus?.parent?.name).toBe('body');
    expect(r.caretOffset).toBe(0);
  });
});

// ---- in-cell content: a table <entry> is a block container, so it accepts MULTIPLE
//      <p> siblings (the cell support already exists; this proves two coexist). ----

const BODY_CELL =
  '<body><table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
  '<tbody><row><entry><p>cell</p></entry></row></tbody></tgroup></table></body>';

describe('multiple paragraphs in one table cell', () => {
  test('insert a second then a third <p> into the same <entry>: all siblings, additive', () => {
    const idx = indexDocument(BODY_CELL);
    const entryId = idOf(idx, 'entry');
    // first added <p> after the existing cell <p>
    const r1 = applyInsert(BODY_CELL, 'paragraph', { mode: 'after', refId: idOf(idx, 'p', 'cell') });
    expect(commonAffixesCover(BODY_CELL, r1.source)).toBe(true);
    const out1 = reindex(r1.source);
    const entry1 = [...out1.byId.values()].find((e) => e.name === 'entry');
    expect(entry1?.children.filter((c) => 'name' in c && c.name === 'p').length).toBe(2);

    // second insert: append another <p> INTO the same entry (now three siblings)
    const r2 = applyInsert(r1.source, 'paragraph', { mode: 'into', containerId: idOf(out1, 'entry') });
    expect(commonAffixesCover(r1.source, r2.source)).toBe(true);
    const out2 = reindex(r2.source);
    const entry2 = [...out2.byId.values()].find((e) => e.name === 'entry');
    const cellParas = entry2?.children.filter((c) => 'name' in c && c.name === 'p') ?? [];
    expect(cellParas.length).toBe(3);
    // every cell <p> is a direct child of the SAME <entry> (true siblings)
    for (const p of cellParas) expect((p as typeof entry2)?.parent).toBe(entry2);
    void entryId;
  });
});

// ---- before mode: insert as the PREVIOUS sibling (paragraph before a table/fig/p) ----

const BODY_TABLE =
  '<body><p>lead</p><table><tgroup cols="1"><colspec colname="c1" colnum="1"/>' +
  '<tbody><row><entry>x</entry></row></tbody></tgroup></table></body>';

describe('insert before mode', () => {
  test('canInsert before agrees with after for the same ref (same container gates both)', () => {
    const idx = indexDocument(BODY_P);
    const ref = idOf(idx, 'p');
    expect(canInsert('paragraph', { mode: 'before', refId: ref }, idx)).toEqual({ enabled: true, ditaValid: true });
    // before/after share the content model, so availableInserts must match at the same ref.
    expect(availableInserts({ mode: 'before', refId: ref }, idx).sort()).toEqual(
      availableInserts({ mode: 'after', refId: ref }, idx).sort(),
    );
  });

  test('listItem before a <p> in <body> is refused (content model): ditaValid:false', () => {
    const idx = indexDocument(BODY_P);
    const v = canInsert('listItem', { mode: 'before', refId: idOf(idx, 'p') }, idx);
    expect(v.enabled).toBe(false);
    expect(v.ditaValid).toBe(false);
    expect(v.reason).toMatch(/list item/i);
  });

  test('paragraph before a <p>: new empty <p> is the PREVIOUS sibling, focus on it, additive+stable', () => {
    const idx = indexDocument(BODY_P);
    const r = applyInsert(BODY_P, 'paragraph', { mode: 'before', refId: idOf(idx, 'p') });
    // ordering: the new empty paragraph precedes the original <p>intro</p>.
    expect(r.source.indexOf('<p></p>')).toBeLessThan(r.source.indexOf('<p>intro</p>'));
    expect(commonAffixesCover(BODY_P, r.source)).toBe(true); // strictly additive
    const out = reindex(r.source); // re-parse stable
    const focus = out.byId.get(r.focusId as string);
    expect(focus?.name).toBe('p');
    expect(focus?.children.length).toBe(0);
    expect(focus?.parent?.name).toBe('body');
  });

  test('paragraph before a <table> (the user case): new <p> sits between the lead <p> and the table', () => {
    const idx = indexDocument(BODY_TABLE);
    const r = applyInsert(BODY_TABLE, 'paragraph', { mode: 'before', refId: idOf(idx, 'table') });
    expect(r.source.indexOf('<p>lead</p>')).toBeLessThan(r.source.indexOf('<p></p>'));
    expect(r.source.indexOf('<p></p>')).toBeLessThan(r.source.indexOf('<table>'));
    expect(commonAffixesCover(BODY_TABLE, r.source)).toBe(true);
    const out = reindex(r.source);
    expect(out.byId.get(r.focusId as string)?.parent?.name).toBe('body');
  });

  test('paragraph after a <table> also works (sibling after the table)', () => {
    const idx = indexDocument(BODY_TABLE);
    const r = applyInsert(BODY_TABLE, 'paragraph', { mode: 'after', refId: idOf(idx, 'table') });
    expect(r.source.indexOf('</table>')).toBeLessThan(r.source.indexOf('<p></p>'));
    expect(commonAffixesCover(BODY_TABLE, r.source)).toBe(true);
    reindex(r.source);
  });

  test('before a rootless element refuses with reason and does not mutate (no container)', () => {
    const idx = indexDocument(BODY_P);
    const bodyId = idOf(idx, 'body'); // top-level <body>, no parent
    const v = canInsert('paragraph', { mode: 'before', refId: bodyId }, idx);
    expect(v).toMatchObject({ enabled: false, ditaValid: true });
    expect(v.reason).toMatch(/container/i);
    expect(() => applyInsert(BODY_P, 'paragraph', { mode: 'before', refId: bodyId })).toThrow(/container/i);
  });
});

// ---- serialization invariant: every insert is strictly additive --------------

describe('serialization invariant (purely additive edit)', () => {
  const SHAPES: Array<{ kind: InsertKind; opts?: { table?: { cols: number; rows: number } } }> = [
    { kind: 'paragraph' },
    { kind: 'lines' },
    { kind: 'unorderedList' },
    { kind: 'alphabeticList' },
    { kind: 'orderedList' },
    { kind: 'table' },
    { kind: 'table', opts: { table: { cols: 3, rows: 2 } } },
  ];

  test('inline fixture: insert changes no original byte', () => {
    const idx = indexDocument(BODY_P);
    const ref = idOf(idx, 'p');
    for (const { kind, opts } of SHAPES) {
      const r = applyInsert(BODY_P, kind, { mode: 'after', refId: ref }, opts);
      const { prefix, suffix } = commonAffixes(BODY_P, r.source);
      expect(prefix + suffix).toBe(BODY_P.length); // original fully preserved → additive
      expect(r.source.length).toBeGreaterThan(BODY_P.length);
    }
  });

  // Cross-check on a corpus topic: inserting after its first <p> must leave every
  // other byte untouched (the same round-trip guarantee corpus-noop.test.ts gates).
  function firstTopicWithP(limit: number): { file: string; source: string } | null {
    for (const file of loadCorpusFiles().slice(0, limit)) {
      if (file.source.includes('<p>')) return { file: file.abs, source: file.source };
    }
    return null;
  }

  test('corpus topic: insert after first <p> is strictly additive', () => {
    const found = firstTopicWithP(200);
    expect(found).not.toBeNull();
    if (!found) return;
    const { source } = found;
    const ids = assignElementIds(parse(source));
    let pId: string | null = null;
    for (const [el, id] of ids) {
      if (el.name === 'p') {
        pId = id;
        break;
      }
    }
    expect(pId).not.toBeNull();
    for (const { kind, opts } of SHAPES) {
      const r = applyInsert(source, kind, { mode: 'after', refId: pId as string }, opts);
      const { prefix, suffix } = commonAffixes(source, r.source);
      expect(prefix + suffix).toBe(source.length); // no original byte changed
      expect(serialize(parse(r.source))).toBe(r.source); // result is itself stable
    }
  });
});
