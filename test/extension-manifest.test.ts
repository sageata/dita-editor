import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
const extensionSource = readFileSync(join(import.meta.dir, '..', 'src', 'extension.ts'), 'utf8');

describe('extension manifest', () => {
  test('activates after startup so Source Control .dita diff clicks can be intercepted', () => {
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  test('declares the exact resource-scoped workspace file settings', () => {
    const properties = manifest.contributes.configuration.properties;

    expect(properties['ditaeditor.visual.contentStylesheets']).toEqual({
      type: 'array',
      items: { type: 'string' },
      default: [],
      scope: 'resource',
    });
    expect(properties['ditaeditor.visual.managedAuthorStylesheet']).toEqual({
      type: 'string',
      default: 'css/ditaeditor-author-styles.css',
      scope: 'resource',
    });
    expect(properties['ditaeditor.visual.taxonomyFile']).toEqual({
      type: 'string',
      default: '',
      scope: 'resource',
    });
  });

  test('limits workspace file settings in Restricted Mode', () => {
    expect(manifest.capabilities).toEqual({
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

  test('exposes the exact manifest comparison script', () => {
    expect(manifest.scripts['compare:extension-manifests']).toBe(
      'node scripts/compare-extension-manifests.mjs',
    );
  });

  test('re-queries tabs after openWith instead of closing a stale tab object', () => {
    const body = extensionSource.match(/async function reopenInPlace[\s\S]*?\n}\n\nfunction isDitaUri/)?.[0];
    expect(body).toBeTruthy();
    const afterOpen = body!.split("await vscode.commands.executeCommand('vscode.openWith'")[1];
    expect(afterOpen).toContain('vscode.window.tabGroups.all');
    expect(afterOpen).not.toContain('close(prior');
  });
});
