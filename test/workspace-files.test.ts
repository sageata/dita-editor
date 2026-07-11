import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import type * as vscode from 'vscode';
import {
  canonicalIdentity,
  isCanonicalPathInside,
  readWorkspaceVisualSettings,
  resolveVisualWorkspaceFiles,
  validateWorkspaceRelativePath,
  type WorkspaceFileIdentityAdapter,
  type WorkspaceVisualSettings,
} from '../src/host/workspace-files';

type EntryKind = 'file' | 'directory' | 'symlink';

interface FakeEntry {
  path: string;
  kind: EntryKind;
  realpath?: string;
  statIsFile?: boolean;
}

class FakeFiles implements WorkspaceFileIdentityAdapter {
  readonly calls: Array<{ method: 'stat' | 'lstat' | 'realpath'; path: string }> = [];
  private readonly entries = new Map<string, FakeEntry>();
  private readonly pathApi: typeof path.posix;

  constructor(entries: FakeEntry[], platform: NodeJS.Platform = 'linux') {
    this.pathApi = platform === 'win32' ? path.win32 : path.posix;
    for (const entry of entries) this.entries.set(this.key(entry.path), entry);
  }

  async stat(value: string): Promise<{ isFile(): boolean }> {
    this.calls.push({ method: 'stat', path: value });
    const entry = this.require(value);
    return {
      isFile: () => entry.statIsFile ?? entry.kind === 'file',
    };
  }

  async lstat(value: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }> {
    this.calls.push({ method: 'lstat', path: value });
    const entry = this.require(value);
    return {
      isFile: () => entry.kind === 'file',
      isSymbolicLink: () => entry.kind === 'symlink',
    };
  }

  async realpath(value: string): Promise<string> {
    this.calls.push({ method: 'realpath', path: value });
    const entry = this.require(value);
    return entry.realpath ?? entry.path;
  }

  private key(value: string): string {
    return this.pathApi.normalize(value);
  }

  private require(value: string): FakeEntry {
    const entry = this.entries.get(this.key(value));
    if (entry) return entry;
    const error = new Error(`ENOENT: ${value}`) as Error & { code: string };
    error.code = 'ENOENT';
    throw error;
  }
}

const DEFAULT_SETTINGS: WorkspaceVisualSettings = {
  contentStylesheets: [],
  managedAuthorStylesheet: 'css/ditaeditor-author-styles.css',
  taxonomyFile: '',
};

function uri(fsPath: string, scheme = 'file'): vscode.Uri {
  return { fsPath, scheme } as vscode.Uri;
}

function folder(fsPath: string, scheme = 'file'): vscode.WorkspaceFolder {
  return { uri: uri(fsPath, scheme), name: 'workspace', index: 0 };
}

function joinPathFor(platform: NodeJS.Platform): typeof vscode.Uri.joinPath {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return ((base: vscode.Uri, ...segments: string[]) =>
    uri(pathApi.join(base.fsPath, ...segments), base.scheme)) as typeof vscode.Uri.joinPath;
}

function configuration(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
  return {
    get<T>(section: string, defaultValue?: T): T | undefined {
      return (section in values ? values[section] : defaultValue) as T | undefined;
    },
  } as vscode.WorkspaceConfiguration;
}

async function resolveFixture(params: {
  files: FakeFiles;
  settings?: WorkspaceVisualSettings;
  folder?: vscode.WorkspaceFolder;
  trusted?: boolean;
  platform?: NodeJS.Platform;
}) {
  const platform = params.platform ?? 'linux';
  const logs: string[] = [];
  const result = await resolveVisualWorkspaceFiles({
    folder: params.folder,
    trusted: params.trusted ?? true,
    settings: params.settings ?? DEFAULT_SETTINGS,
    joinPath: joinPathFor(platform),
    files: params.files,
    platform,
    log: (message) => logs.push(message),
  });
  return { result, logs };
}

