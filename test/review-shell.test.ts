import { describe, expect, test } from 'bun:test';
import { renderReviewExportShell, renderReviewShell } from '../src/compare/review-shell';

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
    expect(html).toContain('data-redline-action="exportHtml"');
    expect(html).toContain('Export HTML');
    expect(html).toContain('Side-by-side XML diff');
    expect(html).toContain('3 changes');
  });

  test('includes previous and next controls in both rendered layouts', () => {
    const html = renderReviewShell({
      label: '',
      note: 'No base',
      changeCount: 0,
      inlineHtml: '',
      sideBySideHtml: '',
    });

    expect(html).toContain('data-redline-nav="previous"');
    expect(html).toContain('data-redline-nav="next"');
    expect(html).toContain('role="group" aria-label="Change navigation"');
    expect(html).toContain('Change 0 of 0');
    expect(html).toContain('data-redline-status role="status"');
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

  test('renders a static side-by-side-only export shell', () => {
    const html = renderReviewExportShell({
      label: '<selected>',
      note: 'working copy',
      changeCount: 2,
      sideBySideHtml: '<div data-redline-comparison>comparison</div>',
    });

    expect(html).toContain('Comparing with <strong>&lt;selected&gt;</strong>');
    expect(html).toContain('working copy');
    expect(html).toContain('2 changes');
    expect(html).toContain('data-redline-comparison');
    expect(html).toContain('data-redline-nav="previous"');
    expect(html).toContain('data-redline-nav="next"');
    expect(html).not.toContain('data-redline-action');
    expect(html).not.toContain('data-redline-view');
  });
});
