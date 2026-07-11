// Review Changes (track-changes) panel: a read-only webview that renders ONE
// merged redline of a .dita topic — working copy (including unsaved buffer
// edits) against its git base revision (merge-base with main, falling back to
// HEAD). Deletions struck red, insertions green, formatting-only changes amber.
// This surface never writes a byte to any document and never opens a
// git:-scheme editor, so the workspace's git→text editorAssociations rule is
// never engaged. Live: the panel re-renders (trailing 300ms debounce) while the
// topic is edited or saved; the base revision is re-resolved on every refresh
// so mid-session commits are picked up. The only script the panel loads is
// media/redline.js (scroll persistence across the html swaps).

import * as vscode from 'vscode';
import * as path from 'node:path';
import { parse } from '../cst/parse';
import { renderRedline } from '../compare/render-redline';
import { buildCanvasHtml } from '../webview/canvas-html';
import { readFileAtRevision, resolveBaseRevision } from './revision-source';
import { configureRedlineWebviewResources } from './webview-resources';
import { makeNonce } from './nonce';
import { markManualSourceDiff } from './scm-intercept';
import { inspectAuthorStyleSource } from './author-style-source';
import {
  redlineManagedStylePresentation,
  type RedlineManagedStylesMessage,
} from './redline-managed-style-presentation';
import {
  createNodeManagedStyleFiles,
  type ManagedStyleDocument,
  type ManagedStyleTarget,
} from './managed-style-persistence';
import {
  createManagedStyleDocumentRefreshHandler,
  matchesManagedStyleDocumentTarget,
} from './managed-style-refresh';
import {
  canonicalIdentity,
  readWorkspaceVisualSettings,
  resolveVisualWorkspaceFiles,
  type ResolvedWorkspaceFile,
} from './workspace-files';
import { resolvedWorkspaceWatcherPattern } from './workspace-watcher-path';
import { createRefreshGeneration, type RefreshGeneration } from './refresh-generation';
import {
  updateWorkspaceResourceWatchTarget,
  workspaceResourceWatcherSpecifications,
  type WorkspaceResourceWatchTarget,
} from './resource-watch-target';

const REDLINE_VIEW_TYPE = 'ditaeditor.redline';
const REFRESH_DEBOUNCE_MS = 300;

interface RedlineEntry {
  panel: vscode.WebviewPanel;
  subscriptions: vscode.Disposable[];
  timer: ReturnType<typeof setTimeout> | undefined;
  managedStylesMessage: RedlineManagedStylesMessage;
  managedStyleTarget: ManagedStyleTarget | null;
  managedStyleWatchKey: string;
  managedStyleWatcher: vscode.FileSystemWatcher | null;
  managedStyleWatcherSubscriptions: vscode.Disposable[];
  taxonomyWatchTarget: WorkspaceResourceWatchTarget | null;
  taxonomyWatchKey: string;
  taxonomyWatchers: vscode.FileSystemWatcher[];
  taxonomyWatcherSubscriptions: vscode.Disposable[];
  refreshGeneration: RefreshGeneration;
}

// One panel per file; re-running the command refreshes it in place.
const panels = new Map<string, RedlineEntry>();

function disposeManagedStyleWatcher(entry: RedlineEntry): void {
  for (const subscription of entry.managedStyleWatcherSubscriptions) subscription.dispose();
  entry.managedStyleWatcherSubscriptions = [];
  entry.managedStyleWatcher?.dispose();
  entry.managedStyleWatcher = null;
  entry.managedStyleWatchKey = '';
}

function retargetManagedStyleWatcher(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  entry: RedlineEntry,
  debug: vscode.OutputChannel,
  folder: vscode.WorkspaceFolder | undefined,
  target: ManagedStyleTarget | null,
): void {
  if (entry.refreshGeneration.isDisposed()) return;
  const nextKey = folder && target
    ? resolvedWorkspaceWatcherPattern(folder.uri.fsPath, target.lexicalPath, process.platform) ?? ''
    : '';
  if (nextKey === entry.managedStyleWatchKey) return;
  disposeManagedStyleWatcher(entry);
  if (!folder || !target || !nextKey) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, nextKey),
  );
  const refresh = (): void => scheduleRefresh(context, uri, entry, debug);
  entry.managedStyleWatcher = watcher;
  entry.managedStyleWatchKey = nextKey;
  entry.managedStyleWatcherSubscriptions = [
    watcher.onDidChange(refresh),
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
  ];
}