describe('validateWorkspaceRelativePath', () => {
  test('normalizes slash styles and dot segments', () => {
    expect(validateWorkspaceRelativePath('css\\theme.css')).toEqual({
      ok: true,
      normalized: 'css/theme.css',
    });
    expect(validateWorkspaceRelativePath('css//./nested/../theme.css')).toEqual({
      ok: true,
      normalized: 'css/theme.css',
    });
  });

  test.each([
    ['/etc/theme.css', 'Path must be workspace-relative.'],
    ['C:\\styles\\theme.css', 'Path must be workspace-relative.'],
    ['C:/styles/theme.css', 'Path must be workspace-relative.'],
    ['\\\\server\\share\\theme.css', 'Path must be workspace-relative.'],
    ['file:///tmp/theme.css', 'Path must not be a URI.'],
    ['https://example.test/theme.css', 'Path must not be a URI.'],
    ['css/bad\0name.css', 'Path must not contain NUL.'],
    ['', 'Path must not be empty.'],
    ['.', 'Path must name a file inside the workspace.'],
    ['./', 'Path must name a file inside the workspace.'],
    ['..', 'Path escapes the workspace.'],
    ['../theme.css', 'Path escapes the workspace.'],
    ['css/../../theme.css', 'Path escapes the workspace.'],
  ])('rejects unsafe input %s', (value, reason) => {
    expect(validateWorkspaceRelativePath(value)).toEqual({ ok: false, reason });
  });
});

describe('workspace settings', () => {
  test('reads the three values from an injected resource-scoped configuration', () => {
    const settings = readWorkspaceVisualSettings(configuration({
      contentStylesheets: ['css/a.css', 'css/b.css'],
      managedAuthorStylesheet: 'styles/managed.css',
      taxonomyFile: 'config/taxonomy.json',
    }));

    expect(settings).toEqual({
      contentStylesheets: ['css/a.css', 'css/b.css'],
      managedAuthorStylesheet: 'styles/managed.css',
      taxonomyFile: 'config/taxonomy.json',
    });
  });

  test('uses exact defaults and keeps multi-root configurations independent', () => {
    const first = readWorkspaceVisualSettings(configuration({
      contentStylesheets: ['first.css'],
      managedAuthorStylesheet: 'first-managed.css',
    }));
    const second = readWorkspaceVisualSettings(configuration({
      contentStylesheets: ['second.css'],
      taxonomyFile: 'second.json',
    }));

    expect(first).toEqual({
      contentStylesheets: ['first.css'],
      managedAuthorStylesheet: 'first-managed.css',
      taxonomyFile: '',
    });
    expect(second).toEqual({
      contentStylesheets: ['second.css'],
      managedAuthorStylesheet: 'css/ditaeditor-author-styles.css',
      taxonomyFile: 'second.json',
    });
  });
});

describe('canonical workspace identities', () => {
  test('normalizes Unicode and applies Windows and macOS case rules', () => {
    expect(canonicalIdentity('C:\\WS\\CAFÉ.css', 'win32')).toBe('c:/ws/café.css');
    expect(canonicalIdentity('/WS/CAFE\u0301.css', 'darwin')).toBe('/ws/café.css');
    expect(canonicalIdentity('/WS/CAFE\u0301.css', 'linux')).toBe('/WS/CAFÉ.css');
  });

  test('preserves literal backslashes in POSIX canonical identities', () => {
    const value = '/safe/project\\outside/file.css';
    expect(canonicalIdentity(value, 'linux')).toBe(value);
    expect(canonicalIdentity(value, 'darwin')).toBe(value);
  });

  test('contains only the canonical root itself or descendants', () => {
    expect(isCanonicalPathInside('/real/ws', '/real/ws', 'linux')).toBe(true);
    expect(isCanonicalPathInside('/real/ws', '/real/ws/css/theme.css', 'linux')).toBe(true);
    expect(isCanonicalPathInside('/real/ws', '/real/ws-other/theme.css', 'linux')).toBe(false);
    expect(isCanonicalPathInside('C:\\Real\\WS', 'C:\\Real\\WS\\CSS\\theme.css', 'win32')).toBe(true);
    expect(isCanonicalPathInside('/Real/WS', '/Real/WS/css/theme.css', 'darwin')).toBe(true);
  });

  test.each([
    ['darwin', '/Volumes/Project/Root', '/Volumes/Project/root/theme.css'],
    ['win32', 'C:\\Project\\Root', 'c:\\project\\root\\theme.css'],
    ['linux', '/srv/Project/Root', '/srv/Project/root/theme.css'],
  ] as const)(
    'conservatively refuses case-distinct canonical roots on %s',
    (platform, root, target) => {
      expect(isCanonicalPathInside(root, target, platform)).toBe(false);
    },
  );

  test.each([
    ['darwin', '/Volumes/Caf\u00e9/Root', '/Volumes/Cafe\u0301/Root/theme.css'],
    ['win32', 'C:\\Caf\u00e9\\Root', 'C:\\Cafe\u0301\\Root\\theme.css'],
    ['linux', '/srv/Caf\u00e9/Root', '/srv/Cafe\u0301/Root/theme.css'],
  ] as const)(
    'conservatively refuses Unicode-normalization-distinct canonical roots on %s',
    (platform, root, target) => {
      expect(isCanonicalPathInside(root, target, platform)).toBe(false);
    },
  );

  test('normalizes separators and dot syntax without weakening exact containment', () => {
    expect(isCanonicalPathInside('C:\\Project\\Root\\', 'C:/Project/Root/css/../theme.css', 'win32')).toBe(true);
    expect(isCanonicalPathInside('/srv/project/root/', '/srv/project/root/css/../theme.css', 'linux')).toBe(true);
  });

  test.each(['linux', 'darwin'] as const)(
    'refuses a POSIX sibling whose literal backslash resembles a separator on %s',
    (platform) => {
      expect(
        isCanonicalPathInside('/safe/project', '/safe/project\\outside/file.css', platform),
      ).toBe(false);
    },
  );

  test('continues to accept equivalent Windows separator spellings inside the root', () => {
    expect(
      isCanonicalPathInside(
        'C:\\safe\\project',
        'C:/safe/project\\styles/theme.css',
        'win32',
      ),
    ).toBe(true);
  });
});

