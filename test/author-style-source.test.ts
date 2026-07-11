import { describe, expect, test } from 'bun:test';
import { authorStyleNames, inspectAuthorStyleSource } from '../src/host/author-style-source';
import {
  createNodeManagedStyleFiles,
  type ManagedStyleDocument,
  type ManagedStyleTarget,
} from '../src/host/managed-style-persistence';
import {
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
} from '../src/host/managed-author-stylesheet';
import { DEFAULT_AUTHOR_STYLES, type AuthorStyleDefinition } from '../src/styles/author-styles';

const TARGET: ManagedStyleTarget = {
  configuredPath: 'styles/managed.css',
  uri: 'file:///workspace/styles/managed.css',
  lexicalPath: '/workspace/styles/managed.css',
  canonicalPath: '/real/workspace/styles/managed.css',
  identity: '/real/workspace/styles/managed.css',
};

function sourceDependencies(options: {
  source?: string | Uint8Array | null;
  documents?: ManagedStyleDocument[];
  logs?: string[];
  resolveDocumentIdentity?: (fsPath: string) => Promise<string>;
} = {}) {
  const source = options.source === undefined ? null : options.source;
  const files = createNodeManagedStyleFiles();
  return {
    files: {
      ...files,
      lstat: async () => {
        if (source === null) {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return { mode: 0o100644, dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false };
      },
      readFile: async () => typeof source === 'string'
        ? Buffer.from(source, 'utf8')
        : Buffer.from(source ?? []),
    },
    listDocuments: () => options.documents ?? [],
    resolveDocumentIdentity: options.resolveDocumentIdentity ?? (async () => TARGET.identity),
    platform: process.platform,
    log: (message: string) => options.logs?.push(message),
  };
}

describe('inspectAuthorStyleSource', () => {
  test('a missing resolved destination uses the writable built-in neutral inspection', async () => {
    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies());

    expect(inspection.kind).toBe('missing');
    expect(inspection.styles).toEqual(DEFAULT_AUTHOR_STYLES);
    expect(inspection.writable).toBe(true);
    expect(inspection.error).toBeUndefined();
  });

  test('a dirty matching document remains completely visible but is non-writable', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const dirtySource = `${plan.resultingText}\n/* unsaved */`;
    const document: ManagedStyleDocument = {
      uri: TARGET.uri,
      scheme: 'file',
      fsPath: TARGET.lexicalPath,
      version: 9,
      dirty: true,
      generation: {},
      text: dirtySource,
    };

    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies({
      source: plan.resultingText,
      documents: [
        document,
        {
          uri: 'file:///workspace/aliases/clean-managed-styles',
          scheme: 'file',
          fsPath: '/workspace/aliases/clean-managed-styles',
          version: 7,
          dirty: false,
          generation: {},
          text: plan.resultingText,
        },
      ],
    }));

    expect(inspection.sourceText).toBe(dirtySource);
    expect(inspection.renderCssText).toBe(dirtySource);
    expect(inspection.sourceHash).toBe(inspectManagedAuthorStylesheet(dirtySource).sourceHash);
    expect(inspection.writable).toBe(false);
    expect(inspection.error).toContain('unsaved changes');
  });

  test.each([
    '/workspace/aliases/managed.scss',
    '/workspace/aliases/managed-styles',
  ])('a dirty canonical alias is visible and non-writable regardless of extension: %s', async (aliasPath) => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const dirtySource = `${plan.resultingText}\n/* unsaved alias */`;
    const document: ManagedStyleDocument = {
      uri: `file://${aliasPath}`,
      scheme: 'file',
      fsPath: aliasPath,
      version: 3,
      dirty: true,
      generation: {},
      text: dirtySource,
    };

    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies({
      source: plan.resultingText,
      documents: [document],
      resolveDocumentIdentity: async (fsPath) => {
        expect(fsPath).toBe(aliasPath);
        return TARGET.identity;
      },
    }));

    expect(inspection.sourceText).toBe(dirtySource);
    expect(inspection.sourceHash).toBe(inspectManagedAuthorStylesheet(dirtySource).sourceHash);
    expect(inspection.writable).toBe(false);
    expect(inspection.error).toContain('unsaved changes');
  });

  test('clean matching documents use exact lossless disk bytes instead of normalized document text', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const diskSource = `\ufeff/* developer prefix */\r\n${plan.resultingText}\r\n/* outside suffix */\n`;
    const diskBytes = Buffer.from(diskSource, 'utf8');
    const document: ManagedStyleDocument = {
      uri: TARGET.uri,
      scheme: 'file',
      fsPath: TARGET.lexicalPath,
      version: 5,
      dirty: false,
      generation: {},
      text: diskSource.replace(/^\ufeff/, '').replaceAll('\r\n', '\n'),
    };

    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies({
      source: diskBytes,
      documents: [
        document,
        {
          uri: 'file:///workspace/aliases/clean-managed-styles',
          scheme: 'file',
          fsPath: '/workspace/aliases/clean-managed-styles',
          version: 8,
          dirty: false,
          generation: {},
          text: 'a second clean view with normalized or stale editor text',
        },
      ],
    }));

    expect(inspection.sourceText).toBe(diskSource);
    expect(inspection.sourceHash).toBe(inspectManagedAuthorStylesheet(diskSource).sourceHash);
    expect(inspection.sourceHash).not.toBe(inspectManagedAuthorStylesheet(document.text).sourceHash);
    expect(Buffer.from(inspection.sourceText, 'utf8')).toEqual(diskBytes);
    expect(inspection.writable).toBe(true);
  });

  test('disagreeing dirty aliases are logged and refused instead of selecting one arbitrarily', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const logs: string[] = [];
    const documents: ManagedStyleDocument[] = [
      {
        uri: 'file:///workspace/aliases/a.scss',
        scheme: 'file',
        fsPath: '/workspace/aliases/a.scss',
        version: 2,
        dirty: true,
        generation: {},
        text: `${plan.resultingText}\n/* edit A */`,
      },
      {
        uri: 'file:///workspace/aliases/b',
        scheme: 'file',
        fsPath: '/workspace/aliases/b',
        version: 4,
        dirty: true,
        generation: {},
        text: `${plan.resultingText}\n/* edit B */`,
      },
    ];

    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies({
      source: plan.resultingText,
      documents,
      logs,
    }));

    expect(inspection.writable).toBe(false);
    expect(inspection.error).toContain('dirty views disagree');
    expect(logs.join('\n')).toContain('dirty views disagree');
  });

  test('a noncanonical disk source stays visible with the inspector refusal', async () => {
    const source = 'body { color: hotpink; }\r\n';
    const inspection = await inspectAuthorStyleSource(TARGET, sourceDependencies({ source }));

    expect(inspection.kind).toBe('refused');
    expect(inspection.sourceText).toBe(source);
    expect(inspection.renderCssText).toBe(source);
    expect(inspection.writable).toBe(false);
    expect(inspection.error).toContain('not canonical');
  });

  test('an unavailable destination is non-writable rather than pretending to be missing', async () => {
    const inspection = await inspectAuthorStyleSource(null, sourceDependencies());

    expect(inspection.writable).toBe(false);
    expect(inspection.styles).toEqual([]);
    expect(inspection.error).toContain('workspace');
  });
});

describe('authorStyleNames', () => {
  test('builds a className -> name map', () => {
    const styles: AuthorStyleDefinition[] = [
      { className: 'dc-gold-header', name: 'Gold header', target: 'tableHeadCell' },
      { className: 'dc-row-group', name: 'Row group', target: 'tableBodyCell' },
    ];

    const names = authorStyleNames(styles);
    expect(names.get('dc-gold-header')).toBe('Gold header');
    expect(names.get('dc-row-group')).toBe('Row group');
    expect(names.size).toBe(2);
  });
});
