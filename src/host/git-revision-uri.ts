import * as path from 'node:path';

export interface GitRevisionUriShape {
  scheme: string;
  query: string;
}

export interface GitRevisionLocation {
  ref: string;
  relPath: string;
}

/** Decode a built-in Git revision URI without opening a VS Code TextDocument. */
export function gitRevisionLocation(
  uri: GitRevisionUriShape,
  repoRoot: string,
): GitRevisionLocation | undefined {
  if (uri.scheme !== 'git') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(uri.query);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as { path?: unknown; ref?: unknown };
  if (typeof candidate.path !== 'string' || typeof candidate.ref !== 'string' || !candidate.ref) {
    return undefined;
  }
  const relPath = path.relative(repoRoot, candidate.path).split(path.sep).join('/');
  if (relPath === '..' || relPath.startsWith('../') || path.posix.isAbsolute(relPath)) return undefined;
  return { ref: candidate.ref, relPath };
}
