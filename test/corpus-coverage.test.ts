import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { walk } from '../src/cst/query';
import { isElement } from '../src/cst/types';
import { loadCorpusFiles, usesExternalCorpus } from './corpus';

/**
 * Slice E — corpus coverage tripwire.
 *
 * Fails if the selected corpus uses any DITA element that the visual editor
 * does not intentionally render. Unhandled elements fall through to the opaque-span
 * fallback in `src/render/to-html.ts` (`default:` at :176-177), which renders them as a
 * bare <span> — silently leaking/losing authoring intent (e.g. prolog/metadata text
 * would leak into the canvas; a `note` would lose its callout). The external stress
 * corpus may change over time, so this test is the
 * tripwire that catches a newly unsupported element before it ships.
 *
 * Scope note: scans .dita TOPIC files only (the custom editor opens *.dita). .ditamap
 * files use the map vocabulary (map/topicref/topicmeta) the topic renderer never touches,
 * and the shared corpus helper lists only `.dita` topic files.
 */

// The set of DITA elements the editor INTENTIONALLY renders. Mirrors the `element()`
// method in src/render/to-html.ts (verified), which is the authoritative render contract:
//   - TOPIC_ROOTS            (to-html.ts:43)        topic, concept, task, reference
//   - BODY_CLASS keys        (to-html.ts:44)        body, conbody, taskbody, refbody
//   - switch cases           (to-html.ts:145-175)   title, shortdesc, p, ul, ol, li,
//                                                    codeph, fig, image, table, section,
//                                                    steps, step, cmd, info
//   - table()/rows()/entries() helpers              tgroup, colspec, thead, tbody, row, entry
// Anything NOT here hits the `default:` opaque-span fallback (to-html.ts:176-177).
// MAINTENANCE: if you add a render case in to-html.ts, add the element name here too.
const RENDERED_ALLOWLIST: ReadonlySet<string> = new Set([
  // topic roots
  'topic', 'concept', 'task', 'reference',
  // body containers
  'body', 'conbody', 'taskbody', 'refbody',
  // block / inline switch cases
  'title', 'shortdesc', 'p', 'ul', 'ol', 'li', 'codeph', 'lines',
  'fig', 'image', 'table', 'section', 'steps', 'step', 'cmd', 'info',
  // inline highlighting + insert kinds (render cases added with the toolbar Format/Insert groups)
  'b', 'i', 'u', 'line-through', 'sub', 'sup', 'xref', 'ph', 'note', 'codeblock',
  // CALS table structure (rendered by helpers, not the switch)
  'tgroup', 'colspec', 'thead', 'tbody', 'row', 'entry',
  // consumed by image() (to-html.ts:449): authored <alt> becomes the <img> alt attribute
  'alt',
]);

/** Pure tripwire predicate: names present that are NOT intentionally rendered (sorted, deduped). */
function findUnsupported(names: Iterable<string>, allow: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const n of names) if (!allow.has(n)) out.add(n);
  return [...out].sort();
}

describe('Slice E: corpus coverage tripwire', () => {
  const files = loadCorpusFiles();
  const external = usesExternalCorpus();

  test('corpus is present (tripwire is not vacuous)', () => {
    console.log(`[coverage] .dita files found: ${files.length}`);
    expect(files.length).toBeGreaterThan(0);
  });

  test('every selected DITA element is intentionally rendered (no opaque-span fallback)', () => {
    const occurrences = new Map<string, number>();
    const example = new Map<string, string>();
    const parseFailures: { file: string; error: string }[] = [];
    let elementNodes = 0;

    for (const file of files) {
      try {
        const doc = parse(file.source);
        for (const node of walk(doc.children)) {
          if (!isElement(node)) continue;
          elementNodes++;
          occurrences.set(node.name, (occurrences.get(node.name) ?? 0) + 1);
          if (!example.has(node.name)) example.set(node.name, file.rel);
        }
      } catch (e) {
        // Do NOT silence: record with file context and fail the assertion below.
        parseFailures.push({ file: file.rel, error: (e as Error).message });
      }
    }

    // Non-vacuity guards: prove the scan actually walked selected corpus content.
    expect(parseFailures).toEqual([]);
    expect(elementNodes).toBeGreaterThan(0);
    for (const core of ['title', 'p', 'entry']) {
      expect(occurrences.has(core)).toBe(true);
    }

    const distinct = [...occurrences.keys()].sort();
    const unsupported = findUnsupported(distinct, RENDERED_ALLOWLIST);
    const uncoveredAllow = [...RENDERED_ALLOWLIST].filter((n) => !occurrences.has(n)).sort();

    // --- Explicit coverage report (logged, never silenced) ---
    console.log(
      `[coverage] files scanned: ${files.length}, element nodes: ${elementNodes}, distinct elements: ${distinct.length}`,
    );
    console.log('[coverage] element occurrences (status / name / count / example file):');
    for (const name of distinct) {
      const status = RENDERED_ALLOWLIST.has(name) ? 'rendered   ' : 'UNSUPPORTED';
      console.log(`[coverage]   ${status} ${name.padEnd(14)} ${String(occurrences.get(name)).padStart(6)}  e.g. ${example.get(name)}`);
    }
    const uncoveredStatus = external ? 'informational for external corpus' : 'must be empty in public corpus';
    console.log(
      `[coverage] allowlist elements NOT exercised by corpus (${uncoveredStatus}): ${uncoveredAllow.length ? uncoveredAllow.join(', ') : '(none)'}`,
    );

    if (unsupported.length) {
      console.error(
        '[coverage] TRIPWIRE FIRED: corpus uses elements with NO render case — they hit the opaque-span fallback (to-html.ts:176):',
      );
      for (const name of unsupported) {
        console.error(`[coverage]   UNSUPPORTED ${name} (${occurrences.get(name)}x), first seen: ${example.get(name)}`);
      }
    }

    // --- The tripwire ---
    expect(unsupported).toEqual([]);
    if (!external) expect(uncoveredAllow).toEqual([]);
  });

  test('tripwire predicate trips on a non-rendered element (logic self-check, not corpus data)', () => {
    // Literal element NAMES, not corpus content: proves the predicate is not a no-op. Uses element
    // names the editor does NOT render (dl/fn) — distinct from the allowlisted ones above.
    expect(findUnsupported(['p', 'title', 'entry'], RENDERED_ALLOWLIST)).toEqual([]);
    expect(findUnsupported(['p', 'dl', 'fn', 'dl'], RENDERED_ALLOWLIST)).toEqual(['dl', 'fn']);
  });
});
