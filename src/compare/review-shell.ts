// Pure Review Changes shell: mode controls, navigation, and the two renderer
// outputs. Keeping this free of vscode makes the UI contract headlessly testable.

export interface ReviewShellOptions {
  label: string;
  note: string;
  changeCount: number;
  inlineHtml: string;
  sideBySideHtml: string;
}

export type ReviewExportShellOptions = Omit<ReviewShellOptions, 'inlineHtml'>;

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
  const exportHtml = '<button type="button" class="redline-banner-btn" data-redline-action="exportHtml" data-redline-side-only hidden title="Save this rendered side-by-side comparison as a self-contained HTML file">Export HTML</button>';

  const modes = '<div class="redline-mode-toggle" role="group" aria-label="Review layout">'
    + '<button type="button" class="redline-banner-btn" data-redline-mode="inline" aria-pressed="true">Track Changes</button>'
    + '<button type="button" class="redline-banner-btn" data-redline-mode="side-by-side" aria-pressed="false">Side by side</button>'
    + '</div>';
  const navigation = '<div class="redline-change-nav" role="group" aria-label="Change navigation">'
    + `<button type="button" class="redline-banner-btn" data-redline-nav="previous" title="Previous change"${changeCount === 0 ? ' disabled aria-disabled="true"' : ''}>Previous</button>`
    + `<button type="button" class="redline-banner-btn" data-redline-nav="next" title="Next change"${changeCount === 0 ? ' disabled aria-disabled="true"' : ''}>Next</button>`
    + `<span class="redline-change-position" data-redline-position aria-live="polite">Change 0 of ${changeCount}</span>`
    + '</div>';
  const banner = `<div class="redline-banner"><span>${compared}</span>${noteHtml}${modes}${navigation}${exportHtml}${sourceDiff}`
    + `<span class="redline-banner-count">${count}</span></div>`;

  return banner
    + '<div class="redline-status" data-redline-status role="status" aria-live="polite"></div>'
    + `<section class="redline-review-view" data-redline-view="inline">${inlineHtml}</section>`
    + `<section class="redline-review-view" hidden data-redline-view="side-by-side">${sideBySideHtml}</section>`;
}

export function renderReviewExportShell(options: ReviewExportShellOptions): string {
  const compared = options.label
    ? `Comparing with <strong>${escapeHtml(options.label)}</strong>`
    : 'No version-control base available';
  const count = options.changeCount === 0
    ? 'No changes'
    : `${options.changeCount} change${options.changeCount === 1 ? '' : 's'}`;
  const note = options.note
    ? `<span class="redline-banner-note">${escapeHtml(options.note)}</span>`
    : '';
  return `<div class="redline-banner"><span>${compared}</span>${note}`
    + '<div class="redline-change-nav" role="group" aria-label="Change navigation">'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="previous">Previous</button>'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="next">Next</button>'
    + `<span class="redline-change-position" data-redline-position aria-live="polite">Change 0 of ${options.changeCount}</span></div>`
    + `<span class="redline-banner-count">${count}</span></div>`
    + `<section class="redline-review-view">${options.sideBySideHtml}</section>`;
}