function disposeTaxonomyWatcher(entry: RedlineEntry): void {
  for (const subscription of entry.taxonomyWatcherSubscriptions) subscription.dispose();
  entry.taxonomyWatcherSubscriptions = [];
  for (const watcher of entry.taxonomyWatchers) watcher.dispose();
  entry.taxonomyWatchers = [];
  entry.taxonomyWatchKey = '';
}

function taxonomyDocumentTarget(
  entry: RedlineEntry,
  folder: vscode.WorkspaceFolder | undefined,
): ManagedStyleTarget | null {
  if (!folder || !entry.taxonomyWatchTarget) return null;
  return {
    ...entry.taxonomyWatchTarget,
    uri: vscode.Uri.file(entry.taxonomyWatchTarget.lexicalPath).toString(true),
  };
}

function retargetTaxonomyWatcher(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  entry: RedlineEntry,
  debug: vscode.OutputChannel,
  folder: vscode.WorkspaceFolder | undefined,
  configuredPath: string,
  target: ResolvedWorkspaceFile | null,
): void {
  if (entry.refreshGeneration.isDisposed()) return;
  entry.taxonomyWatchTarget = updateWorkspaceResourceWatchTarget({
    current: entry.taxonomyWatchTarget,
    workspaceFsPath: folder?.uri.fsPath ?? null,
    configuredPath,
    resolved: target,
    platform: process.platform,
  });
  const specifications = workspaceResourceWatcherSpecifications(
    entry.taxonomyWatchTarget,
    folder?.uri.fsPath ?? null,
    process.platform,
  );
  const nextKey = specifications.map((specification) => specification.key).sort().join('|');
  if (nextKey === entry.taxonomyWatchKey) return;
  disposeTaxonomyWatcher(entry);
  const refresh = (): void => scheduleRefresh(context, uri, entry, debug);
  entry.taxonomyWatchKey = nextKey;
  for (const specification of specifications) {
    const base = specification.base === 'workspace'
      ? folder!
      : vscode.Uri.file(specification.basePath);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, specification.pattern),
    );
    entry.taxonomyWatchers.push(watcher);
    entry.taxonomyWatcherSubscriptions.push(
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh),
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bannerHtml(label: string, changeCount: number, note: string): string {
  const compared = label
    ? `Comparing with <strong>${escapeHtml(label)}</strong>`
    : 'No version-control base available';
  const count =
    changeCount === 0
      ? 'No changes'
      : `${changeCount} change${changeCount === 1 ? '' : 's'}`;
  const noteHtml = note ? `<span class="redline-banner-note">${escapeHtml(note)}</span>` : '';
  // One-click switch to the native side-by-side git diff (only meaningful when
  // a git base exists). media/redline.js posts the data-redline-action back
  // here; the intercept in extension.ts is told to leave that diff tab alone.
  const sourceDiffBtn = label
    ? '<button type="button" class="redline-banner-btn" data-redline-action="openSourceDiff" title="Open the raw XML changes in the standard side-by-side diff">Side-by-side XML diff</button>'
    : '';
  return `<div class="redline-banner"><span>${compared}</span>${noteHtml}${sourceDiffBtn}<span class="redline-banner-count">${count}</span></div>`;
}

