import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import {
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
  type ManagedStylesInspection,
} from './managed-author-stylesheet';

export interface ManagedStyleTarget {
  configuredPath: string;
  uri: string;
  lexicalPath: string;
  canonicalPath: string;
  identity: string;
}

export interface ResolvedManagedStyleTarget {
  target: ManagedStyleTarget;
  exists: boolean;
}

export interface ManagedStyleDocument {
  uri: string;
  scheme: string;
  fsPath: string;
  version: number;
  dirty: boolean;
  generation: unknown;
  text: string;
}

export interface ManagedStyleFileStat {
  mode: number;
  dev: number;
  ino: number;
  birthtimeMs?: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ManagedStyleFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
  stat(): Promise<ManagedStyleFileStat>;
  close(): Promise<void>;
}

export interface ManagedStyleFiles {
  stat(path: string): Promise<ManagedStyleFileStat>;
  lstat(path: string): Promise<ManagedStyleFileStat>;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: 'wx', mode?: number): Promise<ManagedStyleFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ManagedStylePersistenceDependencies {
  files: ManagedStyleFiles;
  listDocuments(): readonly ManagedStyleDocument[];
  resolveDocumentIdentity(fsPath: string): Promise<string>;
  platform: NodeJS.Platform;
  nonce(): string;
  now(): Date;
  pid: number;
  hostname(): string;
  log(message: string): void;
  afterTemporaryFileFlush?(): void | Promise<void>;
}

export interface ManagedStylePersistenceRequest {
  target: ManagedStyleTarget;
  displayedSourceHash: string;
  styles: unknown;
  revalidateTarget(): Promise<ResolvedManagedStyleTarget | null>;
}

export type ManagedStylePersistenceResult =
  | { ok: true; inspection: ManagedStylesInspection }
  | { ok: false; error: string };

interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs?: number;
}

interface DocumentSnapshotEntry {
  uri: string;
  version: number;
  dirty: boolean;
  generation: unknown;
  canonicalIdentity: string;
}

function nodeStat(value: Awaited<ReturnType<typeof lstat>>): ManagedStyleFileStat {
  return {
    mode: Number(value.mode),
    dev: Number(value.dev),
    ino: Number(value.ino),
    birthtimeMs: Number(value.birthtimeMs),
    isFile: () => value.isFile(),
    isSymbolicLink: () => value.isSymbolicLink(),
  };
}

