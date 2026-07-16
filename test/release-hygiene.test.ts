import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

interface Finding {
  path: string;
  rule: string;
  detail: string;
  deferred?: boolean;
}

interface InspectionResult {
  ok: boolean;
  findings: Finding[];
}

interface HygieneModules {
  scanPublicContent(options: {
    root: string;
    includeBuildOutputs?: boolean;
    ignoreContentPaths?: Set<string>;
  }): Promise<Finding[]>;
  scanTextForPrivateContent(path: string, text: string): Finding[];
  scanPathForPrivateContent(path: string): Finding[];
  inspectVsix(options: { vsixPath: string; phase?: 'pre-metadata' }): Promise<InspectionResult>;
  inspectVsixStructure(vsixPath: string): Promise<InspectionResult>;
  PRE_METADATA_DEFERRED_KEYS: readonly string[];
}

interface FixtureEntry {
  name: string | Buffer;
  data?: string | Buffer;
  method?: 0 | 8;
  mode?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  host?: number;
}

const root = resolve(import.meta.dir, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'ditaeditor-release-hygiene-'));
const scannerUrl = pathToFileURL(join(root, 'scripts/scan-public-content.mjs')).href;
const inspectorUrl = pathToFileURL(join(root, 'scripts/inspect-vsix.mjs')).href;
let modules: HygieneModules;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function createZip(entries: FixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const fixture of entries) {
    const name = Buffer.isBuffer(fixture.name) ? fixture.name : Buffer.from(fixture.name, 'utf8');
    const source = Buffer.isBuffer(fixture.data)
      ? fixture.data
      : Buffer.from(fixture.data ?? '', 'utf8');
    const method = fixture.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const compressedSize = fixture.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = fixture.declaredUncompressedSize ?? source.length;
    const checksum = crc32(source);
    const isDirectory = name.at(-1) === 0x2f;
    const mode = fixture.mode ?? (isDirectory ? 0o040755 : 0o100644);
    const flags = 0x0800;

    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), name,
    ]);
    localParts.push(localHeader, compressed);

    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(((fixture.host ?? 3) << 8) | 20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32((mode & 0xffff) << 16), u32(localOffset), name,
    ]));
    localOffset += localHeader.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function writeZip(name: string, entries: FixtureEntry[]): string {
  const path = join(tempRoot, name);
  writeFileSync(path, createZip(entries));
  return path;
}

function contentTypes(): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="json" ContentType="application/json"/>'
    + '<Default Extension="vsixmanifest" ContentType="text/xml"/>'
    + '</Types>';
}

function vsixManifest(name: string, version: string, publisher: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
    + `<Metadata><Identity Id="${name}" Version="${version}" Publisher="${publisher}"/></Metadata>`
    + '<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json"/></Assets>'
    + '</PackageManifest>';
}

function baseEntries(options: {
  explicitDirectories?: boolean;
  manifestName?: string;
  manifestVersion?: string;
  manifestPublisher?: string;
  omit?: string;
  extra?: FixtureEntry[];
} = {}): FixtureEntry[] {
  const publisher = ['eti', 'had'].join('');
  const pkg = {
    name: 'dita-editor',
    displayName: 'DITA Editor',
    version: '0.0.1',
    publisher,
    private: true,
    main: './dist/extension.js',
    engines: { vscode: '^1.90.0' },
  };
  const files: FixtureEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes() },
    {
      name: 'extension.vsixmanifest',
      data: vsixManifest(
        options.manifestName ?? pkg.name,
        options.manifestVersion ?? pkg.version,
        options.manifestPublisher ?? pkg.publisher,
      ),
    },
    { name: 'extension/package.json', data: JSON.stringify(pkg) },
    { name: 'extension/readme.md', data: '# DITA Editor\n\nLegacy preview documentation.\n' },
    { name: 'extension/dist/extension.js', data: 'export const neutral = true;\n' },
    { name: 'extension/media/content-theme.css', data: ':where(.topic) { color: CanvasText; }\n' },
  ];
  if (options.explicitDirectories) {
    files.unshift(
      { name: 'extension/' },
      { name: 'extension/dist/' },
      { name: 'extension/media/' },
    );
  }
  return files.filter((entry) => entry.name !== options.omit).concat(options.extra ?? []);
}