// Full recompute + repaint. Re-resolves the base revision every time (a commit
// made while the panel is open moves the comparison point). The html assignment
// is generation-guarded: if a newer render started while this one awaited git,
// this one drops its result instead of painting stale content.
async function renderIntoPanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  entry: RedlineEntry,
  debug: vscode.OutputChannel,
): Promise<void> {
  const generation = entry.refreshGeneration.begin();
  if (generation === null) return;

  // New side: the open document, so unsaved edits are part of the review.
  const document = await vscode.workspace.openTextDocument(uri);
  const newDoc = parse(document.getText());

  const base = await resolveBaseRevision(uri.fsPath);
  let label = '';
  let note = '';
  let oldSource = '';
  if (base === 'not-in-git') {
    note = 'This file is not under version control — the whole topic shows as new.';
  } else {
    label = base.label;
    const atBase = await readFileAtRevision(base);
    if (atBase === null) {
      note = `New topic — it does not exist in ${base.label}.`;
    } else {
      oldSource = atBase;
    }
  }
  // parse('') yields an empty document, which diffs as "everything inserted" —
  // exactly the right presentation for a new/untracked topic.
  const oldDoc = parse(oldSource);

  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Friendly formatting labels: className → style name from the workspace's
  // managed author-style sheet, re-inspected per refresh so dirty/refused state
  // and renamed labels cannot diverge from the canvas host.
  const styleFiles = createNodeManagedStyleFiles();
  const settings = readWorkspaceVisualSettings(
    vscode.workspace.getConfiguration('ditaeditor.visual', uri),
  );
  const resolved = await resolveVisualWorkspaceFiles({
    folder,
    trusted: vscode.workspace.isTrusted,
    settings,
    joinPath: vscode.Uri.joinPath,
    files: styleFiles,
    platform: process.platform,
    log: (message) => debug.appendLine(message),
  });
  const target: ManagedStyleTarget | null = resolved.managedAuthorStylesheet === null
    ? null
    : {
        configuredPath: resolved.managedAuthorStylesheet.configuredPath,
        uri: resolved.managedAuthorStylesheet.uri.toString(true),
        lexicalPath: resolved.managedAuthorStylesheet.uri.fsPath,
        canonicalPath: resolved.managedAuthorStylesheet.canonicalPath,
        identity: resolved.managedAuthorStylesheet.identity,
      };
  const documents = (): ManagedStyleDocument[] => vscode.workspace.textDocuments.map((styleDocument) => ({
    uri: styleDocument.uri.toString(true),
    scheme: styleDocument.uri.scheme,
    fsPath: styleDocument.uri.fsPath,
    version: styleDocument.version,
    dirty: styleDocument.isDirty,
    generation: styleDocument,
    text: styleDocument.getText(),
  }));
  const inspection = await inspectAuthorStyleSource(target, {
    files: styleFiles,
    listDocuments: documents,
    resolveDocumentIdentity: async (fsPath) =>
      canonicalIdentity(await styleFiles.realpath(fsPath), process.platform),
    platform: process.platform,
    log: (message) => debug.appendLine(message),
  });
  const managedStyles = redlineManagedStylePresentation(inspection);

  const { html, changeCount } = renderRedline(oldDoc, newDoc, {
    styleNames: managedStyles.styleNames,
  });

  if (!entry.refreshGeneration.isCurrent(generation)) return;
  entry.managedStylesMessage = managedStyles.message;
  entry.managedStyleTarget = target;
  retargetManagedStyleWatcher(context, uri, entry, debug, folder, target);
  retargetTaxonomyWatcher(
    context,
    uri,
    entry,
    debug,
    folder,
    settings.taxonomyFile,
    resolved.taxonomyFile,
  );

  const { contentStyleUris, surfaceStyleUri, baseHref, scriptUris } = configureRedlineWebviewResources({
    webview: entry.panel.webview,
    extensionUri: context.extensionUri,
    documentUri: uri,
    folder,
    contentStylesheets: resolved.contentStylesheets,
    joinPath: vscode.Uri.joinPath,
  });
  entry.panel.webview.html = buildCanvasHtml({
    bodyHtml: bannerHtml(label, changeCount, note) + html,
    contentStyleUris,
    managedStyleCss: inspection.renderCssText,
    managedStyleConsumer: 'redline',
    surfaceStyleUri,
    baseHref,
    cspSource: entry.panel.webview.cspSource,
    scriptUris,
    nonce: makeNonce(),
  });
}

// Trailing debounce: the LAST keystroke wins, then one render. A refresh
// failure keeps the last good html (never blank the panel mid-typing) and
// logs instead.
function scheduleRefresh(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  entry: RedlineEntry,
  debug: vscode.OutputChannel,
): void {
  if (entry.refreshGeneration.isDisposed()) return;
  // Cancel any render already awaiting Git/filesystem work. The debounced
  // render gets a fresh generation when it starts.
  entry.refreshGeneration.invalidate();
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    renderIntoPanel(context, uri, entry, debug).catch((err) => {
      if (entry.refreshGeneration.isDisposed()) return;
      debug.appendLine(`dita-editor: redline refresh failed: ${String(err)}`);
    });
  }, REFRESH_DEBOUNCE_MS);
}

