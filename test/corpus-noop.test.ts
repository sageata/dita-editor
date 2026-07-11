// PRIMARY GATE: parse -> serialize is byte-identical across the selected
// corpus. This must stay green; no edit feature is trusted until it is. A clean
// round-trip means the CST tiles every byte of every file and loses nothing the
// source preserves (entities, dashes, wrapped-line spaces, DOCTYPE declarations,
// attribute order/quoting, and indentation).

import fs from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { diffContext, firstDiff } from './helpers';
import { loadCorpusFiles, usesExternalCorpus } from './corpus';

interface Failure {
  file: string;
  kind: 'parse-error' | 'mismatch' | 'byte-mismatch';
  detail: string;
}

describe('corpus no-op round-trip', () => {
  const files = loadCorpusFiles();
  const external = usesExternalCorpus();

  test('corpus is present and complete', () => {
    if (external) expect(files.length).toBeGreaterThanOrEqual(1500);
    else expect(files.length).toBeGreaterThan(0);
  });

  test('every .dita file round-trips byte-for-byte', () => {
    const failures: Failure[] = [];

    for (const file of files) {
      const buf = fs.readFileSync(file.abs);
      const original = buf.toString('utf8');
      let serialized: string;
      try {
        serialized = serialize(parse(original));
      } catch (err) {
        failures.push({ file: file.rel, kind: 'parse-error', detail: String(err) });
        continue;
      }
      if (serialized !== original) {
        const at = firstDiff(original, serialized);
        failures.push({
          file: file.rel,
          kind: 'mismatch',
          detail: diffContext(original, serialized, at),
        });
        continue;
      }
      // Strict byte check (UTF-8): re-encode and compare to the original bytes.
      if (!Buffer.from(serialized, 'utf8').equals(buf)) {
        failures.push({ file: file.rel, kind: 'byte-mismatch', detail: 'utf-8 byte length/content differs' });
      }
    }

    if (failures.length > 0) {
      const sample = failures.slice(0, 10)
        .map((f) => `\n[${f.kind}] ${f.file}\n  ${f.detail}`)
        .join('\n');
      throw new Error(
        `${failures.length}/${files.length} files failed the no-op gate. First ${Math.min(10, failures.length)}:\n${sample}`,
      );
    }

    expect(failures.length).toBe(0);
  });
});
