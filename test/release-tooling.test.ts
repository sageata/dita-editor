import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expectedAttributes = `* text=auto eol=lf
*.ts text eol=lf
*.js text eol=lf
*.mjs text eol=lf
*.json text eol=lf
*.jsonc text eol=lf
*.css text eol=lf
*.md text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.xml text eol=lf
*.dita text eol=lf
*.ditamap text eol=lf
*.svg text eol=lf
bun.lock text eol=lf
.node-version text eol=lf
.gitignore text eol=lf
.vscodeignore text eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.vsix binary
`;

afterAll(() => {
  rmSync(join(root, 'artifacts'), { recursive: true, force: true });
});

describe('release tooling contract', () => {
  test('pins the exact Bun, Node, dependencies, and LF normalization contract', () => {
    expect(Bun.version).toBe('1.1.42');
    expect(execFileSync('node', ['--version'], { encoding: 'utf8' }).trim()).toBe('v22.22.2');
    expect(pkg.packageManager).toBe('bun@1.1.42');
    expect(readFileSync(join(root, '.node-version'), 'utf8')).toBe('22.22.2\n');
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(expectedAttributes);
    expect(pkg.devDependencies).toEqual({
      '@types/bun': '1.3.14',
      '@types/vscode': '1.90.0',
      '@types/yauzl': '3.4.0',
      '@vscode/test-electron': '3.0.0',
      '@vscode/vsce': '3.9.2',
      esbuild: '0.24.2',
      typescript: '5.9.3',
      yauzl: '3.4.0',
    });
  });

  test('uses a committed text lock and rejects the binary lock', () => {
    expect(existsSync(join(root, 'bun.lock'))).toBe(true);
    expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toContain('lockfileVersion');
    expect(existsSync(join(root, 'bun.lockb'))).toBe(false);
  });

  test('defines only the strict Bun-owned package gate', () => {
    expect(pkg.scripts['build:production']).toBe('node esbuild.mjs --production');
    expect(pkg.scripts['prepare:artifacts']).toBe("bun -e \"require('node:fs').mkdirSync('artifacts',{recursive:true})\"");
    expect(pkg.scripts['package:vsix:pre-metadata']).toBeUndefined();
    expect(pkg.scripts['package:vsix']).toBe(
      'bun run typecheck && bun run build:production && bun run prepare:artifacts && vsce package --no-dependencies --out artifacts/dita-editor-0.1.0.vsix',
    );
    expect(pkg.scripts['vscode:prepublish']).toBeUndefined();
    expect(pkg.vsce).toEqual({ dependencies: false });
    const command = pkg.scripts['package:vsix'] as string;
    expect(command.match(/--[a-z-]+/g)).toEqual(['--no-dependencies', '--out']);
  });

  test('excludes development inputs and maps while retaining the production bundle', () => {
    const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8');
    for (const entry of [
      'src/**', 'test/**', 'test-artifacts/**', 'docs/**', 'scripts/**', 'esbuild.mjs',
      'tsconfig.json', 'bun.lock', 'bun.lockb', '.node-version', '.gitattributes',
      'artifacts/**', '**/*.map', 'node_modules/',
    ]) expect(ignore).toContain(entry);
    expect(ignore.split(/\r?\n/)).not.toContain('dist/**');
    expect(ignore.split(/\r?\n/)).not.toContain('dist/');
  });

  test('the real package command never invokes npm and leaves no production source map', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'ditaeditor-no-npm-'));
    const marker = join(temp, 'npm-was-called');
    const shim = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 97\n`;
    try {
      for (const name of ['npm', 'npm.cmd']) {
        const path = join(temp, name);
        writeFileSync(path, shim);
        chmodSync(path, 0o755);
      }
      const processHandle = Bun.spawn(['bun', 'run', 'package:vsix'], {
        cwd: root,
        env: { ...process.env, PATH: temp + delimiter + process.env.PATH },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(exitCode, stdout + stderr).toBe(0);
      expect(existsSync(marker), stdout + stderr).toBe(false);
      expect(existsSync(join(root, 'artifacts/dita-editor-0.1.0.vsix'))).toBe(true);
      expect(existsSync(join(root, 'dist/extension.js'))).toBe(true);
      expect(existsSync(join(root, 'dist/extension.js.map'))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