export async function openRedlinePanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  debug: vscode.OutputChannel,
): Promise<void> {
  const key = uri.toString();
  let entry = panels.get(key);
  if (!entry) {
    const panel = vscode.window.createWebviewPanel(
      REDLINE_VIEW_TYPE,
      `Review: ${path.basename(uri.fsPath)}`,
      vscode.ViewColumn.Active,
      {},
    );
    const created: RedlineEntry = {
      panel,
      subscriptions: [],
      timer: undefined,
      managedStylesMessage: { type: 'managedStyles', cssText: '' },
      managedStyleTarget: null,
      managedStyleWatchKey: '',
      managedStyleWatcher: null,
      managedStyleWatcherSubscriptions: [],
      taxonomyWatchTarget: null,
      taxonomyWatchKey: '',
      taxonomyWatchers: [],
      taxonomyWatcherSubscriptions: [],
      refreshGeneration: createRefreshGeneration(),
    };
    const styleFiles = createNodeManagedStyleFiles();
    const refreshForManagedStyleDocument = createManagedStyleDocumentRefreshHandler({
      matches: (document: vscode.TextDocument) => matchesManagedStyleDocumentTarget(
        document,
        created.managedStyleTarget,
        styleFiles,
        process.platform,
      ),
      request: () => scheduleRefresh(context, uri, created, debug),
      log: (message) => debug.appendLine(message),
    });
    const refreshForTaxonomyDocument = createManagedStyleDocumentRefreshHandler({
      matches: (document: vscode.TextDocument) => matchesManagedStyleDocumentTarget(
        document,
        taxonomyDocumentTarget(created, vscode.workspace.getWorkspaceFolder(uri)),
        styleFiles,
        process.platform,
      ),
      request: () => scheduleRefresh(context, uri, created, debug),
      log: (message) => debug.appendLine(message),
    });
    const refreshForResourceDocument = (document: vscode.TextDocument): void => {
      refreshForManagedStyleDocument(document);
      refreshForTaxonomyDocument(document);
    };
    created.subscriptions.push(
      // Banner "Side-by-side XML diff" button: open the native git diff for
      // this file. The file is marked first so the SCM intercept leaves the
      // requested diff tab alone (Review becomes the default again once the
      // user closes that tab).
      panel.webview.onDidReceiveMessage((msg: { type?: string } | undefined) => {
        if (msg?.type === 'redlineReady') {
          void panel.webview.postMessage(created.managedStylesMessage);
          return;
        }
        if (msg?.type !== 'openSourceDiff') return;
        markManualSourceDiff(uri.fsPath);
        void Promise.resolve(vscode.commands.executeCommand('git.openChange', uri)).catch((err: unknown) => {
          debug.appendLine(`dita-editor: opening the side-by-side diff failed: ${String(err)}`);
          void vscode.window.showErrorMessage(
            'DITA Editor: could not open the side-by-side diff (is the built-in Git extension enabled?).',
          );
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) return;
        const changed = event.document.uri.toString();
        if (changed === key) scheduleRefresh(context, uri, created, debug);
        else refreshForResourceDocument(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const saved = document.uri.toString();
        if (saved === key) scheduleRefresh(context, uri, created, debug);
        else refreshForResourceDocument(document);
      }),
      vscode.workspace.onDidOpenTextDocument(refreshForResourceDocument),
      vscode.workspace.onDidCloseTextDocument(refreshForResourceDocument),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ditaeditor.visual', uri)) {
          scheduleRefresh(context, uri, created, debug);
        }
      }),
    );
    panel.onDidDispose(() => {
      created.refreshGeneration.dispose();
      if (created.timer !== undefined) clearTimeout(created.timer);
      created.timer = undefined;
      disposeManagedStyleWatcher(created);
      disposeTaxonomyWatcher(created);
      for (const subscription of created.subscriptions) subscription.dispose();
      panels.delete(key);
    });
    panels.set(key, created);
    entry = created;
  } else {
    entry.panel.reveal(undefined, false);
  }

  await renderIntoPanel(context, uri, entry, debug);
}
