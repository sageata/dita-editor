// W5 P1-2b — edit-path / byte-safety gates for the insert APPLY core (applyInsert in
// src/commands/insert-ops.ts). Proves that inserting real DITA structures into the
// corpus files is strictly additive: every original byte is preserved and the result
// re-serializes byte-for-byte (the same guarantee corpus-noop.test.ts gates for the
// pure no-op). No src/cst/* is touched by this lane (W6 is live in src/cst/structural.ts);
// these are pure behavioural gates over the existing in-lane apply.
//
// No mock data: fixtures are selected deterministically by the shared corpus helper
// (logged, not hardcoded) and parsed by the production CST parser.

import { test, expect, describe } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { indexDocument } from '../src/commands/validity';
import type { DocIndex } from '../src/commands/validity';
import { applyInsert, canInsert, type InsertKind } from '../src/commands/insert-ops';
import { loadCorpusFiles, type CorpusFile } from './corpus';

const CORPUS_FILES = loadCorpusFiles();

/** First corpus .dita (sorted, deterministic) whose text contains every needle. */
function firstFixture(...needles: string[]): CorpusFile | null {
  for (const file of CORPUS_FILES) {
    if (needles.every((needle) => file.source.includes(needle))) return file;
  }
  return null;
}

/** First e{N} id whose element matches name (+ optional trimmed direct text). */
function idOf(idx: DocIndex, name: string, text?: string): string | null {
  for (const [id, el] of idx.byId) {
    if (el.name !== name) continue;
    if (text !== undefined && el.children.map((c) => ('raw' in c ? c.raw : '')).join('').trim() !== text) continue;
    return id;
  }
  return null;
}

/** Strictly additive: the common prefix+suffix span the whole original (no byte changed),
 *  and the edit grew the document. Checked at char AND UTF-8 byte level. */
