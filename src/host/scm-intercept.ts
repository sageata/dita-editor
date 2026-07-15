// Pure predicate for redirecting Source-Control diff clicks on .dita files to the
// Review Changes panel. The `instanceof vscode.TabInputTextDiff` narrowing stays in
// extension.ts so this module remains headlessly testable.

export interface DiffTabShape {
  original: { scheme: string };
  modified: { scheme: string; fsPath: string };
}

export interface ReviewTargetShape {
  scheme: string;
  fsPath: string;
}

interface ReviewTargetDependencies<T extends ReviewTargetShape> {
  fileUri(fsPath: string): T;
  isInWorkspace(uri: T): boolean;
}

export interface ReviewSelection<T extends ReviewTargetShape> {
  /** The newer/right-hand document whose content Review renders. */
  document: T;
  /** An explicit older/left-hand document when Review was opened from a diff. */
  base: T | undefined;
  /** The real workspace file used only to resolve settings, CSS and images. */
  workspace: T;
}

export function reviewPairFromDiffTab<T extends ReviewTargetShape>(
  tab: { original: T; modified: T },
): { document: T; base: T } | undefined {
  if (!tab.original.fsPath.toLowerCase().endsWith('.dita')) return undefined;
  if (!tab.modified.fsPath.toLowerCase().endsWith('.dita')) return undefined;
  return { document: tab.modified, base: tab.original };
}

const REVISION_SCHEMES = new Set(['git', 'gitlens', 'vscode-local-history']);

/**
 * Keep selected revision documents intact so Review can compare the exact
 * left/right pair from a Graph diff. At the same time, derive the corresponding
 * real workspace file because document-scoped settings, local stylesheets and
 * relative images cannot be resolved from a virtual history URI.
 */
export function resolveReviewSelection<T extends ReviewTargetShape>(
  document: T,
  dependencies: ReviewTargetDependencies<T>,
  base?: T,
): ReviewSelection<T> {
  if (!REVISION_SCHEMES.has(document.scheme)) {
    return { document, base, workspace: document };
  }
  const workingCopy = dependencies.fileUri(document.fsPath);
  return {
    document,
    base,
    workspace: dependencies.isInWorkspace(workingCopy) ? workingCopy : document,
  };
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
