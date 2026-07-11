import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

export function shortcutModifier(platform = process.platform) {
  return platform === 'darwin'
    ? { key: 'Meta', cdpMask: 4 }
    : { key: 'Control', cdpMask: 2 };
}

export function buildVsCodeLaunchArgs({
  userDataDir,
  extensionsDir,
  workspacePath,
  port,
  extensionDevelopmentPath,
  restrictedMode = false,
}) {
  if (extensionDevelopmentPath) {
    throw new Error('installed smoke must not use a source checkout or --extensionDevelopmentPath');
  }
  if (!userDataDir || !extensionsDir || !workspacePath || !Number.isInteger(port)) {
    throw new Error('isolated user-data, extensions, workspace, and CDP port are required');
  }
  return [
    '--new-window',
    `--user-data-dir=${resolve(userDataDir)}`,
    `--extensions-dir=${resolve(extensionsDir)}`,
    `--remote-debugging-port=${port}`,
    '--skip-welcome',
    '--disable-telemetry',
    '--disable-updates',
    ...(restrictedMode ? [] : ['--disable-workspace-trust']),
    resolve(workspacePath),
  ];
}

export function buildLaunchCommand(executable, args, platform = process.platform) {
  return platform === 'linux'
    ? { command: 'xvfb-run', args: ['-a', executable, ...args] }
    : { command: executable, args: [...args] };
}

export function cliCommandForExecutable(executable, platform = process.platform) {
  const [command, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, { platform });
  return { command, args };
}

export async function captureCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    let settled = false;
    let timedOut = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateAndWait(child, { timeoutMs: options.terminateTimeoutMs ?? 2_000 });
      finish(rejectExit, new Error(`command timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs ?? 120_000);
    child.once('error', (error) => finish(rejectExit, error));
    child.once('exit', (code, signal) => {
      if (!timedOut) finish(resolveExit, code ?? (signal ? 128 : 1));
    });
  });
  return { exitCode, stdout, stderr };
}

function signalProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export async function terminateAndWait(child, { timeoutMs = 5_000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  signalProcessTree(child, 'SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (graceful) return;
  signalProcessTree(child, 'SIGKILL');
  await Promise.race([
    exited,
    new Promise((_, rejectTimeout) => setTimeout(
      () => rejectTimeout(new Error(`process ${child.pid ?? '<unknown>'} did not exit after SIGKILL`)),
      timeoutMs,
    )),
  ]);
}

export async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') rejectPort(new Error('could not allocate CDP port'));
        else resolvePort(address.port);
      });
    });
  });
}

export async function createIsolatedSmokeLayout(prefix = 'ditaeditor-vsix-smoke-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = {
    root,
    userDataDir: join(root, 'user-data'),
    extensionsDir: join(root, 'extensions'),
    workspaceDir: join(root, 'workspace'),
    artifactDir: join(root, 'artifacts'),
  };
  await Promise.all(Object.values(paths).slice(1).map((path) => mkdir(path, { recursive: true })));
  return {
    ...paths,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function finalizeLayoutLifecycle(layout, { retain, evidenceRoot }) {
  if (retain) return { retained: true, profileRoot: layout.root, workspaceCopy: null };
  const workspaceCopy = join(evidenceRoot, 'workspace-after');
  await cp(layout.workspaceDir, workspaceCopy, { recursive: true });
  await layout.cleanup();
  return { retained: false, profileRoot: null, workspaceCopy };
}

export async function runWithIsolatedLayoutLifecycle({ prefix, retain, evidenceRoot }, operation) {
  const layout = await createIsolatedSmokeLayout(prefix);
  let completed = false;
  try {
    const result = await operation(layout);
    completed = true;
    return { result, layout };
  } finally {
    await finalizeLayoutLifecycle(layout, { retain: retain && completed, evidenceRoot });
  }
}

export async function writeUserSettings(userDataDir, settings = {}) {
  const userDir = join(userDataDir, 'User');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    ...settings,
  }, null, 2));
}

export function extensionIdFromManifest(manifest) {
  if (!manifest?.publisher || !manifest?.name) throw new Error('packaged manifest lacks publisher or name');
  return `${manifest.publisher}.${manifest.name}`;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

export class CdpClient {
  static async connect(url, timeoutMs = 10_000) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);
      const timer = setTimeout(() => rejectConnect(new Error(`timed out connecting to CDP: ${url}`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveConnect(client);
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectConnect(new Error(`CDP connection failed: ${url}`));
      }, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => this.#onMessage(String(event.data)));
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`timed out waiting for CDP method ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }

  #onMessage(raw) {
    const message = JSON.parse(raw);
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
}

export async function evaluate(client, expression, contextId) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluation failed');
  return result.result?.value;
}

export async function installVsix({ executable, extensionsDir, userDataDir, vsixPath, platform = process.platform }) {
  const cli = cliCommandForExecutable(executable, platform);
  const result = await captureCommand(cli.command, [
    ...cli.args,
    `--user-data-dir=${resolve(userDataDir)}`,
    `--extensions-dir=${resolve(extensionsDir)}`,
    '--install-extension', resolve(vsixPath),
    '--force',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`VSIX install failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export async function launchIsolatedCode({ executable, args, platform = process.platform, cwd }) {
  const launch = buildLaunchCommand(executable, args, platform);
  const child = spawn(launch.command, launch.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    output: () => ({ stdout, stderr }),
    terminate: (options) => terminateAndWait(child, options),
  };
}
