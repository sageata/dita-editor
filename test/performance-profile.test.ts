import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { walk } from '../src/cst/query';
import { isElement, type Document } from '../src/cst/types';
import { renderEditable } from '../src/render/to-html';
import { buildCmdMap, buildInsertMap, buildNavMap, buildTransformMap } from '../src/webview/state-maps';
import { loadCorpusFiles, usesExternalCorpus, type CorpusFile } from './corpus';

interface Profile {
  label: string;
  rel: string;
  sourceBytes: number;
  elementCount: number;
  entryCount: number;
  htmlBytes: number;
  payloadBytes: number;
  timingsMs: {
    parse: number;
    renderEditable: number;
    navMap: number;
    cmdMap: number;
    transformMap: number;
    insertMap: number;
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function countElements(doc: Document): number {
  let count = 0;
  for (const node of walk(doc.children)) if (isElement(node)) count++;
  return count;
}

function countEntries(doc: Document): number {
  let count = 0;
  for (const node of walk(doc.children)) if (isElement(node) && node.name === 'entry') count++;
  return count;
}

function largestTopic(files: CorpusFile[]): CorpusFile {
  return files.reduce((best, file) => (byteLength(file.source) > byteLength(best.source) ? file : best), files[0]);
}

function largestTableTopic(files: CorpusFile[]): { file: CorpusFile; entryCount: number } {
  let best = { file: files[0], entryCount: 0 };
  for (const file of files) {
    const tables = file.source.match(/<table\b[\s\S]*?<\/table>/g) ?? [];
    for (const table of tables) {
      const entryCount = (table.match(/<entry\b/g) ?? []).length;
      if (entryCount > best.entryCount) best = { file, entryCount };
    }
  }
  return best;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function profileCorpusFile(label: string, file: CorpusFile): Profile {
  const parsed = timed(() => parse(file.source));
  const doc = parsed.value;
  const rendered = timed(() => renderEditable(doc));
  const nav = timed(() => buildNavMap(doc));
  const cmd = timed(() => buildCmdMap(doc));
  const transforms = timed(() => buildTransformMap(doc));
  const inserts = timed(() => buildInsertMap(doc));
  const payload = {
    navMap: nav.value,
    cmdMap: cmd.value,
    transformMap: transforms.value,
    insertMap: inserts.value,
  };
  return {
    label,
    rel: file.rel,
    sourceBytes: byteLength(file.source),
    elementCount: countElements(doc),
    entryCount: countEntries(doc),
    htmlBytes: byteLength(rendered.value),
    payloadBytes: byteLength(JSON.stringify(payload)),
    timingsMs: {
      parse: parsed.ms,
      renderEditable: rendered.ms,
      navMap: nav.ms,
      cmdMap: cmd.ms,
      transformMap: transforms.ms,
      insertMap: inserts.ms,
    },
  };
}

describe('performance profile baselines on selected corpus shapes', () => {
  const files = loadCorpusFiles();
  const external = usesExternalCorpus();

  test('corpus is present', () => {
    if (external) expect(files.length).toBeGreaterThanOrEqual(1500);
    else expect(files.length).toBeGreaterThan(0);
  });

  test('logs parse/render/state-map baselines for largest topic and largest table', () => {
    const bigTop = largestTopic(files);
    const bigTbl = largestTableTopic(files);

    expect(bigTop.source).toContain('<');
    if (external) {
      expect(bigTbl.entryCount).toBeGreaterThan(50);
    } else {
      expect(bigTop.rel).toBe('performance/large-topic.dita');
      expect(bigTbl.file.rel).toBe('performance/large-table.dita');
      expect(bigTbl.entryCount).toBe(72);
    }

    const profiles = [
      profileCorpusFile('BIG-TOP', bigTop),
      profileCorpusFile(`BIG-TBL entries=${bigTbl.entryCount}`, bigTbl.file),
    ];

    for (const profile of profiles) {
      expect(profile.sourceBytes).toBeGreaterThan(0);
      expect(profile.elementCount).toBeGreaterThan(0);
      expect(profile.htmlBytes).toBeGreaterThan(0);
      expect(profile.payloadBytes).toBeGreaterThan(0);
      if (!external) {
        const bounds = profile.label === 'BIG-TOP'
          ? {
              sourceBytes: [2_500, 15_000],
              elementCount: [60, 180],
              entryCount: [0, 0],
              htmlBytes: [2_000, 40_000],
              payloadBytes: [80_000, 150_000],
            }
          : {
              sourceBytes: [3_000, 15_000],
              elementCount: [90, 220],
              entryCount: [72, 72],
              htmlBytes: [4_000, 50_000],
              payloadBytes: [80_000, 150_000],
            };
        for (const metric of ['sourceBytes', 'elementCount', 'entryCount', 'htmlBytes', 'payloadBytes'] as const) {
          expect(profile[metric]).toBeGreaterThanOrEqual(bounds[metric][0]);
          expect(profile[metric]).toBeLessThanOrEqual(bounds[metric][1]);
        }
      }
      // Timings are descriptive diagnostics only; no duration is a regression gate.
      for (const ms of Object.values(profile.timingsMs)) {
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
      console.log(`[perf-profile] ${JSON.stringify(profile)}`);
    }
  });
});
