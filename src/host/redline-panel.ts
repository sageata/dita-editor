// Review Changes panel: a read-only webview with a merged Track Changes mode
// and an aligned side-by-side rendered mode for one .dita topic. From a native
// diff it preserves that exact
// older/newer document pair; otherwise it compares the working copy (including
// unsaved edits) against its git base revision (merge-base with main, falling
// back to HEAD). Deletions struck red, insertions green, formatting-only changes amber.
// This surface never writes a byte to any document and never opens a
// git:-scheme editor, so the workspace's git→text editorAssociations rule is
// never engaged. Working-copy panels re-render (trailing 300ms debounce) while
// the topic is edited or saved; historical panels retain their exact immutable
// source URIs. The only script the panel loads is media/redline.js (scroll
// persistence across the html swaps).

import * as vscode from 'vscode';
import * as path from 'node:path';
import { renderReviewDocuments } from '../compare/render-review';
import { renderReviewShell } from '../compare/review-shell';
import { buildCanvasHtml } from '../webview/canvas-html';
import { readFileAtRevision, resolveBaseRevision } from './revision-source';
import { configureRedlineWebviewResources } from './webview-resources';
import { makeNonce } from './nonce';
import {
  clearNextManualWorkingCopyDiff,
  markManualSourceDiff,
  markNextManualWorkingCopyDiff,
  reviewComparisonIdentity,
  resolveReviewSelection,
  unmarkManualSourceDiff,
  type ReviewComparison,
  type ReviewSelection,
} from './scm-intercept';
import { renderReviewSources, shouldRefreshReviewContent } from './redline-sources';
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

type RedlineSelection = ReviewSelection<vscode.Uri>;

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
  selection: RedlineSelection,
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
  const refresh = (): void => scheduleRefresh(context, selection, entry, debug);
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
  selection: RedlineSelection,
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
  const refresh = (): void => scheduleRefresh(context, selection, entry, debug);
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

