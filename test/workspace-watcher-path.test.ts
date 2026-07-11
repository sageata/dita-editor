import { describe, expect, test } from 'bun:test';
import {
  absoluteFileWatcherParts,
  configuredWorkspaceWatcherPath,
  escapeRelativePatternLiteral,
  resolvedWorkspaceWatcherPattern,
} from '../src/host/workspace-watcher-path';

describe('resolvedWorkspaceWatcherPattern', () => {
  test('uses the normalized resolved target rather than configured dot segments', () => {
    expect(resolvedWorkspaceWatcherPattern(
      '/workspace',
      '/workspace/css/managed.css',
      'linux',
    )).toBe('css/managed.css');
  });

  test('normalizes Windows separators for RelativePattern', () => {
    expect(resolvedWorkspaceWatcherPattern(
      'C:\\workspace',
      'C:\\workspace\\styles\\managed.css',
      'win32',
    )).toBe('styles/managed.css');
  });

  test('escapes every supported glob metacharacter in literal filenames', () => {
    expect(escapeRelativePatternLiteral('tax/[draft]*?.{json}')).toBe(
      'tax/[[]draft[]][*][?].[{]json[}]',
    );
    expect(resolvedWorkspaceWatcherPattern(
      '/workspace',
      '/workspace/tax/[draft]*?.{json}',
      'linux',
    )).toBe('tax/[[]draft[]][*][?].[{]json[}]');
  });

  test('keeps a validated configured target even before the file exists', () => {
    expect(configuredWorkspaceWatcherPath(
      '/workspace',
      'tax/./nested/../taxonomy.json',
      'linux',
    )).toBe('/workspace/tax/taxonomy.json');
    expect(configuredWorkspaceWatcherPath('/workspace', '../outside.json', 'linux')).toBeNull();
  });

  test('creates literal canonical-file watcher parts without globbing the basename', () => {
    expect(absoluteFileWatcherParts('/real/tax/[draft].json', 'linux')).toEqual({
      base: '/real/tax',
      pattern: '[[]draft[]].json',
    });
  });

  test('refuses the workspace root, siblings, and absolute cross-drive targets', () => {
    expect(resolvedWorkspaceWatcherPattern('/workspace', '/workspace', 'linux')).toBeNull();
    expect(resolvedWorkspaceWatcherPattern('/workspace', '/outside/managed.css', 'linux')).toBeNull();
    expect(resolvedWorkspaceWatcherPattern('C:\\workspace', 'D:\\managed.css', 'win32')).toBeNull();
  });
});
