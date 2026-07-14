import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { test, expect } from 'bun:test';
// @ts-expect-error the smoke driver is intentionally distributed as executable ESM
import { shortcutModifier } from '../scripts/vscode-smoke-driver.mjs';

const RUN_REAL_E2E = process.env.DITAEDITOR_REAL_VSCODE_E2E === '1';
const TEST_TIMEOUT_MS = 120_000;
const EXTENSION_ROOT = resolve(import.meta.dir, '..');
const CODE_BIN = process.env.DITAEDITOR_VSCODE_BIN || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

const FIXTURE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="real-webview-e2e">
  <title>Real WebView E2E</title>
  <body>
    <table>
      <title>Transform target</title>
      <tgroup cols="2">
        <colspec colname="c1"/>
        <colspec colname="c2"/>
        <tbody>
          <row>
            <entry>Alpha beta gamma</entry>
            <entry>Keep separate</entry>
          </row>
          <row>
            <entry><image href="diagram.svg"/></entry>
            <entry>Merge partner</entry>
          </row>
        </tbody>
      </tgroup>
    </table>
    <note>Backspace lead</note>
    <p>Backspace tail</p>
    <p>List lead</p>
    <ul><li>List tail</li></ul>
    <ul><li>Keep listed</li></ul>
  </body>
</topic>
`;

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly contexts: Array<{
    id: number;
    name?: string;
    origin?: string;
    auxData?: { isDefault?: boolean; frameId?: string };
  }> = [];

  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(url);
      const client = new CdpClient(ws);
      const timer = setTimeout(() => {
        ws.close();
        rejectConnect(new Error(`Timed out connecting to CDP websocket: ${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolveConnect(client);
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        rejectConnect(new Error(`CDP websocket failed: ${url}`));
      }, { once: true });
      ws.addEventListener('message', (event) => client.onMessage(String(event.data)));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`Timed out waiting for CDP method ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      this.ws.send(payload);
    });
  }

  close(): void {
    this.ws.close();
  }

  defaultContextId(): number | undefined {
    const defaults = this.contexts.filter((context) => context.auxData?.isDefault === true);
    return defaults.at(-1)?.id ?? this.contexts.find((context) => context.name === '')?.id;
  }

  defaultContextIds(): number[] {
    const defaults = this.contexts.filter((context) => context.auxData?.isDefault === true);
    return defaults.map((context) => context.id);
  }

  frameIdForContext(contextId: number): string | undefined {
    return this.contexts.find((context) => context.id === contextId)?.auxData?.frameId;
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.executionContextCreated' && msg.params?.context) {
      const context = msg.params.context;
      this.contexts.push({
        id: context.id,
        name: context.name,
        origin: context.origin,
        auxData: context.auxData,
      });
      return;
    }
    if (msg.method === 'Runtime.executionContextDestroyed' && typeof msg.params?.executionContextId === 'number') {
      const idx = this.contexts.findIndex((context) => context.id === msg.params.executionContextId);
      if (idx >= 0) this.contexts.splice(idx, 1);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.message}: ${msg.error.data ?? ''}`.trim()));
    else entry.resolve(msg.result);
  }
}

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') rejectPort(new Error('Could not allocate a TCP port'));
        else resolvePort(address.port);
      });
    });
  });
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function listTargets(port: number): Promise<TargetInfo[]> {
  return json<TargetInfo[]>(`http://127.0.0.1:${port}/json/list`);
}

