// Pure builder for the Search DITA Topics webview view document. Kept free of
// any vscode dependency so it is unit-testable headlessly; the extension host
// wires in the real webview URIs, cspSource, and nonce (same contract as
// canvas-html.ts).

export interface TopicSearchHtmlOptions {
  /** webview.cspSource — the only origin allowed for local resources. */
  cspSource: string;
  /** Nonce that authorises scriptUri under CSP. */
  nonce: string;
  /** Webview URI of media/topic-search.js (revision query included). */
  scriptUri: string;
  /** Webview URI of media/topic-search.css (revision query included). */
  styleUri: string;
}

export function buildTopicSearchHtml(options: TopicSearchHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    // data: images only — the stylesheet's inline file-icon SVG; no remote hosts.
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
<body class="ditaeditor-topic-search">
  <div class="search-header">
    <div class="search-header-inner">
      <button id="topic-search-toggle-replace" type="button" class="toggle-replace" title="Toggle Replace" aria-label="Toggle replace" aria-expanded="false">&#9656;</button>
      <div class="search-inputs">
        <div class="search-row" role="search" aria-label="Search DITA topics">
          <input id="topic-search-input" type="text" placeholder="Search" aria-label="Search DITA topics">
          <button id="topic-search-case" type="button" title="Match Case" aria-label="Match case" aria-pressed="false">Aa</button>
        </div>
        <div class="replace-row" id="topic-search-replace-row" hidden>
          <input id="topic-search-replace-input" type="text" placeholder="Replace" aria-label="Replace with">
          <button id="topic-search-replace-all" type="button" class="icon-button" title="Replace All" aria-label="Replace all"><span class="icon-mask icon-replace-all"></span></button>
        </div>
      </div>
    </div>
    <div id="topic-search-status" class="status" aria-live="polite"></div>
  </div>
  <div id="topic-search-results" class="results" role="tree" aria-label="Search results"></div>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
