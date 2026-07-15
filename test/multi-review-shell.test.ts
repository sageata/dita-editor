import { describe, expect, test } from 'bun:test';
import { renderMultiReviewShell } from '../src/compare/multi-review-shell';

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
});
