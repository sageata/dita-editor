import type { ManagedStylesInspection } from './managed-author-stylesheet';
import type { ManagedStyleTarget } from './managed-style-persistence';
import { canonicalIdentity } from './workspace-files';

export interface ManagedStyleIdentityDocument {
  uri: { scheme: string; fsPath: string };
}

export async function matchesManagedStyleDocumentTarget(
  document: ManagedStyleIdentityDocument,
  target: ManagedStyleTarget | null,
  files: { realpath(path: string): Promise<string> },
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (target === null || document.uri.scheme !== 'file') return false;
  const lexical = canonicalIdentity(document.uri.fsPath, platform);
  if (lexical === canonicalIdentity(target.lexicalPath, platform)) return true;
  return canonicalIdentity(await files.realpath(document.uri.fsPath), platform) === target.identity;
}

export interface ManagedStyleRefreshDependencies<T> {
  load(): Promise<T>;
  publish(value: T): void;
  log(message: string): void;
}

export interface ManagedStyleRefreshCoordinator<T> {
  /** Resolves true only when this request is still newest and was published. */
  refresh(): Promise<boolean>;
  /** Runs a one-off latest-wins load, used to reconcile direct save outcomes. */
  refreshWith(load: () => Promise<T>): Promise<boolean>;
  /** Event-callback adapter; failures are logged by refresh(). */
  request(): void;
  /** Monotonic generation used to detect a refresh that starts after publication. */
  generation(): number;
}

export interface ManagedStyleEventSubscription {
  dispose(): void;
}

type ManagedStyleEventSource<T> = (
  listener: (event: T) => void,
) => ManagedStyleEventSubscription;

export interface ManagedStyleRefreshEventSources<TDocument, TChangeEvent, TFileEvent> {
  file?: {
    onDidChange: ManagedStyleEventSource<TFileEvent>;
    onDidCreate: ManagedStyleEventSource<TFileEvent>;
    onDidDelete: ManagedStyleEventSource<TFileEvent>;
  };
  document: {
    onDidChange: ManagedStyleEventSource<TChangeEvent>;
    onDidOpen: ManagedStyleEventSource<TDocument>;
    onDidSave: ManagedStyleEventSource<TDocument>;
    onDidClose: ManagedStyleEventSource<TDocument>;
  };
}

export function createManagedStyleDocumentRefreshHandler<TDocument>(dependencies: {
  matches(document: TDocument): Promise<boolean>;
  request(): void;
  log(message: string): void;
}): (document: TDocument) => void {
  return (document): void => {
    void (async () => {
      try {
        if (await dependencies.matches(document)) dependencies.request();
      } catch (error) {
        dependencies.log(`Managed stylesheet document identity check failed: ${String(error)}`);
        // An unresolved local document may be an extension-agnostic alias of the
        // managed stylesheet. Re-run the complete inspector so it can surface a
        // safe non-writable state instead of leaving a stale writable snapshot.
        dependencies.request();
      }
    })();
  };
}

export function subscribeManagedStyleRefreshEvents<
  TDocument,
  TChangeEvent extends { document: TDocument },
  TFileEvent,
>(
  sources: ManagedStyleRefreshEventSources<TDocument, TChangeEvent, TFileEvent>,
  onFile: () => void,
  onDocument: (document: TDocument) => void,
): ManagedStyleEventSubscription[] {
  const subscriptions: ManagedStyleEventSubscription[] = [];
  if (sources.file) {
    subscriptions.push(
      sources.file.onDidChange(() => onFile()),
      sources.file.onDidCreate(() => onFile()),
      sources.file.onDidDelete(() => onFile()),
    );
  }
  subscriptions.push(
    sources.document.onDidChange((event) => onDocument(event.document)),
    sources.document.onDidOpen(onDocument),
    sources.document.onDidSave(onDocument),
    sources.document.onDidClose(onDocument),
  );
  return subscriptions;
}

export interface ManagedStyleRefreshSnapshot {
  target: ManagedStyleTarget | null;
  inspection: ManagedStylesInspection;
}

export function sameManagedStyleTarget(
  left: ManagedStyleTarget | null,
  right: ManagedStyleTarget | null,
): boolean {
  return left?.configuredPath === right?.configuredPath &&
    left?.uri === right?.uri &&
    left?.lexicalPath === right?.lexicalPath &&
    left?.canonicalPath === right?.canonicalPath &&
    left?.identity === right?.identity;
}

export function sameManagedStyleRefreshSnapshot(
  left: ManagedStyleRefreshSnapshot,
  right: ManagedStyleRefreshSnapshot,
): boolean {
  return sameManagedStyleTarget(left.target, right.target) &&
    left.inspection.kind === right.inspection.kind &&
    left.inspection.sourceHash === right.inspection.sourceHash &&
    left.inspection.renderCssText === right.inspection.renderCssText &&
    left.inspection.writable === right.inspection.writable &&
    left.inspection.error === right.inspection.error &&
    JSON.stringify(left.inspection.styles) === JSON.stringify(right.inspection.styles);
}

export async function reconcileManagedStyleSave(dependencies: {
  coordinator: ManagedStyleRefreshCoordinator<ManagedStyleRefreshSnapshot>;
  savedSnapshot: ManagedStyleRefreshSnapshot;
  loadCurrent(): Promise<ManagedStyleRefreshSnapshot>;
  getCurrent(): ManagedStyleRefreshSnapshot;
  changedError: string;
}): Promise<boolean> {
  const generationBefore = dependencies.coordinator.generation();
  let loadedSavedSnapshot = false;
  const published = await dependencies.coordinator.refreshWith(async () => {
    const current = await dependencies.loadCurrent();
    loadedSavedSnapshot = sameManagedStyleRefreshSnapshot(current, dependencies.savedSnapshot);
    if (loadedSavedSnapshot) return current;
    return {
      target: current.target,
      inspection: { ...current.inspection, error: dependencies.changedError },
    };
  });
  const reconciliationStayedLatest = dependencies.coordinator.generation() === generationBefore + 1;
  return published &&
    reconciliationStayedLatest &&
    loadedSavedSnapshot &&
    sameManagedStyleRefreshSnapshot(dependencies.getCurrent(), dependencies.savedSnapshot);
}

/**
 * Latest-wins asynchronous refresh seam. Every request gets a generation before
 * it starts loading, so a slower older inspection can never publish after a
 * newer event has begun.
 */
export function createManagedStyleRefreshCoordinator<T>(
  dependencies: ManagedStyleRefreshDependencies<T>,
): ManagedStyleRefreshCoordinator<T> {
  let generation = 0;

  const refreshWith = async (load: () => Promise<T>): Promise<boolean> => {
    const requestGeneration = ++generation;
    try {
      const value = await load();
      if (requestGeneration !== generation) return false;
      dependencies.publish(value);
      return true;
    } catch (error) {
      if (requestGeneration === generation) {
        dependencies.log(`Managed stylesheet refresh failed: ${String(error)}`);
      }
      return false;
    }
  };

  return {
    refresh: () => refreshWith(dependencies.load),
    refreshWith,
    request(): void {
      void refreshWith(dependencies.load);
    },
    generation(): number {
      return generation;
    },
  };
}
