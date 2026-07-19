// The inspector view shells (Styles, Properties) follow the topic-search view
// contract: strict CSP, nonced script only, no inline handlers, and the pure
// builder plus the protocol module never import vscode.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInspectorViewHtml } from '../src/webview/inspector-view-html';

const options = {
  cspSource: 'webview-csp-source',
  nonce: 'test-nonce-123',
  scriptUris: [
    'webview:/media/styles-panel.js?v=inspector-views-1',
    'webview:/media/styles-view.js?v=inspector-views-1',
  ],
  styleUri: 'webview:/media/styles-view.css?v=inspector-views-1',
  bodyClass: 'ditaeditor-styles-view',
  ariaLabel: 'DITA styles',
};

describe('inspector-view-html', () => {
  test('emits the exact locked-down CSP', () => {
    const html = buildInspectorViewHtml(options);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
        `img-src data:; style-src webview-csp-source 'unsafe-inline'; ` +
        `script-src 'nonce-test-nonce-123'">`,
    );
  });

  test('loads only the nonced view scripts, engine first, and the linked stylesheet', () => {
    const html = buildInspectorViewHtml(options);
    const engineAt = html.indexOf('<script nonce="test-nonce-123" src="webview:/media/styles-panel.js?v=inspector-views-1"></script>');
    const bootstrapAt = html.indexOf('<script nonce="test-nonce-123" src="webview:/media/styles-view.js?v=inspector-views-1"></script>');
    expect(engineAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(engineAt);
    expect(html).toContain('<link rel="stylesheet" href="webview:/media/styles-view.css?v=inspector-views-1">');
    expect(html).not.toMatch(/ on[a-z]+=/i);
  });

  test('scopes the body class and exposes labelled root and live-status slots', () => {
    const html = buildInspectorViewHtml(options);
    expect(html).toContain('<body class="ditaeditor-styles-view">');
    expect(html).toContain('<div id="inspector-root" role="region" aria-label="DITA styles"></div>');
    expect(html).toContain('aria-live="polite"');
  });

  test('pure module boundary: builder, messages, and hub never import vscode', () => {
    for (const rel of [
      'src/webview/inspector-view-html.ts',
      'src/webview/inspector-view-messages.ts',
      'src/host/inspector-hub.ts',
    ]) {
      const source = readFileSync(join(import.meta.dir, '..', rel), 'utf8');
      expect(source, `${rel} must stay vscode-free`).not.toMatch(/from 'vscode'|require\('vscode'\)/);
    }
  });
});
