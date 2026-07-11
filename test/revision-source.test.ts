import { describe, expect, test } from 'bun:test';
import type { BaseRevision, GitRunner } from '../src/host/revision-source';
import { readFileAtRevision, resolveBaseRevision } from '../src/host/revision-source';

interface CannedResult {
  code: number;
  stdout: string;
  stderr?: string;
}

// Scripted runner: keys are `${cwd}::${args.join(' ')}` so both the git
// invocation and its working directory are asserted. Unexpected calls throw.
function makeRunner(script: Record<string, CannedResult>): GitRunner {
  return async (args, cwd) => {
    const key = `${cwd}::${args.join(' ')}`;
    const canned = script[key];
    if (!canned) throw new Error(`unexpected git call: ${key}`);
    return { code: canned.code, stdout: canned.stdout, stderr: canned.stderr ?? '' };
  };
}

const HEAD_SHA = 'facefacefacefacefacefacefacefaceface0000';
const MERGE_BASE_SHA = 'abc1234def567890abc1234def567890abc12345';

describe('resolveBaseRevision', () => {
  test('branch diverged from main resolves to the merge-base with a main label', async () => {
    const run = makeRunner({
      '/repo/topics::-C /repo/topics rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 0, stdout: `${HEAD_SHA}\n` },
      '/repo::merge-base HEAD main': { code: 0, stdout: `${MERGE_BASE_SHA}\n` },
      '/repo::rev-parse HEAD': { code: 0, stdout: `${HEAD_SHA}\n` },
    });

    const base = await resolveBaseRevision('/repo/topics/ch01.dita', run);

    expect(base).toEqual({
      rev: MERGE_BASE_SHA,
      label: 'main (abc1234)',
      repoRoot: '/repo',
      relPath: 'topics/ch01.dita',
    });
  });

  test('on main (merge-base equals HEAD) falls back to the last commit', async () => {
    const run = makeRunner({
      '/repo/topics::-C /repo/topics rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 0, stdout: `${HEAD_SHA}\n` },
      '/repo::merge-base HEAD main': { code: 0, stdout: `${HEAD_SHA}\n` },
      '/repo::rev-parse HEAD': { code: 0, stdout: `${HEAD_SHA}\n` },
    });

    const base = await resolveBaseRevision('/repo/topics/ch01.dita', run);

    expect(base).toEqual({
      rev: 'HEAD',
      label: 'last commit (HEAD)',
      repoRoot: '/repo',
      relPath: 'topics/ch01.dita',
    });
  });

  test('uses origin/main when no local main exists', async () => {
    const run = makeRunner({
      '/repo/topics::-C /repo/topics rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 1, stdout: '' },
      '/repo::rev-parse --verify --quiet origin/main': { code: 0, stdout: `${MERGE_BASE_SHA}\n` },
      '/repo::merge-base HEAD origin/main': { code: 0, stdout: `${MERGE_BASE_SHA}\n` },
      '/repo::rev-parse HEAD': { code: 0, stdout: `${HEAD_SHA}\n` },
    });

    const base = await resolveBaseRevision('/repo/topics/ch01.dita', run);

    expect(base).toEqual({
      rev: MERGE_BASE_SHA,
      label: 'origin/main (abc1234)',
      repoRoot: '/repo',
      relPath: 'topics/ch01.dita',
    });
  });

  test('neither main nor origin/main falls back to HEAD', async () => {
    const run = makeRunner({
      '/repo/topics::-C /repo/topics rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 1, stdout: '' },
      '/repo::rev-parse --verify --quiet origin/main': { code: 1, stdout: '' },
    });

    const base = await resolveBaseRevision('/repo/topics/ch01.dita', run);

    expect(base).toEqual({
      rev: 'HEAD',
      label: 'last commit (HEAD)',
      repoRoot: '/repo',
      relPath: 'topics/ch01.dita',
    });
  });

  test('repo with no commits yet (rev-parse HEAD fails) still bases on HEAD', async () => {
    const run = makeRunner({
      '/repo/topics::-C /repo/topics rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 1, stdout: '' },
      '/repo::rev-parse --verify --quiet origin/main': { code: 0, stdout: `${MERGE_BASE_SHA}\n` },
      '/repo::merge-base HEAD origin/main': { code: 128, stdout: '', stderr: 'fatal: bad revision' },
      '/repo::rev-parse HEAD': { code: 128, stdout: '', stderr: 'fatal: unknown revision' },
    });

    const base = await resolveBaseRevision('/repo/topics/ch01.dita', run);

    expect(base).toEqual({
      rev: 'HEAD',
      label: 'last commit (HEAD)',
      repoRoot: '/repo',
      relPath: 'topics/ch01.dita',
    });
  });

  test('a file outside any git repo returns not-in-git', async () => {
    const run = makeRunner({
      '/loose::-C /loose rev-parse --show-toplevel': {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    });

    expect(await resolveBaseRevision('/loose/topic.dita', run)).toBe('not-in-git');
  });

  test('relPath of a nested file is POSIX-separated', async () => {
    const dir = '/repo/src/dita/topics/08-f-b-order-taking-delivery-module';
    const run = makeRunner({
      [`${dir}::-C ${dir} rev-parse --show-toplevel`]: { code: 0, stdout: '/repo\n' },
      '/repo::rev-parse --verify --quiet main': { code: 1, stdout: '' },
      '/repo::rev-parse --verify --quiet origin/main': { code: 1, stdout: '' },
    });

    const base = await resolveBaseRevision(`${dir}/order-taking.dita`, run);

    expect(base).not.toBe('not-in-git');
    expect((base as BaseRevision).relPath).toBe(
      'src/dita/topics/08-f-b-order-taking-delivery-module/order-taking.dita',
    );
  });

  test('resolves a file path when git canonicalizes the macOS /var alias to /private/var', async () => {
    const fileDir = '/var/folders/demo/workspace/corpus/topic';
    const repoRoot = '/private/var/folders/demo/workspace';
    const run = makeRunner({
      [`${fileDir}::-C ${fileDir} rev-parse --show-toplevel`]: { code: 0, stdout: `${repoRoot}\n` },
      [`${fileDir}::-C ${fileDir} rev-parse --show-prefix`]: {
        code: 0,
        stdout: 'corpus/topic/\n',
      },
      [`${repoRoot}::rev-parse --verify --quiet main`]: { code: 1, stdout: '' },
      [`${repoRoot}::rev-parse --verify --quiet origin/main`]: { code: 1, stdout: '' },
    });

    const base = await resolveBaseRevision(`${fileDir}/lists-notes-code-lines.dita`, run);

    expect(base).not.toBe('not-in-git');
    expect((base as BaseRevision).relPath).toBe('corpus/topic/lists-notes-code-lines.dita');
  });
});

describe('readFileAtRevision', () => {
  const base: BaseRevision = {
    rev: MERGE_BASE_SHA,
    label: 'main (abc1234)',
    repoRoot: '/repo',
    relPath: 'topics/ch01.dita',
  };

  test('returns null when the file is absent at the base revision', async () => {
    const run = makeRunner({
      [`/repo::show ${MERGE_BASE_SHA}:topics/ch01.dita`]: {
        code: 128,
        stdout: '',
        stderr: `fatal: path 'topics/ch01.dita' does not exist in '${MERGE_BASE_SHA}'`,
      },
    });

    expect(await readFileAtRevision(base, run)).toBeNull();
  });

  test('returns git show stdout verbatim, untrimmed', async () => {
    const content = '<?xml version="1.0" encoding="UTF-8"?>\n<topic id="ch01">\n  <title> spaced </title>\n</topic>\n';
    const run = makeRunner({
      [`/repo::show ${MERGE_BASE_SHA}:topics/ch01.dita`]: { code: 0, stdout: content },
    });

    expect(await readFileAtRevision(base, run)).toBe(content);
  });
});
