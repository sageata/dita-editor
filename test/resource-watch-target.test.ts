import { describe, expect, test } from 'bun:test';
import {
  updateWorkspaceResourceWatchTarget,
  workspaceResourceWatcherSpecifications,
} from '../src/host/resource-watch-target';

describe('workspace resource watch target', () => {
  test('watches an initially missing configured file and observes its later identity', () => {
    const missing = updateWorkspaceResourceWatchTarget({
      current: null,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/./taxonomy.json',
      resolved: null,
      platform: 'linux',
    });
    expect(missing).toEqual({
      configuredPath: 'tax/./taxonomy.json',
      lexicalPath: '/workspace/tax/taxonomy.json',
      canonicalPath: '/workspace/tax/taxonomy.json',
      identity: '/workspace/tax/taxonomy.json',
    });

    const created = updateWorkspaceResourceWatchTarget({
      current: missing,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/./taxonomy.json',
      resolved: { canonicalPath: '/real/workspace/tax/taxonomy.json', identity: 'canonical-taxonomy' },
      platform: 'linux',
    });
    expect(created?.identity).toBe('canonical-taxonomy');
  });

  test('preserves the canonical alias across delete and retargets on recreate', () => {
    const existing = updateWorkspaceResourceWatchTarget({
      current: null,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/taxonomy.json',
      resolved: { canonicalPath: '/real/tax/a.json', identity: 'identity-a' },
      platform: 'linux',
    });
    const deleted = updateWorkspaceResourceWatchTarget({
      current: existing,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/taxonomy.json',
      resolved: null,
      platform: 'linux',
    });
    expect(deleted?.canonicalPath).toBe('/real/tax/a.json');
    expect(deleted?.identity).toBe('identity-a');
    expect(workspaceResourceWatcherSpecifications(deleted, '/workspace', 'linux')).toEqual([
      {
        base: 'workspace',
        basePath: '/workspace',
        pattern: 'tax/taxonomy.json',
        key: '/workspace::tax/taxonomy.json',
      },
      {
        base: 'absolute',
        basePath: '/real/tax',
        pattern: 'a.json',
        key: '/real/tax::a.json',
      },
    ]);

    const recreated = updateWorkspaceResourceWatchTarget({
      current: deleted,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/taxonomy.json',
      resolved: { canonicalPath: '/real/tax/b.json', identity: 'identity-b' },
      platform: 'linux',
    });
    expect(recreated?.canonicalPath).toBe('/real/tax/b.json');
    expect(recreated?.identity).toBe('identity-b');
  });

  test('drops the prior identity on path change, disable, or unsafe configuration', () => {
    const current = updateWorkspaceResourceWatchTarget({
      current: null,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/a.json',
      resolved: { canonicalPath: '/real/tax/a.json', identity: 'identity-a' },
      platform: 'linux',
    });
    const changed = updateWorkspaceResourceWatchTarget({
      current,
      workspaceFsPath: '/workspace',
      configuredPath: 'tax/b.json',
      resolved: null,
      platform: 'linux',
    });
    expect(changed?.identity).toBe('/workspace/tax/b.json');
    expect(updateWorkspaceResourceWatchTarget({
      current: changed,
      workspaceFsPath: '/workspace',
      configuredPath: '',
      resolved: null,
      platform: 'linux',
    })).toBeNull();
    expect(updateWorkspaceResourceWatchTarget({
      current: changed,
      workspaceFsPath: '/workspace',
      configuredPath: '../outside.json',
      resolved: null,
      platform: 'linux',
    })).toBeNull();
  });
});
