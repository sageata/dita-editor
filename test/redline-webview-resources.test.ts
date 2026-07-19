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
import {
  configureRedlineWebviewResources,
  rewriteRedlineImageSources,
} from '../src/host/webview-resources';
import { serializeAuthorStyles } from '../src/styles/author-styles';

interface TestUri {
  path: string;
  scheme: string;
  toString(): string;
}

function uri(path: string, scheme = 'file'): TestUri {
  return { path, scheme, toString: () => `${scheme}:${path}` };
}

function joinPath(base: TestUri, ...parts: string[]): TestUri {
  const segments = base.path.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..') segments.pop();
    else if (part !== '.') segments.push(part);
  }
  return uri('/' + segments.join('/'), base.scheme);
}

function makeWebview() {
  const seen: string[] = [];
  return {
    seen,
    webview: {
      options: {} as { enableScripts?: boolean; localResourceRoots?: TestUri[] },
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
  test('loads corpus sheets + redline.css (never editor.css) and only redline-review.js', () => {
    const { webview, seen } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      resourceUri: uri('/workspace/topic/current.dita') as never,
      folder: folder as never,
      contentStylesheets: workspaceStyles('css/brand.css', 'themes/print.css') as never,
      joinPath: joinPath as never,
    });

    expect(webview.options.enableScripts).toBe(true);
    expect((webview.options.localResourceRoots as TestUri[]).map((root) => root.path)).toEqual([
      '/extension',
      '/workspace',
      '/workspace/topic',
    ]);
    expect(result.contentStyleUris).toEqual([
      'webview:/extension/media/content-theme.css',
      'webview:/workspace/css/brand.css',
      'webview:/workspace/themes/print.css',
    ]);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/redline.css?v=navigation-4');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline-review.js?v=navigation-4']);
    expect(result.baseHref).toBe('webview:/workspace/topic/');
    expect(seen).not.toContain('/extension/media/editor.css');
  });

  test('skips the resource-relative base href for non-file resources', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    const result = configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      resourceUri: uri('/workspace/topic/current.dita', 'git') as never,
      folder: folder as never,
      contentStylesheets: workspaceStyles('css/brand.css') as never,
      joinPath: joinPath as never,
    });

    expect(result.baseHref).toBe('');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline-review.js?v=navigation-4']);
  });

  test('allows every mapped topic directory needed by a multi-file review', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');
    const folder = { uri: uri('/workspace') };

    configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      resourceUri: uri('/workspace/chapters/one/topic.dita') as never,
      additionalResourceUris: [
        uri('/workspace/chapters/two/topic.dita'),
        uri('/workspace/chapters/one/other.dita'),
      ] as never,
      folder: folder as never,
      contentStylesheets: [],
      joinPath: joinPath as never,
    });

    expect(webview.options.enableScripts).toBe(true);
    expect((webview.options.localResourceRoots as TestUri[]).map((root) => root.path)).toEqual([
      '/extension',
      '/workspace',
      '/workspace/chapters/one',
      '/workspace/chapters/two',
    ]);
  });

  test('uses a loose file resource as the image base even without a workspace folder', () => {
    const { webview } = makeWebview();
    const extensionUri = uri('/extension');

    const result = configureRedlineWebviewResources({
      webview: webview as never,
      extensionUri: extensionUri as never,
      resourceUri: uri('/loose/current.dita') as never,
      folder: undefined,
      contentStylesheets: [],
      joinPath: joinPath as never,
    });

    expect(webview.options.enableScripts).toBe(true);
    expect((webview.options.localResourceRoots as TestUri[]).map((root) => root.path)).toEqual([
      '/extension',
      '/loose',
    ]);
    expect(result.contentStyleUris).toEqual(['webview:/extension/media/content-theme.css']);
    expect(result.surfaceStyleUri).toBe('webview:/extension/media/redline.css?v=navigation-4');
    expect(result.scriptUris).toEqual(['webview:/extension/media/redline-review.js?v=navigation-4']);
    expect(result.baseHref).toBe('webview:/loose/');
  });

  test('redline tracks document-scoped configuration and edit/create/delete path changes', () => {
    const source = readFileSync(new URL('../src/host/redline-panel.ts', import.meta.url), 'utf8');
    const multiSource = readFileSync(new URL('../src/host/multi-redline-panel.ts', import.meta.url), 'utf8');
    expect(source).toContain("getConfiguration('ditaeditor.visual', selection.resource)");
    expect(source).toContain("event.affectsConfiguration('ditaeditor.visual', selection.resource)");
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
    expect(source).toContain('renderReviewDocuments(oldSource, newSource');
    expect(source).toContain('renderReviewShell({');
    expect(source).toContain('review content URI ${selection.document.toString(true)} uses local resource URI ${selection.resource.toString(true)}');
    expect(multiSource).toContain('review content URI ${selection.document.toString(true)} uses local resource URI ${selection.resource.toString(true)}');
    expect(multiSource).toContain('additionalResourceUris: selections.slice(1).map((selection) => selection.resource)');
    expect(multiSource).toContain("if (resource.scheme !== 'file') return file;");
    expect(multiSource).toContain('rewriteRedlineImageSources(file.sideBySideHtml');
    expect(multiSource).toContain('createManagedStyleDocumentRefreshHandler({');
    expect(multiSource).toContain('matchesManagedStyleDocumentTarget(');
    expect(multiSource).toContain('watcher.onDidChange(scheduleManagedStyleRefresh)');
    expect(multiSource).toContain('watcher.onDidCreate(scheduleManagedStyleRefresh)');
    expect(multiSource).toContain('watcher.onDidDelete(scheduleManagedStyleRefresh)');
    expect(multiSource).toContain('disposeManagedStyleWatcher(entry)');
    expect(multiSource).toContain('panel.webview.postMessage(managedStyles.message)');
    expect(multiSource).toContain("baseHref: '',");
  });
});

describe('rewriteRedlineImageSources', () => {
  test('resolves relative image sources per topic and leaves absolute sources intact', () => {
    const html = '<div><img src="assets/a.jpg?v=1&amp;x=2"><img src="../shared/b.png">'
      + '<img src="https://example.com/c.png"><img src="data:image/png;base64,AA"><img src="/root/d.png"></div>';

    const first = rewriteRedlineImageSources(html, (source) => `webview:/one/${source}`);
    const second = rewriteRedlineImageSources(html, (source) => `webview:/two/${source}`);

    expect(first).toContain('src="webview:/one/assets/a.jpg?v=1&amp;x=2"');
    expect(first).toContain('src="webview:/one/../shared/b.png"');
    expect(second).toContain('src="webview:/two/assets/a.jpg?v=1&amp;x=2"');
    expect(first).toContain('src="https://example.com/c.png"');
    expect(first).toContain('src="data:image/png;base64,AA"');
    expect(first).toContain('src="/root/d.png"');
    expect(rewriteRedlineImageSources('<img src="?v=1">', () => 'rewritten')).toContain('src="?v=1"');
  });
});

describe('redline managed stylesheet bridge', () => {
  test('uses one inspection for friendly labels, linked project CSS, and generated live declarations', () => {
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
    const stylesheetHref = `author.css?v=${inspection.sourceHash}`;
    const presentation = redlineManagedStylePresentation(inspection, stylesheetHref);
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
    expect(presentation.message).toEqual({
      type: 'managedStyles',
      cssText: managedBody,
      stylesheetHref,
    });
    expect(presentation.message.cssText).not.toContain('developer-owned prefix');
    expect(presentation.message.cssText).not.toContain('developer-owned-suffix');
  });
});