// Full recompute + repaint. Re-resolves the base revision every time (a commit
// made while the panel is open moves the comparison point). The html assignment
// is generation-guarded: if a newer render started while this one awaited git,
// this one drops its result instead of painting stale content.
async function renderIntoPanel(
  context: vscode.ExtensionContext,
  selection: RedlineSelection,
  entry: RedlineEntry,
  debug: vscode.OutputChannel,
): Promise<void> {
  const generation = entry.refreshGeneration.begin();
  if (generation === null) return;

  const folder = vscode.workspace.getWorkspaceFolder(selection.workspace);
  // Friendly formatting labels: className → style name from the workspace's
  // managed author-style sheet, re-inspected per refresh so dirty/refused state
  // and renamed labels cannot diverge from the canvas host.
  const styleFiles = createNodeManagedStyleFiles();
  const settings = readWorkspaceVisualSettings(
    vscode.workspace.getConfiguration('ditaeditor.visual', selection.workspace),
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

  const { label, note, rendered } = await renderReviewSources(
    selection,
    {
      openTextDocument: (uri) => vscode.workspace.openTextDocument(uri),
      resolveBaseRevision,
      readFileAtRevision,
    },
    (oldSource, newSource) => renderReviewDocuments(oldSource, newSource, {
      styleNames: managedStyles.styleNames,
    }),
  );
  const { html: inlineHtml, changeCount } = rendered.inline;

  if (!entry.refreshGeneration.isCurrent(generation)) return;
  entry.managedStylesMessage = managedStyles.message;
  entry.managedStyleTarget = target;
  retargetManagedStyleWatcher(context, selection, entry, debug, folder, target);
  retargetTaxonomyWatcher(
    context,
    selection,
    entry,
    debug,
    folder,
    settings.taxonomyFile,
    resolved.taxonomyFile,
  );

  const { contentStyleUris, surfaceStyleUri, baseHref, scriptUris } = configureRedlineWebviewResources({
    webview: entry.panel.webview,
    extensionUri: context.extensionUri,
    documentUri: selection.workspace,
    folder,
    contentStylesheets: resolved.contentStylesheets,
    joinPath: vscode.Uri.joinPath,
  });
  entry.panel.webview.html = buildCanvasHtml({
    bodyHtml: renderReviewShell({
      label,
      note,
      changeCount,
      inlineHtml,
      sideBySideHtml: rendered.sideBySide.html,
    }),
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
  selection: RedlineSelection,
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
    renderIntoPanel(context, selection, entry, debug).catch((err) => {
      if (entry.refreshGeneration.isDisposed()) return;
      debug.appendLine(`dita-editor: redline refresh failed: ${String(err)}`);
    });
  }, REFRESH_DEBOUNCE_MS);
}

export async function openRedlinePanel(
  context: vscode.ExtensionContext,
  comparison: ReviewComparison<vscode.Uri>,
  debug: vscode.OutputChannel,
): Promise<void> {
  const selection = resolveReviewSelection(comparison, {
    fileUri: vscode.Uri.file,
    isInWorkspace: (candidate) => vscode.workspace.getWorkspaceFolder(candidate) !== undefined,
  });
  if (selection.workspace !== selection.document) {
    debug.appendLine(
      `dita-editor: preserving ${selection.document.scheme}: review content and using the workspace file only for resources for ${path.basename(selection.workspace.fsPath)}.`,
    );
  }
  const key = reviewComparisonIdentity(comparison);
  let entry = panels.get(key);
  let createdThisCall = false;
  if (!entry) {
    const panel = vscode.window.createWebviewPanel(
      REDLINE_VIEW_TYPE,
      `Review: ${path.basename(selection.workspace.fsPath)}`,
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
      request: () => scheduleRefresh(context, selection, created, debug),
      log: (message) => debug.appendLine(message),
    });
    const refreshForTaxonomyDocument = createManagedStyleDocumentRefreshHandler({
      matches: (document: vscode.TextDocument) => matchesManagedStyleDocumentTarget(
        document,
        taxonomyDocumentTarget(created, vscode.workspace.getWorkspaceFolder(selection.workspace)),
        styleFiles,
        process.platform,
      ),
      request: () => scheduleRefresh(context, selection, created, debug),
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
        const historicalDiff = selection.base
          ? { original: selection.base, modified: selection.document }
          : undefined;
        if (historicalDiff) markManualSourceDiff(historicalDiff);
        else markNextManualWorkingCopyDiff(selection.workspace);
        const openDiff = historicalDiff
          ? vscode.commands.executeCommand(
              'vscode.diff',
              historicalDiff.original,
              historicalDiff.modified,
              `${path.basename(selection.workspace.fsPath)} (selected revisions)`,
            )
          : vscode.commands.executeCommand('git.openChange', selection.workspace);
        void Promise.resolve(openDiff).catch((err: unknown) => {
          if (historicalDiff) unmarkManualSourceDiff(historicalDiff);
          else clearNextManualWorkingCopyDiff(selection.workspace);
          debug.appendLine(`dita-editor: opening the side-by-side diff failed: ${String(err)}`);
          void vscode.window.showErrorMessage(
            'DITA Editor: could not open the side-by-side diff (is the built-in Git extension enabled?).',
          );
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) return;
        if (shouldRefreshReviewContent(selection, event.document.uri, (target) => target.toString())) {
          scheduleRefresh(context, selection, created, debug);
        } else refreshForResourceDocument(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (shouldRefreshReviewContent(selection, document.uri, (target) => target.toString())) {
          scheduleRefresh(context, selection, created, debug);
        } else refreshForResourceDocument(document);
      }),
      vscode.workspace.onDidOpenTextDocument(refreshForResourceDocument),
      vscode.workspace.onDidCloseTextDocument(refreshForResourceDocument),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ditaeditor.visual', selection.workspace)) {
          scheduleRefresh(context, selection, created, debug);
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
    createdThisCall = true;
  } else {
    entry.panel.reveal(undefined, false);
  }

  try {
    await renderIntoPanel(context, selection, entry, debug);
  } catch (err) {
    if (createdThisCall) entry.panel.dispose();
    throw err;
  }
}
