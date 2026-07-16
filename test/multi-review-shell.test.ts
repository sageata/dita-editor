import { describe, expect, test } from 'bun:test';
import { renderMultiReviewExportShell, renderMultiReviewShell } from '../src/compare/multi-review-shell';

describe('renderMultiReviewShell', () => {
  test('stacks every rendered DITA comparison under one commit banner', () => {
    const html = renderMultiReviewShell({
      title: '7e5fb47 - Convert tables (146 files)',
      files: [
        { name: 'one.dita', path: 'topics/one.dita', changeCount: 2, sideBySideHtml: '<div>one comparison</div>' },
        { name: 'two.dita', path: 'topics/two.dita', changeCount: 1, sideBySideHtml: '<div>two comparison</div>' },
      ],
      skippedFileCount: 4,
    });

    expect(html.match(/data-redline-file/g)?.length).toBe(2);
    expect(html).toContain('2 DITA files · 3 changes');
    expect(html).toContain('4 non-DITA files omitted');
    expect(html.match(/data-redline-nav="previous"/g)?.length).toBe(1);
    expect(html.match(/data-redline-nav="next"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Change navigation"');
    expect(html).toContain('data-redline-position');
    expect(html).toContain('data-redline-action="exportHtml"');
    expect(html).toContain('Export HTML');
    expect(html).toContain('data-redline-action="openSourceDiff"');
    expect(html).toContain('Side-by-side XML diff');
    expect(html).not.toContain('data-redline-side-only');
    expect(html).toContain('one comparison');
    expect(html).toContain('two comparison');
  });

  test('escapes commit and file labels while preserving trusted renderer HTML', () => {
    const html = renderMultiReviewShell({
      title: '<commit & unsafe>',
      files: [{
        name: '<topic>.dita',
        path: 'topics/<topic>.dita',
        changeCount: 0,
        sideBySideHtml: '<div data-rendered>trusted</div>',
      }],
      skippedFileCount: 0,
    });

    expect(html).toContain('&lt;commit &amp; unsafe&gt;');
    expect(html).toContain('&lt;topic&gt;.dita');
    expect(html).toContain('<div data-rendered>trusted</div>');
    expect(html).not.toContain('non-DITA');
  });

  test('renders a static multi-file export shell without VS Code controls', () => {
    const html = renderMultiReviewExportShell({
      title: 'Commit <title>',
      files: [{
        name: 'one.dita',
        path: 'topics/one.dita',
        changeCount: 1,
        sideBySideHtml: '<div data-rendered>comparison</div>',
      }],
      skippedFileCount: 2,
    });

    expect(html).toContain('Commit &lt;title&gt;');
    expect(html).toContain('1 DITA file · 1 change');
    expect(html).toContain('2 non-DITA files omitted');
    expect(html).toContain('data-redline-file');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-redline-nav');
  });
});