export function createNodeManagedStyleFiles(): ManagedStyleFiles {
  return {
    stat: async (value) => nodeStat(await stat(value)),
    lstat: async (value) => nodeStat(await lstat(value)),
    readFile,
    realpath,
    open: async (value, flags, mode) => {
      const handle = await open(value, flags, mode);
      return {
        writeFile: async (data) => { await handle.writeFile(data); },
        sync: async () => { await handle.sync(); },
        chmod: async (nextMode) => { await handle.chmod(nextMode); },
        stat: async () => nodeStat(await handle.stat()),
        close: async () => { await handle.close(); },
      };
    },
    rename,
    unlink,
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function identityOf(stat: ManagedStyleFileStat): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function sameFile(left: FileIdentity | null, right: ManagedStyleFileStat): boolean {
  if (left === null || left.dev !== right.dev || left.ino !== right.ino) return false;
  const leftBirthtime = left?.birthtimeMs;
  const rightBirthtime = right.birthtimeMs;
  const leftBirthtimeUsable = typeof leftBirthtime === 'number' &&
    Number.isFinite(leftBirthtime) && leftBirthtime > 0;
  const rightBirthtimeUsable = typeof rightBirthtime === 'number' &&
    Number.isFinite(rightBirthtime) && rightBirthtime > 0;
  if (leftBirthtimeUsable !== rightBirthtimeUsable) return false;
  return !leftBirthtimeUsable || leftBirthtime === rightBirthtime;
}

function sameTarget(left: ManagedStyleTarget, right: ManagedStyleTarget): boolean {
  return left.configuredPath === right.configuredPath &&
    left.uri === right.uri &&
    left.lexicalPath === right.lexicalPath &&
    left.canonicalPath === right.canonicalPath &&
    left.identity === right.identity;
}

function refuse(
  dependencies: ManagedStylePersistenceDependencies,
  message: string,
  error?: unknown,
): ManagedStylePersistenceResult {
  const detail = error === undefined ? message : `${message}: ${String(error)}`;
  dependencies.log(detail);
  return { ok: false, error: message };
}

export function decodeManagedStyleSource(bytes: Uint8Array): string | null {
  const source = Buffer.from(bytes).toString('utf8');
  return Buffer.from(source, 'utf8').equals(Buffer.from(bytes)) ? source : null;
}

export async function findMatchingManagedStyleDocuments(
  target: ManagedStyleTarget,
  dependencies: Pick<ManagedStylePersistenceDependencies,
    'listDocuments' | 'resolveDocumentIdentity' | 'platform' | 'log'>,
): Promise<ManagedStyleDocument[]> {
  const matches: ManagedStyleDocument[] = [];
  for (const document of dependencies.listDocuments()) {
    if (document.scheme !== 'file') continue;
    let resolvedIdentity: string;
    try {
      resolvedIdentity = await dependencies.resolveDocumentIdentity(document.fsPath);
    } catch (error) {
      const message = `Open document identity could not be resolved safely for ${document.fsPath}: ${String(error)}`;
      dependencies.log(message);
      throw new Error(message);
    }
    if (resolvedIdentity !== target.identity) continue;
    matches.push(document);
  }
  return matches.sort((left, right) => left.uri.localeCompare(right.uri));
}

async function snapshotDocuments(
  target: ManagedStyleTarget,
  dependencies: ManagedStylePersistenceDependencies,
): Promise<DocumentSnapshotEntry[]> {
  const matches = await findMatchingManagedStyleDocuments(target, dependencies);
  const snapshot: DocumentSnapshotEntry[] = [];
  for (const document of matches) {
    let resolvedIdentity: string;
    try {
      resolvedIdentity = await dependencies.resolveDocumentIdentity(document.fsPath);
    } catch (error) {
      const message = `Matching open document identity changed or became inaccessible for ${document.fsPath}: ${String(error)}`;
      dependencies.log(message);
      throw new Error(message);
    }
    if (resolvedIdentity !== target.identity) {
      const message = `Matching open document identity changed for ${document.fsPath}.`;
      dependencies.log(message);
      throw new Error(message);
    }
    snapshot.push({
      uri: document.uri,
      version: document.version,
      dirty: document.dirty,
      generation: document.generation,
      canonicalIdentity: resolvedIdentity,
    });
  }
  return snapshot;
}

function sameDocumentSnapshot(
  left: readonly DocumentSnapshotEntry[],
  right: readonly DocumentSnapshotEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      entry.uri === candidate.uri &&
      entry.version === candidate.version &&
      entry.dirty === candidate.dirty &&
      entry.generation === candidate.generation &&
      entry.canonicalIdentity === candidate.canonicalIdentity;
  });
}

async function closeQuietly(
  handle: ManagedStyleFileHandle | null,
  dependencies: ManagedStylePersistenceDependencies,
  label: string,
): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch (error) {
    dependencies.log(`${label} close failed: ${String(error)}`);
  }
}

async function removeOwnedFile(
  path: string,
  ownedIdentity: FileIdentity | null,
  dependencies: ManagedStylePersistenceDependencies,
  label: string,
): Promise<void> {
  if (ownedIdentity === null) return;
  try {
    const current = await dependencies.files.lstat(path);
    if (!sameFile(ownedIdentity, current)) {
      dependencies.log(`${label} cleanup left ${path} because its file identity changed.`);
      return;
    }
    await dependencies.files.unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      dependencies.log(`${label} cleanup failed for ${path}: ${String(error)}`);
    }
  }
}

