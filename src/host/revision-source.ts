import { execFile } from 'node:child_process';
import * as path from 'node:path';

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface BaseRevision {
  rev: string; // resolved commit-ish used with `git show`
  label: string; // human label for the banner, e.g. 'main (a1b2c3d)' or 'last commit (HEAD)'
  repoRoot: string; // absolute repo root
  relPath: string; // POSIX relative path of the file inside the repo
}

// git show of a large topic can exceed execFile's 1MB default buffer.
const MAX_BUFFER = 64 * 1024 * 1024;

const defaultRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      // error.code is the exit code when git ran, but a string (e.g. 'ENOENT')
      // when git itself is missing — normalize both to a non-zero number.
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

export async function resolveBaseRevision(
  fileFsPath: string,
  run: GitRunner = defaultRunner,
): Promise<BaseRevision | 'not-in-git'> {
  const fileDir = path.dirname(fileFsPath);
  const toplevel = await run(['-C', fileDir, 'rev-parse', '--show-toplevel'], fileDir);
  if (toplevel.code !== 0) return 'not-in-git';
  const repoRoot = toplevel.stdout.trim();
  let relPath = path.relative(repoRoot, fileFsPath).split(path.sep).join('/');
  // On macOS, VS Code commonly supplies /var/... while Git canonicalizes the
  // same checkout to /private/var/.... A lexical path.relative() then appears
  // to escape the repository even though the file is inside it. Ask Git for
  // the directory's repository-relative prefix in that case; Git resolves the
  // filesystem alias before calculating it.
  if (relPath === '..' || relPath.startsWith('../') || path.posix.isAbsolute(relPath)) {
    const prefix = await run(['-C', fileDir, 'rev-parse', '--show-prefix'], fileDir);
    if (prefix.code === 0) {
      relPath = path.posix.join(prefix.stdout.trim(), path.basename(fileFsPath));
    }
  }

  let mainRef: string | undefined;
  const localMain = await run(['rev-parse', '--verify', '--quiet', 'main'], repoRoot);
  if (localMain.code === 0) {
    mainRef = 'main';
  } else {
    const originMain = await run(['rev-parse', '--verify', '--quiet', 'origin/main'], repoRoot);
    if (originMain.code === 0) mainRef = 'origin/main';
  }

  if (mainRef) {
    const mergeBase = await run(['merge-base', 'HEAD', mainRef], repoRoot);
    const head = await run(['rev-parse', 'HEAD'], repoRoot);
    // rev-parse HEAD failing means an unborn branch (no commits yet) — fall
    // through to the HEAD base; readFileAtRevision will return null there.
    if (mergeBase.code === 0 && head.code === 0) {
      const mergeBaseRev = mergeBase.stdout.trim();
      if (mergeBaseRev !== head.stdout.trim()) {
        return {
          rev: mergeBaseRev,
          label: `${mainRef} (${mergeBaseRev.slice(0, 7)})`,
          repoRoot,
          relPath,
        };
      }
    }
  }

  return { rev: 'HEAD', label: 'last commit (HEAD)', repoRoot, relPath };
}

export async function readFileAtRevision(
  base: BaseRevision,
  run: GitRunner = defaultRunner,
): Promise<string | null> {
  const shown = await run(['show', `${base.rev}:${base.relPath}`], base.repoRoot);
  if (shown.code !== 0) return null;
  // Byte fidelity matters: return stdout verbatim, never trimmed.
  return shown.stdout;
}
