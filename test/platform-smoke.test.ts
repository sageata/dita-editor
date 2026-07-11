import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLaunchCommand,
  buildVsCodeLaunchArgs,
  captureCommand,
  createIsolatedSmokeLayout,
  finalizeLayoutLifecycle,
  runWithIsolatedLayoutLifecycle,
  shortcutModifier,
// @ts-expect-error executable ESM smoke driver intentionally has no generated declaration
} from '../scripts/vscode-smoke-driver.mjs';

describe('VS Code smoke platform contract', () => {
  test('uses the native command modifier on each supported platform', () => {
    expect(shortcutModifier('darwin')).toEqual({ key: 'Meta', cdpMask: 4 });
    expect(shortcutModifier('linux')).toEqual({ key: 'Control', cdpMask: 2 });
    expect(shortcutModifier('win32')).toEqual({ key: 'Control', cdpMask: 2 });
  });

  test('launches only isolated installed-extension profiles', () => {
    const args = buildVsCodeLaunchArgs({
      userDataDir: '/tmp/user',
      extensionsDir: '/tmp/extensions',
      workspacePath: '/tmp/workspace.code-workspace',
      port: 9222,
    });
    expect(args).toContain('--user-data-dir=/tmp/user');
    expect(args).toContain('--extensions-dir=/tmp/extensions');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).not.toContainEqual(expect.stringContaining('--extensionDevelopmentPath'));
    expect(() => buildVsCodeLaunchArgs({
      userDataDir: '/tmp/user',
      extensionsDir: '/tmp/extensions',
      workspacePath: '/tmp/workspace.code-workspace',
      port: 9222,
      extensionDevelopmentPath: '/private/source',
    })).toThrow('source checkout');
  });

  test('wraps Linux graphical launches with xvfb-run -a only', () => {
    expect(buildLaunchCommand('/code', ['--new-window'], 'linux')).toEqual({
      command: 'xvfb-run',
      args: ['-a', '/code', '--new-window'],
    });
    expect(buildLaunchCommand('/code', ['--new-window'], 'darwin')).toEqual({
      command: '/code',
      args: ['--new-window'],
    });
  });

  test('times out commands and reaps the child instead of hanging', async () => {
    const started = Date.now();
    await expect(captureCommand('bun', ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
    })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('retains only retained profiles and copies evidence before bounded cleanup', async () => {
    const retained = await createIsolatedSmokeLayout('retain-test-');
    await Bun.write(`${retained.workspaceDir}/fixture.txt`, 'fixture');
    expect((await finalizeLayoutLifecycle(retained, { retain: true, evidenceRoot: retained.artifactDir })).retained).toBe(true);
    expect(await Bun.file(`${retained.workspaceDir}/fixture.txt`).exists()).toBe(true);
    const evidenceRoot = `${retained.root}-evidence`;
    const cleaned = await finalizeLayoutLifecycle(retained, { retain: false, evidenceRoot });
    expect(cleaned.retained).toBe(false);
    expect(await Bun.file(`${retained.workspaceDir}/fixture.txt`).exists()).toBe(false);
    expect(await Bun.file(`${evidenceRoot}/workspace-after/fixture.txt`).text()).toBe('fixture');
    await (await import('node:fs/promises')).rm(evidenceRoot, { recursive: true, force: true });
  });

  test('cleans an injected early failure even when retention was requested', async () => {
    const evidenceRoot = join(tmpdir(), `early-failure-evidence-${Date.now()}`);
    let profileRoot = '';
    await expect(runWithIsolatedLayoutLifecycle({ prefix: 'early-failure-', retain: true, evidenceRoot }, async (layout: any) => {
      profileRoot = layout.root;
      await Bun.write(`${layout.workspaceDir}/before-failure.txt`, 'safe copy');
      throw new Error('injected resolution failure');
    })).rejects.toThrow('injected resolution failure');
    expect(await Bun.file(profileRoot).exists()).toBe(false);
    expect(await Bun.file(`${evidenceRoot}/workspace-after/before-failure.txt`).text()).toBe('safe copy');
    await (await import('node:fs/promises')).rm(evidenceRoot, { recursive: true, force: true });
  });
});