function webviewWsUrl(port: number, target: TargetInfo): string {
  return target.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/page/${target.id}`;
}

async function evaluate(client: CdpClient, expression: string, contextId = client.defaultContextId()): Promise<any> {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    ...(contextId ? { contextId } : {}),
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(text);
  }
  return result.result?.value;
}

async function pointerClick(client: CdpClient, point: { x: number; y: number }): Promise<void> {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function saveActiveEditor(client: CdpClient): Promise<void> {
  const { cdpMask } = shortcutModifier(process.platform);
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 1,
    modifiers: cdpMask,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 1,
    modifiers: cdpMask,
  });
}

async function dispatchKey(
  client: CdpClient,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0,
): Promise<void> {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode,
    modifiers,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode,
    modifiers,
  });
}

async function openVisualEditorFromCommandPalette(workbench: CdpClient): Promise<void> {
  const { cdpMask } = shortcutModifier(process.platform);
  await dispatchKey(workbench, 'P', 'KeyP', 80, cdpMask | 8);
  await sleep(500);
  await workbench.send('Input.insertText', { text: 'DITA Editor: Open Visual Editor' });
  await sleep(500);
  await dispatchKey(workbench, 'Enter', 'Enter', 13);
}

function buildExtension(): void {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`bun run build failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function createTempProject(): Promise<{ root: string; fixture: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ditaeditor-real-webview-'));
  const userDir = join(root, 'user-data', 'User');
  const workspaceDir = join(root, 'workspace');
  await mkdir(userDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(userDir, 'settings.json'), JSON.stringify({
    'workbench.editorAssociations': { '*.dita': 'ditaeditor.visual' },
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
  }, null, 2));
  const fixture = join(workspaceDir, 'real-webview-table-transform.dita');
  await writeFile(fixture, FIXTURE_SOURCE);
  await writeFile(
    join(workspaceDir, 'diagram.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0b6bcb"/></svg>',
  );
  return { root, fixture };
}

function launchCode(root: string, fixture: string, port: number): ChildProcessWithoutNullStreams {
  const userDataDir = join(root, 'user-data');
  const extensionsDir = join(root, 'extensions');
  const proc = spawn(CODE_BIN, [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--remote-debugging-port=${port}`,
    `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    fixture,
  ], {
    cwd: dirname(fixture),
    stdio: 'pipe',
  });
  proc.stderr.on('data', () => undefined);
  proc.stdout.on('data', () => undefined);
  return proc;
}

async function quitCode(proc: ChildProcessWithoutNullStreams, browser?: CdpClient): Promise<void> {
  try {
    await browser?.send('Browser.close');
  } catch {
    // The process may already be gone.
  }
  await sleep(750);
  if (!proc.killed) proc.kill('SIGTERM');
}

async function runRealWebviewSmoke(): Promise<void> {
  if (!existsSync(CODE_BIN)) {
    throw new Error(`VS Code binary not found at ${CODE_BIN}; set DITAEDITOR_VSCODE_BIN to override it`);
  }

  buildExtension();
  const port = await freePort();
  const project = await createTempProject();
  let proc: ChildProcessWithoutNullStreams | undefined;
  let browser: CdpClient | undefined;
  let workbench: CdpClient | undefined;
  let webview: CdpClient | undefined;

  try {
    console.log(`[real-webview-e2e] launching VS Code on CDP port ${port}`);
    proc = launchCode(project.root, project.fixture, port);
    console.log('[real-webview-e2e] waiting for DevTools endpoint');
    const version = await waitFor('VS Code DevTools endpoint', () =>
      json<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${port}/json/version`),
      45_000,
    );
    console.log('[real-webview-e2e] connecting to browser target');
    browser = await CdpClient.connect(version.webSocketDebuggerUrl);

    const workbenchTarget = await waitFor('VS Code workbench target', async () => {
      const targets = await listTargets(port);
      return targets.find((candidate) => candidate.url.includes('/workbench/workbench.html'));
    }, 10_000);
    workbench = await CdpClient.connect(webviewWsUrl(port, workbenchTarget));
    await workbench.send('Runtime.enable');
    await waitFor('VS Code workbench default execution context', async () => workbench!.defaultContextId() ? true : null, 5_000);
    await workbench.send('Input.setIgnoreInputEvents', { ignore: false });
    await workbench.send('Page.bringToFront');

    console.log('[real-webview-e2e] opening visual editor from the command palette');
    await openVisualEditorFromCommandPalette(workbench);

    console.log('[real-webview-e2e] waiting for DITA Editor WebView target');
    const target = await waitFor('DITA Editor visual WebView target', async () => {
      const targets = await listTargets(port);
      return targets.find((candidate) =>
        candidate.url.includes('extensionId=paul-razvan-sarbu.dita-editor') ||
        candidate.url.includes('extensionId%3Dpaul-razvan-sarbu.dita-editor'));
    }, 45_000);

    console.log(`[real-webview-e2e] connecting to webview target ${target.id}`);
    webview = await CdpClient.connect(webviewWsUrl(port, target));
    await webview.send('Runtime.enable');
    await waitFor('DITA Editor WebView default execution context', async () => webview!.defaultContextId() ? true : null, 5_000);
    await webview.send('Input.setIgnoreInputEvents', { ignore: false });
    const webviewContextId = await waitFor('DITA Editor editor frame execution context', async () => {
      for (const contextId of webview!.defaultContextIds()) {
        try {
          const found = await evaluate(webview!, `(() => {
            return !!(
              document.querySelector('td[data-cell-id][contenteditable], th[data-cell-id][contenteditable]') &&
              document.querySelector('.cmd-bar')
            );
          })()`, contextId);
          if (found) return contextId;
        } catch {
          // Some default contexts may be transient during WebView boot.
        }
      }
      return null;
    }, 10_000);

    console.log('[real-webview-e2e] waiting for rendered table cell');
    await waitFor('rendered direct table entry and command bar', async () => {
      const state = await evaluate(webview!, `(() => {
        const cell = document.querySelector('td[data-cell-id][contenteditable], th[data-cell-id][contenteditable]');
        const bar = document.querySelector('.cmd-bar');
        return cell && bar ? { text: cell.textContent, href: location.href } : null;
      })()`, webviewContextId);
      return state && String(state.text).includes('Alpha beta gamma') ? state : null;
    });

    console.log('[real-webview-e2e] checking WebView accessibility tree');
    await webview.send('Accessibility.enable');
    const webviewFrameId = webview.frameIdForContext(webviewContextId);
    const axTree = await webview.send(
      'Accessibility.getFullAXTree',
      webviewFrameId ? { frameId: webviewFrameId } : {},
    );
    const axText = JSON.stringify((axTree.nodes || []).map((node: any) => ({
      role: node.role?.value,
      name: node.name?.value,
      value: node.value?.value,
    })));
    expect(axText).toContain('Document commands');
    expect(axText).toContain('Alpha beta gamma');
    expect(axText).toContain('Navigation status');

    console.log('[real-webview-e2e] focusing direct entry and refreshing command bar');
    await evaluate(webview, `(() => {
      const cell = document.querySelector('td[data-cell-id][contenteditable], th[data-cell-id][contenteditable]');
      if (!cell) throw new Error('No direct editable table cell found after click');
      cell.scrollIntoView({ block: 'center', inline: 'center' });
      cell.focus();
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      return true;
    })()`, webviewContextId);

    console.log('[real-webview-e2e] clicking Structure alphabetic-list toolbar button in the real WebView DOM');
    const clickResult = await waitFor('enabled Structure Alphabetic list button', async () => {
      return evaluate(webview!, `(() => {
        const buttons = Array.from(document.querySelectorAll('.cmd-bar button'));
        const button = buttons.find((b) =>
          b.closest('.cmd-group')?.querySelector('.cmd-group-label')?.textContent === 'Structure' &&
          (b.dataset.action === 'Alphabetic list' || b.getAttribute('aria-label') === 'Alphabetic list') &&
          (b.getAttribute('aria-label') === 'Convert to alphabetic list' || b.title === 'Convert to alphabetic list')
        );
        if (!button) return null;
        const style = window.getComputedStyle(button);
        const group = button.closest('.cmd-group');
        const groupStyle = group ? window.getComputedStyle(group) : null;
        const rect = button.getBoundingClientRect();
        const disabled = button.getAttribute('aria-disabled') === 'true';
        if (
          disabled ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          !group ||
          !groupStyle ||
          groupStyle.display === 'none' ||
          groupStyle.visibility === 'hidden' ||
          rect.width === 0 ||
          rect.height === 0
        ) return null;
        window.__ditaeditorE2eToolbarClickCount = 0;
        button.addEventListener('click', () => { window.__ditaeditorE2eToolbarClickCount += 1; }, { once: true, capture: true });
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        button.click();
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        const anchorEl = anchorNode && anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
        const editEl = anchorEl?.closest ? anchorEl.closest('[data-edit-id][contenteditable]') : null;
        const cellEl = anchorEl?.closest ? anchorEl.closest('td[data-cell-id], th[data-cell-id]') : null;
        const status = document.querySelector('[role="status"]');
        return {
          clicks: window.__ditaeditorE2eToolbarClickCount,
          label: button.getAttribute('aria-label'),
          text: button.textContent.trim(),
          barRunType: typeof button._barRun,
          ariaDisabled: button.getAttribute('aria-disabled'),
          activeElement: {
            tag: document.activeElement?.tagName,
            editId: document.activeElement?.getAttribute?.('data-edit-id'),
            cellId: document.activeElement?.getAttribute?.('data-cell-id'),
          },
          selection: {
            isCollapsed: selection?.isCollapsed,
            anchorNodeType: anchorNode?.nodeType,
            anchorTag: anchorEl?.tagName,
            editId: editEl?.getAttribute('data-edit-id'),
            cellId: cellEl?.getAttribute('data-cell-id'),
          },
          statusText: status?.textContent || '',
        };
      })()`, webviewContextId);
    }, 10_000);
    console.log('[real-webview-e2e] click result', JSON.stringify(clickResult));
    expect(clickResult.clicks).toBe(1);
    expect(clickResult.label).toBe('Convert to alphabetic list');
    expect(clickResult.text).toBeTruthy();

    console.log('[real-webview-e2e] waiting for WebView alphabetic-list rerender');
    await waitFor('WebView rerendered entry as an alphabetic list', async () => {
      return evaluate(webview!, `(() => {
        const list = document.querySelector('td[data-cell-id] ol.lower-alpha, th[data-cell-id] ol.lower-alpha');
        return list ? list.textContent : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] aligning the image cell from the top command bar');
    await evaluate(webview, `(() => {
      const image = document.querySelector('img[data-struct-id][data-struct-kind="image"]');
      if (!image) throw new Error('No rendered image found');
      image.click();
      const button = document.querySelector('[aria-label^="Horizontal alignment"]');
      if (!button || getComputedStyle(button).display === 'none') throw new Error('Top-bar horizontal alignment control is not visible');
      button.click();
      const choice = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Right' && item.closest('[role="menu"]').style.display === 'flex');
      if (!choice) throw new Error('Right alignment choice is not visible');
      choice.click();
    })()`, webviewContextId);
    await waitFor('table image cell rerendered right-aligned', async () => {
      return evaluate(webview!, `document.querySelector('td[data-align="right"] img[data-struct-kind="image"]') ? true : null`, webviewContextId);
    }, 20_000);
    await evaluate(webview, `(() => {
      const image = document.querySelector('img[data-struct-id][data-struct-kind="image"]');
      if (!image) throw new Error('No rendered image found after horizontal alignment');
      image.click();
      const button = document.querySelector('[aria-label^="Vertical alignment"]');
      if (!button || getComputedStyle(button).display === 'none') throw new Error('Top-bar vertical alignment control is not visible');
      button.click();
      const choice = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Middle' && item.closest('[role="menu"]').style.display === 'flex');
      if (!choice) throw new Error('Middle alignment choice is not visible');
      choice.click();
    })()`, webviewContextId);
    await waitFor('table image cell rerendered vertically middle', async () => {
      return evaluate(webview!, `document.querySelector('td[data-valign="middle"] img[data-struct-kind="image"]') ? true : null`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] applying table frame and grid settings from the compact context menu');
    const frameCases = [
      { label: 'All', value: 'all', widths: ['1px', '1px', '1px', '1px'] },
      { label: 'Top and bottom', value: 'topbot', widths: ['1px', '0px', '1px', '0px'] },
      { label: 'Top', value: 'top', widths: ['1px', '0px', '0px', '0px'] },
      { label: 'Bottom', value: 'bottom', widths: ['0px', '0px', '1px', '0px'] },
      { label: 'None', value: 'none', widths: ['0px', '0px', '0px', '0px'] },
    ];
    for (const frameCase of frameCases) {
      await evaluate(webview, `(() => {
        const cell = document.querySelectorAll('tbody tr')[0].children[0];
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 600, clientY: 400, view: window }));
        const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Table settings');
        if (!settings) throw new Error('Table settings is not visible');
        settings.click();
        const choice = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === ${JSON.stringify('Table frame: ')} + ${JSON.stringify(frameCase.label)});
        if (!choice) throw new Error('Table frame choice is not visible');
        choice.click();
      })()`, webviewContextId);
      await waitFor(`WebView rendered frame ${frameCase.value}`, async () => evaluate(webview!, `(() => {
        const table = document.querySelector('table[data-struct-id]');
        if (!table?.classList.contains(${JSON.stringify(`frame-${frameCase.value}`)})) return null;
        const style = getComputedStyle(table);
        return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].join(',') === ${JSON.stringify(frameCase.widths.join(','))} ? true : null;
      })()`, webviewContextId), 20_000);
    }
    const settingsPoint = await evaluate(webview, `(() => {
      const cell = document.querySelectorAll('tbody tr')[0].children[0];
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 600, clientY: 400, view: window }));
      const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Table settings');
      if (!settings) throw new Error('Table settings is not visible after title rerender');
      const rect = settings.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`, webviewContextId);
    await pointerClick(webview, settingsPoint);
    const sidesPoint = await evaluate(webview, `(() => {
      const sides = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Table frame: Sides');
      if (!sides) throw new Error('Table frame: Sides is not visible');
      const rect = sides.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`, webviewContextId);
    await pointerClick(webview, sidesPoint);
    await waitFor('WebView rerendered table frame setting', async () => {
      return evaluate(webview!, `(() => {
        const table = document.querySelector('table[data-struct-id]');
        if (!table?.classList.contains('frame-sides')) return null;
        const style = getComputedStyle(table);
        return style.borderTopWidth === '0px' && style.borderRightWidth === '1px' && style.borderBottomWidth === '0px' && style.borderLeftWidth === '1px' ? true : null;
      })()`, webviewContextId);
    }, 20_000);
    await evaluate(webview, `(() => {
      const cell = document.querySelectorAll('tbody tr')[0].children[0];
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 600, clientY: 400, view: window }));
      const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Table settings');
      if (!settings) throw new Error('Table settings is not visible after frame rerender');
      settings.click();
      const grid = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Grid lines: No grid lines');
      if (!grid) throw new Error('Grid lines: No grid lines is not visible');
      grid.click();
    })()`, webviewContextId);
    await waitFor('WebView rerendered table grid setting', async () => {
      return evaluate(webview!, `(() => {
        const cell = document.querySelectorAll('tbody tr')[0].children[0];
        if (cell?.getAttribute('data-colsep') !== '0' || cell?.getAttribute('data-rowsep') !== '0') return null;
        const style = getComputedStyle(cell);
        return style.borderRightWidth === '0px' && style.borderBottomWidth === '0px' ? true : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] selecting and drag-resizing the real rendered image');
    const resizeResult = await evaluate(webview, `(() => {
      const image = document.querySelector('img[data-struct-id][data-struct-kind="image"]');
      if (!image) throw new Error('No rendered image found');
      image.click();
      const handle = document.querySelector('[aria-label="Drag to resize image"]');
      if (!handle || getComputedStyle(handle).display === 'none') throw new Error('Image resize handle is not visible');
      const rect = image.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.right,
        clientY: rect.bottom,
        view: window,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: rect.right + 60,
        clientY: rect.bottom,
        view: window,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: rect.right + 60,
        clientY: rect.bottom,
        view: window,
      }));
      return { before: Math.round(rect.width), preview: image.style.width, handle: handle.getAttribute('aria-label') };
    })()`, webviewContextId);
    expect(resizeResult.handle).toBe('Drag to resize image');
    expect(resizeResult.preview).toBe(`${resizeResult.before + 60}px`);

    await waitFor('WebView rerendered image from authored width', async () => {
      return evaluate(webview!, `(() => {
        const image = document.querySelector('img[data-struct-id][data-struct-kind="image"]');
        if (!image || !image.style.width) return null;
        const authoredAttrs = decodeURIComponent(image.getAttribute('data-attrs') || '');
        return authoredAttrs.includes('"width"') ? { width: image.style.width, authoredAttrs } : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] merging a selected cell rectangle from the compact context menu');
    const selectedCellCount = await evaluate(webview, `(() => {
      const row = document.querySelectorAll('tbody tr')[1];
      if (!row || row.children.length !== 2) throw new Error('Expected two cells in the image row');
      const first = row.children[0];
      const second = row.children[1];
      first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, view: window }));
      second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 0, view: window }));
      second.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, view: window }));
      return document.querySelectorAll('td.is-selected, th.is-selected').length;
    })()`, webviewContextId);
    expect(selectedCellCount).toBe(2);
    await waitFor('Merge selected cells availability in compact context menu', async () => evaluate(webview!, `(() => {
      const first = document.querySelectorAll('tbody tr')[1].children[0];
      first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 600, clientY: 500, view: window }));
      const merge = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Merge selected cells');
      return merge && merge.getAttribute('aria-disabled') !== 'true' ? true : null;
    })()`, webviewContextId), 20_000);
    await evaluate(webview, `(() => {
      const merge = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.getAttribute('aria-label') === 'Merge selected cells');
      if (!merge) throw new Error('Merge selected cells disappeared before activation');
      merge.click();
    })()`, webviewContextId);
    await waitFor('selected image row merged into one spanning cell', async () => {
      return evaluate(webview!, `(() => {
        const row = document.querySelectorAll('tbody tr')[1];
        const cell = row && row.children[0];
        return row && row.children.length === 1 && cell && cell.getAttribute('colspan') === '2' ? cell.textContent : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] joining a paragraph into the preceding note with Backspace');
    await evaluate(webview, `(() => {
      const paragraph = Array.from(document.querySelectorAll('p[data-edit-id][contenteditable]'))
        .find((element) => element.textContent === 'Backspace tail');
      if (!paragraph) throw new Error('Backspace target paragraph is not rendered');
      paragraph.scrollIntoView({ block: 'center' });
      paragraph.focus();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`, webviewContextId);
    await dispatchKey(webview, 'Backspace', 'Backspace', 8);
    await waitFor('paragraph joined into preceding note', async () => {
      return evaluate(webview!, `(() => {
        const note = Array.from(document.querySelectorAll('[data-struct-kind="note"]'))
          .find((element) => element.textContent === 'Backspace leadBackspace tail');
        const tail = Array.from(document.querySelectorAll('p[data-edit-id][contenteditable]'))
          .find((element) => element.textContent === 'Backspace tail');
        return note && !tail ? true : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] joining a sole list item across its list wrapper');
    await evaluate(webview, `(() => {
      const item = Array.from(document.querySelectorAll('li[data-edit-id][contenteditable]'))
        .find((element) => element.textContent === 'List tail');
      if (!item) throw new Error('Single-item list Backspace target is not rendered');
      item.focus();
      const range = document.createRange();
      range.selectNodeContents(item);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`, webviewContextId);
    await dispatchKey(webview, 'Backspace', 'Backspace', 8);
    await waitFor('sole list item joined into preceding paragraph', async () => {
      return evaluate(webview!, `(() => {
        const paragraph = Array.from(document.querySelectorAll('p[data-edit-id][contenteditable]'))
          .find((element) => element.textContent === 'List leadList tail');
        const kept = Array.from(document.querySelectorAll('li[data-edit-id][contenteditable]'))
          .find((element) => element.textContent === 'Keep listed');
        return paragraph && kept ? true : null;
      })()`, webviewContextId);
    }, 20_000);

    console.log('[real-webview-e2e] saving active editor');
    await saveActiveEditor(workbench);

    console.log('[real-webview-e2e] waiting for saved file bytes');
    await waitFor('saved file bytes contain entryToAlphabeticList output', async () => {
      const source = await readFile(project.fixture, 'utf8');
      return source.includes('<entry><ol outputclass="lower-alpha">') && source.includes('<li>Alpha beta gamma</li>') ? source : null;
    }, 20_000);
    await waitFor('saved file bytes contain nested image width', async () => {
      const source = await readFile(project.fixture, 'utf8');
      return source.includes('frame="sides"') && source.includes('colsep="0"') && source.includes('rowsep="0"') && source.includes('align="right"') && source.includes('valign="middle"') && source.includes('namest="c1"') && source.includes('nameend="c2"') && /<image href="diagram\.svg" width="\d+px"\/>/.test(source) ? source : null;
    }, 20_000);

    const saved = await readFile(project.fixture, 'utf8');
    expect(saved).toContain('<entry><ol outputclass="lower-alpha">');
    expect(saved).toContain('<li>Alpha beta gamma</li>');
    expect(saved).not.toContain('<entry>Alpha beta gamma</entry>');
    expect(saved).toContain('frame="sides"');
    expect(saved).toContain('colsep="0"');
    expect(saved).toContain('rowsep="0"');
    expect(saved).toContain('align="right"');
    expect(saved).toContain('valign="middle"');
    expect(saved).toContain('namest="c1"');
    expect(saved).toContain('nameend="c2"');
    expect(saved).toMatch(/<image href="diagram\.svg" width="\d+px"\/>/);
    expect(saved).toContain('<note>Backspace leadBackspace tail</note>');
    expect(saved).not.toContain('<p>Backspace tail</p>');
    expect(saved).toContain('<p>List leadList tail</p>');
    expect(saved).not.toContain('<li>List tail</li>');
    expect(saved).toContain('<ul><li>Keep listed</li></ul>');
  } finally {
    console.log('[real-webview-e2e] cleanup');
    if (proc) await quitCode(proc, browser);
    webview?.close();
    workbench?.close();
    browser?.close();
    await rm(project.root, { recursive: true, force: true });
  }
}

(RUN_REAL_E2E ? test : test.skip)(
  'real VS Code WebView toolbar click transforms a direct table entry and saves the file',
  runRealWebviewSmoke,
  TEST_TIMEOUT_MS,
);
