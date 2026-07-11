import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');
const properties = readFileSync(new URL('../media/canvas-properties.js', import.meta.url), 'utf8');
const contextMenu = readFileSync(new URL('../media/canvas-context-menu.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../media/canvas-styles.js', import.meta.url), 'utf8');

describe('visual editor taxonomy integration contract', () => {
  test('re-resolves every taxonomy event and revalidates canonical identity after reading bytes', () => {
    const requestStart = provider.indexOf('const requestTaxonomyReload =');
    const requestEnd = provider.indexOf('const updateTaxonomyWatchTarget =', requestStart);
    const request = provider.slice(requestStart, requestEnd);
    expect(request).toContain('resolveWorkspaceFileConfiguration(');
    expect(request).toContain('await refreshResolvedTaxonomy(');
    expect(provider).toContain('readRevalidatedTaxonomyResource({');
    expect(provider).toContain('vscode.Uri.file(file.canonicalPath)');
    expect(provider).toContain('reResolve: async () => taxonomyResourceIdentity(');
  });

  test('binds early disposal and workspace-folder reassignment to taxonomy invalidation', () => {
    expect(provider.indexOf('disposeEarlyTaxonomy();')).toBeLessThan(provider.indexOf('await refreshResolvedTaxonomy('));
    expect(provider).toContain('vscode.workspace.onDidChangeWorkspaceFolders');
    const folders = provider.slice(
      provider.indexOf('const onWorkspaceFolders ='),
      provider.indexOf('retargetStyleWatcher();', provider.indexOf('const onWorkspaceFolders =')),
    );
    expect(folders).toContain('taxonomyState.invalidate(null)');
    expect(folders).toContain('requestWorkspaceConfigurationReload()');
  });

  test('awaits taxonomy on full reload and replays current state in the ready handshake', () => {
    const refresh = provider.indexOf('await refreshResolvedTaxonomy(resolvedTaxonomyFile);');
    expect(refresh).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(provider.indexOf('render();', refresh));
    expect(provider).toContain('taxonomy: currentTaxonomy,');
    expect(canvas).toContain('if (msg.taxonomy !== undefined)');
    expect(canvas).toContain('propertiesPanel.setTaxonomy(taxonomy)');
  });

  test('every browser attribute family carries the current render generation', () => {
    for (const source of [properties, contextMenu, styles]) {
      expect(source).toContain('baseStructVersion: getStructVersion()');
    }
    expect(canvas).toContain('getStructVersion: () => structVersion');
    expect(provider).toContain('structVersion++; // external bytes may recycle positional ids');
  });
});
