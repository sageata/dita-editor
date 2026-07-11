import path from 'node:path';
import { validateWorkspaceRelativePath } from './workspace-files';

export function escapeRelativePatternLiteral(value: string): string {
  let escaped = '';
  for (const character of value) {
    if (character === '*') escaped += '[*]';
    else if (character === '?') escaped += '[?]';
    else if (character === '[') escaped += '[[]';
    else if (character === ']') escaped += '[]]';
    else if (character === '{') escaped += '[{]';
    else if (character === '}') escaped += '[}]';
    else escaped += character;
  }
  return escaped;
}

export function configuredWorkspaceWatcherPath(
  workspaceFsPath: string,
  configuredPath: string,
  platform: NodeJS.Platform,
): string | null {
  const validated = validateWorkspaceRelativePath(configuredPath);
  if (!validated.ok) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(workspaceFsPath, ...validated.normalized.split('/'));
}

export function absoluteFileWatcherParts(
  targetFsPath: string,
  platform: NodeJS.Platform,
): { base: string; pattern: string } {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return {
    base: pathApi.dirname(targetFsPath),
    pattern: escapeRelativePatternLiteral(pathApi.basename(targetFsPath)),
  };
}

/**
 * Derives a VS Code RelativePattern glob from resolved lexical paths, never
 * from the user's unnormalised setting text. Returns null if the target is not
 * a strict descendant of the selected workspace folder.
 */
export function resolvedWorkspaceWatcherPattern(
  workspaceFsPath: string,
  targetFsPath: string,
  platform: NodeJS.Platform,
): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(workspaceFsPath, targetFsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return null;
  }
  return escapeRelativePatternLiteral(relative.replace(/\\/g, '/'));
}