describe('resolveVisualWorkspaceFiles trust boundary', () => {
  test('returns one neutral refusal without filesystem calls when there is no workspace', async () => {
    const files = new FakeFiles([]);
    const { result, logs } = await resolveFixture({ files });

    expect(result).toEqual({
      contentStylesheets: [],
      managedAuthorStylesheet: null,
      managedAuthorStylesheetExists: false,
      taxonomyFile: null,
      writable: false,
      error: 'Workspace file settings require an open workspace folder.',
    });
    expect(logs).toEqual(['Workspace file settings require an open workspace folder.']);
    expect(files.calls).toEqual([]);
  });

  test('returns one neutral refusal without filesystem calls in Restricted Mode', async () => {
    const files = new FakeFiles([]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      trusted: false,
    });

    expect(result.writable).toBe(false);
    expect(result.contentStylesheets).toEqual([]);
    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.taxonomyFile).toBeNull();
    expect(result.error).toBe('Workspace file settings are disabled in Restricted Mode.');
    expect(logs).toEqual(['Workspace file settings are disabled in Restricted Mode.']);
    expect(files.calls).toEqual([]);
  });

  test('returns one neutral refusal without filesystem calls for a non-file workspace', async () => {
    const files = new FakeFiles([]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/virtual/ws', 'vscode-remote'),
    });

    expect(result.writable).toBe(false);
    expect(result.error).toBe('Workspace file settings require a local file: workspace folder.');
    expect(logs).toEqual(['Workspace file settings require a local file: workspace folder.']);
    expect(files.calls).toEqual([]);
  });
});

