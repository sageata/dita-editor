import {
  decodeManagedStyleSource,
  findMatchingManagedStyleDocuments,
  type ManagedStyleDocument,
  type ManagedStyleFiles,
  type ManagedStyleTarget,
} from './managed-style-persistence';
import {
  inspectManagedAuthorStylesheet,
  type ManagedStylesInspection,
} from './managed-author-stylesheet';
import type { AuthorStyleDefinition } from '../styles/author-styles';

export interface AuthorStyleSourceDependencies {
  files: Pick<ManagedStyleFiles, 'lstat' | 'readFile'>;
  listDocuments(): readonly ManagedStyleDocument[];
  resolveDocumentIdentity(fsPath: string): Promise<string>;
  platform: NodeJS.Platform;
  log(message: string): void;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function unavailableInspection(error: string): ManagedStylesInspection {
  const missing = inspectManagedAuthorStylesheet(null);
  return {
    ...missing,
    styles: [],
    renderCssText: '',
    writable: false,
    error,
  };
}

function dirtyInspection(source: string, dependencies: AuthorStyleSourceDependencies): ManagedStylesInspection {
  const inspection = inspectManagedAuthorStylesheet(source);
  const error = 'The managed author stylesheet is open with unsaved changes. Save or revert that document before changing styles.';
  dependencies.log(error);
  return {
    ...inspection,
    writable: false,
    error,
  };
}

function logInspectionRefusal(
  inspection: ManagedStylesInspection,
  dependencies: AuthorStyleSourceDependencies,
): ManagedStylesInspection {
  if (!inspection.writable && inspection.error) dependencies.log(inspection.error);
  return inspection;
}

export async function inspectAuthorStyleSource(
  target: ManagedStyleTarget | null,
  dependencies: AuthorStyleSourceDependencies,
): Promise<ManagedStylesInspection> {
  if (target === null) {
    return unavailableInspection('Styles cannot be changed because this document has no writable local workspace destination.');
  }

  let documents: ManagedStyleDocument[];
  try {
    documents = await findMatchingManagedStyleDocuments(target, dependencies);
  } catch (identityError) {
    const error = `Open managed stylesheet document identities could not be resolved safely: ${String(identityError)}`;
    dependencies.log(error);
    return unavailableInspection(error);
  }
  const dirtyDocuments = documents.filter((document) => document.dirty);
  if (dirtyDocuments.length > 0) {
    const source = dirtyDocuments[0].text;
    if (dirtyDocuments.some((document) => document.text !== source)) {
      const inspection = inspectManagedAuthorStylesheet(source);
      const error = 'Multiple dirty views disagree about the managed stylesheet. Save or revert the duplicate views before changing styles.';
      dependencies.log(error);
      return { ...inspection, writable: false, error };
    }
    return dirtyInspection(source, dependencies);
  }

  let stat: Awaited<ReturnType<AuthorStyleSourceDependencies['files']['lstat']>>;
  try {
    stat = await dependencies.files.lstat(target.canonicalPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return inspectManagedAuthorStylesheet(null);
    const message = `The managed author stylesheet could not be inspected: ${String(error)}`;
    dependencies.log(message);
    return unavailableInspection(message);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const error = 'The managed author stylesheet destination is not a regular non-symlink file.';
    dependencies.log(error);
    return unavailableInspection(error);
  }

  try {
    const source = decodeManagedStyleSource(await dependencies.files.readFile(target.canonicalPath));
    if (source === null) {
      const error = 'The managed author stylesheet contains invalid or lossy UTF-8 and cannot be changed safely.';
      dependencies.log(error);
      return unavailableInspection(error);
    }
    return logInspectionRefusal(inspectManagedAuthorStylesheet(source), dependencies);
  } catch (readError) {
    const error = `The managed author stylesheet could not be read: ${String(readError)}`;
    dependencies.log(error);
    return unavailableInspection(error);
  }
}

/** className -> human-readable style name, for friendly redline labels. */
export function authorStyleNames(styles: AuthorStyleDefinition[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const style of styles) names.set(style.className, style.name);
  return names;
}
