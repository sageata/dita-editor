import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildTopicSearchHtml } from '../src/webview/topic-search-html';

const options = {
  cspSource: 'vscode-resource://csp',
  nonce: 'testnonce123',
  scriptUri: 'vscode-resource://media/topic-search.js?v=topic-search-1',
  styleUri: 'vscode-resource://media/topic-search.css?v=topic-search-1',
};

describe('buildTopicSearchHtml', () => {
  test('locks down the CSP to styles, data-URI images (file icon), and the nonced script only', () => {
    const html = buildTopicSearchHtml(options);
    expect(html).toContain(
      `content="default-src 'none'; img-src data:; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}'"`,
    );
  });

  test('loads the script with the nonce and the stylesheet by URI', () => {
    const html = buildTopicSearchHtml(options);
    expect(html).toContain(`<script nonce="${options.nonce}" src="${options.scriptUri}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${options.styleUri}">`);
  });

  test('ships the static shell the client script binds to, with no inline handlers', () => {
    const html = buildTopicSearchHtml(options);
    for (const id of ['topic-search-input', 'topic-search-case', 'topic-search-status', 'topic-search-results']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(/ on[a-z]+=/i);
  });

  test('ships the replace UI: toggle chevron, hidden replace row, input, Replace All', () => {
    const html = buildTopicSearchHtml(options);
    for (const id of [
      'topic-search-toggle-replace',
      'topic-search-replace-row',
      'topic-search-replace-input',
      'topic-search-replace-all',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/id="topic-search-replace-row"[^>]*hidden/);
  });

  test('pins the search inputs in a sticky header wrapper', () => {
    const html = buildTopicSearchHtml(options);
    expect(html).toContain('class="search-header"');
  });
});

describe('pure-module boundaries', () => {
  test('search and topic-search webview modules never import vscode', () => {
    const files = [
      ...readdirSync(join(import.meta.dir, '..', 'src', 'search')).map((f) => join('src', 'search', f)),
      'src/webview/topic-search-html.ts',
      'src/webview/topic-search-messages.ts',
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      expect(source).not.toMatch(/from 'vscode'/);
      expect(source).not.toMatch(/import \* as vscode/);
    }
  });
});