describe('resolveVisualWorkspaceFiles read targets', () => {
  test('keeps developer stylesheet order while removing normalized and canonical duplicates', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css/base.css', kind: 'file', realpath: '/real/ws/css/base.css' },
      { path: '/ws/css/theme.css', kind: 'file', realpath: '/real/ws/css/theme.css' },
      {
        path: '/ws/css/theme-link.css',
        kind: 'symlink',
        statIsFile: true,
        realpath: '/real/ws/css/theme.css',
      },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
    ]);
    const { result } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        contentStylesheets: [
          'css/base.css',
          'css/./base.css',
          'css\\theme.css',
          'css/theme-link.css',
        ],
      },
    });

    expect(result.contentStylesheets.map((entry) => entry.configuredPath)).toEqual([
      'css/base.css',
      'css\\theme.css',
    ]);
    expect(result.contentStylesheets.map((entry) => entry.canonicalPath)).toEqual([
      '/real/ws/css/base.css',
      '/real/ws/css/theme.css',
    ]);
    expect(result.contentStylesheets[1].uri.fsPath).toBe('/ws/css/theme.css');
  });

  test('accepts a read symlink whose real target remains in the canonical workspace', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      {
        path: '/ws/css/in-workspace.css',
        kind: 'symlink',
        statIsFile: true,
        realpath: '/real/ws/shared/theme.css',
      },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: { ...DEFAULT_SETTINGS, contentStylesheets: ['css/in-workspace.css'] },
    });

    expect(result.contentStylesheets).toHaveLength(1);
    expect(result.contentStylesheets[0].canonicalPath).toBe('/real/ws/shared/theme.css');
    expect(logs).toEqual([]);
  });

  test('rejects an existing read symlink that canonically escapes the workspace', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      {
        path: '/ws/css/outside.css',
        kind: 'symlink',
        statIsFile: true,
        realpath: '/outside/theme.css',
      },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: { ...DEFAULT_SETTINGS, contentStylesheets: ['css/outside.css'] },
    });

    expect(result.contentStylesheets).toEqual([]);
    expect(logs).toContain(
      'ditaeditor.visual.contentStylesheets "css/outside.css": canonical target escapes the workspace.',
    );
  });

  test('logs and omits missing or non-file read targets', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory' },
      { path: '/ws/css', kind: 'directory' },
      { path: '/ws/css/not-a-file.css', kind: 'directory' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        contentStylesheets: ['css/missing.css', 'css/not-a-file.css'],
        taxonomyFile: 'config/missing.json',
      },
    });

    expect(result.contentStylesheets).toEqual([]);
    expect(result.taxonomyFile).toBeNull();
    expect(logs).toContain(
      'ditaeditor.visual.contentStylesheets "css/missing.css": file does not exist or is not accessible.',
    );
    expect(logs).toContain(
      'ditaeditor.visual.contentStylesheets "css/not-a-file.css": target is not a regular file.',
    );
    expect(logs).toContain(
      'ditaeditor.visual.taxonomyFile "config/missing.json": file does not exist or is not accessible.',
    );
  });

  test('resolves an existing taxonomy file and uses the selected multi-root folder', async () => {
    const files = new FakeFiles([
      { path: '/second', kind: 'directory', realpath: '/real/second' },
      {
        path: '/second/config/taxonomy.json',
        kind: 'file',
        realpath: '/real/second/config/taxonomy.json',
      },
      { path: '/second/css', kind: 'directory', realpath: '/real/second/css' },
    ]);
    const { result } = await resolveFixture({
      files,
      folder: folder('/second'),
      settings: { ...DEFAULT_SETTINGS, taxonomyFile: 'config/taxonomy.json' },
    });

    expect(result.taxonomyFile?.uri.fsPath).toBe('/second/config/taxonomy.json');
    expect(result.taxonomyFile?.canonicalPath).toBe('/real/second/config/taxonomy.json');
  });

  test('deduplicates case-only canonical aliases on macOS', async () => {
    const files = new FakeFiles([
      { path: '/WS', kind: 'directory', realpath: '/Real/WS' },
      { path: '/WS/css/Theme.css', kind: 'file', realpath: '/Real/WS/css/Theme.css' },
      { path: '/WS/css/theme.css', kind: 'file', realpath: '/real/ws/CSS/theme.css' },
      { path: '/WS/css', kind: 'directory', realpath: '/Real/WS/css' },
    ], 'darwin');
    const { result } = await resolveFixture({
      files,
      folder: folder('/WS'),
      platform: 'darwin',
      settings: {
        ...DEFAULT_SETTINGS,
        contentStylesheets: ['css/Theme.css', 'css/theme.css'],
      },
    });

    expect(result.contentStylesheets.map((entry) => entry.configuredPath)).toEqual(['css/Theme.css']);
  });
});

