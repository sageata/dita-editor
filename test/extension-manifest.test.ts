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

    expect(properties['ditaeditor.visual.authorStylesheet']).toEqual({
      type: 'string',
      default: 'css/ditaeditor-author-styles.css',
      scope: 'resource',
      description: 'Workspace-relative repository-owned stylesheet used by the visual editor, review surfaces, and the Styles view. The stylesheet may import project tokens and other manual CSS.',
    });
    expect(properties['ditaeditor.visual.contentStylesheets']).toEqual({
      type: 'array',
      items: { type: 'string' },
      default: [],
      scope: 'resource',
      deprecationMessage: 'Use ditaeditor.visual.authorStylesheet and import additional project stylesheets from that file.',
    });
    expect(properties['ditaeditor.visual.managedAuthorStylesheet']).toEqual({
      type: 'string',
      default: 'css/ditaeditor-author-styles.css',
      scope: 'resource',
      deprecationMessage: 'Use ditaeditor.visual.authorStylesheet. This setting remains as a compatibility fallback.',
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
          'ditaeditor.visual.authorStylesheet',
          'ditaeditor.visual.contentStylesheets',
          'ditaeditor.visual.managedAuthorStylesheet',
          'ditaeditor.visual.taxonomyFile',
        ],
      },
    });
  });

  test('contributes the Search DITA Topics activity-bar view with icon and shortcut', () => {
    // The inspector container is contributed to the ACTIVITY BAR, not
    // secondarySideBar: forks/builds without that 1.106 contribution point
    // dump such views into Explorer with a warning. Users drag the container
    // to the Secondary Side Bar once and the placement is remembered.
    expect(manifest.contributes.viewsContainers).toEqual({
      activitybar: [
        { id: 'ditaeditor-search', title: 'DITA Search', icon: 'media/search-topics.svg' },
        { id: 'ditaeditor-inspector', title: 'DITA', icon: 'media/dita-inspector.svg' },
      ],
    });
    expect(manifest.contributes.views).toEqual({
      'ditaeditor-search': [
        {
          type: 'webview',
          id: 'ditaeditor.topicSearch',
          name: 'Search DITA Topics',
          contextualTitle: 'DITA Search',
          icon: 'media/search-topics.svg',
        },
      ],
      'ditaeditor-inspector': [
        {
          type: 'webview',
          id: 'ditaeditor.stylesView',
          name: 'DITA Styles',
          contextualTitle: 'DITA Styles',
          icon: 'media/dita-inspector.svg',
        },
        {
          type: 'webview',
          id: 'ditaeditor.propertiesView',
          name: 'DITA Properties',
          contextualTitle: 'DITA Properties',
          icon: 'media/dita-inspector.svg',
        },
      ],
    });
    expect(manifest.contributes.keybindings).toEqual([
      { command: 'ditaeditor.searchTopics', key: 'ctrl+shift+alt+f', mac: 'cmd+shift+alt+f' },
      // Scoped to open DITA visual editors so cmd+alt+s never shadows macOS
      // Save All in unrelated workspaces.
      { command: 'ditaeditor.focusStyles', key: 'ctrl+alt+s', mac: 'cmd+alt+s', when: 'ditaeditor.hasVisualEditor' },
      { command: 'ditaeditor.focusProperties', key: 'ctrl+alt+p', mac: 'cmd+alt+p', when: 'ditaeditor.hasVisualEditor' },
    ]);
    const commands = manifest.contributes.commands as Array<{ command: string; category?: string }>;
    for (const id of [
      'ditaeditor.searchTopics',
      'ditaeditor.refreshTopicSearch',
      'ditaeditor.focusStyles',
      'ditaeditor.focusProperties',
    ]) {
      const entry = commands.find((c) => c.command === id);
      expect(entry?.category).toBe('DITA Editor');
    }
    const viewTitle = manifest.contributes.menus['view/title'] as Array<{ command: string; when: string; group: string }>;
    expect(viewTitle).toContainEqual({
      command: 'ditaeditor.refreshTopicSearch',
      when: 'view == ditaeditor.topicSearch',
      group: 'navigation',
    });
  });

  test('pins the minimum VS Code engine matching the frozen minimum version record', () => {
    expect(manifest.engines.vscode).toBe('^1.106.0');
  });

  test('registers the topic search view and commands in activate', () => {
    expect(extensionSource).toContain("registerWebviewViewProvider(TOPIC_SEARCH_VIEW_ID");
    expect(extensionSource).toContain("registerCommand('ditaeditor.searchTopics'");
    expect(extensionSource).toContain("registerCommand('ditaeditor.refreshTopicSearch'");
  });

  test('registers the inspector views and focus commands in activate', () => {
    expect(extensionSource).toContain('registerWebviewViewProvider(STYLES_VIEW_ID');
    expect(extensionSource).toContain('registerWebviewViewProvider(PROPERTIES_VIEW_ID');
    expect(extensionSource).toContain("registerCommand('ditaeditor.focusStyles'");
    expect(extensionSource).toContain("registerCommand('ditaeditor.focusProperties'");
  });

  test('maintains the keybinding gate context from the visual-editor registry', () => {
    const providerSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'host', 'visual-editor-provider.ts'),
      'utf8',
    );
    expect(providerSource).toContain("'ditaeditor.hasVisualEditor'");
    expect(providerSource).toContain('this.visualPanels.size > 0');
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
