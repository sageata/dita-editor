import type { ReviewSelection, ReviewTargetShape } from './scm-intercept';

export interface ReviewSourceDependencies<T extends ReviewTargetShape, B extends { label: string }> {
  openTextDocument(uri: T): PromiseLike<{ getText(): string }>;
  resolveBaseRevision(fsPath: string): PromiseLike<B | 'not-in-git'>;
  readFileAtRevision(base: B): PromiseLike<string | null>;
}

export interface ReviewSourceResult<R> {
  label: string;
  note: string;
  rendered: R;
}

export function shouldRefreshReviewContent<T extends ReviewTargetShape>(
  selection: ReviewSelection<T>,
  changedDocument: T,
  identity: (target: T) => string,
): boolean {
  return !selection.historical && identity(changedDocument) === identity(selection.document);
}

/**
 * Load the two sources selected for Review and pass those exact strings to the
 * renderer. Historical comparisons never consult the working file or resolve a
 * repository base; working-copy comparisons retain the existing base resolution.
 */
export async function renderReviewSources<T extends ReviewTargetShape, B extends { label: string }, R>(
  selection: ReviewSelection<T>,
  dependencies: ReviewSourceDependencies<T, B>,
  render: (oldSource: string, newSource: string) => R,
): Promise<ReviewSourceResult<R>> {
  const newDocument = await dependencies.openTextDocument(selection.document);
  const newSource = newDocument.getText();

  let label = '';
  let note = '';
  let oldSource = '';
  if (selection.base) {
    const baseDocument = await dependencies.openTextDocument(selection.base);
    oldSource = baseDocument.getText();
    label = 'the selected earlier revision';
  } else {
    const base = await dependencies.resolveBaseRevision(selection.workspace.fsPath);
    if (base === 'not-in-git') {
      note = 'This file is not under version control — the whole topic shows as new.';
    } else {
      label = base.label;
      const atBase = await dependencies.readFileAtRevision(base);
      if (atBase === null) {
        note = `New topic — it does not exist in ${base.label}.`;
      } else {
        oldSource = atBase;
      }
    }
  }

  return { label, note, rendered: render(oldSource, newSource) };
}
