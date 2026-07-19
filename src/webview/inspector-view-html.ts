// Pure builder for the Secondary Side Bar inspector view documents (Styles and
// Properties). No vscode dependency — the host wires in webview URIs,
// cspSource, and nonce (same contract as topic-search-html.ts). The shell is
// static: each view's client script renders everything into #inspector-root.

export interface InspectorViewHtmlOptions {
  /** webview.cspSource — the only origin allowed for local resources. */
  cspSource: string;
  /** Nonce that authorises the scripts under CSP. */
  nonce: string;
  /** Webview URIs of the view's media scripts, in load order (engine before
   *  bootstrap; revision query included). */
  scriptUris: string[];
  /** Webview URI of the view's media stylesheet (revision query included). */
  styleUri: string;
  /** Body class scoping the view's CSS, e.g. "ditaeditor-styles-view". */
  bodyClass: string;
  /** Accessible name for the view's root region. */
  ariaLabel: string;
}

export function buildInspectorViewHtml(options: InspectorViewHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `img-src data:`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${options.styleUri}">
</head>
<body class="${options.bodyClass}">
  <div id="inspector-root" role="region" aria-label="${options.ariaLabel}"></div>
  <div id="inspector-status" class="inspector-status" aria-live="polite"></div>
${options.scriptUris.map((uri) => `  <script nonce="${options.nonce}" src="${uri}"></script>`).join('\n')}
</body>
</html>`;
}
