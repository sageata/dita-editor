import type { TaxonomyConfig } from '../config/taxonomy';

export interface TaxonomyResourceIdentity {
  configuredPath: string;
  identity: string;
  uri: string;
}

export function sameTaxonomyResource(
  left: TaxonomyResourceIdentity | null,
  right: TaxonomyResourceIdentity | null,
): boolean {
  return left?.configuredPath === right?.configuredPath &&
    left?.identity === right?.identity &&
    left?.uri === right?.uri;
}

/** Read first, then re-resolve the exact canonical target before returning any
 * bytes. This closes a path-swap/symlink race between Task 3 resolution and IO. */
export async function readRevalidatedTaxonomyResource(params: {
  resolved: TaxonomyResourceIdentity;
  read(): Promise<Uint8Array>;
  reResolve(): Promise<TaxonomyResourceIdentity | null>;
}): Promise<Uint8Array> {
  const bytes = await params.read();
  const current = await params.reResolve();
  if (!sameTaxonomyResource(params.resolved, current)) {
    throw new Error('resolved taxonomy target changed during read.');
  }
  return bytes;
}

export interface TaxonomyStateCoordinator {
  refresh(request: {
    identity: string;
    load(log: (message: string) => void): Promise<TaxonomyConfig | null>;
  }): Promise<boolean>;
  /** Cancel older async work without clearing the currently rendered schema. */
  supersede(): void;
  invalidate(identity: string | null): void;
  current(): TaxonomyConfig | null;
  generation(): number;
  dispose(): void;
}

function sameTaxonomy(left: TaxonomyConfig | null, right: TaxonomyConfig | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createTaxonomyStateCoordinator(dependencies: {
  publish(taxonomy: TaxonomyConfig | null): void;
  log(message: string): void;
}): TaxonomyStateCoordinator {
  let generation = 0;
  let identity: string | null = null;
  let taxonomy: TaxonomyConfig | null = null;
  let disposed = false;

  const publish = (next: TaxonomyConfig | null): void => {
    if (sameTaxonomy(taxonomy, next)) return;
    taxonomy = next;
    dependencies.publish(next);
  };

  const invalidate = (nextIdentity: string | null): void => {
    if (disposed) return;
    generation++;
    identity = nextIdentity;
    publish(null);
  };

  return {
    async refresh(request): Promise<boolean> {
      if (disposed) return false;
      const requestGeneration = ++generation;
      if (request.identity !== identity) {
        identity = request.identity;
        publish(null);
      }
      const pendingLogs: string[] = [];
      let value: TaxonomyConfig | null;
      try {
        value = await request.load((message) => pendingLogs.push(message));
      } catch (error) {
        pendingLogs.push(`[taxonomy] load failed: ${String(error)}`);
        value = null;
      }
      if (disposed || requestGeneration !== generation || request.identity !== identity) return false;
      for (const message of pendingLogs) dependencies.log(message);
      publish(value);
      return true;
    },
    supersede(): void {
      if (!disposed) generation++;
    },
    invalidate,
    current: () => taxonomy,
    generation: () => generation,
    dispose(): void {
      if (disposed) return;
      invalidate(null);
      disposed = true;
      generation++;
    },
  };
}
