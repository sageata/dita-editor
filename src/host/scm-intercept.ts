// Pure helpers for redirecting Source-Control diff clicks on .dita files to the
// Review Changes panel. The `instanceof vscode.TabInputTextDiff` narrowing stays in
// extension.ts so this module remains headlessly testable.

export interface ReviewTargetShape {
  scheme: string;
  fsPath: string;
}

export interface ReviewTargetIdentityShape extends ReviewTargetShape {
  toString(skipEncoding?: boolean): string;
}

export interface DiffTabShape<T extends ReviewTargetShape = ReviewTargetShape> {
  original: T;
  modified: T;
}

/**
 * Runtime shape of VS Code's aggregate multi-file diff tab. The corresponding
 * `TabInputTextMultiDiff` API is still proposed, so production extensions cannot
 * name the constructor without opting into an experimental API. VS Code still
 * exposes the input through `Tab.input` as `unknown`; keeping this structural
 * shape here lets us consume it without an experimental manifest dependency.
 */
export interface TextMultiDiffShape<T extends ReviewTargetShape = ReviewTargetShape> {
  readonly textDiffs: readonly DiffTabShape<T>[];
}

interface ReviewTargetDependencies<T extends ReviewTargetShape> {
  fileUri(fsPath: string): T;
  isInWorkspace(uri: T): boolean;
}

export type ReviewComparison<T extends ReviewTargetShape> =
  | {
      kind: 'working-copy';
      modified: T;
    }
  | {
      kind: 'historical';
      original: T;
      modified: T;
    };

export interface ReviewSelection<T extends ReviewTargetShape> {
  /** The newer/right-hand document whose content Review renders. */
  document: T;
  /** An explicit older/left-hand historical document. */
  base: T | undefined;
  /** The real workspace file used only to resolve settings, CSS and images. */
  workspace: T;
  /** Historical sources are immutable and never follow working-copy changes. */
  historical: boolean;
}

function isDita(target: ReviewTargetShape): boolean {
  return target.fsPath.toLowerCase().endsWith('.dita');
}

const REVISION_SCHEMES = new Set(['git', 'gitlens', 'vscode-local-history']);

/**
 * Preserve the exact left/right pair for a committed-history diff. A working-copy
 * diff deliberately keeps the existing Review behavior (working file vs resolved
 * repository base).
 */
export function reviewComparisonFromDiffTab<T extends ReviewTargetShape>(
  tab: DiffTabShape<T>,
): ReviewComparison<T> | undefined {
  if (!isDita(tab.original) || !isDita(tab.modified)) return undefined;
  if (REVISION_SCHEMES.has(tab.original.scheme) && REVISION_SCHEMES.has(tab.modified.scheme)) {
    return { kind: 'historical', original: tab.original, modified: tab.modified };
  }
  if (tab.original.scheme === 'git' && tab.modified.scheme === 'file') {
    return { kind: 'working-copy', modified: tab.modified };
  }
  return undefined;
}

export interface MultiDiffReviewComparisons<T extends ReviewTargetShape> {
  comparisons: ReviewComparison<T>[];
  totalTextDiffs: number;
}

function isReviewTargetShape(value: unknown): value is ReviewTargetShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReviewTargetShape>;
  return typeof candidate.scheme === 'string' && typeof candidate.fsPath === 'string';
}

/** Extract the exact historical pairs from a Source Control Graph commit tab. */
export function reviewComparisonsFromMultiDiff<T extends ReviewTargetShape>(
  input: unknown,
): MultiDiffReviewComparisons<T> | undefined {
  if (!input || typeof input !== 'object' || !('textDiffs' in input)) return undefined;
  const textDiffs = (input as { textDiffs?: unknown }).textDiffs;
  if (!Array.isArray(textDiffs)) return undefined;

  const comparisons: ReviewComparison<T>[] = [];
  for (const candidate of textDiffs) {
    if (!candidate || typeof candidate !== 'object') continue;
    const original = (candidate as { original?: unknown }).original;
    const modified = (candidate as { modified?: unknown }).modified;
    if (!isReviewTargetShape(original) || !isReviewTargetShape(modified)) continue;
    const comparison = reviewComparisonFromDiffTab({
      original: original as T,
      modified: modified as T,
    });
    if (comparison) comparisons.push(comparison);
  }
  return { comparisons, totalTextDiffs: textDiffs.length };
}

