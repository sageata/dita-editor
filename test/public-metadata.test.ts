import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const publicDocuments = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/STYLING.md',
  'docs/TAXONOMY.md',
  'docs/PROVENANCE.md',
  'docs/provenance.json',
  'docs/public-export.json',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/pull_request_template.md',
];

const expectedAttributes = `* text=auto eol=lf
*.ts text eol=lf
*.js text eol=lf
*.mjs text eol=lf
*.json text eol=lf
*.jsonc text eol=lf
*.css text eol=lf
*.md text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.xml text eol=lf
*.dita text eol=lf
*.ditamap text eol=lf
*.svg text eol=lf
bun.lock text eol=lf
.node-version text eol=lf
.gitignore text eol=lf
.vscodeignore text eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.vsix binary
`;

describe('public extension metadata', () => {
  test('uses the owner-approved public identity', () => {
    expect(pkg).toMatchObject({
      name: 'dita-editor',
      displayName: 'DITA Editor',
      version: '0.1.0',
      preview: true,
      publisher: 'paul-razvan-sarbu',
      icon: 'media/icon.png',
      license: 'Apache-2.0',
      repository: {
        type: 'git',
        url: 'https://github.com/sageata/dita-editor.git',
      },
      homepage: 'https://github.com/sageata/dita-editor#readme',
      bugs: { url: 'https://github.com/sageata/dita-editor/issues' },
      pricing: 'Free',
    });
    expect(pkg.private).toBeUndefined();
    expect(pkg.categories).toEqual(expect.arrayContaining(['Programming Languages', 'Other']));
    expect(pkg.keywords).toEqual(expect.arrayContaining(['DITA', 'XML', 'WYSIWYG', 'documentation']));
  });

  test('keeps the exact limited Workspace Trust declaration', () => {
    expect(pkg.capabilities).toEqual({
      untrustedWorkspaces: {
        supported: 'limited',
        restrictedConfigurations: [
          'ditaeditor.visual.contentStylesheets',
          'ditaeditor.visual.managedAuthorStylesheet',
          'ditaeditor.visual.taxonomyFile',
        ],
      },
    });
  });

  test('uses only the strict Bun-owned package gate', () => {
    expect(pkg.scripts['package:vsix:pre-metadata']).toBeUndefined();
    expect(pkg.scripts['vscode:prepublish']).toBeUndefined();
    expect(pkg.scripts['package:vsix']).toBe(
      'bun run typecheck && bun run build:production && bun run prepare:artifacts && vsce package --no-dependencies --out artifacts/dita-editor-0.1.0.vsix',
    );
    expect(pkg.scripts['package:vsix']).not.toContain('--allow-missing-repository');
    expect(pkg.scripts['package:vsix']).not.toContain('--skip-license');
    expect(pkg.scripts['verify:metadata']).toBe('node scripts/verify-public-metadata.mjs');
    expect(pkg.scripts['scan:public-export']).toBe(
      'node scripts/verify-public-metadata.mjs --scan-only',
    );
  });

  test('records both approved identifiers as owner-scope verified available', () => {
    const evidence = JSON.parse(readFileSync(join(root, 'test/coexistence-extension.json'), 'utf8'));
    const ownerEvidence = evidence.ownerScopedAvailability;
    expect(evidence.publicRepositoryObserved).toBe(false);
    expect(ownerEvidence.repository.availability).toBe('verified-available-owner-scope');
    expect(ownerEvidence.repository.method).toBe('owner-scoped-github-graphql');
    expect(ownerEvidence.repository).toMatchObject({
      viewer: 'sageata',
      owner: 'sageata',
      name: 'dita-editor',
      result: 'null-with-not-found',
    });
    expect(ownerEvidence.marketplace.availability).toBe('verified-available-owner-scope');
    expect(ownerEvidence.marketplace.method).toBe('owner-authenticated-publisher-inventory');
    expect(ownerEvidence.marketplace).toMatchObject({
      publisherName: 'Paul Razvan Sarbu',
      publisherId: 'paul-razvan-sarbu',
      inventory: 'empty',
      extensionId: 'paul-razvan-sarbu.dita-editor',
    });
    expect(ownerEvidence.verifiedAt).toBe('2026-07-11');
    expect(ownerEvidence.source).toBe('controller-verified-owner-scoped-check');
  });

  test('includes every required public document without placeholders', () => {
    for (const path of publicDocuments) {
      expect(existsSync(join(root, path)), path).toBe(true);
      const text = readFileSync(join(root, path), 'utf8');
      expect(text, path).not.toMatch(/\b(?:OWNER|EMAIL|TBD)\b/u);
    }
    expect(readFileSync(join(root, '.github/CODEOWNERS'), 'utf8')).toBe(
      '* @sageata\n/.github/ @sageata\n',
    );
  });

  test('ships the approved PNG icon at no less than 128 by 128', () => {
    const bytes = readFileSync(join(root, 'media/icon.png'));
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(bytes.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
  });

  test('preserves the exact public line-ending contract', () => {
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(expectedAttributes);
  });
});
