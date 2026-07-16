import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildReviewExportHtml,
  ReviewExportSnapshotStore,
  saveReviewExport,
  type ReviewExportSnapshot,
} from '../src/compare/review-html-export';

function snapshot(overrides: Partial<ReviewExportSnapshot> = {}): ReviewExportSnapshot {
  return {
    title: 'Review <one>',
    defaultFilename: 'one-comparison.html',
    bodyHtml: '<div class="redline-banner"><button data-redline-action="exportHtml">Export</button></div>'
      + '<section data-redline-unchanged-group="u"><button data-redline-expand="u">2 unchanged</button>'
      + '<div hidden data-redline-unchanged-rows="u"><p>All content</p></div></section>'
      + '<script>throw new Error("must not export")</script>',
    stylesheets: [
      { cssText: ':root{--cascade:neutral}', baseUri: 'file:///extension/media/content-theme.css' },
      { cssText: 'p{color:brand}', baseUri: 'file:///workspace/css/brand.css' },
      { cssText: 'p{color:managed}', baseUri: 'file:///workspace/css/managed.css' },
      { cssText: 'p{color:redline}', baseUri: 'file:///extension/media/redline.css' },
    ],
    imageBaseUris: ['file:///workspace/topics/'],
    ...overrides,
  };
}

