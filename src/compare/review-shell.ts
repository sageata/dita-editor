// Pure Review Changes shell: mode controls, navigation, and the two renderer
// outputs. Keeping this free of vscode makes the UI contract headlessly testable.

export interface ReviewShellOptions {
  label: string;
  note: string;
  changeCount: number;
  inlineHtml: string;
  sideBySideHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReviewShell(options: ReviewShellOptions): string {
  const { label, note, changeCount, inlineHtml, sideBySideHtml } = options;
  const compared = label
    ? `Comparing with <strong>${escapeHtml(label)}</strong>`
    : 'No version-control base available';
  const count = changeCount === 0
    ? 'No changes'
    : `${changeCount} change${changeCount === 1 ? '' : 's'}`;
  const noteHtml = note
    ? `<span class="redline-banner-note">${escapeHtml(note)}</span>`
    : '';
  const sourceDiff = label
    ? '<button type="button" class="redline-banner-btn" data-redline-action="openSourceDiff" title="Open the raw XML changes in the standard side-by-side diff">Side-by-side XML diff</button>'
    : '';

  const modes = '<div class="redline-mode-toggle" role="group" aria-label="Review layout">'
    + '<button type="button" class="redline-banner-btn" data-redline-mode="inline" aria-pressed="true">Track Changes</button>'
    + '<button type="button" class="redline-banner-btn" data-redline-mode="side-by-side" aria-pressed="false">Side by side</button>'
    + '</div>';
  const navigation = '<div class="redline-change-nav" data-redline-side-only hidden>'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="previous" title="Previous change">Previous</button>'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="next" title="Next change">Next</button>'
    + '</div>';
  const banner = `<div class="redline-banner"><span>${compared}</span>${noteHtml}${modes}${navigation}${sourceDiff}`
    + `<span class="redline-banner-count">${count}</span></div>`;

  return banner
    + `<section class="redline-review-view" data-redline-view="inline">${inlineHtml}</section>`
    + `<section class="redline-review-view" hidden data-redline-view="side-by-side">${sideBySideHtml}</section>`;
}
