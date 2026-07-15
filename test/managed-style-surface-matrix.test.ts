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

function embeddedPayload(cssText: string, consumer: 'canvas' | 'redline'): string {
  const html = buildCanvasHtml({
    bodyHtml: '<p>Matrix</p>',
    contentStyleUris: ['theme.css'],
    managedStyleCss: cssText,
    managedStyleConsumer: consumer,
    surfaceStyleUri: consumer === 'canvas' ? 'editor.css' : 'redline.css',
    baseHref: '',
    cspSource: 'vs',
    nonce: 'MATRIX',
  });
  const payload = html.match(/<script id="ditaeditor-managed-style-data"[^>]*>([^<]*)<\/script>/)?.[1];
  expect(payload).toBeString();
  return payload!;
}

function runCanvas(payload: string): { cssText: string; styleCount: number } {
  const source = readFileSync(new URL('../media/canvas-styles.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasStyles: {
      installStylesPanel(options: Record<string, unknown>): unknown;
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
  win.DitaEditorCanvasStyles.installStylesPanel({
    document,
    window: {
      innerWidth: 1200,
      addEventListener() { /* no-op */ },
      removeEventListener() { /* no-op */ },
    },
    vscode: {
      postMessage() { /* no-op */ },
      getState: () => undefined,
      setState() { /* no-op */ },
    },
    fontFamily: 'sans-serif',
    saveRequestSessionId: 'surface-matrix',
    getStyleState: () => ({ styles: [], cssText: '', writable: false }),
    getCurrentTarget: () => null,
    announceNav() { /* no-op */ },
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
    test(`${inspection.kind} source reaches canvas and redline exactly through the existing slot`, () => {
      if (inspection.kind === 'missing') {
        expect(inspection.renderCssText).toContain('DITAEDITOR_AUTHOR_STYLE');
      } else {
        expect(inspection.renderCssText).toBe(inspection.sourceText);
      }

      const canvas = runCanvas(embeddedPayload(inspection.renderCssText, 'canvas'));
      expect(canvas.cssText).toBe(inspection.renderCssText);
      expect(canvas.styleCount).toBe(1);

      const redline = runRedline(embeddedPayload(inspection.renderCssText, 'redline'));
      expect(redline.cssText).toBe(inspection.renderCssText);
      expect(redline.appended).toBe(0);
    });
  }
});
