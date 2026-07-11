import { describe, expect, test } from 'bun:test';
import {
  createTaxonomyStateCoordinator,
  readRevalidatedTaxonomyResource,
} from '../src/host/taxonomy-state';
import type { TaxonomyConfig } from '../src/config/taxonomy';

const A: TaxonomyConfig = {
  version: 1,
  fields: [{ attribute: 'a', label: 'A', input: 'text' }],
};
const B: TaxonomyConfig = {
  version: 1,
  fields: [{ attribute: 'b', label: 'B', input: 'text' }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('taxonomy state coordinator', () => {
  test('publishes only the newest resource when A and B finish in reverse order', async () => {
    const a = deferred<TaxonomyConfig | null>();
    const b = deferred<TaxonomyConfig | null>();
    const published: Array<TaxonomyConfig | null> = [];
    const logs: string[] = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: (message) => logs.push(message),
    });
    const loadA = coordinator.refresh({ identity: 'A', load: async () => a.promise });
    const loadB = coordinator.refresh({ identity: 'B', load: async () => b.promise });
    b.resolve(B);
    expect(await loadB).toBe(true);
    a.resolve(A);
    expect(await loadA).toBe(false);
    expect(published).toEqual([B]);
    expect(logs).toEqual([]);
  });

  test('clears immediately on path change, disable, trust loss, and disposal', async () => {
    const published: Array<TaxonomyConfig | null> = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: () => undefined,
    });
    await coordinator.refresh({ identity: 'A', load: async () => A });
    const late = deferred<TaxonomyConfig | null>();
    const loading = coordinator.refresh({ identity: 'B', load: async () => late.promise });
    expect(published).toEqual([A, null]);
    coordinator.invalidate(null);
    late.resolve(B);
    expect(await loading).toBe(false);
    coordinator.dispose();
    expect(await coordinator.refresh({ identity: 'C', load: async () => B })).toBe(false);
    expect(coordinator.current()).toBeNull();
  });

  test('same-resource invalid results clear old state and current logs only once', async () => {
    const published: Array<TaxonomyConfig | null> = [];
    const logs: string[] = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: (message) => logs.push(message),
    });
    await coordinator.refresh({ identity: 'A', load: async () => A });
    await coordinator.refresh({
      identity: 'A',
      load: async (log) => {
        log('[taxonomy] a.json: invalid');
        return null;
      },
    });
    expect(published).toEqual([A, null]);
    expect(logs).toEqual(['[taxonomy] a.json: invalid']);
  });

  test('equivalent normalized schemas do not republish or disturb focused UI', async () => {
    const published: Array<TaxonomyConfig | null> = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: () => undefined,
    });
    await coordinator.refresh({ identity: 'A', load: async () => A });
    await coordinator.refresh({ identity: 'A', load: async () => JSON.parse(JSON.stringify(A)) });
    expect(published).toEqual([A]);
  });

  test('stale invalid loads neither log nor clear a newer valid schema', async () => {
    const stale = deferred<TaxonomyConfig | null>();
    const published: Array<TaxonomyConfig | null> = [];
    const logs: string[] = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: (message) => logs.push(message),
    });
    const loadA = coordinator.refresh({
      identity: 'A',
      load: async (log) => {
        const value = await stale.promise;
        log('[taxonomy] A: invalid');
        return value;
      },
    });
    await coordinator.refresh({ identity: 'B', load: async () => B });
    stale.resolve(null);
    expect(await loadA).toBe(false);
    expect(published).toEqual([B]);
    expect(logs).toEqual([]);
  });

  test('same-path resolution supersedes a pending read before the next read starts', async () => {
    const stale = deferred<TaxonomyConfig | null>();
    const published: Array<TaxonomyConfig | null> = [];
    const logs: string[] = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: (message) => logs.push(message),
    });
    await coordinator.refresh({ identity: 'same', load: async () => A });
    const pending = coordinator.refresh({
      identity: 'same',
      load: async (log) => {
        const value = await stale.promise;
        log('[taxonomy] stale same-path read');
        return value;
      },
    });
    coordinator.supersede();
    stale.resolve(B);
    expect(await pending).toBe(false);
    expect(published).toEqual([A]);
    expect(logs).toEqual([]);
  });

  test('disposal during a deferred invalid load suppresses its late log and publication', async () => {
    const pending = deferred<TaxonomyConfig | null>();
    const logs: string[] = [];
    const published: Array<TaxonomyConfig | null> = [];
    const coordinator = createTaxonomyStateCoordinator({
      publish: (taxonomy) => published.push(taxonomy),
      log: (message) => logs.push(message),
    });
    const loading = coordinator.refresh({
      identity: 'A',
      load: async (log) => {
        const value = await pending.promise;
        log('[taxonomy] A: invalid after disposal');
        return value;
      },
    });
    coordinator.dispose();
    pending.resolve(null);
    expect(await loading).toBe(false);
    expect(logs).toEqual([]);
    expect(published).toEqual([]);
  });

  test('returns bytes only when post-read canonical re-resolution preserves exact identity', async () => {
    const identity = { configuredPath: 'taxonomy.json', identity: '/safe/taxonomy.json', uri: 'file:///safe/taxonomy.json' };
    const bytes = new TextEncoder().encode('{"version":1,"fields":[]}');
    expect(await readRevalidatedTaxonomyResource({
      resolved: identity,
      read: async () => bytes,
      reResolve: async () => ({ ...identity }),
    })).toBe(bytes);
    await expect(readRevalidatedTaxonomyResource({
      resolved: identity,
      read: async () => bytes,
      reResolve: async () => ({ ...identity, identity: '/outside/taxonomy.json' }),
    })).rejects.toThrow('resolved taxonomy target changed during read');
  });
});
