// Aggregate rendered Review for VS Code's Source Control Graph multi-file diff.
// Historical URI pairs are read exactly as supplied by VS Code, then stacked in
// one side-by-side webview. The native multi-diff remains open until this entire
// panel has rendered successfully. It then stays open behind Review so the
// banner can switch back to the complete native XML comparison.

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  renderMultiReviewExportShell,
  renderMultiReviewShell,
  type MultiReviewFile,
} from '../compare/multi-review-shell';
import { renderReviewDocuments } from '../compare/render-review';
import { ReviewExportSnapshotStore, saveReviewExport } from '../compare/review-html-export';
import { buildCanvasHtml } from '../webview/canvas-html';
import { inspectAuthorStyleSource } from './author-style-source';
import { gitRevisionLocation } from './git-revision-uri';
import { createNodeManagedStyleFiles, type ManagedStyleDocument, type ManagedStyleTarget } from './managed-style-persistence';
import {
  createManagedStyleDocumentRefreshHandler,
  matchesManagedStyleDocumentTarget,
} from './managed-style-refresh';
import { makeNonce } from './nonce';
import { redlineManagedStylePresentation } from './redline-managed-style-presentation';
import { renderReviewSources } from './redline-sources';
import { readFileAtRevision, resolveBaseRevision } from './revision-source';
import {
  resolveReviewSelection,
  reviewComparisonIdentity,
  type ReviewComparison,
} from './scm-intercept';
import {
  configureRedlineWebviewResources,
  rewriteRedlineImageSources,
} from './webview-resources';
import {
  canonicalIdentity,
  readWorkspaceVisualSettings,
  resolveVisualWorkspaceFiles,
} from './workspace-files';
import { resolvedWorkspaceWatcherPattern } from './workspace-watcher-path';
import {
  captureReviewExportStylesheets,
  reviewDocumentDirectory,
  reviewExportSaveAdapter,
} from './review-html-export-host';

const MULTI_REDLINE_VIEW_TYPE = 'ditaeditor.multiRedline';
interface MultiRedlineEntry {
  panel: vscode.WebviewPanel;
  exportSnapshots: ReviewExportSnapshotStore;
  subscriptions: vscode.Disposable[];
  managedStyleWatcher: vscode.FileSystemWatcher | null;
  managedStyleWatcherSubscriptions: vscode.Disposable[];
  styleRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  styleRefreshQueue: Promise<void>;
  disposed: boolean;
}
const panels = new Map<string, MultiRedlineEntry>();
const STYLE_REFRESH_DEBOUNCE_MS = 300;

