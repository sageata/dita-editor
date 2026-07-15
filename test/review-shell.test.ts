import { describe, expect, test } from 'bun:test';
import { renderReviewShell } from '../src/compare/review-shell';

describe('renderReviewShell', () => {
  test('keeps Track Changes as the default and exposes side-by-side and XML modes', () => {
    const html = renderReviewShell({
      label: 'selected revision',
      note: '',
      changeCount: 3,
      inlineHtml: '<article>inline</article>',
      sideBySideHtml: '<div>paired</div>',
    });

    expect(html).toContain('data-redline-mode="inline" aria-pressed="true"');
    expect(html).toContain('data-redline-mode="side-by-side" aria-pressed="false"');
    expect(html).toContain('data-redline-view="inline"');
    expect(html).toContain('hidden data-redline-view="side-by-side"');
    expect(html).toContain('data-redline-action="openSourceDiff"');
    expect(html).toContain('Side-by-side XML diff');
    expect(html).toContain('3 changes');
  });

  test('includes side-by-side-only previous and next controls', () => {
    const html = renderReviewShell({
      label: '',
      note: 'No base',
      changeCount: 0,
      inlineHtml: '',
      sideBySideHtml: '',
    });

    expect(html).toContain('data-redline-nav="previous"');
    expect(html).toContain('data-redline-nav="next"');
    expect(html).toContain('data-redline-side-only');
    expect(html).toContain('No changes');
    expect(html).not.toContain('openSourceDiff');
  });

  test('escapes revision labels and notes', () => {
    const html = renderReviewShell({
      label: '<older & unsafe>',
      note: '"quoted"',
      changeCount: 1,
      inlineHtml: '<p>trusted renderer output</p>',
      sideBySideHtml: '',
    });

    expect(html).toContain('&lt;older &amp; unsafe&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('<older & unsafe>');
  });
});