/**
 * Keep selected revision documents intact so Review can compare the exact
 * left/right pair from a Graph diff. At the same time, derive the corresponding
 * real workspace file because document-scoped settings, local stylesheets and
 * relative images cannot be resolved from a virtual history URI.
 */
export function resolveReviewSelection<T extends ReviewTargetShape>(
  comparison: ReviewComparison<T>,
  dependencies: ReviewTargetDependencies<T>,
): ReviewSelection<T> {
  if (comparison.kind === 'working-copy') {
    return {
      document: comparison.modified,
      base: undefined,
      workspace: comparison.modified,
      historical: false,
    };
  }

  const workingCopy = dependencies.fileUri(comparison.modified.fsPath);
  return {
    document: comparison.modified,
    base: comparison.original,
    workspace: dependencies.isInWorkspace(workingCopy) ? workingCopy : comparison.modified,
    historical: true,
  };
}

export function shouldInterceptScmDiff(tab: DiffTabShape): boolean {
  return (
    tab.original.scheme === 'git' &&
    (tab.modified.scheme === 'file' || tab.modified.scheme === 'git') &&
    isDita(tab.original) &&
    isDita(tab.modified)
  );
}

/** Keep the native diff as fallback until the rendered Review is fully ready. */
export async function renderReviewBeforeClosingNative(
  openReview: () => PromiseLike<void>,
  closeNative: () => PromiseLike<boolean>,
): Promise<boolean> {
  await openReview();
  return closeNative();
}

// -- Manual source-diff suppression ------------------------------------------
// The Review panel's "Side-by-side XML diff" button opens a native diff on
// purpose. Historical suppressions are keyed by the complete original/modified
// URI strings, so another revision pair for the same path is never suppressed.
// For git -> file, git.openChange owns the original URI; a one-shot request is
// promoted to the exact pair as soon as VS Code opens that diff.

type SourceDiffShape = DiffTabShape<ReviewTargetIdentityShape>;

const manualSourceDiffs = new Set<string>();
const pendingWorkingCopyDiffs = new Set<string>();

function uriIdentity(uri: ReviewTargetIdentityShape): string {
  return uri.toString(true);
}

export function sourceDiffIdentity(diff: SourceDiffShape): string {
  return `${uriIdentity(diff.original)}\u0000${uriIdentity(diff.modified)}`;
}

export function reviewComparisonIdentity(
  comparison: ReviewComparison<ReviewTargetIdentityShape>,
): string {
  return comparison.kind === 'historical'
    ? `historical\u0000${sourceDiffIdentity(comparison)}`
    : `working-copy\u0000${uriIdentity(comparison.modified)}`;
}

export function markManualSourceDiff(diff: SourceDiffShape): void {
  manualSourceDiffs.add(sourceDiffIdentity(diff));
}

export function unmarkManualSourceDiff(diff: SourceDiffShape): void {
  manualSourceDiffs.delete(sourceDiffIdentity(diff));
}

export function markNextManualWorkingCopyDiff(modified: ReviewTargetIdentityShape): void {
  pendingWorkingCopyDiffs.add(uriIdentity(modified));
}

export function clearNextManualWorkingCopyDiff(modified: ReviewTargetIdentityShape): void {
  pendingWorkingCopyDiffs.delete(uriIdentity(modified));
}

export function isManualSourceDiff(diff: SourceDiffShape): boolean {
  const exact = sourceDiffIdentity(diff);
  if (manualSourceDiffs.has(exact)) return true;
  if (diff.original.scheme !== 'git' || diff.modified.scheme !== 'file') return false;

  const modified = uriIdentity(diff.modified);
  if (!pendingWorkingCopyDiffs.delete(modified)) return false;
  manualSourceDiffs.add(exact);
  return true;
}
