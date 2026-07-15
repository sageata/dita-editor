import { describe, expect, test } from 'bun:test';
import { renderReviewDocuments } from '../src/compare/render-review';

describe('renderReviewDocuments', () => {
  test('feeds the same exact historical strings to both layouts', () => {
    const oldSource = '<topic id="t"><title>T</title><body><p>Earlier exact text</p></body></topic>';
    const newSource = '<topic id="t"><title>T</title><body><p>Newer exact text</p></body></topic>';
    const rendered = renderReviewDocuments(oldSource, newSource);

    expect(rendered.inline.html).toContain('<del class="redline">Earlier</del>');
    expect(rendered.inline.html).toContain('<ins class="redline">Newer</ins>');
    expect(rendered.sideBySide.html).toContain('Earlier exact text');
    expect(rendered.sideBySide.html).toContain('Newer exact text');
    expect(rendered.inline.changeCount).toBe(1);
  });

  test('namespaces side-by-side controls when many topics share one webview', () => {
    const oldSource = '<topic id="t"><title>T</title><body><p>Same</p><p>Old</p></body></topic>';
    const newSource = '<topic id="t"><title>T</title><body><p>Same</p><p>New</p></body></topic>';
    const rendered = renderReviewDocuments(oldSource, newSource, { idPrefix: 'file-7-' });

    expect(rendered.sideBySide.html).toContain('id="file-7-comparison-row-');
    expect(rendered.sideBySide.html).toContain('data-redline-expand="file-7-unchanged-');
    expect(rendered.sideBySide.html).not.toContain('data-redline-expand="unchanged-');
  });
});
