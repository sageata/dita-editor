// Pure predicate for redirecting Source-Control diff clicks on .dita files to the
// Review Changes panel. The `instanceof vscode.TabInputTextDiff` narrowing stays in
// extension.ts so this module remains headlessly testable.

export interface DiffTabShape {
  original: { scheme: string };
  modified: { scheme: string; fsPath: string };
}

export function shouldInterceptScmDiff(tab: DiffTabShape): boolean {
  return (
    tab.original.scheme === 'git' &&
    tab.modified.scheme === 'file' &&
    tab.modified.fsPath.toLowerCase().endsWith('.dita')
  );
}

// ── Manual source-diff suppression ──────────────────────────────────────────
// The Review panel's "side-by-side XML diff" button opens the native git diff
// on purpose; without a mark the tab intercept above would immediately close
// it and bounce back to Review. A marked file's git-diff tabs are left alone
// until the user closes them (the unmark runs on tab close), so the choice
// sticks for that file while the diff stays open.

const manualSourceDiffs = new Set<string>();

/** The user explicitly asked for the raw git diff of this file: stop intercepting it. */
export function markManualSourceDiff(fsPath: string): void {
  manualSourceDiffs.add(fsPath.toLowerCase());
}

/** The raw git diff for this file was closed: SCM clicks open Review again. */
export function unmarkManualSourceDiff(fsPath: string): void {
  manualSourceDiffs.delete(fsPath.toLowerCase());
}

export function isManualSourceDiff(fsPath: string): boolean {
  return manualSourceDiffs.has(fsPath.toLowerCase());
}
