import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CANVAS_SCRIPT_FILES } from '../src/webview/canvas-scripts';
import { configureVisualWebviewResources } from '../src/host/webview-resources';

interface TestUri {
  path: string;
  scheme: string;
}

function uri(path: string, scheme = 'file'): TestUri {
  return { path, scheme };
}

function joinPath(base: TestUri, ...parts: string[]): TestUri {
  const segments = base.path.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..') segments.pop();
    else if (part !== '.') segments.push(part);
  }
  return { path: '/' + segments.join('/'), scheme: base.scheme };
}

function makeWebview() {
  const seen: string[] = [];
  return {
    seen,
    webview: {
      options: {},
      asWebviewUri(input: TestUri) {
        seen.push(input.path);
        return { toString: () => `webview:${input.path}` };
      },
    },
  };
}

function workspaceStyles(...paths: string[]) {
  return paths.map((configuredPath) => ({
    configuredPath,
    uri: uri(`/workspace/${configuredPath}`),
    canonicalPath: `/workspace/${configuredPath}`,
    identity: `/workspace/${configuredPath}`,
  }));
}

describe('configureVisualWebviewResources', () => {
  test('configures workspace-backed CSS, base href, scripts, and local roots', () => {
    const { webview, seen } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureVisualWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      documentUri: uri('/workspace/topic/current.dita') as never,
      folder: folder as never,
      contentStylesheets: workspaceStyles('css/brand.css', 'themes/print.css') as never,
      joinPath: joinPath as never,
    });

    expect(webview.options).toEqual({ enableScripts: true, localResourceRoots: [extensionUri, folder.uri] });
    expect(result.contentStyleUris).toEqual([
      'webview:/extension/media/content-theme.css',
      'webview:/workspace/css/brand.css',
      'webview:/workspace/themes/print.css',
    ]);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/editor.css');
    expect(result.baseHref).toBe('webview:/workspace/topic/');
    expect(result.scriptUris).toHaveLength(CANVAS_SCRIPT_FILES.length);
    expect(result.scriptUris[0]).toBe(`webview:/extension/media/${CANVAS_SCRIPT_FILES[0]}`);
    expect(result.scriptUris.at(-1)).toBe(`webview:/extension/media/${CANVAS_SCRIPT_FILES.at(-1)}`);
    expect(seen).toContain('/extension/media/editor.css');
  });

  test('skips the document-relative base href for non-file documents (git diff side)', () => {
    const { webview, seen } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureVisualWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      documentUri: uri('/workspace/topic/current.dita', 'git') as never,
      folder: folder as never,
      contentStylesheets: workspaceStyles('css/brand.css') as never,
      joinPath: joinPath as never,
    });

    expect(result.baseHref).toBe('');
    // asWebviewUri must never be handed the git:-scheme document path.
    expect(seen).not.toContain('/workspace/topic');
    expect(result.contentStyleUris).toEqual([
      'webview:/extension/media/content-theme.css',
      'webview:/workspace/css/brand.css',
    ]);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/editor.css');
  });

  test('still loads extension CSS and scripts without a workspace folder', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');

    const result = configureVisualWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      documentUri: uri('/loose/current.dita') as never,
      folder: undefined,
      contentStylesheets: [],
      joinPath: joinPath as never,
    });

    expect(webview.options).toEqual({ enableScripts: true, localResourceRoots: [extensionUri] });
    expect(result.contentStyleUris).toEqual(['webview:/extension/media/content-theme.css']);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/editor.css');
    expect(result.baseHref).toBe('');
    expect(result.scriptUris).toHaveLength(CANVAS_SCRIPT_FILES.length);
  });

  test('the provider re-resolves document-scoped settings and retargets all managed-file events', () => {
    const source = readFileSync(
      new URL('../src/host/visual-editor-provider.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("getConfiguration('ditaeditor.visual', document.uri)");
    expect(source).toContain("event.affectsConfiguration('ditaeditor.visual', document.uri)");
    expect(source).toContain('contentStylesheets: resolvedWorkspaceFiles.contentStylesheets');
    expect(source).toContain('requestStyleReload();');
    expect(source).toContain('retargetStyleWatcher();');
    expect(source).toContain('resolvedWorkspaceWatcherPattern(folder.uri.fsPath, authorStyleTarget.lexicalPath');
    expect(source).toContain('watcher.onDidChange(requestStyleReload)');
    expect(source).toContain('watcher.onDidCreate(requestStyleReload)');
    expect(source).toContain('watcher.onDidDelete(requestStyleReload)');
    expect(source).toContain('retargetTaxonomyWatcher();');
    expect(source).toContain('disposeTaxonomyWatcher();');
    expect(source).toContain('updateWorkspaceResourceWatchTarget({');
    expect(source).toContain('workspaceResourceWatcherSpecifications(');
    expect(source.indexOf('const earlyDispose = webviewPanel.onDidDispose')).toBeLessThan(
      source.indexOf('let resolvedWorkspaceFiles = await resolveWorkspaceFileConfiguration'),
    );
    expect(source).toContain('disposeStyleWatcher();');
  });
});
