import { describe, expect, test } from 'bun:test';
import { buildCanvasHtml } from '../src/webview/canvas-html';
import { CANVAS_SCRIPT_FILES } from '../src/webview/canvas-scripts';

describe('buildCanvasHtml', () => {
  const html = buildCanvasHtml({
    bodyHtml: '<article role="article"><h1 class="title topictitle1">T</h1></article>',
    contentStyleUris: [
      'https://x.vscode-cdn.net/media/content-theme.css',
      'https://x.vscode-cdn.net/css/workspace-base.css',
      'https://x.vscode-cdn.net/css/workspace-tokens.css',
    ],
    managedStyleCss: '.dc-managed { color: #123456; }',
    managedStyleConsumer: 'canvas',
    surfaceStyleUri: 'https://x.vscode-cdn.net/media/editor.css',
    baseHref: 'https://x.vscode-cdn.net/src/dita/topic/',
    cspSource: 'https://x.vscode-cdn.net',
    nonce: 'DATA123',
    taxonomy: { version: 1, fields: [{ attribute: 'owner', label: 'Owner', input: 'text' }] },
  });

  test('locks down CSP to local resources only', () => {
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain('img-src https://x.vscode-cdn.net https: data:');
    expect(html).toContain('Content-Security-Policy');
  });

  test('declares a light color-scheme so the brand canvas stays consistent under any VS Code theme', () => {
    expect(html).toContain('<meta name="color-scheme" content="light">');
  });

  test('loads the neutral theme, configured styles, live slot, and surface sheet in exact cascade order', () => {
    const neutral = html.indexOf('<link rel="stylesheet" href="https://x.vscode-cdn.net/media/content-theme.css">');
    const configuredOne = html.indexOf('<link rel="stylesheet" href="https://x.vscode-cdn.net/css/workspace-base.css" data-ditaeditor-style-origin="configured">');
    const configuredTwo = html.indexOf('<link rel="stylesheet" href="https://x.vscode-cdn.net/css/workspace-tokens.css" data-ditaeditor-style-origin="configured">');
    const live = html.indexOf('<style id="ditaeditor-author-styles-live"></style>');
    const surface = html.indexOf('<link rel="stylesheet" href="https://x.vscode-cdn.net/media/editor.css">');
    expect(neutral).toBeGreaterThan(-1);
    expect(neutral).toBeLessThan(configuredOne);
    expect(configuredOne).toBeLessThan(configuredTwo);
    expect(configuredTwo).toBeLessThan(live);
    expect(live).toBeLessThan(surface);
    expect(html).toContain('<script id="ditaeditor-managed-style-data" type="application/json" nonce="DATA123">');
    expect(html).toContain('"consumer":"canvas"');
    expect(html).toContain('"cssText":".dc-managed { color: #123456; }"');
  });

  test('sets base href so relative image paths resolve', () => {
    expect(html).toContain('<base href="https://x.vscode-cdn.net/src/dita/topic/">');
  });

  test('embeds the rendered body inside <main>', () => {
    expect(html).toContain('<main role="main"><article role="article"><h1 class="title topictitle1">T</h1></article></main>');
  });

  test('keeps executable scripts after main', () => {
    const data = html.indexOf('<script id="ditaeditor-managed-style-data"');
    const main = html.indexOf('<main role="main">');
    expect(main).toBeLessThan(data);
    expect(html).not.toContain(' src=');
  });

  test('embeds taxonomy as inert JSON after main and before executable scripts', () => {
    const taxonomy = html.indexOf('<script id="ditaeditor-taxonomy-data" type="application/json" nonce="DATA123">');
    const main = html.indexOf('<main role="main">');
    expect(taxonomy).toBeGreaterThan(main);
    const payload = html.match(/id="ditaeditor-taxonomy-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(JSON.parse(payload ?? 'null')).toEqual({
      version: 1,
      fields: [{ attribute: 'owner', label: 'Owner', input: 'text' }],
    });
  });

  test('escapes hostile taxonomy strings without creating executable markup', () => {
    const label = '</script><img onerror=marker>&\u2028\u2029';
    const hostile = buildCanvasHtml({
      bodyHtml: '<article></article>',
      contentStyleUris: ['theme.css'],
      managedStyleCss: '',
      managedStyleConsumer: 'canvas',
      surfaceStyleUri: 'editor.css',
      baseHref: '',
      cspSource: 'vscode-webview:',
      scriptUris: ['canvas.js'],
      nonce: 'nonce',
      taxonomy: {
        version: 1,
        fields: [{ attribute: 'owner', label, input: 'text' }],
      },
    });
    const payload = hostile.match(/id="ditaeditor-taxonomy-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(payload).not.toContain('</script');
    expect(payload).not.toContain('<img');
    expect(JSON.parse(payload).fields[0].label).toBe(label);
    expect(hostile.indexOf('ditaeditor-taxonomy-data')).toBeLessThan(hostile.indexOf('src="canvas.js"'));
  });

  test('embeds hostile managed CSS only as escaped, round-trippable JSON for both surfaces', () => {
    const cssText = '</ScRiPt><style id="owned">&\u2028\u2029 { color: red; }';
    for (const managedStyleConsumer of ['canvas', 'redline'] as const) {
      const hostile = buildCanvasHtml({
        bodyHtml: '<p>x</p>',
        contentStyleUris: ['theme.css'],
        managedStyleCss: cssText,
        managedStyleConsumer,
        surfaceStyleUri: managedStyleConsumer === 'canvas' ? 'editor.css' : 'redline.css',
        baseHref: '',
        cspSource: 'vs',
        nonce: 'SAFE',
      });
      expect(hostile).not.toContain(cssText);
      expect(hostile).not.toContain('<style id="owned">');
      const payload = hostile.match(/<script id="ditaeditor-managed-style-data"[^>]*>([^<]*)<\/script>/)?.[1];
      expect(payload).toBeString();
      expect(JSON.parse(payload!)).toEqual({ consumer: managedStyleConsumer, cssText });
    }
  });

  test('includes the editing script under a nonce when supplied', () => {
    const withScript = buildCanvasHtml({
      bodyHtml: '<p>x</p>',
      contentStyleUris: ['theme.css'],
      managedStyleCss: '',
      managedStyleConsumer: 'canvas',
      surfaceStyleUri: 'editor.css',
      baseHref: '',
      cspSource: 'vs',
      scriptUri: 'https://x.vscode-cdn.net/media/canvas.js',
      nonce: 'ABC123',
    });
    expect(withScript).toContain('<script nonce="ABC123" src="https://x.vscode-cdn.net/media/canvas.js"></script>');
    expect(withScript).toContain(`script-src 'nonce-ABC123'`);
    expect(withScript.indexOf('<main role="main">')).toBeLessThan(withScript.indexOf(' src="https://x.vscode-cdn.net/media/canvas.js"'));
  });

  test('loads multiple editing scripts in the requested order under the same nonce', () => {
    const scriptUris = CANVAS_SCRIPT_FILES.map((file) => `https://x.vscode-cdn.net/media/${file}`);
    const withScripts = buildCanvasHtml({
      bodyHtml: '<p>x</p>',
      contentStyleUris: ['theme.css'],
      managedStyleCss: '',
      managedStyleConsumer: 'canvas',
      surfaceStyleUri: 'editor.css',
      baseHref: '',
      cspSource: 'vs',
      scriptUris,
      nonce: 'XYZ789',
    });
    expect(withScripts).toContain(
      scriptUris.map((uri) => `<script nonce="XYZ789" src="${uri}"></script>`).join('\n  '),
    );
  });

  test('omits base href when unavailable', () => {
    const noBase = buildCanvasHtml({
      bodyHtml: '<p>x</p>',
      contentStyleUris: ['theme.css'],
      managedStyleCss: '',
      managedStyleConsumer: 'canvas',
      surfaceStyleUri: 'editor.css',
      baseHref: '',
      cspSource: 'vs',
    });
    expect(noBase).not.toContain('<base');
  });
});