function assertAdditive(original: string, edited: string): void {
  let prefix = 0;
  while (prefix < original.length && prefix < edited.length && original[prefix] === edited[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < edited.length - prefix &&
    original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
  ) {
    suffix++;
  }
  expect(prefix + suffix).toBe(original.length); // every original char preserved
  expect(edited.length).toBeGreaterThan(original.length);

  // Byte-level: the original's UTF-8 bytes appear as prefix+suffix of the edited bytes.
  const ob = Buffer.from(original, 'utf8');
  const eb = Buffer.from(edited, 'utf8');
  let bp = 0;
  while (bp < ob.length && bp < eb.length && ob[bp] === eb[bp]) bp++;
  let bs = 0;
  while (bs < ob.length - bp && bs < eb.length - bp && ob[ob.length - 1 - bs] === eb[eb.length - 1 - bs]) bs++;
  expect(bp + bs).toBe(ob.length);
}

/** Re-parse stability: serialize(parse(x)) === x, at char and byte level. */
function assertStable(source: string): void {
  const round = serialize(parse(source));
  expect(round).toBe(source);
  expect(Buffer.from(round, 'utf8').equals(Buffer.from(source, 'utf8'))).toBe(true);
}

// Resolve the deterministic fixtures once.
const P_FIX = firstFixture('<p>');
const LIST_FIX = firstFixture('<ul>', '<li>');
const TABLE_FIX = firstFixture('<tgroup');
const TABLE_WITH_P_FIX = firstFixture('<tgroup', '<p>');

describe('corpus no-op byte-exact gate (two established files)', () => {
  // Established fixtures: the deterministic list-bearing and table-bearing corpus
  // topics (logged so a green run is never mistaken for hardcoded coverage).
  const established = [LIST_FIX, TABLE_FIX].filter(Boolean) as Array<NonNullable<typeof LIST_FIX>>;

  test('the two corpus fixtures exist', () => {
    expect(P_FIX).not.toBeNull();
    expect(LIST_FIX).not.toBeNull();
    expect(TABLE_FIX).not.toBeNull();
    expect(TABLE_WITH_P_FIX).not.toBeNull();
    console.log(
      `[insert-edit-path] p=${P_FIX?.rel} list=${LIST_FIX?.rel} table=${TABLE_FIX?.rel} table-with-p=${TABLE_WITH_P_FIX?.rel}`,
    );
  });

  test('parse→serialize is byte-exact no-op on both established files', () => {
    for (const f of established) assertStable(f.source);
  });
});

describe('edit-path roundtrip on corpus fixtures (p / list / table containers)', () => {
  test('p fixture: insert a paragraph after a corpus <p> stays additive + stable', () => {
    expect(P_FIX).not.toBeNull();
    if (!P_FIX) return;
    const idx = indexDocument(P_FIX.source);
    const pId = idOf(idx, 'p');
    expect(pId).not.toBeNull();
    const r = applyInsert(P_FIX.source, 'paragraph', { mode: 'after', refId: pId as string });
    assertAdditive(P_FIX.source, r.source);
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect(out.byId.get(r.focusId as string)?.name).toBe('p');
  });

  test('p fixture: insert a <lines> block after a corpus <p> stays additive + stable', () => {
    expect(P_FIX).not.toBeNull();
    if (!P_FIX) return;
    const idx = indexDocument(P_FIX.source);
    const pId = idOf(idx, 'p');
    expect(pId).not.toBeNull();
    const r = applyInsert(P_FIX.source, 'lines', { mode: 'after', refId: pId as string });
    expect(r.source).toContain('<lines></lines>');
    assertAdditive(P_FIX.source, r.source);
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect(out.byId.get(r.focusId as string)?.name).toBe('lines');
  });

  test('list fixture: insert a list item after a corpus <li> stays additive + stable', () => {
    expect(LIST_FIX).not.toBeNull();
    if (!LIST_FIX) return;
    const idx = indexDocument(LIST_FIX.source);
    const liId = idOf(idx, 'li');
    expect(liId).not.toBeNull();
    const beforeCount = [...idx.byId.values()].filter((e) => e.name === 'li').length;
    const r = applyInsert(LIST_FIX.source, 'listItem', { mode: 'after', refId: liId as string });
    assertAdditive(LIST_FIX.source, r.source);
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect([...out.byId.values()].filter((e) => e.name === 'li').length).toBe(beforeCount + 1);
    expect(out.byId.get(r.focusId as string)?.parent?.name).toMatch(/^(ul|ol)$/);
  });

  test('table fixture: insert a paragraph into a corpus <entry> cell stays additive + stable', () => {
    expect(TABLE_FIX).not.toBeNull();
    if (!TABLE_FIX) return;
    const idx = indexDocument(TABLE_FIX.source);
    const entryId = idOf(idx, 'entry');
    expect(entryId).not.toBeNull();
    const r = applyInsert(TABLE_FIX.source, 'paragraph', { mode: 'into', containerId: entryId as string });
    assertAdditive(TABLE_FIX.source, r.source);
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect(out.byId.get(r.focusId as string)?.parent?.name).toBe('entry');
  });

  test('table fixture: insert a whole new table after a corpus <p> stays additive + stable', () => {
    expect(TABLE_WITH_P_FIX).not.toBeNull();
    if (!TABLE_WITH_P_FIX) throw new Error('no corpus fixture contains both <tgroup> and <p>');
    const idx = indexDocument(TABLE_WITH_P_FIX.source);
    const pId = idOf(idx, 'p');
    expect(pId).not.toBeNull();
    if (pId === null) throw new Error(`table fixture has no paragraph anchor: ${TABLE_WITH_P_FIX.rel}`);
    const beforeCount = [...idx.byId.values()].filter((element) => element.name === 'table').length;
    const r = applyInsert(TABLE_WITH_P_FIX.source, 'table', { mode: 'after', refId: pId });
    assertAdditive(TABLE_WITH_P_FIX.source, r.source);
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect([...out.byId.values()].filter((element) => element.name === 'table')).toHaveLength(beforeCount + 1);
    expect(out.byId.get(r.focusId as string)?.name).toBe('entry');
  });
});

describe('inserted nodes mirror corpus style (indentation + quote style)', () => {
  test('synthetic table colspecs use double-quoted attrs like the corpus', () => {
    expect(P_FIX).not.toBeNull();
    if (!P_FIX) return;
    const idx = indexDocument(P_FIX.source);
    const r = applyInsert(P_FIX.source, 'table', { mode: 'after', refId: idOf(idx, 'p') as string });
    // Canonical CALS colspec form, double-quoted (matches src/cst/structural.ts newColspec
    // and the corpus convention `<colspec colname="cN" colnum="N"/>`).
    expect(r.source).toContain('<colspec colname="c1" colnum="1"/>');
    expect(r.source).toContain('cols="2"');
  });

  test('a fresh empty paragraph mirrors the anchor indentation on its own line', () => {
    expect(P_FIX).not.toBeNull();
    if (!P_FIX) return;
    const idx = indexDocument(P_FIX.source);
    const pId = idOf(idx, 'p') as string;
    const anchor = idx.byId.get(pId);
    expect(anchor).toBeDefined();
    // The anchor <p>'s exact leading whitespace (the text node immediately before it).
    const sibs = anchor!.parent?.children ?? [];
    const ai = sibs.indexOf(anchor!);
    const prev = ai > 0 ? sibs[ai - 1] : undefined;
    const lead = prev && prev.type === 'text' ? prev.raw : '\n';
    // insertAfter mirrors that lead before the new node; the empty synthetic paragraph
    // serializes as a paired tag. So `${lead}<p></p>` must appear verbatim in the output.
    const r = applyInsert(P_FIX.source, 'paragraph', { mode: 'after', refId: pId });
    expect(r.source).toContain(`${lead}<p></p>`);
  });
});

// ---- canInsert ↔ applyInsert agreement sweep over the selected corpus --------
// Mirrors validity.test.ts's corpus cross-check: the UI predicate (canInsert.enabled)
// MUST agree with whether the real mutation (applyInsert) succeeds, across many real DITA
// shapes and every kind × both placement modes — and every successful insert must be
// strictly additive + re-parse stable. Bounded + logged so a green run is never mistaken
// for full corpus coverage. (Agreement alone can't prove an allowlist entry FIRES — both
// sides could refuse in agreement — so conbody/refbody get a separate positive test below.)

/** Longest common prefix/suffix lengths; for a strictly-additive edit prefix+suffix
 *  spans the whole original. (assertAdditive uses expect(); the sweep needs the raw
 *  numbers to throw a file/id-tagged message instead.) */
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

const ALL_KINDS: InsertKind[] = ['paragraph', 'lines', 'unorderedList', 'alphabeticList', 'orderedList', 'listItem', 'table'];

function corpusFiles(limit: number): Array<{ rel: string; source: string }> {
  return CORPUS_FILES.slice(0, limit);
}

describe('canInsert ↔ applyInsert agreement on corpus (bounded sweep)', () => {
  const FILE_CAP = 20;
  const ELEMS_PER_FILE = 10;
  const files = corpusFiles(FILE_CAP);

  test('corpus present', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test(`predicate.enabled === apply-succeeds, every applied insert additive+stable (≤${FILE_CAP} files, ≤${ELEMS_PER_FILE} elems each)`, () => {
    let checked = 0;
    let applied = 0;
    let skippedElems = 0;
    for (const { rel, source } of files) {
      const idx = indexDocument(source);
      const ids = [...idx.byId.keys()];
      const sample = ids.slice(0, ELEMS_PER_FILE);
      if (ids.length > ELEMS_PER_FILE) skippedElems += ids.length - ELEMS_PER_FILE;
      for (const id of sample) {
        for (const kind of ALL_KINDS) {
          const positions = [
            { mode: 'after', refId: id } as const,
            { mode: 'before', refId: id } as const,
            { mode: 'into', containerId: id } as const,
          ];
          for (const pos of positions) {
            const predicted = canInsert(kind, pos, idx).enabled;
            let result: string | null = null;
            let succeeded = true;
            try {
              result = applyInsert(source, kind, pos).source;
            } catch {
              succeeded = false;
            }
            if (predicted !== succeeded) {
              throw new Error(
                `disagreement in ${rel} id ${id} kind ${kind} mode ${pos.mode}: ` +
                  `canInsert.enabled=${predicted} but applyInsert succeeded=${succeeded}`,
              );
            }
            if (succeeded && result !== null) {
              // Inserting INTO a self-closing element legitimately rewrites `<tag/>` →
              // `<tag>…</tag>` (serialize.ts promotes a self-closing el that gains children),
              // so that one case is NOT byte-additive by design. Every other insert must be.
              const container = pos.mode === 'into' ? idx.byId.get(pos.containerId) : undefined;
              const promotesSelfClosing = container?.selfClosing === true;
              if (!promotesSelfClosing) {
                const { prefix, suffix } = commonAffixes(source, result);
                if (prefix + suffix !== source.length) {
                  throw new Error(`non-additive insert in ${rel} id ${id} kind ${kind} mode ${pos.mode}`);
                }
              }
              // Re-parse stability must hold for EVERY successful insert, promotion or not.
              if (serialize(parse(result)) !== result) {
                throw new Error(`unstable re-parse in ${rel} id ${id} kind ${kind} mode ${pos.mode}`);
              }
              applied++;
            }
            checked++;
          }
        }
      }
    }
    console.log(
      `[insert agreement] ${checked} (id,kind,mode) checks, ${applied} real inserts, across ${files.length} files; ${skippedElems} elems skipped by per-file cap`,
    );
    expect(checked).toBeGreaterThan(0);
    expect(applied).toBeGreaterThan(0); // the sweep actually exercised real inserts, not only refusals
  });
});

// ---- self-closing container promotion. A real corpus topic can carry an EMPTY body as
//      `<body/>` (e.g. 01-general.dita). Inserting into it must promote it to a paired
//      `<body>…</body>` and stay re-parse stable. The promotion rewrites the `/>`, so the
//      ONLY changed original bytes are the container's open tag — everything else is verbatim. ----
describe('insert into a self-closing container promotes it correctly', () => {
  const SELF_CLOSING_BODY = '<?xml version="1.0"?>\n<topic id="t"><title>T</title><body/></topic>';

  test('paragraph into <body/> → paired <body> with the new <p>, re-parse stable', () => {
    const idx = indexDocument(SELF_CLOSING_BODY);
    const bodyId = idOf(idx, 'body');
    expect(bodyId).not.toBeNull();
    expect(idx.byId.get(bodyId!)?.selfClosing).toBe(true);
    const r = applyInsert(SELF_CLOSING_BODY, 'paragraph', { mode: 'into', containerId: bodyId! });
    // Promoted: no self-closing body remains; the new <p> lives under a paired <body>.
    expect(r.source).not.toContain('<body/>');
    expect(r.source).toContain('</body>');
    assertStable(r.source);
    const out = indexDocument(r.source);
    expect(out.byId.get(r.focusId as string)?.parent?.name).toBe('body');
    // Everything OUTSIDE the body open tag is untouched: the xml decl + title prefix and the
    // </topic> suffix survive verbatim (the promotion only edits the `<body/>` → `<body>`).
    expect(r.source.startsWith('<?xml version="1.0"?>\n<topic id="t"><title>T</title><body>')).toBe(true);
    expect(r.source.endsWith('</body></topic>')).toBe(true);
  });
});

// ---- specialization bodies: conbody / refbody are in BLOCK_CONTAINERS but were otherwise
//      untested. Assert the allowlist entry actually FIRES (enabled:true) on a corpus concept/
//      reference body, and that the insert stays additive + stable. ----
describe('block inserts into specialization bodies (conbody / refbody)', () => {
  for (const body of ['conbody', 'refbody']) {
    test(`paragraph allowed + additive into a corpus <${body}>`, () => {
      const fix = firstFixture(`<${body}`);
      expect(fix).not.toBeNull();
      if (!fix) throw new Error(`corpus has no <${body}> fixture`);
      const idx = indexDocument(fix.source);
      const id = idOf(idx, body);
      expect(id).not.toBeNull();
      if (id === null) throw new Error(`selected fixture does not contain <${body}>: ${fix.rel}`);
      expect(canInsert('paragraph', { mode: 'into', containerId: id }, idx).enabled).toBe(true);
      const r = applyInsert(fix.source, 'paragraph', { mode: 'into', containerId: id });
      assertAdditive(fix.source, r.source);
      assertStable(r.source);
      expect(indexDocument(r.source).byId.get(r.focusId as string)?.parent?.name).toBe(body);
    });
  }
});