function strictReadyEntries(options: {
  name?: string;
  publisher?: string;
  repositoryOwner?: string;
  manifestComment?: string;
  version?: string;
} = {}): FixtureEntry[] {
  const name = options.name ?? 'dita-editor';
  const publisher = options.publisher ?? 'paul-razvan-sarbu';
  const repositoryOwner = options.repositoryOwner ?? 'neutral-owner';
  const pkg = {
    name,
    displayName: 'DITA Editor',
    version: options.version ?? '0.1.0',
    publisher,
    preview: true,
    main: './dist/extension.js',
    engines: { vscode: '^1.90.0' },
    icon: 'media/icon.png',
    license: 'MIT',
    repository: {
      type: 'git',
      url: `https://github.com/${repositoryOwner}/dita-editor.git`,
    },
    homepage: `https://github.com/${repositoryOwner}/dita-editor`,
    bugs: { url: `https://github.com/${repositoryOwner}/dita-editor/issues` },
    pricing: 'Free',
  };
  let manifest = vsixManifest(name, pkg.version, publisher);
  if (options.manifestComment) {
    manifest = manifest.replace('<Metadata>', `<Metadata><!-- ${options.manifestComment} -->`);
  }
  return [
    { name: '[Content_Types].xml', data: contentTypes() },
    { name: 'extension.vsixmanifest', data: manifest },
    { name: 'extension/package.json', data: JSON.stringify(pkg) },
    {
      name: 'extension/readme.md',
      data: [
        '# DITA Editor',
        '',
        'See docs/STYLING.md and docs/TAXONOMY.md.',
        'See CONTRIBUTING.md, SECURITY.md, and SUPPORT.md.',
        '',
      ].join('\n'),
    },
    { name: 'extension/changelog.md', data: '# Changelog\n\n## 0.1.0\n\nInitial preview.\n' },
    { name: 'extension/LICENSE', data: 'MIT License\n' },
    { name: 'extension/THIRD_PARTY_NOTICES.md', data: '# Third-party notices\n' },
    { name: 'extension/dist/extension.js', data: 'export const neutral = true;\n' },
    { name: 'extension/media/content-theme.css', data: ':where(.topic) { color: CanvasText; }\n' },
    { name: 'extension/media/icon.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ];
}

function rules(result: InspectionResult | Finding[]): string[] {
  const findings = Array.isArray(result) ? result : result.findings;
  return findings.map((finding) => finding.rule);
}

beforeAll(async () => {
  const scanner = await import(scannerUrl);
  const inspector = await import(inspectorUrl);
  modules = { ...scanner, ...inspector } as HygieneModules;
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('public content scanner', () => {
  test('rejects the complete private-content and filesystem rule set deterministically', async () => {
    const scanRoot = join(tempRoot, 'scanner-private');
    mkdirSync(scanRoot);
    const organization = ['Eti', 'had'].join('');
    const styleName = ['eti', 'had-preview.css'].join('');
    const styleToken = ['--', 'ey', '-accent'].join('');
    const taxonomyName = ['manual-', 'taxonomy-values.js'].join('');
    const corpus = ['onboard-', 'hospitality-manual'].join('');
    writeFileSync(join(scanRoot, 'absolute.txt'), ['/Users', 'sample', 'private', 'topic.dita'].join('/'));
    writeFileSync(join(scanRoot, 'absolute-windows.txt'), ['C:', 'Users', 'sample', 'private', 'topic.dita'].join('\\'));
    writeFileSync(join(scanRoot, 'absolute-file-uri.txt'), ['file:', '', '', 'Users', 'sample', 'private', 'topic.dita'].join('/'));
    writeFileSync(join(scanRoot, 'absolute-bundle-uri.txt'), ['webpack:', '', '', 'home', 'sample', 'private', 'topic.dita'].join('/'));
    writeFileSync(join(scanRoot, 'absolute-json.txt'), JSON.stringify({
      path: ['C:', 'Users', 'sample', 'private', 'topic.dita'].join('\\'),
    }));
    writeFileSync(join(scanRoot, taxonomyName), 'export default {};\n');
    writeFileSync(join(scanRoot, 'style.txt'), `${styleName}\n${styleToken}\n`);
    writeFileSync(join(scanRoot, 'organization.txt'), `${organization} Airways\n`);
    writeFileSync(join(scanRoot, 'corpus.txt'), `src/dita/${corpus}/topic.dita\n`);
    writeFileSync(join(scanRoot, 'bundle.js.map'), '{}\n');
    writeFileSync(join(scanRoot, 'mapped.js'), `//# ${['source', 'MappingURL='].join('')}bundle.js.map\n`);
    writeFileSync(join(scanRoot, 'target.txt'), 'safe\n');
    symlinkSync('target.txt', join(scanRoot, 'alias.txt'));

    const findings = await modules.scanPublicContent({ root: scanRoot });
    expect(new Set(findings.map((finding) => finding.rule))).toEqual(new Set([
      'absolute-personal-path',
      'private-taxonomy-asset',
      'private-style-asset',
      'private-style-token',
      'private-organization',
      'private-corpus-path',
      'source-map',
      'symbolic-link',
    ]));
    expect(findings).toEqual([...findings].sort((left, right) =>
      left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule)));
  });

  test('treats neutral binary data separately and does not broadly reject ordinary letter pairs', async () => {
    const scanRoot = join(tempRoot, 'scanner-binary');
    mkdirSync(scanRoot);
    writeFileSync(join(scanRoot, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    writeFileSync(join(scanRoot, 'ordinary.txt'), 'A key enables every style safely.\n');
    expect(await modules.scanPublicContent({ root: scanRoot })).toEqual([]);
  });

  test('scans visible binary metadata without decoding arbitrary binary payloads as text', async () => {
    const scanRoot = join(tempRoot, 'scanner-binary-metadata');
    mkdirSync(scanRoot);
    const marker = Buffer.from(`${['Eti', 'had'].join('')} Airways`, 'utf8');
    writeFileSync(join(scanRoot, 'icon.png'), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), marker, Buffer.from([0xff]),
    ]));
    expect((await modules.scanPublicContent({ root: scanRoot })).map((finding) => finding.rule))
      .toContain('private-organization');
  });

  test('recognizes direct, URI-wrapped, and JSON-escaped personal home paths individually', () => {
    const paths = [
      ['/Users', 'sample', 'private', 'topic.dita'].join('/'),
      ['file:', '', '', 'Users', 'sample', 'private', 'topic.dita'].join('/'),
      ['webpack:', '', '', 'home', 'sample', 'private', 'topic.dita'].join('/'),
      ['C:', 'Users', 'sample', 'private', 'topic.dita'].join('\\'),
      JSON.stringify({ path: ['C:', 'Users', 'sample', 'private', 'topic.dita'].join('\\') }),
    ];
    for (const [index, value] of paths.entries()) {
      expect(
        modules.scanTextForPrivateContent(`path-${index}.txt`, value)
          .map((finding) => finding.rule),
      ).toContain('absolute-personal-path');
    }
    expect(modules.scanTextForPrivateContent(
      'public-url.txt',
      'https://example.test/Users/alice/documentation/',
    )).toEqual([]);
  });

  test('rejects source-map directives at line starts and after generated code', () => {
    const marker = ['source', 'MappingURL='].join('');
    for (const source of [
      `//# ${marker}bundle.js.map\n`,
      `code();//# ${marker}bundle.js.map\n`,
      `body{}/*# ${marker}styles.css.map */\n`,
    ]) {
      expect(modules.scanTextForPrivateContent('mapped.js', source)
        .map((finding) => finding.rule)).toContain('source-map');
    }
  });

  test('rejects the full private organization name inside camelCase source and paths', () => {
    const sourceIdentifier = ['eti', 'hadAirwaysConfig'].join('');
    const pathIdentifier = ['eti', 'hadConfig.ts'].join('');
    expect(modules.scanTextForPrivateContent(
      'source.js',
      `const ${sourceIdentifier} = {};`,
    ).map((finding) => finding.rule)).toContain('private-organization');
    expect(modules.scanPathForPrivateContent(
      `src/${pathIdentifier}`,
    ).map((finding) => finding.rule)).toContain('private-organization');
  });

  test('exposes the documented explicit-root CLI and returns a non-zero status for findings', async () => {
    const scanRoot = join(tempRoot, 'scanner-cli');
    mkdirSync(scanRoot);
    writeFileSync(join(scanRoot, 'safe.txt'), 'Neutral public text.\n');

    const run = async () => {
      const processHandle = Bun.spawn(['bun', 'run', 'scan:public', '--', '--root', scanRoot], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      return { exitCode, output: stdout + stderr };
    };

    expect((await run()).exitCode).toBe(0);
    writeFileSync(join(scanRoot, 'private.txt'), `${['Eti', 'had'].join('')} Airways\n`);
    const rejected = await run();
    expect(rejected.exitCode).toBe(1);
    expect(rejected.output).toContain('[private-organization]');
  });
});

describe('VSIX central-directory safety', () => {
  test('rejects absolute, drive, UNC, traversal, backslash, NUL, dot, and non-NFC names', async () => {
    const cases: Array<[string, string | Buffer, string]> = [
      ['absolute', '/extension/evil.js', 'archive-absolute-path'],
      ['drive', 'C:/extension/evil.js', 'archive-drive-path'],
      ['unc', '//server/share/evil.js', 'archive-absolute-path'],
      ['traversal', '../evil.js', 'archive-traversal'],
      ['backslash', 'extension\\evil.js', 'archive-backslash'],
      ['nul', Buffer.from('extension/evil\0.js'), 'archive-nul'],
      ['dot', 'extension/./evil.js', 'archive-noncanonical-path'],
      ['unicode', 'extension/media/e\u0301.js', 'archive-non-nfc-path'],
      [
        'encoding',
        Buffer.concat([Buffer.from('extension/media/'), Buffer.from([0xff]), Buffer.from('.js')]),
        'archive-name-encoding',
      ],
    ];
    for (const [label, name, expectedRule] of cases) {
      const path = writeZip(`unsafe-${label}.vsix`, [{ name }]);
      const result = await modules.inspectVsixStructure(path);
      expect(result.ok, label).toBe(false);
      expect(rules(result), label).toContain(expectedRule);
    }
  });

  test('rejects duplicate, case-fold, and Unicode-normalization aliases', async () => {
    const exact = writeZip('alias-exact.vsix', [
      { name: 'extension/media/a.js' },
      { name: 'extension/media/a.js' },
    ]);
    const caseFold = writeZip('alias-case.vsix', [
      { name: 'extension/media/A.js' },
      { name: 'extension/media/a.js' },
    ]);
    const unicode = writeZip('alias-unicode.vsix', [
      { name: 'extension/media/é.js' },
      { name: 'extension/media/e\u0301.js' },
    ]);
    const fullCaseFold = writeZip('alias-full-case.vsix', [
      { name: 'extension/media/ß.js' },
      { name: 'extension/media/ss.js' },
    ]);
    const ancestorCaseFold = writeZip('alias-ancestor-case.vsix', [
      { name: 'extension/Media/a.js' },
      { name: 'extension/media/b.js' },
    ]);
    expect(rules(await modules.inspectVsixStructure(exact))).toContain('archive-alias-collision');
    expect(rules(await modules.inspectVsixStructure(caseFold))).toContain('archive-alias-collision');
    expect(rules(await modules.inspectVsixStructure(unicode))).toContain('archive-unicode-alias');
    expect(rules(await modules.inspectVsixStructure(fullCaseFold))).toContain('archive-alias-collision');
    expect(rules(await modules.inspectVsixStructure(ancestorCaseFold))).toContain('archive-alias-collision');
  });

  test('rejects symlink and special-file attributes before extraction', async () => {
    const symlink = writeZip('type-symlink.vsix', [
      { name: 'extension/media/link.js', data: 'target', mode: 0o120777, host: 0 },
    ]);
    const special = writeZip('type-special.vsix', [
      { name: 'extension/media/device.js', mode: 0o020666 },
    ]);
    expect(rules(await modules.inspectVsixStructure(symlink))).toContain('archive-symlink');
    expect(rules(await modules.inspectVsixStructure(special))).toContain('archive-special-file');
  });

  test('verifies local headers and streamed uncompressed sizes before inspection', async () => {
    const localHeaderBytes = createZip(baseEntries());
    const localName = Buffer.from('extension/media/content-theme.css');
    const localIndex = localHeaderBytes.indexOf(localName);
    expect(localIndex).toBeGreaterThan(0);
    localHeaderBytes[localIndex + localName.length - 1] = 'x'.charCodeAt(0);
    const localHeaderPath = join(tempRoot, 'local-header-mismatch.vsix');
    writeFileSync(localHeaderPath, localHeaderBytes);

    const streamEntries = baseEntries().map((entry) => {
      if (entry.name !== 'extension/media/content-theme.css') return entry;
      const data = String(entry.data ?? '');
      return {
        ...entry,
        method: 8 as const,
        declaredUncompressedSize: Buffer.byteLength(data) + 1,
      };
    });
    const streamPath = writeZip('stream-size-mismatch.vsix', streamEntries);

    expect(rules(await modules.inspectVsixStructure(localHeaderPath))).toContain('archive-local-header');
    expect(rules(await modules.inspectVsixStructure(streamPath))).toContain('archive-stream');
  });

  test('enforces entry, per-file, total-uncompressed, and compression-ratio caps', async () => {
    const many = writeZip('limit-count.vsix', Array.from({ length: 5_001 }, (_, index) => ({
      name: `extension/media/x-${index}.js`,
    })));
    const huge = writeZip('limit-file.vsix', [{
      name: 'extension/media/huge.js',
      data: 'x',
      method: 8,
      declaredCompressedSize: 1_048_576,
      declaredUncompressedSize: 50 * 1_048_576 + 1,
    }]);
    const total = writeZip('limit-total.vsix', [0, 1, 2].map((index) => ({
      name: `extension/media/total-${index}.js`,
      data: 'x',
      method: 8 as const,
      declaredCompressedSize: 1_048_576,
      declaredUncompressedSize: 40 * 1_048_576,
    })));
    const ratio = writeZip('limit-ratio.vsix', [{
      name: 'extension/media/ratio.js',
      data: 'x',
      method: 8,
      declaredUncompressedSize: 10_000,
    }]);

    expect(rules(await modules.inspectVsixStructure(many))).toContain('archive-entry-limit');
    expect(rules(await modules.inspectVsixStructure(huge))).toContain('archive-file-size-limit');
    expect(rules(await modules.inspectVsixStructure(total))).toContain('archive-total-size-limit');
    expect(rules(await modules.inspectVsixStructure(ratio))).toContain('archive-compression-ratio');
  });
});

describe('VSIX runtime inventory and pre-metadata gate', () => {
  test('accepts both directory-less and explicit-directory structural layouts', async () => {
    for (const explicitDirectories of [false, true]) {
      const path = writeZip(`valid-${explicitDirectories}.vsix`, baseEntries({ explicitDirectories }));
      const structure = await modules.inspectVsixStructure(path);
      expect(structure.ok, JSON.stringify(structure.findings)).toBe(true);
      expect(structure.findings).toEqual([]);
      const preMetadata = await modules.inspectVsix({ vsixPath: path, phase: 'pre-metadata' });
      expect(preMetadata.ok, JSON.stringify(preMetadata.findings)).toBe(true);
      expect(preMetadata.findings.map((finding) => `${finding.path}|${finding.rule}`).sort())
        .toEqual([...modules.PRE_METADATA_DEFERRED_KEYS].sort());
      expect(preMetadata.findings.every((finding) => finding.deferred)).toBe(true);
      const strict = await modules.inspectVsix({ vsixPath: path });
      expect(strict.ok).toBe(false);
      expect(strict.findings.some((finding) => finding.deferred)).toBe(false);
    }
  });

  test('rejects missing envelopes and package/envelope identity mismatches', async () => {
    const missing = writeZip(
      'missing-envelope.vsix',
      baseEntries({ omit: '[Content_Types].xml' }),
    );
    const mismatch = writeZip(
      'identity-mismatch.vsix',
      baseEntries({ manifestVersion: '9.9.9' }),
    );
    expect(rules(await modules.inspectVsixStructure(missing))).toContain('vsix-missing-envelope');
    expect(rules(await modules.inspectVsixStructure(mismatch))).toContain('vsix-identity-mismatch');
  });

  test('rejects duplicate envelope identity declarations instead of accepting the first match', async () => {
    const publisher = ['eti', 'had'].join('');
    const duplicate = baseEntries().map((entry) => {
      if (entry.name !== 'extension.vsixmanifest') return entry;
      const source = String(entry.data);
      const second = `<Identity Id="dita-editor" Version="0.0.1" Publisher="${publisher}"/>`;
      return { ...entry, data: source.replace('</Metadata>', `${second}</Metadata>`) };
    });
    const path = writeZip('duplicate-identity.vsix', duplicate);
    expect(rules(await modules.inspectVsixStructure(path))).toContain('vsix-envelope-format');
  });

  test('rejects malformed entities plus misnested or lowercase schema elements', async () => {
    const mutate = (label: string, transform: (source: string) => string) => {
      const entries = strictReadyEntries().map((entry) => {
        if (entry.name !== 'extension.vsixmanifest' && entry.name !== '[Content_Types].xml') return entry;
        return { ...entry, data: transform(String(entry.data)) };
      });
      return writeZip(`invalid-envelope-${label}.vsix`, entries);
    };
    const malformedEntity = mutate('entity', (source) =>
      source.includes('<Metadata>') ? source.replace('<Metadata>', '<Metadata>&broken;') : source);
    const misnested = mutate('misnested', (source) => {
      if (!source.includes('<Identity ')) return source;
      const identity = /<Identity\b[^>]*\/>/u.exec(source)?.[0] ?? '';
      return source.replace(identity, '').replace('</Metadata>', `</Metadata>${identity}`);
    });
    const lowercaseIdentity = mutate('lowercase-identity', (source) =>
      source.replace('<Identity ', '<identity '));
    const lowercaseDefault = mutate('lowercase-default', (source) =>
      source.replace('<Default ', '<default '));
    const rawCdataEnd = mutate('raw-cdata-end', (source) =>
      source.includes('<Metadata>') ? source.replace('<Metadata>', '<Metadata>]]>') : source);
    const duplicateDeclaration = mutate('duplicate-declaration', (source) =>
      source.startsWith('<?xml') ? `<?xml version="1.0"?>${source}` : source);
    const invalidComment = mutate('invalid-comment', (source) =>
      source.includes('<Metadata>') ? source.replace('<Metadata>', '<Metadata><!-- bad --->') : source);
    const declarationAfterWhitespace = mutate('declaration-after-whitespace', (source) =>
      source.startsWith('<?xml') ? ` \n${source}` : source);
    const commentInTagName = mutate('comment-in-tag-name', (source) =>
      source.replace('<PackageManifest', '<Package<!-- neutral -->Manifest'));
    const commentInAttribute = mutate('comment-in-attribute', (source) =>
      source.replace('Publisher=', 'Pub<!-- neutral -->lisher='));

    for (const [label, path] of [
      ['entity', malformedEntity],
      ['misnested', misnested],
      ['lowercase-identity', lowercaseIdentity],
      ['lowercase-default', lowercaseDefault],
      ['raw-cdata-end', rawCdataEnd],
      ['duplicate-declaration', duplicateDeclaration],
      ['invalid-comment', invalidComment],
      ['declaration-after-whitespace', declarationAfterWhitespace],
      ['comment-in-tag-name', commentInTagName],
      ['comment-in-attribute', commentInAttribute],
    ]) {
      const result = await modules.inspectVsixStructure(path);
      expect(result.ok, label).toBe(false);
      expect(rules(result), label).toContain('vsix-envelope-format');
    }
  });

  test('rejects forbidden payloads and one extra non-deferred finding in pre-metadata mode', async () => {
    const path = writeZip('forbidden-payload.vsix', baseEntries({
      extra: [
        { name: 'extension/src/secret.ts', data: 'export {};\n' },
        { name: 'extension/media/secret.js', data: 'export {};\n' },
      ],
    }));
    const result = await modules.inspectVsix({ vsixPath: path, phase: 'pre-metadata' });
    expect(result.ok).toBe(false);
    expect(rules(result)).toContain('vsix-forbidden-path');
    expect(rules(result)).toContain('pre-metadata-deferral-set');
  });

  test('never defers private package content outside the owner identity fields', async () => {
    const privateContent = baseEntries().map((entry) => {
      if (entry.name !== 'extension/package.json') return entry;
      const pkg = JSON.parse(String(entry.data));
      pkg.description = `${['Eti', 'had'].join('')} private corpus`;
      return { ...entry, data: JSON.stringify(pkg) };
    });
    const path = writeZip('private-package-content.vsix', privateContent);
    const result = await modules.inspectVsix({ vsixPath: path, phase: 'pre-metadata' });
    expect(result.ok).toBe(false);
    expect(rules(result)).toContain('private-organization');
    expect(rules(result)).toContain('pre-metadata-deferral-set');

    const organization = ['Eti', 'had'].join('');
    const privateEnvelope = baseEntries().map((entry) => {
      if (entry.name !== 'extension.vsixmanifest') return entry;
      return {
        ...entry,
        data: String(entry.data).replace(
          '<Metadata>',
          `<Metadata><!-- <Identity Publisher="${organization}"/> -->`,
        ),
      };
    });
    const envelopePath = writeZip('private-envelope-content.vsix', privateEnvelope);
    const envelopeResult = await modules.inspectVsix({
      vsixPath: envelopePath,
      phase: 'pre-metadata',
    });
    expect(envelopeResult.ok).toBe(false);
    expect(rules(envelopeResult)).toContain('private-organization');
    expect(rules(envelopeResult)).toContain('pre-metadata-deferral-set');

    const duplicateOwner = baseEntries().map((entry) => {
      if (entry.name !== 'extension/package.json') return entry;
      const owner = organization.toLocaleLowerCase('en-US');
      const token = `"publisher":"${owner}"`;
      return { ...entry, data: String(entry.data).replace(token, `${token},${token}`) };
    });
    const duplicateOwnerPath = writeZip('duplicate-owner-metadata.vsix', duplicateOwner);
    const duplicateOwnerResult = await modules.inspectVsix({
      vsixPath: duplicateOwnerPath,
      phase: 'pre-metadata',
    });
    expect(duplicateOwnerResult.ok).toBe(false);
    expect(rules(duplicateOwnerResult)).toContain('vsix-package-json');
    expect(rules(duplicateOwnerResult)).toContain('pre-metadata-deferral-set');

    const extraIdentityAttribute = baseEntries().map((entry) => {
      if (entry.name !== 'extension.vsixmanifest') return entry;
      return {
        ...entry,
        data: String(entry.data).replace(
          '<Identity ',
          `<Identity Leak="${organization} private" `,
        ),
      };
    });
    const extraAttributePath = writeZip('private-identity-extra-attribute.vsix', extraIdentityAttribute);
    const extraAttributeResult = await modules.inspectVsix({
      vsixPath: extraAttributePath,
      phase: 'pre-metadata',
    });
    expect(extraAttributeResult.ok).toBe(false);
    expect(rules(extraAttributeResult)).toContain('private-organization');
    expect(rules(extraAttributeResult)).toContain('pre-metadata-deferral-set');

    const unrelatedOwnerTags = baseEntries().map((entry) => {
      if (entry.name !== 'extension.vsixmanifest') return entry;
      const extra = `<Properties><Identity Leak="${organization}"/><DisplayName>${organization}</DisplayName></Properties>`;
      return { ...entry, data: String(entry.data).replace('</PackageManifest>', `${extra}</PackageManifest>`) };
    });
    const unrelatedPath = writeZip('private-unrelated-owner-tags.vsix', unrelatedOwnerTags);
    const unrelatedResult = await modules.inspectVsix({
      vsixPath: unrelatedPath,
      phase: 'pre-metadata',
    });
    expect(unrelatedResult.ok).toBe(false);
    expect(rules(unrelatedResult)).toContain('private-organization');
    expect(rules(unrelatedResult)).toContain('pre-metadata-deferral-set');

    const intendedDisplayName = baseEntries().map((entry) => {
      if (entry.name !== 'extension.vsixmanifest') return entry;
      return {
        ...entry,
        data: String(entry.data).replace(
          '</Metadata>',
          `<DisplayName>${organization}</DisplayName></Metadata>`,
        ),
      };
    });
    const intendedDisplayPath = writeZip('owner-display-name.vsix', intendedDisplayName);
    const intendedDisplayResult = await modules.inspectVsix({
      vsixPath: intendedDisplayPath,
      phase: 'pre-metadata',
    });
    expect(intendedDisplayResult.ok, JSON.stringify(intendedDisplayResult.findings)).toBe(true);
  });

  test('strict mode scans complete identity, repository, and envelope bytes with no deferrals', async () => {
    const neutralPath = writeZip('strict-neutral.vsix', strictReadyEntries());
    const neutral = await modules.inspectVsix({ vsixPath: neutralPath });
    expect(neutral.ok, JSON.stringify(neutral.findings)).toBe(true);

    for (const version of ['0.1.1', '0.2.42', '1.0.1']) {
      const patchPath = writeZip(`strict-preview-${version}.vsix`, strictReadyEntries({ version }));
      const patch = await modules.inspectVsix({ vsixPath: patchPath });
      expect(patch.ok, JSON.stringify(patch.findings)).toBe(true);
    }
    for (const version of ['0.1.01', '0.1.1-beta.1']) {
      const invalidPath = writeZip(`strict-invalid-${version}.vsix`, strictReadyEntries({ version }));
      const invalid = await modules.inspectVsix({ vsixPath: invalidPath });
      expect(invalid.ok, version).toBe(false);
      expect(rules(invalid), version).toContain('owner-gated-metadata');
    }
    for (const [label, entries] of [
      ['name', strictReadyEntries({ name: 'another-extension' })],
      ['publisher', strictReadyEntries({ publisher: 'another-publisher' })],
    ] as const) {
      const wrongIdentityPath = writeZip(`strict-wrong-${label}.vsix`, entries);
      const wrongIdentity = await modules.inspectVsix({ vsixPath: wrongIdentityPath });
      expect(wrongIdentity.ok, label).toBe(false);
      expect(rules(wrongIdentity), label).toContain('owner-gated-metadata');
    }

    const organization = ['eti', 'had'].join('');
    const cases: Array<[string, FixtureEntry[]]> = [
      ['publisher', strictReadyEntries({ publisher: organization })],
      ['name', strictReadyEntries({ name: `${organization}-visual` })],
      ['repository', strictReadyEntries({ repositoryOwner: organization })],
      ['envelope-comment', strictReadyEntries({ manifestComment: organization })],
      ['envelope-entity', strictReadyEntries().map((entry) => {
        if (entry.name !== 'extension.vsixmanifest') return entry;
        return {
          ...entry,
          data: String(entry.data).replace(
            '</Metadata>',
            '<Description>&#69;tihad private</Description></Metadata>',
          ),
        };
      })],
      ['envelope-cdata-split', strictReadyEntries().map((entry) => {
        if (entry.name !== 'extension.vsixmanifest') return entry;
        return {
          ...entry,
          data: String(entry.data).replace(
            '</Metadata>',
            '<Description>Eti<![CDATA[h]]>ad Airways</Description></Metadata>',
          ),
        };
      })],
    ];
    for (const [label, entries] of cases) {
      const path = writeZip(`strict-private-${label}.vsix`, entries);
      const result = await modules.inspectVsix({ vsixPath: path });
      expect(result.ok, label).toBe(false);
      expect(rules(result), label).toContain('private-organization');
      expect(result.findings.some((finding) => finding.deferred), label).toBe(false);
    }

    const duplicatePrivateBytes = strictReadyEntries().map((entry) => {
      if (entry.name !== 'extension/package.json') return entry;
      const injected = `"description":"${organization} private","description":"neutral","main":`;
      return { ...entry, data: String(entry.data).replace('"main":', injected) };
    });
    const duplicatePath = writeZip('strict-duplicate-private.vsix', duplicatePrivateBytes);
    const duplicateResult = await modules.inspectVsix({ vsixPath: duplicatePath });
    expect(duplicateResult.ok).toBe(false);
    expect(rules(duplicateResult)).toContain('vsix-package-json');
    expect(rules(duplicateResult)).toContain('private-organization');

    const escapedPrivateBytes = strictReadyEntries().map((entry) => {
      if (entry.name !== 'extension/package.json') return entry;
      return {
        ...entry,
        data: String(entry.data).replace(
          '"main":',
          '"description":"\\u0045tihad private","main":',
        ),
      };
    });
    const escapedPath = writeZip('strict-escaped-private.vsix', escapedPrivateBytes);
    const escapedResult = await modules.inspectVsix({ vsixPath: escapedPath });
    expect(escapedResult.ok).toBe(false);
    expect(rules(escapedResult)).toContain('private-organization');
  });

  test('accepts the real Task 9 VSCE archive structurally', async () => {
    const artifact = join(tempRoot, 'real-task9-vsce.vsix');
    const run = async (command: string[]) => {
      const processHandle = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(exitCode, stdout + stderr).toBe(0);
    };
    await run(['bun', 'run', 'build:production']);
    await run([
      'node', join(root, 'node_modules/@vscode/vsce/vsce'), 'package',
      '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', artifact,
    ]);
    const result = await modules.inspectVsixStructure(artifact);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  }, 120_000);
});
