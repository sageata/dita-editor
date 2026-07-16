// Pure shell for a Source Control Graph commit containing multiple DITA topics.
// Every comparison remains in normal document flow, so the entire commit uses
// one scrollbar and each Earlier/Newer pair stays vertically aligned.

export interface MultiReviewFile {
  name: string;
  path: string;
  changeCount: number;
  sideBySideHtml: string;
}

export interface MultiReviewShellOptions {
  title: string;
  files: MultiReviewFile[];
  skippedFileCount: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMultiReviewShell(options: MultiReviewShellOptions): string {
  const totalChanges = options.files.reduce((sum, file) => sum + file.changeCount, 0);
  const skipped = options.skippedFileCount > 0
    ? `<span class="redline-banner-note">${options.skippedFileCount} non-DITA file${options.skippedFileCount === 1 ? '' : 's'} omitted</span>`
    : '';
  const navigation = '<div class="redline-change-nav" role="group" aria-label="Change navigation">'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="previous" title="Previous change">Previous</button>'
    + '<button type="button" class="redline-banner-btn" data-redline-nav="next" title="Next change">Next</button>'
    + '<span class="redline-change-position" data-redline-position aria-live="polite"></span>'
    + '</div>';
  const exportHtml = '<button type="button" class="redline-banner-btn" data-redline-action="exportHtml" title="Save this rendered comparison as a self-contained HTML file">Export HTML</button>';
  const sourceDiff = '<button type="button" class="redline-banner-btn" data-redline-action="openSourceDiff" title="Show all raw XML changes in the native multi-file diff">Side-by-side XML diff</button>';
  const sections = options.files.map((file) => {
    const count = file.changeCount === 0
      ? 'No content changes'
      : `${file.changeCount} change${file.changeCount === 1 ? '' : 's'}`;
    return `<section class="redline-multi-file" data-redline-file>`
      + `<header class="redline-multi-file-header"><span><strong>${escapeHtml(file.name)}</strong>`
      + `<small>${escapeHtml(file.path)}</small></span><span>${count}</span></header>`
      + file.sideBySideHtml
      + '</section>';
  }).join('');
  return `<div class="redline-banner redline-multi-banner"><span><strong>${escapeHtml(options.title)}</strong></span>`
    + `${skipped}${navigation}${exportHtml}${sourceDiff}<span class="redline-banner-count">${options.files.length} DITA file${options.files.length === 1 ? '' : 's'} · ${totalChanges} change${totalChanges === 1 ? '' : 's'}</span></div>`
    + `<div class="redline-multi-files">${sections}</div>`;
}

export function renderMultiReviewExportShell(options: MultiReviewShellOptions): string {
  const totalChanges = options.files.reduce((sum, file) => sum + file.changeCount, 0);
  const skipped = options.skippedFileCount > 0
    ? `<span class="redline-banner-note">${options.skippedFileCount} non-DITA file${options.skippedFileCount === 1 ? '' : 's'} omitted</span>`
    : '';
  const sections = options.files.map((file) => {
    const count = file.changeCount === 0
      ? 'No content changes'
      : `${file.changeCount} change${file.changeCount === 1 ? '' : 's'}`;
    return `<section class="redline-multi-file" data-redline-file>`
      + `<header class="redline-multi-file-header"><span><strong>${escapeHtml(file.name)}</strong>`
      + `<small>${escapeHtml(file.path)}</small></span><span>${count}</span></header>`
      + file.sideBySideHtml
      + '</section>';
  }).join('');
  return `<div class="redline-banner redline-multi-banner"><span><strong>${escapeHtml(options.title)}</strong></span>`
    + `${skipped}<span class="redline-banner-count">${options.files.length} DITA file${options.files.length === 1 ? '' : 's'} · ${totalChanges} change${totalChanges === 1 ? '' : 's'}</span></div>`
    + `<div class="redline-multi-files">${sections}</div>`;
}
