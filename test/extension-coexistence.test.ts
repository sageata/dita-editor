import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(EXTENSION_ROOT, 'scripts', 'compare-extension-manifests.mjs');
const CURRENT_MANIFEST = join(EXTENSION_ROOT, 'package.json');

interface Contributions {
  commands?: string[];
  settings?: string[];
  views?: string[];
  languages?: Array<{ id: string; extensions?: string[] }>;
  activationEvents?: string[];
  editors?: Array<{ viewType: string; filenamePattern?: string; priority?: string }>;
}

interface FixtureManifest {
  name: string;
  publisher: string;
  version: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string }>;
    configuration: unknown;
    views: Record<string, Array<{ id: string; name: string }>>;
    languages: Array<{ id: string; extensions?: string[] }>;
    customEditors: Array<{
      viewType: string;
      displayName: string;
      selector: Array<{ filenamePattern: string }>;
      priority: string;
    }>;
  };
}

function manifest(name: string, contributions: Contributions): FixtureManifest {
  return {
    name,
    publisher: 'fixture',
    version: '1.0.0',
    activationEvents: contributions.activationEvents ?? [],
    contributes: {
      commands: (contributions.commands ?? []).map((command) => ({ command, title: command })),
      configuration: {
        properties: Object.fromEntries(
          (contributions.settings ?? []).map((setting) => [setting, { type: 'string' }]),
        ),
      },
      views: {
        explorer: (contributions.views ?? []).map((id) => ({ id, name: id })),
      },
      languages: contributions.languages ?? [],
      customEditors: (contributions.editors ?? []).map((editor) => ({
        viewType: editor.viewType,
        displayName: editor.viewType,
        selector: [{ filenamePattern: editor.filenamePattern ?? '*.dita' }],
        priority: editor.priority ?? 'default',
      })),
    },
  };
}

function runComparator(left: string, right: string) {
  const result = Bun.spawnSync({
    cmd: ['node', SCRIPT, left, right],
    cwd: EXTENSION_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function withManifestPair(
  left: object,
  right: object,
  run: (leftPath: string, rightPath: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'ditaeditor-manifests-'));
  const leftPath = join(directory, 'left.json');
  const rightPath = join(directory, 'right.json');
  try {
    writeFileSync(leftPath, JSON.stringify(left), 'utf8');
    writeFileSync(rightPath, JSON.stringify(right), 'utf8');
    run(leftPath, rightPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('extension manifest coexistence comparator', () => {
  test('passes distinct IDs, activation events, file associations, and editor selectors', () => {
    withManifestPair(
      manifest('visual', {
        commands: ['ditaeditor.openVisual'],
        settings: ['ditaeditor.visual.taxonomyFile'],
        views: ['ditaeditor.visualOutline'],
        languages: [{ id: 'dita-visual', extensions: ['.dita-visual'] }],
        activationEvents: ['onCommand:ditaeditor.openVisual'],
        editors: [{ viewType: 'ditaeditor.visual', filenamePattern: '*.dita-visual' }],
      }),
      manifest('ditacraft', {
        commands: ['ditacraft.openFile'],
        settings: ['ditacraft.ditaOtPath'],
        views: ['ditacraft.ditaExplorer'],
        languages: [{ id: 'dita', extensions: ['.dita'] }],
        activationEvents: ['onLanguage:dita'],
        editors: [{ viewType: 'ditacraft.source', filenamePattern: '*.dita' }],
      }),
      (left, right) => {
        const result = runComparator(left, right);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No exact contribution collisions.');
        expect(result.stderr).toBe('');
      },
    );
  });

  test('fails exact command, setting, view, language, and custom-editor IDs', () => {
    const shared: Contributions = {
      commands: ['shared.command'],
      settings: ['shared.setting'],
      views: ['shared.view'],
      languages: [{ id: 'shared-language' }],
      editors: [{ viewType: 'shared.editor' }],
    };
    withManifestPair(manifest('left', shared), manifest('right', shared), (left, right) => {
      const result = runComparator(left, right);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Exact contribution collisions found:');
      expect(result.stderr).toContain('command: shared.command');
      expect(result.stderr).toContain('setting: shared.setting');
      expect(result.stderr).toContain('view: shared.view');
      expect(result.stderr).toContain('language: shared-language');
      expect(result.stderr).toContain('editor: shared.editor');
    });
  });

  test('fails exact activation events, file associations, selectors, and editor priorities', () => {
    const left = manifest('left', {
      activationEvents: ['onLanguage:dita'],
      languages: [{ id: 'left-language', extensions: ['.dita'] }],
      editors: [{ viewType: 'left.editor', filenamePattern: '*.dita', priority: 'default' }],
    });
    const right = manifest('right', {
      activationEvents: ['onLanguage:dita'],
      languages: [{ id: 'right-language', extensions: ['.dita'] }],
      editors: [{ viewType: 'right.editor', filenamePattern: '*.dita', priority: 'default' }],
    });
    withManifestPair(left, right, (leftPath, rightPath) => {
      const result = runComparator(leftPath, rightPath);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('activation-event: onLanguage:dita');
      expect(result.stderr).toContain('file-association: .dita');
      expect(result.stderr).toContain('editor-selector: *.dita');
      expect(result.stderr).toContain('editor-priority: default');
      expect(result.stderr).toContain('competing-default-editor: *.dita');
    });
  });

  test('handles configuration arrays and view groups without broadening collision policy', () => {
    const left = manifest('left', {});
    left.contributes.configuration = [
      { title: 'One', properties: { 'shared.setting': { type: 'string' } } },
      { title: 'Two', properties: { 'left.only': { type: 'boolean' } } },
    ];
    left.contributes.views = {
      explorer: [{ id: 'left.view', name: 'Left' }],
      panel: [{ id: 'shared.view', name: 'Shared' }],
    };
    const right = manifest('right', { settings: ['shared.setting'], views: ['shared.view'] });

    withManifestPair(left, right, (leftPath, rightPath) => {
      const result = runComparator(leftPath, rightPath);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('setting: shared.setting');
      expect(result.stderr).toContain('view: shared.view');
      expect(result.stderr).not.toContain('left.only');
      expect(result.stderr).not.toContain('left.view');
    });
  });

  test(
    'the committed official Marketplace evidence is current-shaped and has no collisions',
    () => {
      const evidencePath = join(EXTENSION_ROOT, 'test/coexistence-extension.json');
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      expect(evidence.companionExtensionId).toBe('JeremyJeanne.ditacraft');
      expect(evidence.companionVersion).toBe('0.8.1');
      expect(evidence.companionLicense).toBe('MIT');
      expect(evidence.targetIdentifierObserved).toBe(false);
      expect(evidence.manifest.contributes.customEditors).toEqual([]);

      const result = runComparator(CURRENT_MANIFEST, evidencePath);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No exact contribution collisions.');
      expect(result.stderr).toBe('');
    },
  );
});