describe('buildReviewExportHtml', () => {
  test('creates static HTML in stylesheet order with all unchanged content expanded', async () => {
    const html = await buildReviewExportHtml(snapshot(), async (uri) => {
      throw new Error(`unexpected read: ${uri}`);
    });

    expect(html).toStartWith('<!DOCTYPE html>');
    expect(html).toContain('<title>Review &lt;one&gt;</title>');
    expect(html.indexOf('--cascade:neutral')).toBeLessThan(html.indexOf('color:brand'));
    expect(html.indexOf('color:brand')).toBeLessThan(html.indexOf('color:managed'));
    expect(html.indexOf('color:managed')).toBeLessThan(html.indexOf('color:redline'));
    expect(html).toContain('<p>All content</p>');
    expect(html).not.toContain(' hidden');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('data-redline-action');
  });

  test('recursively inlines imported CSS and every CSS image or font resource', async () => {
    const resources = new Map<string, { content: Uint8Array; mediaType?: string }>([
      ['file:///workspace/css/nested/print.css', {
        content: new TextEncoder().encode('@font-face{font-family:Review;src:url("../fonts/review.woff2") format("woff2")}'),
        mediaType: 'text/css',
      }],
      ['file:///workspace/css/fonts/review.woff2', {
        content: new Uint8Array([1, 2, 3]),
        mediaType: 'font/woff2',
      }],
      ['file:///workspace/images/mark.svg', {
        content: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        mediaType: 'image/svg+xml',
      }],
    ]);
    const seen: string[] = [];
    const html = await buildReviewExportHtml(snapshot({
      stylesheets: [{
        cssText: '@import "./nested/print.css" layer(review) supports((display: grid) and (color: red)) print;'
          + '.hero{background:url("../images/mark.svg")}',
        baseUri: 'file:///workspace/css/review.css',
      }],
    }), async (uri) => {
      seen.push(uri);
      const resource = resources.get(uri);
      if (!resource) throw new Error(`missing ${uri}`);
      return resource;
    });

    expect(seen).toEqual([
      'file:///workspace/css/nested/print.css',
      'file:///workspace/css/fonts/review.woff2',
      'file:///workspace/images/mark.svg',
    ]);
    expect(html).toContain('@layer review');
    expect(html).toContain('@supports ((display: grid) and (color: red))');
    expect(html).toContain('@media print');
    expect(html).toContain('data:font/woff2;base64,AQID');
    expect(html).toContain('data:image/svg+xml;base64,PHN2Zy');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('file:///');
  });

  test('resolves nested assets from the effective URL of a redirected HTTPS import', async () => {
    const seen: string[] = [];
    const html = await buildReviewExportHtml(snapshot({
      stylesheets: [{
        cssText: '@import "https://example.test/theme.css";',
        baseUri: 'https://example.test/root.css',
      }],
    }), async (uri) => {
      seen.push(uri);
      if (uri === 'https://example.test/theme.css') {
        return {
          content: new TextEncoder().encode('.logo{background:url("./mark.svg")}'),
          mediaType: 'text/css',
          resolvedUri: 'https://cdn.example.test/assets/theme.css',
        };
      }
      if (uri === 'https://cdn.example.test/assets/mark.svg') {
        return {
          content: new TextEncoder().encode('<svg/>'),
          mediaType: 'image/svg+xml',
        };
      }
      throw new Error(`unexpected read: ${uri}`);
    });

    expect(seen).toEqual([
      'https://example.test/theme.css',
      'https://cdn.example.test/assets/mark.svg',
    ]);
    expect(html).toContain('data:image/svg+xml;base64,PHN2Zy8+');
    expect(html).not.toContain('https://');
  });

  test('inlines rendered images relative to each topic in a multi-file review', async () => {
    const html = await buildReviewExportHtml(snapshot({
      bodyHtml: '<section data-redline-file><img src="images/diagram.svg"></section>'
        + '<section data-redline-file><img src="images/diagram.svg"><img src="data:image/png;base64,AA=="></section>',
      stylesheets: [],
      imageBaseUris: ['file:///workspace/one/', 'file:///workspace/two/'],
    }), async (uri) => ({
      content: new TextEncoder().encode(uri.includes('/one/') ? '<svg>one</svg>' : '<svg>two</svg>'),
      mediaType: 'image/svg+xml',
    }));

    expect(html.match(/src="data:image\/svg\+xml;base64,/g)?.length).toBe(2);
    expect(html).toContain(Buffer.from('<svg>one</svg>').toString('base64'));
    expect(html).toContain(Buffer.from('<svg>two</svg>').toString('base64'));
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).not.toContain('src="images/diagram.svg"');
  });
});

describe('saveReviewExport', () => {
  test('prompts with the latest successful snapshot name, then performs one complete write', async () => {
    const store = new ReviewExportSnapshotStore();
    store.replace(snapshot({ title: 'stale', defaultFilename: 'stale.html' }));
    store.replace(snapshot({ title: 'current', defaultFilename: 'current.html' }));
    const prompts: string[] = [];
    const writes: Array<{ destination: string; html: string }> = [];

    const result = await saveReviewExport(store, {
      chooseDestination: async (name) => {
        prompts.push(name);
        return 'file:///exports/current.html';
      },
      readResource: async (uri) => { throw new Error(`unexpected read: ${uri}`); },
      write: async (destination, html) => { writes.push({ destination, html }); },
      log: () => undefined,
      showError: async () => undefined,
    });

    expect(result).toBe('saved');
    expect(prompts).toEqual(['current.html']);
    expect(writes).toHaveLength(1);
    expect(writes[0].destination).toBe('file:///exports/current.html');
    expect(writes[0].html).toContain('<title>current</title>');
  });

  test('does not build or write when the Save dialog is cancelled', async () => {
    const store = new ReviewExportSnapshotStore();
    store.replace(snapshot());
    let reads = 0;
    let writes = 0;

    const result = await saveReviewExport(store, {
      chooseDestination: async () => undefined,
      readResource: async () => { reads += 1; return { content: new Uint8Array() }; },
      write: async () => { writes += 1; },
      log: () => undefined,
      showError: async () => undefined,
    });

    expect(result).toBe('cancelled');
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test('logs and shows the exact resource failure without writing a partial file', async () => {
    const store = new ReviewExportSnapshotStore();
    store.replace(snapshot({
      bodyHtml: '<img src="missing.svg">',
    }));
    const logs: string[] = [];
    const errors: string[] = [];
    let writes = 0;

    const result = await saveReviewExport(store, {
      chooseDestination: async () => 'file:///exports/review.html',
      readResource: async () => { throw new Error('missing.svg could not be read'); },
      write: async () => { writes += 1; },
      log: (message) => logs.push(message),
      showError: async (message) => { errors.push(message); },
    });

    expect(result).toBe('failed');
    expect(writes).toBe(0);
    expect(logs).toEqual(['DITA Editor: HTML comparison export failed: missing.svg could not be read']);
    expect(errors).toEqual(['DITA Editor: HTML export failed: missing.svg could not be read']);
  });
});

describe('review export host wiring', () => {
  test('single and multi panels replace snapshots only after assigning rendered HTML and handle export messages', () => {
    for (const relativePath of ['../src/host/redline-panel.ts', '../src/host/multi-redline-panel.ts']) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      const htmlAssignment = source.indexOf('.webview.html = buildCanvasHtml({');
      const snapshotReplace = source.indexOf('.exportSnapshots.replace({');
      expect(source, relativePath).toContain("message?.type === 'exportHtml'");
      expect(source, relativePath).toContain('saveReviewExport(');
      expect(source, relativePath).toContain('captureReviewExportStylesheets(');
      expect(htmlAssignment, relativePath).toBeGreaterThan(-1);
      expect(snapshotReplace, relativePath).toBeGreaterThan(htmlAssignment);
    }
  });

  test('canonicalizes file resources and refuses paths outside the allowed export roots', () => {
    const source = readFileSync(
      new URL('../src/host/review-html-export-host.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("import { realpath } from 'node:fs/promises'");
    expect(source).toContain('isCanonicalPathInside(root, target, process.platform)');
    expect(source).toContain('Export resource escapes the allowed workspace roots');
    expect(source).toContain('createReviewExportResourceReader(allowedFileRoots)');
  });
});
