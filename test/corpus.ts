import { Glob } from 'bun';
import fs from 'node:fs';
import path from 'node:path';

export const PUBLIC_CORPUS_DIR = path.resolve(import.meta.dir, 'fixtures/corpus');

export interface CorpusFile {
  rel: string;
  abs: string;
  source: string;
}

export function resolveCorpusDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.DITAEDITOR_CORPUS_DIR?.trim();
  return override ? path.resolve(override) : PUBLIC_CORPUS_DIR;
}

function checkedRoot(root: string): string {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`DITA corpus directory does not exist: ${resolved}`);
  }
  return resolved;
}

export function listCorpusPaths(root: string = resolveCorpusDir()): string[] {
  const resolved = checkedRoot(root);
  return [...new Glob('**/*.dita').scanSync(resolved)]
    .sort()
    .map((rel) => path.join(resolved, rel));
}

export function loadCorpusFiles(root: string = resolveCorpusDir()): CorpusFile[] {
  const resolved = checkedRoot(root);
  return listCorpusPaths(resolved).map((abs) => ({
    rel: path.relative(resolved, abs).split(path.sep).join('/'),
    abs,
    source: fs.readFileSync(abs, 'utf8'),
  }));
}

export function usesExternalCorpus(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.DITAEDITOR_CORPUS_DIR?.trim());
}
