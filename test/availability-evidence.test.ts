import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const script = join(root, 'scripts/fetch-coexistence-manifest.mjs');
const committedEvidence = join(root, 'test/owner-scoped-availability.json');
const temps: string[] = [];

function run(args: string[]) {
  const result = Bun.spawnSync({
    cmd: ['node', script, ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function mutatedEvidence(mutate: (value: any) => void): string {
  const directory = mkdtempSync(join(tmpdir(), 'dita-editor-owner-evidence-'));
  temps.push(directory);
  const value = JSON.parse(readFileSync(committedEvidence, 'utf8'));
  mutate(value);
  const path = join(directory, 'evidence.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

describe('owner-scoped availability evidence', () => {
  test('accepts the separately supplied immutable controller evidence', () => {
    const result = run([
      '--validate-owner-evidence-only',
      '--owner-evidence', committedEvidence,
      '--observation-date', '2026-07-11',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Owner-scoped availability evidence verified at 2026-07-11.');
  });

  test('fails closed when owner-scoped input is missing', () => {
    const result = run(['--validate-owner-evidence-only', '--observation-date', '2026-07-11']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--owner-evidence is required');
  });

  test('rejects stale evidence instead of refreshing its verification date', () => {
    const stale = mutatedEvidence((value) => { value.verifiedAt = '2026-07-10'; });
    const result = run([
      '--validate-owner-evidence-only', '--owner-evidence', stale,
      '--observation-date', '2026-07-11',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('owner evidence is stale');
    expect(JSON.parse(readFileSync(stale, 'utf8')).verifiedAt).toBe('2026-07-10');
  });

  test('rejects mismatched owner, repository, publisher, and extension identities', () => {
    const mutations: Array<[string, (value: any) => void]> = [
      ['viewer', (value) => { value.repository.viewer = 'different-user'; }],
      ['repository', (value) => { value.repository.name = 'different-repository'; }],
      ['publisher', (value) => { value.marketplace.publisherId = 'different-publisher'; }],
      ['extension', (value) => { value.marketplace.extensionId = 'different.extension'; }],
    ];
    for (const [label, mutate] of mutations) {
      const path = mutatedEvidence(mutate);
      const result = run([
        '--validate-owner-evidence-only', '--owner-evidence', path,
        '--observation-date', '2026-07-11',
      ]);
      expect(result.code, label).not.toBe(0);
      expect(result.stderr, label).toContain('owner evidence identity mismatch');
    }
  });

  test('committed coexistence output preserves evidence date and separates public observation time', () => {
    const owner = JSON.parse(readFileSync(committedEvidence, 'utf8'));
    const output = JSON.parse(readFileSync(join(root, 'test/coexistence-extension.json'), 'utf8'));
    expect(output.publicObservationCheckedAt).toMatch(/^2026-07-11T/);
    expect(output.checkedAt).toBeUndefined();
    expect(output.ownerScopedAvailability).toEqual(owner);
    expect(output.ownerScopedAvailability.verifiedAt).toBe('2026-07-11');
  });
});