describe('resolveVisualWorkspaceFiles managed destination', () => {
  test('resolves a regular existing managed file as writable', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
      {
        path: '/ws/css/ditaeditor-author-styles.css',
        kind: 'file',
        realpath: '/real/ws/css/ditaeditor-author-styles.css',
      },
    ]);
    const { result, logs } = await resolveFixture({ files, folder: folder('/ws') });

    expect(result.managedAuthorStylesheet).toMatchObject({
      configuredPath: 'css/ditaeditor-author-styles.css',
      canonicalPath: '/real/ws/css/ditaeditor-author-styles.css',
    });
    expect(result.managedAuthorStylesheetExists).toBe(true);
    expect(result.writable).toBe(true);
    expect(logs).toEqual([]);
  });

  test('keeps a safe missing managed file using its canonical existing parent', async () => {
    const files = new FakeFiles([
      { path: '/workspace-link', kind: 'directory', realpath: '/real/ws' },
      { path: '/workspace-link/css', kind: 'directory', realpath: '/real/ws/css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/workspace-link'),
      settings: { ...DEFAULT_SETTINGS, managedAuthorStylesheet: 'css/new.css' },
    });

    expect(result.managedAuthorStylesheet).toMatchObject({
      configuredPath: 'css/new.css',
      canonicalPath: '/real/ws/css/new.css',
    });
    expect(result.managedAuthorStylesheetExists).toBe(false);
    expect(result.writable).toBe(true);
    expect(logs).toEqual([]);
    expect(files.calls).toContainEqual({ method: 'realpath', path: '/workspace-link/css' });
  });

  test('rejects a missing managed file when its direct parent does not exist', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/styles', kind: 'directory', realpath: '/real/ws/styles' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        managedAuthorStylesheet: 'styles/generated/author.css',
      },
    });

    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.managedAuthorStylesheetExists).toBe(false);
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "styles/generated/author.css": direct parent "styles/generated" does not exist.',
    );
  });

  test('rejects a symlinked managed parent', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'symlink', realpath: '/real/ws/css' },
    ]);
    const { result, logs } = await resolveFixture({ files, folder: folder('/ws') });

    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/ditaeditor-author-styles.css": path component "css" is a symbolic link or reparse point.',
    );
  });

  test('rejects a symlinked managed destination', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
      {
        path: '/ws/css/managed.css',
        kind: 'symlink',
        statIsFile: true,
        realpath: '/real/ws/css/actual.css',
      },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: { ...DEFAULT_SETTINGS, managedAuthorStylesheet: 'css/managed.css' },
    });

    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/managed.css": destination is a symbolic link or reparse point.',
    );
  });

  test('rejects a missing destination whose existing parent canonically escapes', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/outside/css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: { ...DEFAULT_SETTINGS, managedAuthorStylesheet: 'css/new.css' },
    });

    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/new.css": canonical existing parent escapes the workspace.',
    );
  });

  test('preserves a read-only content entry and rejects a canonical managed collision', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
      { path: '/ws/css/developer.css', kind: 'file', realpath: '/real/ws/css/shared.css' },
      { path: '/ws/css/managed.css', kind: 'file', realpath: '/real/ws/css/shared.css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        contentStylesheets: ['css/developer.css'],
        managedAuthorStylesheet: 'css/managed.css',
      },
    });

    expect(result.contentStylesheets.map((entry) => entry.configuredPath)).toEqual(['css/developer.css']);
    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.managedAuthorStylesheetExists).toBe(false);
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/managed.css": canonical target collides with a developer content stylesheet.',
    );
  });

  test('preserves an existing taxonomy file and rejects the same managed destination', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
      { path: '/ws/css/shared.css', kind: 'file', realpath: '/real/ws/css/shared.css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        managedAuthorStylesheet: 'css/shared.css',
        taxonomyFile: 'css/shared.css',
      },
    });

    expect(result.taxonomyFile?.configuredPath).toBe('css/shared.css');
    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.managedAuthorStylesheetExists).toBe(false);
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/shared.css": canonical target collides with the taxonomy file.',
    );
  });

  test('preserves a taxonomy symlink and rejects a canonical managed alias collision', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory', realpath: '/real/ws' },
      { path: '/ws/css', kind: 'directory', realpath: '/real/ws/css' },
      {
        path: '/ws/config/taxonomy.json',
        kind: 'symlink',
        statIsFile: true,
        realpath: '/real/ws/css/managed.css',
      },
      { path: '/ws/css/managed.css', kind: 'file', realpath: '/real/ws/css/managed.css' },
    ]);
    const { result, logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        ...DEFAULT_SETTINGS,
        managedAuthorStylesheet: 'css/managed.css',
        taxonomyFile: 'config/taxonomy.json',
      },
    });

    expect(result.taxonomyFile?.configuredPath).toBe('config/taxonomy.json');
    expect(result.taxonomyFile?.canonicalPath).toBe('/real/ws/css/managed.css');
    expect(result.managedAuthorStylesheet).toBeNull();
    expect(result.writable).toBe(false);
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "css/managed.css": canonical target collides with the taxonomy file.',
    );
  });
});

describe('resolver refusal logging', () => {
  test('logs the setting key, configured value, and exact validation reason', async () => {
    const files = new FakeFiles([
      { path: '/ws', kind: 'directory' },
      { path: '/ws/css', kind: 'directory' },
    ]);
    const { logs } = await resolveFixture({
      files,
      folder: folder('/ws'),
      settings: {
        contentStylesheets: ['/outside.css'],
        managedAuthorStylesheet: '../managed.css',
        taxonomyFile: 'file:///outside.json',
      },
    });

    expect(logs).toContain(
      'ditaeditor.visual.contentStylesheets "/outside.css": Path must be workspace-relative.',
    );
    expect(logs).toContain(
      'ditaeditor.visual.managedAuthorStylesheet "../managed.css": Path escapes the workspace.',
    );
    expect(logs).toContain(
      'ditaeditor.visual.taxonomyFile "file:///outside.json": Path must not be a URI.',
    );
  });
});