async function removeOwnedLock(
  path: string,
  ownedIdentity: FileIdentity | null,
  nonce: string,
  canonicalTarget: string,
  dependencies: ManagedStylePersistenceDependencies,
): Promise<void> {
  if (ownedIdentity === null) return;
  try {
    const currentStat = await dependencies.files.lstat(path);
    if (!sameFile(ownedIdentity, currentStat)) {
      dependencies.log(`Managed stylesheet lock cleanup left ${path} because its file identity changed.`);
      return;
    }
    const source = decodeManagedStyleSource(await dependencies.files.readFile(path));
    if (source === null) {
      dependencies.log(`Managed stylesheet lock cleanup left ${path} because its contents are not valid UTF-8.`);
      return;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(source);
    } catch {
      dependencies.log(`Managed stylesheet lock cleanup left ${path} because its contents were replaced or tampered with.`);
      return;
    }
    if (typeof metadata !== 'object' || metadata === null ||
      (metadata as { nonce?: unknown }).nonce !== nonce ||
      (metadata as { canonicalTarget?: unknown }).canonicalTarget !== canonicalTarget) {
      dependencies.log(`Managed stylesheet lock cleanup left ${path} because its contents were replaced or tampered with.`);
      return;
    }
    await dependencies.files.unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      dependencies.log(`Managed stylesheet lock cleanup failed for ${path}: ${String(error)}`);
    }
  }
}

