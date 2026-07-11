import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dir, '..');
const verifier = join(extensionRoot, 'scripts/verify-public-metadata.mjs');
const temps: string[] = [];

type Entry = {
  path: string;
  sha256: string;
  origin: string;
  authorOrOwner: string;
  licenseBasis: string;
  disposition: string;
  reviewer: string;
  reviewDate: string;
  approved: boolean;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validEntry(path = 'README.md', source = '# Public\n'): Entry {
  return {
    path,
    sha256: hash(source),
    origin: 'DITA Editor project',
    authorOrOwner: 'DITA Editor contributors',
    licenseBasis: 'Apache-2.0',
    disposition: 'public-export',
    reviewer: 'Paul Razvan Sarbu',
    reviewDate: '2026-07-11',
    approved: true,
  };
}

function fixture(options: {
  entries?: Entry[];
  inventory?: string[];
  files?: Record<string, string>;
  symlink?: { path: string; target: string };
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dita-editor-metadata-'));
  temps.push(root);
  const files = options.files ?? { 'README.md': '# Public\n' };
  const entries = options.entries ?? [validEntry()];
  const inventory = options.inventory ?? ['README.md', 'docs/provenance.json', 'docs/public-export.json'];
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  mkdirSync(join(root, 'docs'), { recursive: true });
  const inventorySource = `${JSON.stringify({ version: 1, files: inventory }, null, 2)}\n`;
  writeFileSync(join(root, 'docs/public-export.json'), inventorySource);
  const manifestEntry = validEntry('docs/public-export.json', inventorySource);
  writeFileSync(join(root, 'docs/provenance.json'), `${JSON.stringify([...entries, manifestEntry], null, 2)}\n`);
  if (options.symlink) symlinkSync(options.symlink.target, join(root, options.symlink.path));
  return root;
}

function run(root: string, scanOnly = false) {
  const result = Bun.spawnSync({
    cmd: ['node', verifier, '--root', root, ...(scanOnly ? ['--scan-only'] : [])],
    cwd: extensionRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

describe('actual public metadata verifier', () => {
  test('accepts a complete exact inventory and scans only its approved bytes', () => {
    const result = run(fixture());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Public metadata verified: 2 approved files; 3 export paths; 0 scan findings.');
  });

  test('rejects missing and stale provenance', () => {
    expect(run(fixture({ entries: [] })).stderr).toContain('missing provenance entry');
    expect(run(fixture({ entries: [{ ...validEntry(), sha256: '0'.repeat(64) }] })).stderr).toContain('stale sha256');
  });

  test('rejects duplicate, case-fold, and Unicode-normalized aliases', () => {
    const duplicate = [validEntry(), validEntry()];
    expect(run(fixture({ entries: duplicate })).stderr).toContain('duplicate path');
    const caseFold = [validEntry(), validEntry('readme.md')];
    expect(run(fixture({ entries: caseFold, inventory: ['README.md', 'readme.md', 'docs/provenance.json', 'docs/public-export.json'], files: { 'README.md': '# Public\n', 'readme.md': '# Public\n' } })).stderr).toContain('case-fold or Unicode-normalized collision');
    const composed = 'caf\u00e9.md';
    const decomposed = 'cafe\u0301.md';
    expect(run(fixture({ entries: [validEntry(composed), validEntry(decomposed)], inventory: [composed, decomposed, 'docs/provenance.json', 'docs/public-export.json'], files: { [composed]: '# Public\n', [decomposed]: '# Public\n' } })).stderr).toContain('canonical POSIX-relative NFC');
  });

  test('rejects unapproved, placeholder, and invalid classification entries', () => {
    expect(run(fixture({ entries: [{ ...validEntry(), approved: false }] })).stderr).toContain('approved must be true');
    expect(run(fixture({ entries: [{ ...validEntry(), origin: 'TBD' }] })).stderr).toContain('origin is empty or contains a placeholder');
    expect(run(fixture({ entries: [{ ...validEntry(), disposition: 'maybe-public' }] })).stderr).toContain('disposition must be public-export');
    expect(run(fixture({ entries: [{ ...validEntry(), licenseBasis: 'unknown' }] })).stderr).toContain('licenseBasis is not an allowed classification');
  });

  test('rejects symlinks and inventory/provenance disagreement in either direction', () => {
    const target = join(tmpdir(), 'dita-editor-outside-target.txt');
    writeFileSync(target, '# Public\n');
    const linked = fixture({ files: {}, entries: [validEntry('linked.md')], inventory: ['linked.md', 'docs/provenance.json', 'docs/public-export.json'], symlink: { path: 'linked.md', target } });
    expect(run(linked).stderr).toContain('must not be a symbolic link');
    rmSync(target, { force: true });

    expect(run(fixture({ entries: [validEntry()], inventory: ['README.md', 'EXTRA.md', 'docs/provenance.json', 'docs/public-export.json'], files: { 'README.md': '# Public\n', 'EXTRA.md': '# Extra\n' } })).stderr).toContain('missing provenance entry');
    expect(run(fixture({ entries: [validEntry(), validEntry('EXTRA.md', '# Extra\n')], inventory: ['README.md', 'docs/provenance.json', 'docs/public-export.json'], files: { 'README.md': '# Public\n', 'EXTRA.md': '# Extra\n' } })).stderr).toContain('not in the exact public export inventory');
  });

  test('scan-only executes the real scanner and rejects private marker bytes', () => {
    const marker = ['eti', 'had'].join('');
    const root = fixture({
      entries: [validEntry('README.md', `# ${marker}\n`)],
      files: { 'README.md': `# ${marker}\n` },
    });
    const result = run(root, true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[private-organization]');
  });
});
