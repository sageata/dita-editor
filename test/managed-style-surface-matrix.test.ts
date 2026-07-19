import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  inspectManagedAuthorStylesheet,
  MANAGED_STYLES_END,
  MANAGED_STYLES_START,
} from '../src/host/managed-author-stylesheet';
import { serializeAuthorStyles, type AuthorStyleDefinition } from '../src/styles/author-styles';
import { buildCanvasHtml } from '../src/webview/canvas-html';
import { TestDocument } from './canvas-test-dom';

const CUSTOM_STYLE: AuthorStyleDefinition = {
  className: 'dc-surface-matrix',
  name: 'Surface matrix',
  target: 'body',
  color: '#123456',
};

function inspections() {
  const body = serializeAuthorStyles([CUSTOM_STYLE]);
  return [
    inspectManagedAuthorStylesheet(null),
    inspectManagedAuthorStylesheet(
      `\ufeff/* prefix */\r\n${MANAGED_STYLES_START}\r\n${body}${MANAGED_STYLES_END}\r\n/* suffix */\r\n`,
    ),
    inspectManagedAuthorStylesheet(body),
    inspectManagedAuthorStylesheet('/* developer prefix */\n.x { color: red; }\n/* developer suffix */\n'),
  ];
}

function surfaceHtml(
  consumer: 'canvas' | 'redline',
  authorStyleUri?: string,
): { html: string; payload: string } {
  const html = buildCanvasHtml({
    bodyHtml: '<p>Matrix</p>',
    contentStyleUris: ['theme.css'],
    authorStyleUri,
    managedStyleCss: '',
    managedStyleConsumer: consumer,
    surfaceStyleUri: consumer === 'canvas' ? 'editor.css' : 'redline.css',
    baseHref: '',
    cspSource: 'vs',
    nonce: 'MATRIX',
  });
  const payload = html.match(/<script id="ditaeditor-managed-style-data"[^>]*>([^<]*)<\/script>/)?.[1];
  expect(payload).toBeString();
  return { html, payload: payload! };
}

function runCanvas(payload: string): { cssText: string; styleCount: number } {
  const source = readFileSync(new URL('../media/canvas-style-bridge.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasStyleBridge: {
      installStyleBridge(options: Record<string, unknown>): unknown;
    };
  };
  const document = new TestDocument();
  const liveStyle = document.createElement('style');
  liveStyle.id = 'ditaeditor-author-styles-live';
  document.body.appendChild(liveStyle);
  const data = document.createElement('script');
  data.id = 'ditaeditor-managed-style-data';
  data.textContent = payload;
  document.body.appendChild(data);
  new Function('window', source)(win);
  win.DitaEditorCanvasStyleBridge.installStyleBridge({
    document,
    window: {},
    vscode: {
      postMessage() { /* no-op */ },
    },
    getStyleState: () => ({ styles: [], cssText: '', writable: false }),
    getCurrentTarget: () => null,
    getStructVersion: () => 0,
  });
  return {
    cssText: liveStyle.textContent,
    styleCount: document.body.querySelectorAll('style').length,
  };
}

function runRedline(payload: string): { cssText: string; appended: number } {
  const source = readFileSync(new URL('../media/redline-review.js', import.meta.url), 'utf8');
  const liveStyle = { textContent: '' };
  const data = { textContent: payload };
  let appended = 0;
  const document = {
    getElementById(id: string) {
      if (id === 'ditaeditor-author-styles-live') return liveStyle;
      if (id === 'ditaeditor-managed-style-data') return data;
      return null;
    },
    head: { appendChild() { appended++; } },
    createElement() { appended++; return {}; },
    addEventListener() { /* no-op */ },
  };
  const window = {
    scrollY: 0,
    scrollTo() { /* no-op */ },
    addEventListener() { /* no-op */ },
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
    class {},
    () => ({ getState: () => null, postMessage() { /* no-op */ }, setState() { /* no-op */ } }),
    (callback: () => void) => callback(),
  );
  return { cssText: liveStyle.textContent, appended };
}

describe('managed stylesheet surface matrix', () => {
  for (const inspection of inspections()) {
    test(`${inspection.kind} source uses the linked author stylesheet contract in canvas and redline`, () => {
      expect(inspection.renderCssText).toBe(
        inspection.kind === 'missing' ? '' : inspection.sourceText,
      );
      const href = inspection.kind === 'missing'
        ? undefined
        : `author.css?v=${inspection.sourceHash}`;

      for (const consumer of ['canvas', 'redline'] as const) {
        const surface = surfaceHtml(consumer, href);
        if (href) {
          expect(surface.html).toContain(
            `<link rel="stylesheet" href="${href}" data-ditaeditor-style-origin="author">`,
          );
        } else {
          expect(surface.html).not.toContain('data-ditaeditor-style-origin="author"');
        }
        expect(surface.html).not.toContain(inspection.sourceText || 'DITAEDITOR_AUTHOR_STYLE');

        if (consumer === 'canvas') {
          const canvas = runCanvas(surface.payload);
          expect(canvas.cssText).toBe('');
          expect(canvas.styleCount).toBe(1);
        } else {
          const redline = runRedline(surface.payload);
          expect(redline.cssText).toBe('');
          expect(redline.appended).toBe(0);
        }
      }
    });
  }
});
