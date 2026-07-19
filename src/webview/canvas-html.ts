// Pure builder for the canvas webview document. Kept free of any vscode
// dependency so it is unit-testable headlessly; the extension host wires in the
// real webview URIs, cspSource, and nonce.

import { serializeEmbeddedJson } from './embedded-json';

export interface CanvasHtmlOptions {
  /** Rendered topic body HTML (from src/render/to-html.ts). */
  bodyHtml: string;
  /** Legacy configured workspace sheets, after the structural stylesheet. */
  contentStyleUris: string[];
  /** Complete repository-owned author entry point, linked for relative imports. */
  authorStyleUri?: string;
  /** Temporary generated declarations used while a refreshed link is loading. */
  managedStyleCss: string;
  /** Ensures only the intended surface consumes the embedded source. */
  managedStyleConsumer: 'canvas' | 'redline';
  /** Surface-only stylesheet, deliberately after the managed live slot. */
  surfaceStyleUri: string;
  /** Webview URI (with trailing slash) of the topic's directory, so relative
   *  image `src="images/..."` resolve. Empty string when unavailable. */
  baseHref: string;
  /** webview.cspSource — the only origin allowed for local resources. */
  cspSource: string;
  /** Optional webview URI of the editing client script. */
  scriptUri?: string;
  /** Optional ordered webview URIs of editing client scripts. */
  scriptUris?: string[];
  /** Nonce that authorises scriptUri/scriptUris under CSP. */
  nonce?: string;
  /** Random id used to route native context commands back to this webview. */
  nativeContextSession?: string;
}

function contentSecurityPolicy(cspSource: string, nonce?: string): string {
  const scriptSrc = nonce ? `script-src 'nonce-${nonce}'` : `script-src 'none'`;
  return [
    `default-src 'none'`,
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} https: data:`,
    scriptSrc,
  ].join('; ');
}

export function buildCanvasHtml(options: CanvasHtmlOptions): string {
  const csp = contentSecurityPolicy(options.cspSource, options.nonce);
  const base = options.baseHref ? `<base href="${options.baseHref}">` : '';
  const contentLinks = options.contentStyleUris.map((uri, index) =>
    index === 0
      ? `<link rel="stylesheet" href="${uri}">`
      : `<link rel="stylesheet" href="${uri}" data-ditaeditor-style-origin="configured">`,
  ).join('\n  ');
  const authorLink = options.authorStyleUri
    ? `<link rel="stylesheet" href="${options.authorStyleUri}" data-ditaeditor-style-origin="author">`
    : '';
  const surfaceLink = `<link rel="stylesheet" href="${options.surfaceStyleUri}">`;
  const managedStyleData = serializeEmbeddedJson({
    consumer: options.managedStyleConsumer,
    cssText: options.managedStyleCss,
  });
  const dataNonce = options.nonce ? ` nonce="${options.nonce}"` : '';
  const scriptUris = options.scriptUris ?? (options.scriptUri ? [options.scriptUri] : []);
  const scripts =
    options.nonce
      ? scriptUris.map((uri) => `<script nonce="${options.nonce}" src="${uri}"></script>`).join('\n  ')
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${base}
  ${contentLinks}
  ${authorLink}
  <style id="ditaeditor-author-styles-live"></style>
  ${surfaceLink}
</head>
<body class="ditaeditor-canvas"${options.nativeContextSession ? ` data-vscode-context='${JSON.stringify({ ditaNativeSession: options.nativeContextSession })}'` : ''}>
  <main role="main">${options.bodyHtml}</main>
  <script id="ditaeditor-managed-style-data" type="application/json"${dataNonce}>${managedStyleData}</script>
  ${scripts}
</body>
</html>`;
}