export async function persistManagedAuthorStylesheet(
  request: ManagedStylePersistenceRequest,
  dependencies: ManagedStylePersistenceDependencies,
): Promise<ManagedStylePersistenceResult> {
  const validation = planManagedAuthorStylesheetWrite(null, request.styles);
  if (!validation.ok) return refuse(dependencies, validation.reason);

  let initialDocuments: DocumentSnapshotEntry[];
  try {
    initialDocuments = await snapshotDocuments(request.target, dependencies);
  } catch (error) {
    return refuse(dependencies, 'Open managed stylesheet document identities could not be resolved safely.', error);
  }
  if (initialDocuments.some((document) => document.dirty)) {
    return refuse(
      dependencies,
      'The managed author stylesheet is open with unsaved changes. Save or revert that document before changing styles.',
    );
  }

  let firstResolution: ResolvedManagedStyleTarget | null;
  try {
    firstResolution = await request.revalidateTarget();
  } catch (error) {
    return refuse(dependencies, 'The managed stylesheet destination could not be revalidated safely.', error);
  }
  if (firstResolution === null || !sameTarget(request.target, firstResolution.target)) {
    return refuse(dependencies, 'The managed stylesheet destination changed since it was displayed. Reload the editor before saving.');
  }

  const nonce = dependencies.nonce();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    return refuse(dependencies, 'The managed stylesheet operation nonce is invalid.');
  }
  const target = firstResolution.target;
  const lockPath = `${target.canonicalPath}.ditaeditor.lock`;
  const temporaryPath = `${target.canonicalPath}.ditaeditor-${nonce}.tmp`;
  const lockMetadata = {
    schemaVersion: 1,
    canonicalTarget: target.canonicalPath,
    pid: dependencies.pid,
    host: dependencies.hostname(),
    startedAt: dependencies.now().toISOString(),
    nonce,
  };
  const lockBytes = Buffer.from(`${JSON.stringify(lockMetadata)}\n`, 'utf8');
  let lockHandle: ManagedStyleFileHandle | null = null;
  let lockIdentity: FileIdentity | null = null;
  let temporaryHandle: ManagedStyleFileHandle | null = null;
  let destinationHandle: ManagedStyleFileHandle | null = null;
  let destinationIdentity: FileIdentity | null = null;
  let temporaryIdentity: FileIdentity | null = null;
  let destinationComplete = false;

  try {
    try {
      lockHandle = await dependencies.files.open(lockPath, 'wx', 0o600);
      lockIdentity = identityOf(await lockHandle.stat());
      await lockHandle.writeFile(lockBytes);
      await lockHandle.sync();
      await lockHandle.close();
      lockHandle = null;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        return refuse(
          dependencies,
          `The managed stylesheet is locked at ${lockPath}. It may be removed manually only after confirming no DITA Editor instance is writing.`,
        );
      }
      return refuse(dependencies, 'The managed stylesheet lock could not be acquired or flushed.', error);
    } finally {
      await closeQuietly(lockHandle, dependencies, 'Managed stylesheet lock');
      lockHandle = null;
    }

    let initialSource: string | null = null;
    let initialStat: ManagedStyleFileStat | null = null;
    if (firstResolution.exists) {
      try {
        initialStat = await dependencies.files.lstat(target.canonicalPath);
        if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
          return refuse(dependencies, 'The managed stylesheet destination is no longer a regular non-symlink file.');
        }
        initialSource = decodeManagedStyleSource(await dependencies.files.readFile(target.canonicalPath));
        if (initialSource === null) {
          return refuse(dependencies, 'The managed stylesheet contains invalid or lossy UTF-8 and cannot be changed safely.');
        }
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet could not be reread safely.', error);
      }
    } else {
      try {
        await dependencies.files.lstat(target.canonicalPath);
        return refuse(dependencies, 'The managed stylesheet appeared before exclusive creation and was not replaced.');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          return refuse(dependencies, 'The managed stylesheet destination could not be checked safely.', error);
        }
      }
    }

    const currentInspection = inspectManagedAuthorStylesheet(initialSource);
    if (currentInspection.sourceHash !== request.displayedSourceHash) {
      return refuse(dependencies, 'The managed stylesheet changed since it was displayed. Reload the editor before saving.');
    }
    const plan = planManagedAuthorStylesheetWrite(initialSource, request.styles);
    if (!plan.ok) return refuse(dependencies, plan.reason);

    if (firstResolution.exists) {
      try {
        temporaryHandle = await dependencies.files.open(temporaryPath, 'wx', 0o600);
        temporaryIdentity = identityOf(await temporaryHandle.stat());
        await temporaryHandle.writeFile(Buffer.from(plan.resultingText, 'utf8'));
        await temporaryHandle.chmod((initialStat?.mode ?? 0o600) & 0o7777);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet temporary file could not be created exclusively and flushed.', error);
      } finally {
        await closeQuietly(temporaryHandle, dependencies, 'Managed stylesheet temporary file');
        temporaryHandle = null;
      }
      if (dependencies.afterTemporaryFileFlush) {
        try {
          await dependencies.afterTemporaryFileFlush();
        } catch (error) {
          return refuse(dependencies, 'The managed stylesheet after-flush check failed.', error);
        }
      }
    }

    let finalDocuments: DocumentSnapshotEntry[];
    try {
      finalDocuments = await snapshotDocuments(target, dependencies);
    } catch (error) {
      return refuse(
        dependencies,
        'The open managed stylesheet document changed or its identity could not be rechecked safely. No file was replaced.',
        error,
      );
    }
    if (!sameDocumentSnapshot(initialDocuments, finalDocuments) || finalDocuments.some((document) => document.dirty)) {
      return refuse(dependencies, 'The open managed stylesheet document changed while styles were being prepared. No file was replaced.');
    }

    let finalResolution: ResolvedManagedStyleTarget | null;
    try {
      finalResolution = await request.revalidateTarget();
    } catch (error) {
      return refuse(dependencies, 'The managed stylesheet destination could not be revalidated before commit.', error);
    }
    if (finalResolution === null || !sameTarget(target, finalResolution.target) ||
      finalResolution.exists !== firstResolution.exists) {
      return refuse(dependencies, 'The managed stylesheet destination identity or presence changed before commit. No file was replaced.');
    }

    if (firstResolution.exists) {
      try {
        const finalStat = await dependencies.files.lstat(target.canonicalPath);
        if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
          return refuse(dependencies, 'The managed stylesheet destination stopped being a regular non-symlink file before commit.');
        }
        const finalSource = decodeManagedStyleSource(await dependencies.files.readFile(target.canonicalPath));
        if (finalSource === null) {
          return refuse(dependencies, 'The managed stylesheet became invalid or lossy UTF-8 before commit. No file was replaced.');
        }
        if (plan.expectedSourceHash === null ||
          inspectManagedAuthorStylesheet(finalSource).sourceHash !== plan.expectedSourceHash) {
          return refuse(dependencies, 'The managed stylesheet bytes changed before commit. No file was replaced.');
        }
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet could not be reread before commit.', error);
      }
      try {
        const temporaryStatBeforeRead = await dependencies.files.lstat(temporaryPath);
        if (temporaryStatBeforeRead.isSymbolicLink() || !temporaryStatBeforeRead.isFile()) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file stopped being a regular non-symlink file before commit.',
          );
        }
        if (!sameFile(temporaryIdentity, temporaryStatBeforeRead)) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file identity changed before commit. No file was replaced.',
          );
        }
        const temporaryBytes = await dependencies.files.readFile(temporaryPath);
        const temporarySource = decodeManagedStyleSource(temporaryBytes);
        if (temporarySource === null) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file became invalid or lossy UTF-8 before commit. No file was replaced.',
          );
        }
        const expectedTemporaryBytes = Buffer.from(plan.resultingText, 'utf8');
        const temporaryHash = inspectManagedAuthorStylesheet(temporarySource).sourceHash;
        const expectedTemporaryHash = inspectManagedAuthorStylesheet(plan.resultingText).sourceHash;
        if (temporarySource !== plan.resultingText ||
          temporaryHash !== expectedTemporaryHash ||
          !Buffer.from(temporaryBytes).equals(expectedTemporaryBytes)) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file bytes changed before commit. No file was replaced.',
          );
        }
        const temporaryStatBeforeRename = await dependencies.files.lstat(temporaryPath);
        if (temporaryStatBeforeRename.isSymbolicLink() || !temporaryStatBeforeRename.isFile()) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file stopped being a regular non-symlink file before commit.',
          );
        }
        if (!sameFile(temporaryIdentity, temporaryStatBeforeRename)) {
          return refuse(
            dependencies,
            'The managed stylesheet temporary file identity changed before commit. No file was replaced.',
          );
        }
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet temporary file could not be revalidated before commit.', error);
      }
      try {
        await dependencies.files.rename(temporaryPath, target.canonicalPath);
        temporaryIdentity = null;
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet atomic replacement failed; no direct-write fallback was attempted.', error);
      }
    } else {
      try {
        await dependencies.files.lstat(target.canonicalPath);
        return refuse(dependencies, 'The managed stylesheet appeared before exclusive creation and was not replaced.');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          return refuse(dependencies, 'The managed stylesheet destination could not be checked before commit.', error);
        }
      }

      try {
        destinationHandle = await dependencies.files.open(target.canonicalPath, 'wx', 0o666);
        destinationIdentity = identityOf(await destinationHandle.stat());
        await destinationHandle.writeFile(Buffer.from(plan.resultingText, 'utf8'));
        await destinationHandle.sync();
        await destinationHandle.close();
        destinationHandle = null;
        destinationComplete = true;
      } catch (error) {
        return refuse(dependencies, 'The managed stylesheet could not be created exclusively and flushed.', error);
      } finally {
        await closeQuietly(destinationHandle, dependencies, 'Managed stylesheet destination');
        destinationHandle = null;
      }
    }

    return {
      ok: true,
      inspection: inspectManagedAuthorStylesheet(plan.resultingText),
    };
  } finally {
    if (!destinationComplete) {
      await removeOwnedFile(
        target.canonicalPath,
        destinationIdentity,
        dependencies,
        'Managed stylesheet destination',
      );
    }
    await removeOwnedFile(
      temporaryPath,
      temporaryIdentity,
      dependencies,
      'Managed stylesheet temporary file',
    );
    await removeOwnedLock(lockPath, lockIdentity, nonce, target.canonicalPath, dependencies);
  }
}