function disposeManagedStyleWatcher(entry: MultiRedlineEntry): void {
  for (const subscription of entry.managedStyleWatcherSubscriptions) subscription.dispose();
  entry.managedStyleWatcherSubscriptions = [];
  entry.managedStyleWatcher?.dispose();
  entry.managedStyleWatcher = null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await transform(values[index], index);
      // Large commits can contain hundreds of topics. Yield between parse/render
      // jobs so other extension-host events are not starved by one long turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function openMultiRedlinePanel(
  context: vscode.ExtensionContext,
  comparisons: readonly ReviewComparison<vscode.Uri>[],
  totalTextDiffs: number,
  title: string,
  debug: vscode.OutputChannel,
): Promise<void> {
  if (comparisons.length === 0) throw new Error('The selected commit has no DITA file comparisons.');
  const key = comparisons.map((comparison) => reviewComparisonIdentity(comparison)).join('\n');
  const existing = panels.get(key);
  if (existing) {
    existing.panel.reveal(undefined, false);
    return;
  }

  const selections = comparisons.map((comparison) => resolveReviewSelection(comparison, {
    fileUri: vscode.Uri.file,
    isInWorkspace: (candidate) => vscode.workspace.getWorkspaceFolder(candidate) !== undefined,
  }));
  for (const selection of selections) {
    if (selection.resource.toString(true) !== selection.document.toString(true)) {
      debug.appendLine(
        `dita-editor: review content URI ${selection.document.toString(true)} uses local resource URI ${selection.resource.toString(true)}.`,
      );
    }
  }
  const first = selections[0];
  const folder = vscode.workspace.getWorkspaceFolder(first.resource);
  const styleFiles = createNodeManagedStyleFiles();
  const settings = readWorkspaceVisualSettings(
    vscode.workspace.getConfiguration('ditaeditor.visual', first.resource),
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
  const documents = (): ManagedStyleDocument[] => vscode.workspace.textDocuments.map((document) => ({
    uri: document.uri.toString(true),
    scheme: document.uri.scheme,
    fsPath: document.uri.fsPath,
    version: document.version,
    dirty: document.isDirty,
    generation: document,
    text: document.getText(),
  }));
  const inspection = await inspectAuthorStyleSource(target, {
    files: styleFiles,
    listDocuments: documents,
    resolveDocumentIdentity: async (fsPath) =>
      canonicalIdentity(await styleFiles.realpath(fsPath), process.platform),
    platform: process.platform,
    log: (message) => debug.appendLine(message),
  });
  let managedStyles = redlineManagedStylePresentation(inspection);
  const exportStylesheets = await captureReviewExportStylesheets({
    extensionUri: context.extensionUri,
    configuredStyleUris: resolved.contentStylesheets.map((stylesheet) => stylesheet.uri),
    authorStylesheet: target && inspection.kind !== 'missing'
      ? { cssText: inspection.sourceText, baseUri: target.uri }
      : undefined,
    managedCssText: target && inspection.kind !== 'missing' ? '' : inspection.renderCssText,
    managedBaseUri: target
      ? vscode.Uri.parse(target.uri, true)
      : vscode.Uri.joinPath(reviewDocumentDirectory(first.resource), 'ditaeditor-managed.css'),
    allowedFileRoots: [
      context.extensionUri,
      ...selections.map((selection) =>
        vscode.workspace.getWorkspaceFolder(selection.resource)?.uri
          ?? reviewDocumentDirectory(selection.resource)
      ),
    ],
  });
  const repositoryBase = await resolveBaseRevision(first.resource.fsPath);
  const openReviewSource = async (uri: vscode.Uri): Promise<{ getText(): string }> => {
    if (repositoryBase !== 'not-in-git') {
      const location = gitRevisionLocation(uri, repositoryBase.repoRoot);
      if (location) {
        const source = await readFileAtRevision({
          ...repositoryBase,
          rev: location.ref,
          relPath: location.relPath,
        });
        if (source === null) {
          throw new Error(`Git could not read ${location.ref}:${location.relPath}.`);
        }
        return { getText: () => source };
      }
    }
    return vscode.workspace.openTextDocument(uri);
  };

  const files = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rendering ${comparisons.length} DITA file${comparisons.length === 1 ? '' : 's'} from the selected commit…`,
      cancellable: false,
    },
    async (progress) => {
      let completed = 0;
      return mapWithConcurrency(selections, 6, async (selection, index): Promise<MultiReviewFile> => {
        const { rendered } = await renderReviewSources(
          selection,
          {
            // Built-in git: URIs are read directly, so GitLens and language
            // extensions do not start tracking 2 virtual documents per file.
            openTextDocument: openReviewSource,
            resolveBaseRevision,
            readFileAtRevision,
          },
          (oldSource, newSource) => renderReviewDocuments(oldSource, newSource, {
            styleNames: managedStyles.styleNames,
            idPrefix: `file-${index + 1}-`,
          }),
        );
        completed += 1;
        progress.report({
          increment: 100 / selections.length,
          message: `${completed}/${selections.length}`,
        });
        return {
          name: path.basename(selection.resource.fsPath),
          path: folder
            ? path.relative(folder.uri.fsPath, selection.resource.fsPath)
            : selection.resource.fsPath,
          changeCount: rendered.inline.changeCount,
          sideBySideHtml: rendered.sideBySide.html,
        };
      });
    },
  );

  const panel = vscode.window.createWebviewPanel(
    MULTI_REDLINE_VIEW_TYPE,
    `Review: ${title}`,
    vscode.ViewColumn.Active,
    {},
  );
  const entry: MultiRedlineEntry = {
    panel,
    exportSnapshots: new ReviewExportSnapshotStore(),
    subscriptions: [],
    managedStyleWatcher: null,
    managedStyleWatcherSubscriptions: [],
    styleRefreshTimer: undefined,
    styleRefreshQueue: Promise.resolve(),
    disposed: false,
  };
  panels.set(key, entry);
  entry.subscriptions.push(panel.webview.onDidReceiveMessage((message: { type?: string } | undefined) => {
    if (message?.type === 'redlineReady') {
      void panel.webview.postMessage(managedStyles.message);
      return;
    }
    if (message?.type === 'authorStylesheetLoadError') {
      debug.appendLine('DITA Editor: repository author stylesheet failed to load in Review Changes.');
      void vscode.window.showErrorMessage('DITA Editor: the repository author stylesheet could not be loaded in Review Changes.');
      return;
    }
    if (message?.type === 'openSourceDiff') {
      void vscode.commands.executeCommand('workbench.action.previousEditor');
      return;
    }
    if (message?.type === 'exportHtml') {
      void saveReviewExport(
        entry.exportSnapshots,
        reviewExportSaveAdapter(
          reviewDocumentDirectory(first.resource),
          debug,
          [
            context.extensionUri,
            ...selections.map((selection) =>
              vscode.workspace.getWorkspaceFolder(selection.resource)?.uri
                ?? reviewDocumentDirectory(selection.resource)
            ),
          ],
        ),
      );
    }
  }));

  const { contentStyleUris, surfaceStyleUri, scriptUris } = configureRedlineWebviewResources({
    webview: panel.webview,
    extensionUri: context.extensionUri,
    resourceUri: first.resource,
    additionalResourceUris: selections.slice(1).map((selection) => selection.resource),
    folder,
    contentStylesheets: resolved.contentStylesheets,
    joinPath: vscode.Uri.joinPath,
  });
  const authorStyleUri = target && inspection.kind !== 'missing'
    ? `${panel.webview.asWebviewUri(vscode.Uri.parse(target.uri)).toString()}?v=${inspection.sourceHash}`
    : undefined;
  managedStyles = redlineManagedStylePresentation(inspection, authorStyleUri);

  const refreshManagedStyles = async (): Promise<void> => {
    const nextInspection = await inspectAuthorStyleSource(target, {
      files: styleFiles,
      listDocuments: documents,
      resolveDocumentIdentity: async (fsPath) =>
        canonicalIdentity(await styleFiles.realpath(fsPath), process.platform),
      platform: process.platform,
      log: (message) => debug.appendLine(message),
    });
    if (entry.disposed) return;
    const nextAuthorStyleUri = target && nextInspection.kind !== 'missing'
      ? `${panel.webview.asWebviewUri(vscode.Uri.parse(target.uri)).toString()}?v=${nextInspection.sourceHash}`
      : undefined;
    managedStyles = redlineManagedStylePresentation(nextInspection, nextAuthorStyleUri);
    await panel.webview.postMessage(managedStyles.message);
  };
  const scheduleManagedStyleRefresh = (): void => {
    if (entry.disposed) return;
    if (entry.styleRefreshTimer !== undefined) clearTimeout(entry.styleRefreshTimer);
    entry.styleRefreshTimer = setTimeout(() => {
      entry.styleRefreshTimer = undefined;
      entry.styleRefreshQueue = entry.styleRefreshQueue
        .then(refreshManagedStyles)
        .catch((error) => {
          if (!entry.disposed) {
            debug.appendLine(`dita-editor: multi-file Review stylesheet refresh failed: ${String(error)}`);
          }
        });
    }, STYLE_REFRESH_DEBOUNCE_MS);
  };
  const refreshForManagedStyleDocument = createManagedStyleDocumentRefreshHandler({
    matches: (document: vscode.TextDocument) => matchesManagedStyleDocumentTarget(
      document,
      target,
      styleFiles,
      process.platform,
    ),
    request: scheduleManagedStyleRefresh,
    log: (message) => debug.appendLine(message),
  });
  entry.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) refreshForManagedStyleDocument(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument(refreshForManagedStyleDocument),
    vscode.workspace.onDidOpenTextDocument(refreshForManagedStyleDocument),
    vscode.workspace.onDidCloseTextDocument(refreshForManagedStyleDocument),
  );
  const watchPattern = folder && target
    ? resolvedWorkspaceWatcherPattern(folder.uri.fsPath, target.lexicalPath, process.platform)
    : null;
  if (folder && watchPattern) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, watchPattern),
    );
    entry.managedStyleWatcher = watcher;
    entry.managedStyleWatcherSubscriptions = [
      watcher.onDidChange(scheduleManagedStyleRefresh),
      watcher.onDidCreate(scheduleManagedStyleRefresh),
      watcher.onDidDelete(scheduleManagedStyleRefresh),
    ];
  }
  panel.onDidDispose(() => {
    entry.disposed = true;
    if (entry.styleRefreshTimer !== undefined) clearTimeout(entry.styleRefreshTimer);
    entry.styleRefreshTimer = undefined;
    disposeManagedStyleWatcher(entry);
    for (const subscription of entry.subscriptions) subscription.dispose();
    panels.delete(key);
  });

  const liveFiles = files.map((file, index) => {
    const resource = selections[index].resource;
    if (resource.scheme !== 'file') return file;
    return {
      ...file,
      sideBySideHtml: rewriteRedlineImageSources(file.sideBySideHtml, (source) => {
        const suffixAt = source.search(/[?#]/);
        const relativePath = suffixAt < 0 ? source : source.slice(0, suffixAt);
        const suffix = suffixAt < 0 ? '' : source.slice(suffixAt);
        const localImage = vscode.Uri.joinPath(
          resource,
          '..',
          relativePath.replace(/\\/g, '/'),
        );
        return `${panel.webview.asWebviewUri(localImage).toString()}${suffix}`;
      }),
    };
  });
  panel.webview.html = buildCanvasHtml({
    bodyHtml: renderMultiReviewShell({
      title,
      files: liveFiles,
      skippedFileCount: Math.max(0, totalTextDiffs - comparisons.length),
    }),
    contentStyleUris,
    authorStyleUri,
    managedStyleCss: '',
    managedStyleConsumer: 'redline',
    surfaceStyleUri,
    // Each topic's relative image URLs are rewritten against its own resource URI.
    // A global base would resolve every later topic against the first topic's folder.
    baseHref: '',
    cspSource: panel.webview.cspSource,
    scriptUris,
    nonce: makeNonce(),
  });
  entry.exportSnapshots.replace({
    title: `Review: ${title}`,
    defaultFilename: 'dita-review-comparison.html',
    bodyHtml: renderMultiReviewExportShell({
      title,
      files,
      skippedFileCount: Math.max(0, totalTextDiffs - comparisons.length),
    }),
    stylesheets: exportStylesheets,
    imageBaseUris: selections.map((selection) =>
      `${reviewDocumentDirectory(selection.resource).toString(true).replace(/\/$/, '')}/`
    ),
  });
}
