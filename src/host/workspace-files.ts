import path from 'node:path';
import type * as vscode from 'vscode';

const CONTENT_STYLESHEETS_KEY = 'ditaeditor.visual.contentStylesheets';
const MANAGED_STYLESHEET_KEY = 'ditaeditor.visual.managedAuthorStylesheet';
const TAXONOMY_FILE_KEY = 'ditaeditor.visual.taxonomyFile';

export interface WorkspaceVisualSettings {
  contentStylesheets: string[];
  managedAuthorStylesheet: string;
  taxonomyFile: string;
}

export interface ResolvedWorkspaceFile {
  configuredPath: string;
  uri: vscode.Uri;
  canonicalPath: string;
  identity: string;
}

export interface ResolvedVisualWorkspaceFiles {
  contentStylesheets: ResolvedWorkspaceFile[];
  managedAuthorStylesheet: ResolvedWorkspaceFile | null;
  managedAuthorStylesheetExists: boolean;
  taxonomyFile: ResolvedWorkspaceFile | null;
  writable: boolean;
  error?: string;
}

export type RelativePathResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

export interface WorkspaceFileIdentityAdapter {
  stat(path: string): Promise<{ isFile(): boolean }>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
}

export function validateWorkspaceRelativePath(value: string): RelativePathResult {
  if (value.length === 0) return { ok: false, reason: 'Path must not be empty.' };
  if (value.includes('\0')) return { ok: false, reason: 'Path must not contain NUL.' };

  const slashNormalized = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:($|\/)/.test(slashNormalized) || slashNormalized.startsWith('/')) {
    return { ok: false, reason: 'Path must be workspace-relative.' };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashNormalized)) {
    return { ok: false, reason: 'Path must not be a URI.' };
  }

  const normalized = path.posix.normalize(slashNormalized);
  if (normalized === '.' || normalized === './') {
    return { ok: false, reason: 'Path must name a file inside the workspace.' };
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, reason: 'Path escapes the workspace.' };
  }
  if (normalized.startsWith('/')) {
    return { ok: false, reason: 'Path must be workspace-relative.' };
  }
  return { ok: true, normalized };
}

export function readWorkspaceVisualSettings(
  configuration: vscode.WorkspaceConfiguration,
): WorkspaceVisualSettings {
  return {
    contentStylesheets: [
      ...(configuration.get<string[]>('contentStylesheets', []) ?? []),
    ],
    managedAuthorStylesheet: configuration.get<string>(
      'managedAuthorStylesheet',
      'css/ditaeditor-author-styles.css',
    ) ?? 'css/ditaeditor-author-styles.css',
    taxonomyFile: configuration.get<string>('taxonomyFile', '') ?? '',
  };
}

export function canonicalIdentity(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let identity = pathApi.normalize(value);
  if (platform === 'win32') identity = identity.replace(/\\/g, '/');
  identity = identity.normalize('NFC');
  if (platform === 'win32' || platform === 'darwin') identity = identity.toLowerCase();
  return identity;
}

