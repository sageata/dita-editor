import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');
const properties = readFileSync(new URL('../media/properties-panel.js', import.meta.url), 'utf8');
const contextMenu = readFileSync(new URL('../media/canvas-native-context-menu.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../media/styles-panel.js', import.meta.url), 'utf8');

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

  test('awaits taxonomy on full reload and feeds the inspector hub for the Properties view', () => {
    const refresh = provider.indexOf('await refreshResolvedTaxonomy(resolvedTaxonomyFile);');
    expect(refresh).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(provider.indexOf('render();', refresh));
    // The canvas no longer consumes taxonomy: the hub relays it to the native
    // Properties view, and the ready handshake re-feeds it.
    expect(provider).toContain('this.host.inspectors.update(visualPanelKey, { taxonomy })');
    expect(provider).toContain('taxonomy: currentTaxonomy,');
    expect(canvas).not.toContain('taxonomy');
  });

  test('every browser attribute family carries the current render generation', () => {
    for (const source of [properties, styles]) {
      expect(source).toContain('baseStructVersion: getStructVersion()');
    }
    expect(contextMenu).toContain('message.baseStructVersion = context.ditaNativeStructVersion');
    expect(canvas).toContain('getStructVersion: () => structVersion');
    expect(provider).toContain('structVersion++; // external bytes may recycle positional ids');
  });
});
