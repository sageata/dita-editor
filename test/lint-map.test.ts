import { describe, expect, test } from 'bun:test';
import { lintDitaSource } from '../src/cst/dita-quality';
import { mapLintToIds } from '../src/webview/lint-map';
import { parse } from '../src/cst/parse';
import { assignElementIds } from '../src/cst/element-ids';
import type { ElementNode } from '../src/cst/types';

describe('lint-map', () => {
  test('maps a literal-bullet finding onto the containing element id', () => {
    const src = '<topic><body>\n  <p>• bad bullet</p>\n  <p>fine</p>\n</body></topic>';
    const issues = lintDitaSource(src);
    expect(issues.length).toBeGreaterThan(0);
    const items = mapLintToIds(src, issues);
    expect(items.length).toBe(issues.length);
    // the mapped id resolves to the <p> with the bullet
    const doc = parse(src);
    let bulletId: string | null = null;
    for (const [el, id] of assignElementIds(doc)) {
      const e = el as ElementNode;
      if (e.name === 'p' && src.slice(e.range.start, e.range.end).includes('•')) bulletId = id;
    }
    expect(items[0].id).toBe(bulletId!);
    expect(items[0].message).toBeTruthy();
  });

  test('returns [] when there are no issues', () => {
    const src = '<topic><body>\n  <p>clean</p>\n</body></topic>';
    expect(mapLintToIds(src, lintDitaSource(src))).toEqual([]);
  });
});
