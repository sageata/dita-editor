import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderRedline } from '../src/compare/render-redline';
import { parse } from '../src/cst/parse';
import {
  inspectManagedAuthorStylesheet,
  MANAGED_STYLES_END,
  MANAGED_STYLES_START,
} from '../src/host/managed-author-stylesheet';
import { redlineManagedStylePresentation } from '../src/host/redline-managed-style-presentation';
import { configureRedlineWebviewResources } from '../src/host/webview-resources';
import { serializeAuthorStyles } from '../src/styles/author-styles';

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

describe('configureRedlineWebviewResources', () => {
  test('loads corpus sheets + redline.css (never editor.css) and only redline.js', () => {
    const { webview, seen } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureRedlineWebviewResources({
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
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/redline.css');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline.js']);
    expect(result.baseHref).toBe('webview:/workspace/topic/');
    expect(seen).not.toContain('/extension/media/editor.css');
  });

  test('skips the document-relative base href for non-file documents', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      documentUri: uri('/workspace/topic/current.dita', 'git') as never,
      folder: folder as never,
      contentStylesheets: workspaceStyles('css/brand.css') as never,
      joinPath: joinPath as never,
    });

    expect(result.baseHref).toBe('');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline.js']);
  });

  test('still loads redline.css without a workspace folder', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');

    const result = configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      documentUri: uri('/loose/current.dita') as never,
      folder: undefined,
      contentStylesheets: [],
      joinPath: joinPath as never,
    });

    expect(webview.options).toEqual({ enableScripts: true, localResourceRoots: [extensionUri] });
    expect(result.contentStyleUris).toEqual(['webview:/extension/media/content-theme.css']);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/redline.css');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline.js']);
    expect(result.baseHref).toBe('');
  });

  test('redline tracks document-scoped configuration and edit/create/delete path changes', () => {
    const source = readFileSync(new URL('../src/host/redline-panel.ts', import.meta.url), 'utf8');
    expect(source).toContain("getConfiguration('ditaeditor.visual', selection.workspace)");
    expect(source).toContain("event.affectsConfiguration('ditaeditor.visual', selection.workspace)");
    expect(source).toContain('retargetManagedStyleWatcher(context, selection, entry, debug, folder, target)');
    expect(source).toContain('watcher.onDidChange(refresh)');
    expect(source).toContain('watcher.onDidCreate(refresh)');
    expect(source).toContain('watcher.onDidDelete(refresh)');
    expect(source).toContain('disposeManagedStyleWatcher(created)');
    expect(source).toContain('retargetTaxonomyWatcher(');
    expect(source).toContain('settings.taxonomyFile');
    expect(source).toContain('updateWorkspaceResourceWatchTarget({');
    expect(source).toContain('workspaceResourceWatcherSpecifications(');
    expect(source).toContain('matchesManagedStyleDocumentTarget(');
    expect(source).toContain('created.refreshGeneration.dispose()');
  });
});

describe('redline managed stylesheet bridge', () => {
  test('uses one inspection for friendly labels and the exact complete CSS delivered by the live bridge', () => {
    const managedBody = serializeAuthorStyles([{
      className: 'review-accent',
      name: 'Review accent',
      target: 'body',
      color: '#123456',
    }]);
    const completeCss = [
      '/* developer-owned prefix */',
      ':root { --outside-managed-region: #abcdef; }',
      MANAGED_STYLES_START,
      managedBody + MANAGED_STYLES_END,
      '.developer-owned-suffix { outline: 2px solid; }',
      '',
    ].join('\n');
    const inspection = inspectManagedAuthorStylesheet(completeCss);
    const presentation = redlineManagedStylePresentation(inspection);
    const oldDocument = parse(
      '<topic id="t"><title>T</title><body><p>Same</p></body></topic>',
    );
    const newDocument = parse(
      '<topic id="t"><title>T</title><body><p outputclass="review-accent">Same</p></body></topic>',
    );
    const redline = renderRedline(oldDocument, newDocument, {
      styleNames: presentation.styleNames,
    });

    expect(redline.html).toContain(
      '<span class="redline-fmt-label">Formatting: Review accent applied</span>',
    );
    expect(presentation.message).toEqual({ type: 'managedStyles', cssText: completeCss });

    const source = readFileSync(new URL('../media/redline.js', import.meta.url), 'utf8');
    const postedMessages: unknown[] = [];
    const windowListeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    class FakeElement {
      id = '';
      textContent = '';
      getAttribute(): string | null { return null; }
      closest(): FakeElement | null { return null; }
    }
    const styles = new Map<string, FakeElement>();
    const liveStyle = new FakeElement();
    liveStyle.id = 'ditaeditor-author-styles-live';
    styles.set(liveStyle.id, liveStyle);
    const managedData = new FakeElement();
    managedData.id = 'ditaeditor-managed-style-data';
    managedData.textContent = JSON.stringify({ consumer: 'redline', cssText: completeCss });
    styles.set(managedData.id, managedData);
    const document = {
      head: {
        appendChild(style: FakeElement) {
          styles.set(style.id, style);
          return style;
        },
      },
      createElement() { return new FakeElement(); },
      getElementById(id: string) { return styles.get(id) ?? null; },
      addEventListener() { /* click behavior is outside this bridge test */ },
    };
    const window = {
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      },
      scrollTo() { /* no persisted position in this fixture */ },
      scrollY: 0,
    };
    const vscode = {
      getState: () => null,
      postMessage(message: unknown) { postedMessages.push(message); },
      setState() { /* scroll persistence is outside this bridge test */ },
    };
    new Function(
      'window',
      'document',
      'Element',
      'acquireVsCodeApi',
      'requestAnimationFrame',
      source,
    )(
      window,
      document,
      FakeElement,
      () => vscode,
      (callback: () => void) => callback(),
    );
    for (const listener of windowListeners.get('message') ?? []) {
      listener({ data: presentation.message });
    }

    expect(postedMessages).toEqual([{ type: 'redlineReady' }]);
    expect(document.getElementById('ditaeditor-author-styles-live')?.textContent).toBe(completeCss);
  });
});
