import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createNodeManagedStyleFiles,
  persistManagedAuthorStylesheet,
  type ManagedStylePersistenceDependencies,
  type ManagedStyleFiles,
  type ManagedStyleTarget,
} from '../src/host/managed-style-persistence';
import { inspectAuthorStyleSource } from '../src/host/author-style-source';
import {
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
} from '../src/host/managed-author-stylesheet';
import type { AuthorStyleDefinition } from '../src/styles/author-styles';

const STYLE: AuthorStyleDefinition = {
  className: 'dc-cabin-lead',
  name: 'Cabin lead',
  target: 'heading',
  color: '#123456',
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempTarget(nested = 'styles/managed.css'): Promise<{
  root: string;
  target: ManagedStyleTarget;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ditaeditor-managed-style-'));
  cleanupPaths.push(root);
  const parent = path.dirname(path.join(root, nested));
  if (parent !== root) await mkdir(parent, { recursive: true });
  const canonicalRoot = await realpath(root);
  const lexicalPath = path.join(root, nested);
  const canonicalPath = path.join(canonicalRoot, nested);
  return {
    root,
    target: {
      configuredPath: nested,
      uri: `file://${lexicalPath}`,
      lexicalPath,
      canonicalPath,
      identity: canonicalPath,
    },
  };
}

function dependencies(logs: string[]): ManagedStylePersistenceDependencies {
  const files = createNodeManagedStyleFiles();
  return {
    files,
    listDocuments: () => [],
    resolveDocumentIdentity: async (fsPath) => realpath(fsPath),
    platform: process.platform,
    nonce: () => 'nonce-123',
    now: () => new Date('2026-07-10T08:00:00.000Z'),
    pid: 4242,
    hostname: () => 'test-host',
    log: (message) => logs.push(message),
  };
}

async function exists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function createManagedSource(target: ManagedStyleTarget, styles: unknown = [STYLE]): Promise<string> {
  const plan = planManagedAuthorStylesheetWrite(null, styles);
  if (!plan.ok) throw new Error(plan.reason);
  await writeFile(target.canonicalPath, plan.resultingText, 'utf8');
  return plan.resultingText;
}

function withFiles(
  deps: ManagedStylePersistenceDependencies,
  override: Partial<ManagedStyleFiles>,
): ManagedStylePersistenceDependencies {
  return { ...deps, files: { ...deps.files, ...override } };
}

describe('persistManagedAuthorStylesheet', () => {
  test('node file handles retain one exact nanosecond identity after pathname replacement', async () => {
    const { target } = await tempTarget('identity-probe');
    const files = createNodeManagedStyleFiles();
    const handle = await files.open(target.canonicalPath, 'wx', 0o600);
    try {
      const opened = await handle.stat();
      const openedPath = await files.lstat(target.canonicalPath);
      expect(typeof opened.birthtimeNs).toBe('bigint');
      expect(opened.birthtimeNs).toBe(openedPath.birthtimeNs);

      await files.unlink(target.canonicalPath);
      await writeFile(target.canonicalPath, 'replacement', 'utf8');
      const cached = await handle.stat();
      const replacement = await files.lstat(target.canonicalPath);

      expect(cached.dev).toBe(opened.dev);
      expect(cached.ino).toBe(opened.ino);
      expect(cached.birthtimeNs).toBe(opened.birthtimeNs);
      expect(typeof replacement.birthtimeNs).toBe('bigint');
      expect(replacement.birthtimeNs).not.toBe(opened.birthtimeNs);
      expect(cached.birthtimeNs).not.toBe(replacement.birthtimeNs);
    } finally {
      await handle.close();
    }
  });

  test('creates a missing custom nested destination exclusively and cleans its owned lock', async () => {
    const { target } = await tempTarget('custom/nested/managed.css');
    const logs: string[] = [];
    let resolutions = 0;
    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => {
        resolutions += 1;
        return { target, exists: await exists(target.canonicalPath) };
      },
    }, dependencies(logs));

    expect(result.ok).toBe(true);
    expect(resolutions).toBe(2);
    const source = await readFile(target.canonicalPath, 'utf8');
    expect(inspectManagedAuthorStylesheet(source).kind).toBe('marked');
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(logs).toEqual([]);
  });

  test('replaces an existing marked file through a flushed same-directory temporary file', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    let hookCalls = 0;
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = () => { hookCalls += 1; };
    const next = { ...STYLE, name: 'Updated cabin lead' };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [next],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(true);
    expect(hookCalls).toBe(1);
    const source = await readFile(target.canonicalPath, 'utf8');
    expect(inspectManagedAuthorStylesheet(source).styles.find((entry) => entry.className === next.className)?.name)
      .toBe(next.name);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(logs).toEqual([]);
  });

  test('rejects an invalid payload before document, resolver, or filesystem mutation work', async () => {
    const { target } = await tempTarget();
    const logs: string[] = [];
    let opens = 0;
    let resolutions = 0;
    const deps = dependencies(logs);
    const files = deps.files;
    const guarded = withFiles(deps, {
      open: async (...args) => {
        opens += 1;
        return files.open(...args);
      },
    });

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE, { ...STYLE }],
      revalidateTarget: async () => {
        resolutions += 1;
        return { target, exists: false };
      },
    }, guarded);

    expect(result.ok).toBe(false);
    expect(opens).toBe(0);
    expect(resolutions).toBe(0);
    expect(await exists(target.canonicalPath)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('an unpaired UTF-16 surrogate refuses physical creation with zero filesystem mutation', async () => {
    const { target } = await tempTarget();
    const logs: string[] = [];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [{ ...STYLE, name: `Cabin lead \ud800` }],
      revalidateTarget: async () => ({ target, exists: false }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unpaired UTF-16 surrogate');
    expect(await exists(target.canonicalPath)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('an unpaired UTF-16 surrogate refuses physical replacement with destination bytes and inode untouched', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialStat = await stat(target.canonicalPath);
    const logs: string[] = [];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, color: `#123456\udc00` }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unpaired UTF-16 surrogate');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(Number(initialStat.ino));
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('refuses a dirty matching open document before acquiring a lock', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 7,
      dirty: true,
      generation: {},
      text: `${initialSource}/* dirty */`,
    }];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never written' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    if (!result.ok) expect(result.error).toContain('unsaved changes');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('unsaved changes');
  });

  test('refuses a dirty exact configured stylesheet document with no file extension', async () => {
    const { target } = await tempTarget('managed-styles');
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 3,
      dirty: true,
      generation: {},
      text: `${initialSource}/* dirty */`,
    }];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never written' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsaved changes');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('unsaved changes');
  });

  test('refuses a dirty exact configured .scss stylesheet document', async () => {
    const { target } = await tempTarget('theme/managed-styles.scss');
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 8,
      dirty: true,
      generation: {},
      text: `${initialSource}/* dirty scss */`,
    }];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never written' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsaved changes');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('unsaved changes');
  });

  test('a stale displayed hash refuses after the lock without replacing destination bytes', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet('different').sourceHash,
      styles: [{ ...STYLE, name: 'Never written' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('changed since it was displayed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('every pre-existing lock is a visible refusal and is never aged out or deleted', async () => {
    const { target } = await tempTarget();
    const logs: string[] = [];
    const lockPath = `${target.canonicalPath}.ditaeditor.lock`;
    for (const contents of [
      '{"schemaVersion":1,"startedAt":"2026-07-10T07:59:59.000Z"}\n',
      'crash-stale lock from last year',
    ]) {
      await writeFile(lockPath, contents, 'utf8');
      const result = await persistManagedAuthorStylesheet({
        target,
        displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
        styles: [STYLE],
        revalidateTarget: async () => ({ target, exists: false }),
      }, dependencies(logs));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(lockPath);
        expect(result.error).toContain('removed manually only after confirming no DITA Editor instance is writing');
      }
      expect(await readFile(lockPath, 'utf8')).toBe(contents);
      await rm(lockPath);
    }
  });

  test('an existing empty file is refused as noncanonical, not treated as missing', async () => {
    const { target } = await tempTarget();
    await writeFile(target.canonicalPath, '');
    const logs: string[] = [];
    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet('').sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe('');
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('invalid UTF-8 bytes refuse before any replacement', async () => {
    const { target } = await tempTarget();
    const invalid = Buffer.from([0xc3, 0x28]);
    await writeFile(target.canonicalPath, invalid);
    const logs: string[] = [];
    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: 'unavailable-invalid-source',
      styles: [STYLE],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid or lossy UTF-8');
    expect(Buffer.from(await readFile(target.canonicalPath))).toEqual(invalid);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('an external edit to any destination byte after temp flush refuses with zero replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const externalSource = `/* external prefix */\r\n${initialSource}`;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = async () => {
      await writeFile(target.canonicalPath, externalSource, 'utf8');
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('bytes changed before commit');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(externalSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('bytes changed before commit');
  });

  test('in-place temporary-file mutation after flush refuses before rename and preserves destination bytes', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const temporaryPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = async () => {
      await writeFile(temporaryPath, 'tampered temporary bytes', 'utf8');
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('temporary file bytes changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(temporaryPath)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('temporary file bytes changed');
  });

  test('temporary pathname replacement after flush refuses by inode and leaves the foreign file untouched', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const temporaryPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
    let replacementBytes = Buffer.alloc(0);
    let replacementInode = 0;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = async () => {
      replacementBytes = await readFile(temporaryPath);
      await rm(temporaryPath);
      await writeFile(temporaryPath, replacementBytes);
      replacementInode = Number((await stat(temporaryPath)).ino);
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('temporary file identity changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Buffer.from(await readFile(temporaryPath))).toEqual(replacementBytes);
    expect(Number((await stat(temporaryPath)).ino)).toBe(replacementInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('temporary file identity changed');
    expect(logs.join('\n')).toContain('cleanup left');
  });

  test('temporary pathname replacement with a reused inode requires matching usable birth times', async () => {
    for (const {
      ownedBirthtimeMs,
      replacementBirthtimeMs,
      ownedBirthtimeNs,
      replacementBirthtimeNs,
    } of [
      {
        ownedBirthtimeMs: 100,
        replacementBirthtimeMs: 200,
        ownedBirthtimeNs: undefined,
        replacementBirthtimeNs: undefined,
      },
      {
        ownedBirthtimeMs: 100,
        replacementBirthtimeMs: undefined,
        ownedBirthtimeNs: undefined,
        replacementBirthtimeNs: undefined,
      },
      {
        ownedBirthtimeMs: undefined,
        replacementBirthtimeMs: 100,
        ownedBirthtimeNs: undefined,
        replacementBirthtimeNs: undefined,
      },
      {
        ownedBirthtimeMs: 100,
        replacementBirthtimeMs: 100,
        ownedBirthtimeNs: 100_000_001n,
        replacementBirthtimeNs: 100_000_002n,
      },
      {
        ownedBirthtimeMs: 100,
        replacementBirthtimeMs: 100,
        ownedBirthtimeNs: 100_000_001n,
        replacementBirthtimeNs: undefined,
      },
      {
        ownedBirthtimeMs: 100,
        replacementBirthtimeMs: 100,
        ownedBirthtimeNs: undefined,
        replacementBirthtimeNs: 100_000_002n,
      },
    ] as const) {
      const { target } = await tempTarget();
      const initialSource = await createManagedSource(target);
      const temporaryPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
      const logs: string[] = [];
      const deps = dependencies(logs);
      const files = deps.files;
      let hookCalls = 0;
      deps.afterTemporaryFileFlush = async () => {
        hookCalls += 1;
        const replacementBytes = await readFile(temporaryPath);
        await rm(temporaryPath);
        await writeFile(temporaryPath, replacementBytes);
      };
      const reusedIdentity = withFiles(deps, {
        open: async (value, flags, mode) => {
          const handle = await files.open(value, flags, mode);
          if (value !== temporaryPath) return handle;
          return {
            ...handle,
            stat: async () => ({
              ...await handle.stat(),
              dev: 7,
              ino: 11,
              birthtimeMs: ownedBirthtimeMs,
              birthtimeNs: ownedBirthtimeNs,
            }),
          };
        },
        lstat: async (value) => {
          const current = await files.lstat(value);
          return value === temporaryPath
            ? {
              ...current,
              dev: 7,
              ino: 11,
              birthtimeMs: replacementBirthtimeMs,
              birthtimeNs: replacementBirthtimeNs,
            }
            : current;
        },
      });
      const result = await persistManagedAuthorStylesheet({
        target,
        displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
        styles: [{ ...STYLE, name: 'Never committed' }],
        revalidateTarget: async () => ({ target, exists: true }),
      }, reusedIdentity);

      expect(hookCalls).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('temporary file identity changed');
      expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
      expect(await exists(temporaryPath)).toBe(true);
      expect(logs.join('\n')).toContain('cleanup left');
    }
  });

  test('adapters without usable birth times retain dev and inode ownership compatibility', async () => {
    for (const [birthtimeMs, birthtimeNs] of [
      [undefined, undefined],
      [0, 0n],
    ] as const) {
      const { target } = await tempTarget();
      const initialSource = await createManagedSource(target);
      const temporaryPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
      const lockPath = `${target.canonicalPath}.ditaeditor.lock`;
      const logs: string[] = [];
      const deps = dependencies(logs);
      const files = deps.files;
      const withoutUsableBirthtime = withFiles(deps, {
        open: async (value, flags, mode) => {
          const handle = await files.open(value, flags, mode);
          return {
            ...handle,
            stat: async () => ({ ...await handle.stat(), birthtimeMs, birthtimeNs }),
          };
        },
        lstat: async (value) => ({
          ...await files.lstat(value),
          birthtimeMs,
          birthtimeNs,
        }),
      });

      const result = await persistManagedAuthorStylesheet({
        target,
        displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
        styles: [{ ...STYLE, name: `Compatible ${String(birthtimeMs)}` }],
        revalidateTarget: async () => ({ target, exists: true }),
      }, withoutUsableBirthtime);

      expect(result.ok).toBe(true);
      expect(await exists(temporaryPath)).toBe(false);
      expect(await exists(lockPath)).toBe(false);
      expect(logs).toEqual([]);
    }
  });

  test('a matching document generation that becomes dirty after temp flush refuses before rename', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const generation = {};
    let document = {
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 4,
      dirty: false,
      generation,
      text: initialSource,
    };
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [document];
    deps.afterTemporaryFileFlush = () => {
      document = { ...document, version: 5, dirty: true, text: `${initialSource}/* dirty */` };
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test('a clean matching document version change after temp flush refuses with zero destination replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    const generation = {};
    let document = {
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 4,
      dirty: false,
      generation,
      text: initialSource,
    };
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [document];
    deps.afterTemporaryFileFlush = () => {
      document = { ...document, version: 5 };
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('open managed stylesheet document changed');
  });

  test('a matching document generation-object change after temp flush refuses with zero destination replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    let document = {
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 4,
      dirty: false,
      generation: {},
      text: initialSource,
    };
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [document];
    deps.afterTemporaryFileFlush = () => {
      document = { ...document, generation: {} };
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('open managed stylesheet document changed');
  });

  test('a matching document appearing after temp flush refuses with zero destination replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    let documents: ReturnType<ManagedStylePersistenceDependencies['listDocuments']> = [];
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => documents;
    deps.afterTemporaryFileFlush = () => {
      documents = [{
        uri: target.uri,
        scheme: 'file',
        fsPath: target.lexicalPath,
        version: 1,
        dirty: false,
        generation: {},
        text: initialSource,
      }];
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('open managed stylesheet document changed');
  });

  test('a matching document disappearing after temp flush refuses with zero destination replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    let documents = [{
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 1,
      dirty: false,
      generation: {},
      text: initialSource,
    }];
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => documents;
    deps.afterTemporaryFileFlush = () => {
      documents = [];
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('open managed stylesheet document changed');
  });

  test('a matching document canonical identity change after temp flush refuses with zero destination replacement', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    const document = {
      uri: 'file:///workspace-alias/managed.css',
      scheme: 'file',
      fsPath: '/workspace-alias/managed.css',
      version: 1,
      dirty: false,
      generation: {},
      text: initialSource,
    };
    let afterFlush = false;
    let finalIdentityChecks = 0;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [document];
    deps.resolveDocumentIdentity = async () => {
      if (!afterFlush) return target.identity;
      finalIdentityChecks += 1;
      return finalIdentityChecks === 1 ? target.identity : `${target.identity}.changed`;
    };
    deps.afterTemporaryFileFlush = () => {
      afterFlush = true;
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('open managed stylesheet document changed');
    expect(finalIdentityChecks).toBe(2);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('open managed stylesheet document changed');
  });

  test('a pre-existing nonce temp path refuses exclusive creation and is never deleted', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const tempPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
    await writeFile(tempPath, 'belongs to another operation', 'utf8');
    const logs: string[] = [];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await readFile(tempPath, 'utf8')).toBe('belongs to another operation');
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.at(-1)).toContain('temporary file could not be created exclusively');
  });

  test('temporary flush failure removes only the owned temp and never replaces the destination', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    const files = deps.files;
    const failing = withFiles(deps, {
      open: async (value, flags, mode) => {
        const handle = await files.open(value, flags, mode);
        if (!value.endsWith('.tmp')) return handle;
        return { ...handle, sync: async () => { throw new Error('injected temp sync failure'); } };
      },
    });

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, failing);

    expect(result.ok).toBe(false);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('injected temp sync failure');
  });

  test('injected Windows-style rename failure refuses without direct-write fallback', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    const failing = withFiles(deps, {
      rename: async () => {
        const error = new Error('injected Windows sharing violation') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, failing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no direct-write fallback');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test('an in-workspace canonical target pivot between checks refuses before commit', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    let resolutions = 0;
    const pivot: ManagedStyleTarget = {
      ...target,
      canonicalPath: path.join(path.dirname(target.canonicalPath), 'pivot.css'),
      identity: path.join(path.dirname(target.identity), 'pivot.css'),
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => {
        resolutions += 1;
        return { target: resolutions === 1 ? target : pivot, exists: true };
      },
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    expect(resolutions).toBe(2);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test('a destination appearing before missing-file commit is never replaced or deleted', async () => {
    const { target } = await tempTarget();
    const external = 'created by another process';
    const logs: string[] = [];
    let resolutions = 0;
    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => {
        resolutions += 1;
        if (resolutions === 2) await writeFile(target.canonicalPath, external, 'utf8');
        return { target, exists: resolutions === 2 };
      },
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(external);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test('missing parent resolution refusal never creates directories', async () => {
    const { root, target } = await tempTarget('not-created/managed.css');
    await rm(path.join(root, 'not-created'), { recursive: true });
    const logs: string[] = [];
    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => null,
    }, dependencies(logs));

    expect(result.ok).toBe(false);
    expect(await exists(path.join(root, 'not-created'))).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('injected Windows-style exclusive destination open failure leaves no created file', async () => {
    const { target } = await tempTarget();
    const logs: string[] = [];
    const deps = dependencies(logs);
    const files = deps.files;
    const failing = withFiles(deps, {
      open: async (value, flags, mode) => {
        if (value === target.canonicalPath) {
          const error = new Error('injected Windows access denial') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return files.open(value, flags, mode);
      },
    });

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => ({ target, exists: false }),
    }, failing);

    expect(result.ok).toBe(false);
    expect(await exists(target.canonicalPath)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('injected Windows access denial');
  });

  test('tampered lock contents are left in place and logged instead of being unlinked', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const lockPath = `${target.canonicalPath}.ditaeditor.lock`;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = async () => {
      await writeFile(lockPath, 'tampered-by-another-process', 'utf8');
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Committed despite advisory lock tamper' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(true);
    expect(await readFile(lockPath, 'utf8')).toBe('tampered-by-another-process');
    expect(logs.at(-1)).toContain('replaced or tampered with');
  });

  test('a handled mid-create write failure removes only the destination inode this operation created', async () => {
    const { target } = await tempTarget();
    const logs: string[] = [];
    const deps = dependencies(logs);
    const files = deps.files;
    const failing = withFiles(deps, {
      open: async (value, flags, mode) => {
        const handle = await files.open(value, flags, mode);
        if (value !== target.canonicalPath) return handle;
        return {
          ...handle,
          writeFile: async (data) => {
            await handle.writeFile(data.subarray(0, Math.min(12, data.length)));
            throw new Error('injected mid-create write failure');
          },
        };
      },
    });

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [STYLE],
      revalidateTarget: async () => ({ target, exists: false }),
    }, failing);

    expect(result.ok).toBe(false);
    expect(await exists(target.canonicalPath)).toBe(false);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('injected mid-create write failure');
  });

  test('atomic replacement preserves destination mode without chmodding a hard-linked developer inode', async () => {
    const { root, target } = await tempTarget('managed.css');
    const developerPath = path.join(root, 'developer.css');
    const initialPlan = planManagedAuthorStylesheetWrite(null, [STYLE]);
    if (!initialPlan.ok) throw new Error(initialPlan.reason);
    await writeFile(developerPath, initialPlan.resultingText, 'utf8');
    await chmod(developerPath, 0o640);
    await link(developerPath, target.canonicalPath);
    const developerBefore = await stat(developerPath);
    const managedBefore = await stat(target.canonicalPath);
    expect(Number(developerBefore.ino)).toBe(Number(managedBefore.ino));
    const logs: string[] = [];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialPlan.resultingText).sourceHash,
      styles: [{ ...STYLE, name: 'Managed only' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies(logs));

    expect(result.ok).toBe(true);
    const developerAfter = await stat(developerPath);
    const managedAfter = await stat(target.canonicalPath);
    expect(Number(developerAfter.ino)).toBe(Number(developerBefore.ino));
    expect(Number(managedAfter.ino)).not.toBe(Number(developerAfter.ino));
    expect(await readFile(developerPath, 'utf8')).toBe(initialPlan.resultingText);
    expect(inspectManagedAuthorStylesheet(await readFile(target.canonicalPath, 'utf8')).styles
      .find((entry) => entry.className === STYLE.className)?.name).toBe('Managed only');
    expect(managedAfter.mode & 0o777).toBe(0o640);
    expect(developerAfter.mode & 0o777).toBe(0o640);
    expect(logs).toEqual([]);
  });

  test('replacement preserves the permission mode of a normal destination', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    await chmod(target.canonicalPath, 0o604);

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Mode preserved' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, dependencies([]));

    expect(result.ok).toBe(true);
    expect((await stat(target.canonicalPath)).mode & 0o777).toBe(0o604);
  });

  test('replacement preserves every permission and special bit of the destination', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const temporaryPath = `${target.canonicalPath}.ditaeditor-nonce-123.tmp`;
    const deps = dependencies([]);
    const files = deps.files;
    let temporaryMode = 0o600;
    let targetMode = 0o4755;
    const specialBits = withFiles(deps, {
      lstat: async (value) => {
        const current = await files.lstat(value);
        if (value === target.canonicalPath) return { ...current, mode: targetMode };
        if (value === temporaryPath) return { ...current, mode: temporaryMode };
        return current;
      },
      open: async (value, flags, mode) => {
        const handle = await files.open(value, flags, mode);
        if (value !== temporaryPath) return handle;
        temporaryMode = mode ?? 0o600;
        return {
          ...handle,
          writeFile: async (data) => {
            await handle.writeFile(data);
            // POSIX writes may clear setuid/setgid bits. Model that behavior so
            // this regression remains deterministic on filesystems that refuse
            // to set those bits on a temporary test file in the first place.
            temporaryMode &= ~0o6000;
          },
          chmod: async (mode) => {
            temporaryMode = mode;
            await handle.chmod(mode & 0o777);
          },
          stat: async () => ({ ...await handle.stat(), mode: temporaryMode }),
        };
      },
      rename: async (from, to) => {
        await files.rename(from, to);
        if (from === temporaryPath && to === target.canonicalPath) targetMode = temporaryMode;
      },
    });
    expect((await specialBits.files.lstat(target.canonicalPath)).mode & 0o7777).toBe(0o4755);

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Special mode preserved' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, specialBits);

    expect(result.ok).toBe(true);
    expect((await specialBits.files.lstat(target.canonicalPath)).mode & 0o7777).toBe(0o4755);
  });

  test('a replaced lock inode is left untouched even when another process copies plausible contents', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const lockPath = `${target.canonicalPath}.ditaeditor.lock`;
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.afterTemporaryFileFlush = async () => {
      const contents = await readFile(lockPath);
      await rm(lockPath);
      await writeFile(lockPath, contents);
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(true);
    expect(await exists(lockPath)).toBe(true);
    expect(logs.at(-1)).toContain('file identity changed');
  });

  test('canonical document matching catches a dirty file opened through a symlinked workspace root', async () => {
    const { root, target } = await tempTarget('managed.css');
    const initialSource = await createManagedSource(target);
    const aliasRoot = `${root}-alias`;
    cleanupPaths.push(aliasRoot);
    await symlink(root, aliasRoot, 'dir');
    const aliasedPath = path.join(aliasRoot, 'managed.css');
    const aliasedTarget: ManagedStyleTarget = {
      ...target,
      uri: `file://${aliasedPath}`,
      lexicalPath: aliasedPath,
    };
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: `file://${target.canonicalPath}`,
      scheme: 'file',
      fsPath: target.canonicalPath,
      version: 1,
      dirty: true,
      generation: {},
      text: `${initialSource}/* dirty alias */`,
    }];

    const result = await persistManagedAuthorStylesheet({
      target: aliasedTarget,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target: aliasedTarget, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsaved changes');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test.each([
    'dirty-managed-alias.scss',
    'dirty-managed-alias',
  ])('a dirty physical symlink alias refuses replacement regardless of extension: %s', async (aliasName) => {
    const { root, target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const initialInode = Number((await stat(target.canonicalPath)).ino);
    const aliasPath = path.join(root, aliasName);
    await symlink(target.canonicalPath, aliasPath, 'file');
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [
      {
        uri: target.uri,
        scheme: 'file',
        fsPath: target.lexicalPath,
        version: 1,
        dirty: false,
        generation: {},
        text: initialSource,
      },
      {
        uri: `file://${aliasPath}`,
        scheme: 'file',
        fsPath: aliasPath,
        version: 2,
        dirty: true,
        generation: {},
        text: `${initialSource}/* dirty physical alias */`,
      },
    ];

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsaved changes');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(Number((await stat(target.canonicalPath)).ino)).toBe(initialInode);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
  });

  test('an unresolved possible document alias is a logged structured refusal before locking', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: 'file:///possible-alias/managed.css',
      scheme: 'file',
      fsPath: '/possible-alias/managed.css',
      version: 1,
      dirty: true,
      generation: {},
      text: `${initialSource}/* possibly dirty alias */`,
    }];
    deps.resolveDocumentIdentity = async () => { throw new Error('injected identity failure'); };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('identities could not be resolved safely');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('injected identity failure');
  });

  test('an unresolved non-CSS document fails closed because it could be an extensionless canonical alias', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [{
      uri: 'file:///workspace/new-topic.dita',
      scheme: 'file',
      fsPath: '/workspace/new-topic.dita',
      version: 1,
      dirty: true,
      generation: {},
      text: '<topic/>',
    }];
    deps.resolveDocumentIdentity = async () => { throw new Error('unrelated file is not on disk yet'); };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [{ ...STYLE, name: 'Never committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('identities could not be resolved safely');
    expect(await readFile(target.canonicalPath, 'utf8')).toBe(initialSource);
    expect(await exists(`${target.canonicalPath}.ditaeditor.lock`)).toBe(false);
    expect(logs.join('\n')).toContain('unrelated file is not on disk yet');
  });

  test('clean open-document text cannot normalize BOM or outside EOL bytes before persistence', async () => {
    const { target } = await tempTarget();
    const initialPlan = planManagedAuthorStylesheetWrite(null, [STYLE]);
    if (!initialPlan.ok) throw new Error(initialPlan.reason);
    const diskSource = `\ufeff/* developer prefix */\r\n${initialPlan.resultingText}\r\n/* outside suffix */\n`;
    const diskBytes = Buffer.from(diskSource, 'utf8');
    await writeFile(target.canonicalPath, diskBytes);
    const cleanDocument = {
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 6,
      dirty: false,
      generation: {},
      text: diskSource.replace(/^\ufeff/, '').replaceAll('\r\n', '\n'),
    };
    const logs: string[] = [];
    const deps = dependencies(logs);
    deps.listDocuments = () => [cleanDocument];

    const displayed = await inspectAuthorStyleSource(target, deps);
    expect(displayed.sourceText).toBe(diskSource);
    expect(displayed.sourceHash).toBe(inspectManagedAuthorStylesheet(diskSource).sourceHash);

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: displayed.sourceHash,
      styles: [{ ...STYLE, name: 'Safely committed' }],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(true);
    const writtenBytes = Buffer.from(await readFile(target.canonicalPath));
    const writtenSource = writtenBytes.toString('utf8');
    expect(writtenBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(writtenSource.startsWith('\ufeff/* developer prefix */\r\n')).toBe(true);
    expect(writtenSource.endsWith('\r\n/* outside suffix */\n')).toBe(true);
    expect(inspectManagedAuthorStylesheet(writtenSource).styles
      .find((entry) => entry.className === STYLE.className)?.name).toBe('Safely committed');
    expect(logs).toEqual([]);
  });

  test('lock metadata and temp bytes are flushed and both handles close before the after-flush hook', async () => {
    const { target } = await tempTarget();
    const initialSource = await createManagedSource(target);
    const next = { ...STYLE, name: 'Metadata checked' };
    const logs: string[] = [];
    const deps = dependencies(logs);
    const files = deps.files;
    let closes = 0;
    deps.files = {
      ...files,
      open: async (...args) => {
        const handle = await files.open(...args);
        return {
          ...handle,
          close: async () => {
            closes += 1;
            await handle.close();
          },
        };
      },
    };
    deps.afterTemporaryFileFlush = async () => {
      expect(closes).toBe(2);
      const lock = JSON.parse(await readFile(`${target.canonicalPath}.ditaeditor.lock`, 'utf8'));
      expect(lock).toEqual({
        schemaVersion: 1,
        canonicalTarget: target.canonicalPath,
        pid: 4242,
        host: 'test-host',
        startedAt: '2026-07-10T08:00:00.000Z',
        nonce: 'nonce-123',
      });
      const tempSource = await readFile(`${target.canonicalPath}.ditaeditor-nonce-123.tmp`, 'utf8');
      expect(inspectManagedAuthorStylesheet(tempSource).styles
        .find((entry) => entry.className === next.className)?.name).toBe(next.name);
    };

    const result = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(initialSource).sourceHash,
      styles: [next],
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);

    expect(result.ok).toBe(true);
    expect(closes).toBe(2);
    expect(logs).toEqual([]);
  });

  test('adversarial metadata names survive physical create, save, inspect, and live render CSS', async () => {
    const { target } = await tempTarget();
    const name = 'Cabin */ /* DITAEDITOR_MANAGED_STYLES_START */\r\n' +
      '/* DITAEDITOR_MANAGED_STYLES_END */ / \\ \' " .fake { color: red; }';
    const style = { ...STYLE, name };
    const logs: string[] = [];
    const deps = dependencies(logs);

    const created = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: inspectManagedAuthorStylesheet(null).sourceHash,
      styles: [style],
      revalidateTarget: async () => ({ target, exists: await exists(target.canonicalPath) }),
    }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdSource = await readFile(target.canonicalPath, 'utf8');
    expect(created.inspection.renderCssText).toBe(createdSource);
    expect(created.inspection.styles.find((entry) => entry.className === style.className)?.name).toBe(name);

    const saved = await persistManagedAuthorStylesheet({
      target,
      displayedSourceHash: created.inspection.sourceHash,
      styles: created.inspection.styles,
      revalidateTarget: async () => ({ target, exists: true }),
    }, deps);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const savedSource = await readFile(target.canonicalPath, 'utf8');
    expect(saved.inspection.renderCssText).toBe(savedSource);
    expect(saved.inspection.styles.find((entry) => entry.className === style.className)?.name).toBe(name);
    expect(savedSource.split('/* DITAEDITOR_MANAGED_STYLES_START */')).toHaveLength(2);
    expect(savedSource.split('/* DITAEDITOR_MANAGED_STYLES_END */')).toHaveLength(2);
    expect(logs).toEqual([]);
  });
});