function normalizedContainmentPath(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let normalized = pathApi.normalize(value);
  if (platform === 'win32') normalized = normalized.replace(/\\/g, '/');
  const isWindowsDriveRoot = platform === 'win32' && /^[A-Za-z]:\/$/.test(normalized);
  if (normalized.length > 1 && normalized.endsWith('/') && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

export function isCanonicalPathInside(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedRoot = normalizedContainmentPath(root, platform);
  const normalizedTarget = normalizedContainmentPath(target, platform);
  if (normalizedTarget === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedTarget.startsWith(rootPrefix);
}

function neutralResult(error: string): ResolvedVisualWorkspaceFiles {
  return {
    contentStylesheets: [],
    managedAuthorStylesheet: null,
    managedAuthorStylesheetExists: false,
    taxonomyFile: null,
    writable: false,
    error,
  };
}

function settingRefusal(key: string, configuredPath: string, reason: string): string {
  return `${key} ${JSON.stringify(configuredPath)}: ${reason}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function resolveReadTarget(params: {
  configuredPath: string;
  settingKey: string;
  folder: vscode.WorkspaceFolder;
  canonicalRoot: string;
  joinPath: typeof vscode.Uri.joinPath;
  files: WorkspaceFileIdentityAdapter;
  platform: NodeJS.Platform;
  log(message: string): void;
}): Promise<ResolvedWorkspaceFile | null> {
  const {
    configuredPath,
    settingKey,
    folder,
    canonicalRoot,
    joinPath,
    files,
    platform,
    log,
  } = params;
  const validation = validateWorkspaceRelativePath(configuredPath);
  if (!validation.ok) {
    log(settingRefusal(settingKey, configuredPath, validation.reason));
    return null;
  }

  const uri = joinPath(folder.uri, validation.normalized);
  let stat: { isFile(): boolean };
  try {
    stat = await files.stat(uri.fsPath);
  } catch {
    log(settingRefusal(
      settingKey,
      configuredPath,
      'file does not exist or is not accessible.',
    ));
    return null;
  }
  if (!stat.isFile()) {
    log(settingRefusal(settingKey, configuredPath, 'target is not a regular file.'));
    return null;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await files.realpath(uri.fsPath);
  } catch {
    log(settingRefusal(settingKey, configuredPath, 'canonical target could not be resolved.'));
    return null;
  }
  if (!isCanonicalPathInside(canonicalRoot, canonicalPath, platform)) {
    log(settingRefusal(settingKey, configuredPath, 'canonical target escapes the workspace.'));
    return null;
  }

  return {
    configuredPath,
    uri,
    canonicalPath,
    identity: canonicalIdentity(canonicalPath, platform),
  };
}

async function resolveManagedTarget(params: {
  configuredPath: string;
  folder: vscode.WorkspaceFolder;
  canonicalRoot: string;
  joinPath: typeof vscode.Uri.joinPath;
  files: WorkspaceFileIdentityAdapter;
  platform: NodeJS.Platform;
  log(message: string): void;
}): Promise<{ file: ResolvedWorkspaceFile; exists: boolean } | null> {
  const {
    configuredPath,
    folder,
    canonicalRoot,
    joinPath,
    files,
    platform,
    log,
  } = params;
  const validation = validateWorkspaceRelativePath(configuredPath);
  if (!validation.ok) {
    log(settingRefusal(MANAGED_STYLESHEET_KEY, configuredPath, validation.reason));
    return null;
  }

  const segments = validation.normalized.split('/');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const uri = joinPath(folder.uri, validation.normalized);
  let lexicalPath = folder.uri.fsPath;
  let existingCanonicalPath = canonicalRoot;
  let existingSegments = 0;
  let destinationExists = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    lexicalPath = pathApi.join(lexicalPath, segment);
    const isDestination = index === segments.length - 1;

    let stat: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
      stat = await files.lstat(lexicalPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        log(settingRefusal(
          MANAGED_STYLESHEET_KEY,
          configuredPath,
          `path component "${segments.slice(0, index + 1).join('/')}" is not accessible.`,
        ));
        return null;
      }
      if (!isDestination) {
        log(settingRefusal(
          MANAGED_STYLESHEET_KEY,
          configuredPath,
          `direct parent "${segments.slice(0, -1).join('/')}" does not exist.`,
        ));
        return null;
      }
      break;
    }

    if (stat.isSymbolicLink()) {
      const reason = isDestination
        ? 'destination is a symbolic link or reparse point.'
        : `path component "${segments.slice(0, index + 1).join('/')}" is a symbolic link or reparse point.`;
      log(settingRefusal(MANAGED_STYLESHEET_KEY, configuredPath, reason));
      return null;
    }
    if (!isDestination && stat.isFile()) {
      log(settingRefusal(
        MANAGED_STYLESHEET_KEY,
        configuredPath,
        `path component "${segments.slice(0, index + 1).join('/')}" is not a directory.`,
      ));
      return null;
    }
    if (isDestination && !stat.isFile()) {
      log(settingRefusal(
        MANAGED_STYLESHEET_KEY,
        configuredPath,
        'destination is not a regular file.',
      ));
      return null;
    }

    try {
      existingCanonicalPath = await files.realpath(lexicalPath);
    } catch {
      log(settingRefusal(
        MANAGED_STYLESHEET_KEY,
        configuredPath,
        'canonical identity could not be resolved.',
      ));
      return null;
    }
    const escapeReason = isDestination
      ? 'canonical target escapes the workspace.'
      : 'canonical existing parent escapes the workspace.';
    if (!isCanonicalPathInside(canonicalRoot, existingCanonicalPath, platform)) {
      log(settingRefusal(MANAGED_STYLESHEET_KEY, configuredPath, escapeReason));
      return null;
    }
    existingSegments = index + 1;
    if (isDestination) destinationExists = true;
  }

  const remainingSegments = segments.slice(existingSegments);
  const canonicalPath = remainingSegments.length === 0
    ? existingCanonicalPath
    : pathApi.join(existingCanonicalPath, ...remainingSegments);
  if (!isCanonicalPathInside(canonicalRoot, canonicalPath, platform)) {
    log(settingRefusal(
      MANAGED_STYLESHEET_KEY,
      configuredPath,
      'canonical destination escapes the workspace.',
    ));
    return null;
  }

  return {
    file: {
      configuredPath,
      uri,
      canonicalPath,
      identity: canonicalIdentity(canonicalPath, platform),
    },
    exists: destinationExists,
  };
}

export async function resolveVisualWorkspaceFiles(params: {
  folder: vscode.WorkspaceFolder | undefined;
  trusted: boolean;
  settings: WorkspaceVisualSettings;
  joinPath: typeof vscode.Uri.joinPath;
  files: WorkspaceFileIdentityAdapter;
  platform: NodeJS.Platform;
  log(message: string): void;
}): Promise<ResolvedVisualWorkspaceFiles> {
  const { folder, trusted, settings, joinPath, files, platform, log } = params;
  if (!folder) {
    const error = 'Workspace file settings require an open workspace folder.';
    log(error);
    return neutralResult(error);
  }
  if (!trusted) {
    const error = 'Workspace file settings are disabled in Restricted Mode.';
    log(error);
    return neutralResult(error);
  }
  if (folder.uri.scheme !== 'file') {
    const error = 'Workspace file settings require a local file: workspace folder.';
    log(error);
    return neutralResult(error);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await files.realpath(folder.uri.fsPath);
  } catch {
    const error = 'Workspace folder canonical identity could not be resolved.';
    log(error);
    return neutralResult(error);
  }

  const contentStylesheets: ResolvedWorkspaceFile[] = [];
  const contentIdentities = new Set<string>();
  for (const configuredPath of settings.contentStylesheets) {
    const resolved = await resolveReadTarget({
      configuredPath,
      settingKey: CONTENT_STYLESHEETS_KEY,
      folder,
      canonicalRoot,
      joinPath,
      files,
      platform,
      log,
    });
    if (!resolved || contentIdentities.has(resolved.identity)) continue;
    contentIdentities.add(resolved.identity);
    contentStylesheets.push(resolved);
  }

  const taxonomyFile = settings.taxonomyFile === ''
    ? null
    : await resolveReadTarget({
      configuredPath: settings.taxonomyFile,
      settingKey: TAXONOMY_FILE_KEY,
      folder,
      canonicalRoot,
      joinPath,
      files,
      platform,
      log,
    });

  let managedAuthorStylesheet: ResolvedWorkspaceFile | null = null;
  let managedAuthorStylesheetExists = false;
  const managed = await resolveManagedTarget({
    configuredPath: settings.managedAuthorStylesheet,
    folder,
    canonicalRoot,
    joinPath,
    files,
    platform,
    log,
  });
  if (managed) {
    if (contentIdentities.has(managed.file.identity)) {
      log(settingRefusal(
        MANAGED_STYLESHEET_KEY,
        settings.managedAuthorStylesheet,
        'canonical target collides with a developer content stylesheet.',
      ));
    } else if (taxonomyFile?.identity === managed.file.identity) {
      log(settingRefusal(
        MANAGED_STYLESHEET_KEY,
        settings.managedAuthorStylesheet,
        'canonical target collides with the taxonomy file.',
      ));
    } else {
      managedAuthorStylesheet = managed.file;
      managedAuthorStylesheetExists = managed.exists;
    }
  }

  return {
    contentStylesheets,
    managedAuthorStylesheet,
    managedAuthorStylesheetExists,
    taxonomyFile,
    writable: managedAuthorStylesheet !== null,
  };
}
