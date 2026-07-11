import * as vscode from 'vscode';
import { hostname } from 'node:os';
import { minimalEdit } from '../cst/edit-bridge';
import { newTopicSkeleton } from '../cst/new-topic';
import {
  type StructuralOp,
  type StructuralPayload,
} from '../cst/structural';
import type { InsertKind } from '../commands/insert-ops';
import type { TransformType } from '../commands/transform-ops';
import {
  historyCommandForOp,
  isAuthorizedAttributeMessageType,
  isRangeActionType,
  type CanvasMessage,
  type RangeActionAvailability,
} from '../webview/canvas-messages';
import { buildCanvasHtml } from '../webview/canvas-html';
import { applyElementAttribute, applyElementAttributeToIds, applyTgroupAttributes } from './attribute-actions';
import { authorizeAttributeMessage, type AuthorizedAttributeAction } from './attribute-authorization';
import { pickAndApplyImageHref, pickImageHrefForInsert, promptAndApplyImageAlt } from './image-actions';
import {
  editInlineText,
  formatInlineBlocks,
  formatInlineSelection,
  insertInlineElement,
  removeInlineStylesFromBlocks,
  removeInlineStylesFromSelection,
  type InlineInsertResolution,
  type InlineInsertSpec,
} from './inline-actions';
import { applyInsertAction } from './insert-actions';
import { applyLineBreakAction } from './line-break-actions';
import { insertDitaFragment, sliceElements } from './dita-clipboard';
import { openSiblingTopic } from './topic-nav';
import { lintDitaSource } from '../cst/dita-quality';
import { mapLintToIds } from '../webview/lint-map';
import { executeRangeAction, queryRangeActions } from './range-actions';
import { createVisualRenderState } from './render-state';
import { applyOutputClassStyleToIds } from './style-actions';
import {
  applyPersistedShadeToIds,
  createStyleSaveResultReplayCache,
  isValidStyleSaveRequestId,
  managedStyleSaveIntent,
  managedStyleTargetToken,
  runTargetBoundManagedStyleSave,
  runManagedStyleSaveRequest,
  styleSaveResultMessage,
  type ManagedStyleSaveOutcome,
} from './managed-style-actions';
import { applyMultiTransformAction, applyStructuralAction, applyTransformAction } from './structural-actions';
import { applyTableColumnWidthAction } from './table-column-width-actions';
import { createVisualActionContexts, type ApplyMinimalHistory } from './action-contexts';
import { configureVisualWebviewResources } from './webview-resources';
import { makeNonce } from './nonce';
import { inspectAuthorStyleSource } from './author-style-source';
import {
  createNodeManagedStyleFiles,
  persistManagedAuthorStylesheet,
  type ManagedStyleDocument,
  type ManagedStyleTarget,
  type ResolvedManagedStyleTarget,
} from './managed-style-persistence';
import {
  createManagedStyleDocumentRefreshHandler,
  createManagedStyleRefreshCoordinator,
  matchesManagedStyleDocumentTarget,
  reconcileManagedStyleSave,
  sameManagedStyleRefreshSnapshot,
  subscribeManagedStyleRefreshEvents,
} from './managed-style-refresh';
import { resolvedWorkspaceWatcherPattern } from './workspace-watcher-path';
import {
  updateWorkspaceResourceWatchTarget,
  workspaceResourceWatcherSpecifications,
  type WorkspaceResourceWatchTarget,
} from './resource-watch-target';
import {
  canonicalIdentity,
  readWorkspaceVisualSettings,
  resolveVisualWorkspaceFiles,
  type ResolvedVisualWorkspaceFiles,
  type ResolvedWorkspaceFile,
  type WorkspaceVisualSettings,
} from './workspace-files';
import {
  shadeClassNameForColor,
  type AuthorStyleDefinition,
  type AuthorStyleState,
} from '../styles/author-styles';
import { loadTaxonomyFile, type TaxonomyConfig } from '../config/taxonomy';
import {
  createTaxonomyStateCoordinator,
  readRevalidatedTaxonomyResource,
  type TaxonomyResourceIdentity,
} from './taxonomy-state';

export const VIEW_TYPE = 'ditaeditor.visual';

// Host-side discoverability surface, owned by activate() and shared with the
// provider: a Problems DiagnosticCollection for refused/stale ops, plus the
// active-editor + dirty-state tracking that drives the status-bar trust indicator.
export interface VisualHost {
  diagnostics: vscode.DiagnosticCollection;
  /** Named Output channel ("DITA Editor") for inbound-message + refusal tracing.
   *  Before this, all logging went to console.* (extension-host Developer Tools), so the
   *  Output-panel "DITA Editor" entry QA inspected was empty because it never existed.
   *  Anything written here is inspectable from the Output dropdown. */
  debug: vscode.OutputChannel;
  /** Called when a visual editor gains/loses active focus; drives the status bar. */
  notifyActive(doc: vscode.TextDocument, active: boolean): void;
  /** Re-read the active document's dirty state into the status bar on the NEXT tick.
   *  Deferred on purpose: a programmatic workspace.applyEdit commits the document's
   *  dirty flag AFTER onDidChangeTextDocument fires, so a synchronous isDirty read
   *  inside the change handler is stale. Reading next-tick sees the settled flag. */
  scheduleStatusRefresh(): void;
}

export class DitaVisualEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: VisualHost,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const { webview } = webviewPanel;
    let folder = vscode.workspace.getWorkspaceFolder(document.uri);
    let disposed = false;
    let disposeEditorResources = (): void => {};
    let disposeEarlyTaxonomy = (): void => {};
    const earlyDispose = webviewPanel.onDidDispose(() => {
      disposed = true;
      disposeEarlyTaxonomy();
      disposeEditorResources();
    });

    // One image cache-bust token per webview session: images cache within the session
    // (no re-fetch on rerender) but re-fetch on each open/Reload Window, so a replaced or
    // removed image on disk reflects instead of serving a stale webview cache.
    const imageVersion = makeNonce();

    // The render state owns the latest nav/cmd/insert/transform/docProps maps.
    // It always derives them from the SAME parsed doc renderEditable stamped ids
    // from. Empty maps/null docProps are exposed when parse fails.
    const renderState = createVisualRenderState(document, imageVersion);
    const styleFiles = createNodeManagedStyleFiles();
    const styleLog = (message: string): void => this.host.debug.appendLine(message);
    const readVisualSettings = (): WorkspaceVisualSettings => readWorkspaceVisualSettings(
      vscode.workspace.getConfiguration('ditaeditor.visual', document.uri),
    );
    const resolveWorkspaceFileConfiguration = (
      settings: WorkspaceVisualSettings = readVisualSettings(),
      log: (message: string) => void = styleLog,
    ): Promise<ResolvedVisualWorkspaceFiles> =>
      resolveVisualWorkspaceFiles({
        folder,
        trusted: vscode.workspace.isTrusted,
        settings,
        joinPath: vscode.Uri.joinPath,
        files: styleFiles,
        platform: process.platform,
        log,
      });
    const toManagedTarget = (file: ResolvedWorkspaceFile): ManagedStyleTarget => ({
      configuredPath: file.configuredPath,
      uri: file.uri.toString(true),
      lexicalPath: file.uri.fsPath,
      canonicalPath: file.canonicalPath,
      identity: file.identity,
    });
    const managedStyleResolution = (
      resolved: ResolvedVisualWorkspaceFiles,
    ): ResolvedManagedStyleTarget | null => {
      return resolved.managedAuthorStylesheet === null
        ? null
        : {
            target: toManagedTarget(resolved.managedAuthorStylesheet),
            exists: resolved.managedAuthorStylesheetExists,
          };
    };
    const resolveManagedStyleTarget = async (): Promise<ResolvedManagedStyleTarget | null> =>
      managedStyleResolution(await resolveWorkspaceFileConfiguration());
    const managedStyleDocuments = (): ManagedStyleDocument[] =>
      vscode.workspace.textDocuments.map((styleDocument) => ({
        uri: styleDocument.uri.toString(true),
        scheme: styleDocument.uri.scheme,
        fsPath: styleDocument.uri.fsPath,
        version: styleDocument.version,
        dirty: styleDocument.isDirty,
        generation: styleDocument,
        text: styleDocument.getText(),
      }));
    const resolveDocumentIdentity = async (fsPath: string): Promise<string> =>
      canonicalIdentity(await styleFiles.realpath(fsPath), process.platform);
    const styleSourceDependencies = {
      files: styleFiles,
      listDocuments: managedStyleDocuments,
      resolveDocumentIdentity,
      platform: process.platform,
      log: styleLog,
    };
    let workspaceVisualSettings = readVisualSettings();
    const initialResolutionLogs: string[] = [];
    let resolvedWorkspaceFiles = await resolveWorkspaceFileConfiguration(
      workspaceVisualSettings,
      (message) => initialResolutionLogs.push(message),
    );
    if (disposed) {
      earlyDispose.dispose();
      return;
    }
    for (const message of initialResolutionLogs) styleLog(message);
    let currentTaxonomy: TaxonomyConfig | null = null;
    const taxonomyState = createTaxonomyStateCoordinator({
      publish: (taxonomy) => {
        currentTaxonomy = taxonomy;
        if (!disposed) void webview.postMessage({ type: 'taxonomyState', taxonomy });
      },
      log: styleLog,
    });
    disposeEarlyTaxonomy = () => taxonomyState.dispose();
    let taxonomyResolutionGeneration = 0;
    let taxonomyConfiguredPath = workspaceVisualSettings.taxonomyFile;
    let resolvedTaxonomyFile = resolvedWorkspaceFiles.taxonomyFile;
    const taxonomyIdentity = (file: ResolvedWorkspaceFile): string =>
      `${file.configuredPath}\u0000${file.identity}\u0000${file.uri.toString(true)}`;
    const taxonomyResourceIdentity = (file: ResolvedWorkspaceFile | null): TaxonomyResourceIdentity | null =>
      file && {
        configuredPath: file.configuredPath,
        identity: file.identity,
        uri: file.uri.toString(true),
      };
    const readTaxonomyBytes = async (
      file: ResolvedWorkspaceFile,
      preferOpenDocument: boolean,
    ): Promise<Uint8Array> => {
      return readRevalidatedTaxonomyResource({
        resolved: taxonomyResourceIdentity(file)!,
        read: async () => {
          if (preferOpenDocument) {
            const target = toManagedTarget(file);
            for (const openDocument of vscode.workspace.textDocuments) {
              if (await matchesManagedStyleDocumentTarget(openDocument, target, styleFiles, process.platform)) {
                return new TextEncoder().encode(openDocument.getText());
              }
            }
          }
          // Read the already-resolved canonical target, not a lexical symlink
          // that may have been replaced after validation.
          return vscode.workspace.fs.readFile(vscode.Uri.file(file.canonicalPath));
        },
        reResolve: async () => taxonomyResourceIdentity(
          (await resolveWorkspaceFileConfiguration(readVisualSettings(), () => undefined)).taxonomyFile,
        ),
      });
    };
    const refreshResolvedTaxonomy = async (
      file: ResolvedWorkspaceFile | null,
      preferOpenDocument = true,
    ): Promise<boolean> => {
      if (!file) {
        taxonomyState.invalidate(null);
        return false;
      }
      return taxonomyState.refresh({
        identity: taxonomyIdentity(file),
        load: (log) => loadTaxonomyFile({
          configuredPath: file.configuredPath,
          uri: file.uri,
          readFile: () => readTaxonomyBytes(file, preferOpenDocument),
          log,
        }),
      });
    };
    await refreshResolvedTaxonomy(resolvedTaxonomyFile);
    if (disposed) {
      taxonomyState.dispose();
      earlyDispose.dispose();
      return;
    }
    let webviewResources = configureVisualWebviewResources({
      webview,
      extensionUri: this.context.extensionUri,
      documentUri: document.uri,
      folder,
      contentStylesheets: resolvedWorkspaceFiles.contentStylesheets,
      joinPath: vscode.Uri.joinPath,
    });
    const managedResolution = managedStyleResolution(resolvedWorkspaceFiles);
    let authorStyleTarget = managedResolution?.target ?? null;
    let authorStyleInspection = await inspectAuthorStyleSource(authorStyleTarget, styleSourceDependencies);
    if (disposed) {
      taxonomyState.dispose();
      earlyDispose.dispose();
      return;
    }
    const authorStyleState = (): AuthorStyleState => ({
      styles: authorStyleInspection.styles,
      cssText: authorStyleInspection.renderCssText,
      writable: authorStyleTarget !== null && authorStyleInspection.writable,
      cssPath: authorStyleTarget?.lexicalPath,
      error: authorStyleInspection.error,
      sourceHash: authorStyleInspection.sourceHash,
      targetToken: managedStyleTargetToken(authorStyleTarget),
    });

    const loadManagedStyleSnapshot = async () => {
      const resolution = await resolveManagedStyleTarget();
      const target = resolution?.target ?? null;
      const inspection = await inspectAuthorStyleSource(target, styleSourceDependencies);
      return { target, inspection };
    };
    const styleRefresh = createManagedStyleRefreshCoordinator({
      load: loadManagedStyleSnapshot,
      publish: ({ target, inspection }) => {
        if (disposed) return;
        if (sameManagedStyleRefreshSnapshot(
          { target: authorStyleTarget, inspection: authorStyleInspection },
          { target, inspection },
        )) return;
        authorStyleTarget = target;
        authorStyleInspection = inspection;
        void webview.postMessage({ type: 'styleState', styleState: authorStyleState() });
      },
      log: styleLog,
    });
    const requestStyleReload = (): void => {
      if (!disposed) styleRefresh.request();
    };

    // Bidirectional freshness: disk events and matching VS Code document lifecycle
    // events re-inspect the complete source, including dirty/noncanonical buffers.
    let styleWatcher: vscode.FileSystemWatcher | null = null;
    let styleWatcherPattern = '';
    let styleWatcherSubscriptions: vscode.Disposable[] = [];
    const disposeStyleWatcher = (): void => {
      for (const subscription of styleWatcherSubscriptions) subscription.dispose();
      styleWatcherSubscriptions = [];
      styleWatcher?.dispose();
      styleWatcher = null;
      styleWatcherPattern = '';
    };
    const retargetStyleWatcher = (): void => {
      const nextPattern = authorStyleTarget && folder
        ? resolvedWorkspaceWatcherPattern(folder.uri.fsPath, authorStyleTarget.lexicalPath, process.platform)
        : null;
      if ((nextPattern ?? '') === styleWatcherPattern) return;
      disposeStyleWatcher();
      if (!nextPattern || !folder) return;
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, nextPattern),
      );
      styleWatcher = watcher;
      styleWatcherPattern = nextPattern;
      styleWatcherSubscriptions = [
        watcher.onDidChange(requestStyleReload),
        watcher.onDidCreate(requestStyleReload),
        watcher.onDidDelete(requestStyleReload),
      ];
    };
    let taxonomyWatchTarget: WorkspaceResourceWatchTarget | null =
      updateWorkspaceResourceWatchTarget({
        current: null,
        workspaceFsPath: folder?.uri.fsPath ?? null,
        configuredPath: workspaceVisualSettings.taxonomyFile,
        resolved: resolvedWorkspaceFiles.taxonomyFile,
        platform: process.platform,
      });
    let taxonomyWatchers: vscode.FileSystemWatcher[] = [];
    let taxonomyWatcherKey = '';
    let taxonomyWatcherSubscriptions: vscode.Disposable[] = [];
    let requestWorkspaceConfigurationReload = (): void => {};
    const requestTaxonomyReload = (preferOpenDocument = true): void => {
      if (disposed) return;
      const generation = ++taxonomyResolutionGeneration;
      taxonomyState.supersede();
      const nextSettings = readVisualSettings();
      if (!vscode.workspace.isTrusted || nextSettings.taxonomyFile !== taxonomyConfiguredPath) {
        taxonomyState.invalidate(nextSettings.taxonomyFile
          ? `pending:${nextSettings.taxonomyFile}`
          : null);
      }
      void (async () => {
        const pendingLogs: string[] = [];
        try {
          const nextResolved = await resolveWorkspaceFileConfiguration(
            nextSettings,
            (message) => pendingLogs.push(message),
          );
          if (disposed || generation !== taxonomyResolutionGeneration) return;
          taxonomyConfiguredPath = nextSettings.taxonomyFile;
          resolvedTaxonomyFile = nextResolved.taxonomyFile;
          updateTaxonomyWatchTarget(nextSettings, nextResolved);
          retargetTaxonomyWatcher();
          await refreshResolvedTaxonomy(resolvedTaxonomyFile, preferOpenDocument);
          if (disposed || generation !== taxonomyResolutionGeneration) return;
          for (const message of pendingLogs) styleLog(message);
        } catch (error) {
          if (disposed || generation !== taxonomyResolutionGeneration) return;
          taxonomyState.invalidate(null);
          styleLog(`[taxonomy] ${nextSettings.taxonomyFile}: refresh failed: ${String(error)}`);
        }
      })();
    };
    const updateTaxonomyWatchTarget = (
      settings: WorkspaceVisualSettings,
      resolved: ResolvedVisualWorkspaceFiles,
    ): void => {
      taxonomyWatchTarget = updateWorkspaceResourceWatchTarget({
        current: taxonomyWatchTarget,
        workspaceFsPath: folder?.uri.fsPath ?? null,
        configuredPath: settings.taxonomyFile,
        resolved: resolved.taxonomyFile,
        platform: process.platform,
      });
    };
    const taxonomyDocumentTarget = (): ManagedStyleTarget | null => {
      if (!taxonomyWatchTarget) return null;
      return {
        ...taxonomyWatchTarget,
        uri: vscode.Uri.file(taxonomyWatchTarget.lexicalPath).toString(true),
      };
    };
    const disposeTaxonomyWatcher = (): void => {
      for (const subscription of taxonomyWatcherSubscriptions) subscription.dispose();
      taxonomyWatcherSubscriptions = [];
      for (const watcher of taxonomyWatchers) watcher.dispose();
      taxonomyWatchers = [];
      taxonomyWatcherKey = '';
    };
    const retargetTaxonomyWatcher = (): void => {
      const specifications = workspaceResourceWatcherSpecifications(
        taxonomyWatchTarget,
        folder?.uri.fsPath ?? null,
        process.platform,
      );
      const nextKey = specifications.map((specification) => specification.key).sort().join('|');
      if (nextKey === taxonomyWatcherKey) return;
      disposeTaxonomyWatcher();
      const refreshFromDisk = (): void => requestTaxonomyReload(false);
      taxonomyWatcherKey = nextKey;
      for (const specification of specifications) {
        const base = specification.base === 'workspace'
          ? folder!
          : vscode.Uri.file(specification.basePath);
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(base, specification.pattern),
        );
        taxonomyWatchers.push(watcher);
        taxonomyWatcherSubscriptions.push(
          watcher.onDidChange(refreshFromDisk),
          watcher.onDidCreate(refreshFromDisk),
          watcher.onDidDelete(() => {
            taxonomyState.invalidate(null);
            refreshFromDisk();
          }),
        );
      }
    };
    const matchesCurrentStyleTarget = async (styleDocument: vscode.TextDocument): Promise<boolean> => {
      return matchesManagedStyleDocumentTarget(
        styleDocument,
        authorStyleTarget,
        styleFiles,
        process.platform,
      );
    };
    const reloadForStyleDocument = createManagedStyleDocumentRefreshHandler({
      matches: matchesCurrentStyleTarget,
      request: requestStyleReload,
      log: styleLog,
    });
    const styleRefreshSubscriptions = subscribeManagedStyleRefreshEvents({
      document: {
        onDidChange: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
        onDidOpen: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
        onDidSave: (listener) => vscode.workspace.onDidSaveTextDocument(listener),
        onDidClose: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
      },
    }, requestStyleReload, reloadForStyleDocument);
    const reloadForTaxonomyDocument = createManagedStyleDocumentRefreshHandler({
      matches: (taxonomyDocument: vscode.TextDocument) => matchesManagedStyleDocumentTarget(
        taxonomyDocument,
        taxonomyDocumentTarget(),
        styleFiles,
        process.platform,
      ),
      request: requestTaxonomyReload,
      // Identity failures trigger a fresh Task 3 resolution below; the current
      // generation owns the only user-visible log.
      log: () => undefined,
    });
    const taxonomyRefreshSubscriptions = subscribeManagedStyleRefreshEvents({
      document: {
        onDidChange: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
        onDidOpen: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
        onDidSave: (listener) => vscode.workspace.onDidSaveTextDocument(listener),
        onDidClose: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
      },
    }, requestTaxonomyReload, reloadForTaxonomyDocument);

    // Full webview (re)load — used once on open and for hard resyncs. Reassigning
    // webview.html reloads the iframe (flicker, lost scroll), so structural and
    // external edits use pushBody instead.
    const render = (focusId?: string | null) => {
      const { contentStyleUris, surfaceStyleUri, baseHref, scriptUris } = webviewResources;
      webview.html = buildCanvasHtml({
        bodyHtml: renderState.renderBody(focusId),
        contentStyleUris,
        managedStyleCss: authorStyleInspection.renderCssText,
        managedStyleConsumer: 'canvas',
        surfaceStyleUri,
        baseHref,
        cspSource: webview.cspSource,
        scriptUris,
        nonce: makeNonce(),
        taxonomy: currentTaxonomy,
      });
    };

    // Resource-scoped settings may differ across workspace folders. Re-resolve
    // this document only, retarget the managed-file watcher, and rebuild the
    // ordered stylesheet links. A generation guard prevents a slower older
    // configuration read from repainting after a newer change.
    let configurationGeneration = 0;
    requestWorkspaceConfigurationReload = (): void => {
      if (disposed) return;
      // Invalidate any old-target file refresh before resolving the new
      // resource-scoped configuration. The coordinator's latest generation
      // may still publish, but it will resolve the same new settings.
      requestStyleReload();
      const generation = ++configurationGeneration;
      const taxonomyGeneration = ++taxonomyResolutionGeneration;
      taxonomyState.supersede();
      void (async () => {
        const pendingLogs: string[] = [];
        try {
          const nextSettings = readVisualSettings();
          if (!vscode.workspace.isTrusted || nextSettings.taxonomyFile !== taxonomyConfiguredPath) {
            taxonomyState.invalidate(nextSettings.taxonomyFile
              ? `pending:${nextSettings.taxonomyFile}`
              : null);
          }
          const nextResolved = await resolveWorkspaceFileConfiguration(
            nextSettings,
            (message) => pendingLogs.push(message),
          );
          const nextResolution = managedStyleResolution(nextResolved);
          const nextTarget = nextResolution?.target ?? null;
          const nextInspection = await inspectAuthorStyleSource(nextTarget, styleSourceDependencies);
          if (disposed || generation !== configurationGeneration) return;
          workspaceVisualSettings = nextSettings;
          resolvedWorkspaceFiles = nextResolved;
          authorStyleTarget = nextTarget;
          authorStyleInspection = nextInspection;
          webviewResources = configureVisualWebviewResources({
            webview,
            extensionUri: this.context.extensionUri,
            documentUri: document.uri,
            folder,
            contentStylesheets: resolvedWorkspaceFiles.contentStylesheets,
            joinPath: vscode.Uri.joinPath,
          });
          retargetStyleWatcher();
          if (taxonomyGeneration === taxonomyResolutionGeneration) {
            taxonomyConfiguredPath = nextSettings.taxonomyFile;
            resolvedTaxonomyFile = nextResolved.taxonomyFile;
            updateTaxonomyWatchTarget(nextSettings, nextResolved);
            retargetTaxonomyWatcher();
            await refreshResolvedTaxonomy(resolvedTaxonomyFile);
          }
          if (disposed || generation !== configurationGeneration) return;
          for (const message of pendingLogs) {
            if (
              taxonomyGeneration !== taxonomyResolutionGeneration &&
              message.includes('ditaeditor.visual.taxonomyFile')
            ) continue;
            styleLog(message);
          }
          render();
        } catch (error) {
          if (!disposed && generation === configurationGeneration) {
            styleLog(`DITA Editor stylesheet configuration refresh failed: ${String(error)}`);
          }
        }
      })();
    };
    const onConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('ditaeditor.visual', document.uri)) return;
      requestWorkspaceConfigurationReload();
    });
    const onWorkspaceFolders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const nextFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (nextFolder?.uri.toString(true) === folder?.uri.toString(true)) return;
      folder = nextFolder;
      taxonomyResolutionGeneration++;
      taxonomyState.invalidate(null);
      disposeStyleWatcher();
      disposeTaxonomyWatcher();
      requestWorkspaceConfigurationReload();
    });
    retargetStyleWatcher();
    retargetTaxonomyWatcher();

    // Flicker-free re-render: swap just the <main> content in place and restore
    // the caret. Delegated listeners in canvas.js survive the innerHTML swap.
    const pushBody = (focusId: string | null, caretOffset: number | null) => {
      const body = renderState.renderBody(focusId);
      const renderSnapshot = renderState.snapshot();
      void webview.postMessage({
        type: 'rerender',
        body,
        focusId,
        caretOffset,
        navMap: renderSnapshot.navMap,
        cmdMap: renderSnapshot.cmdMap,
        transformMap: renderSnapshot.transformMap,
        insertMap: renderSnapshot.insertMap,
        docProps: renderSnapshot.docProps,
        styleState: authorStyleState(),
        structVersion, // the render cycle these ids belong to (optimistic-concurrency token)
      });
      pushLint();
    };

    // Surface a concise error in the webview (a dismissible banner) so failures are
    // never silent. Details still go to the console / a native toast where apt.
    const postError = (message: string) => void webview.postMessage({ type: 'error', message });

    // UX-7 inline lint surfacing: recompute the dita-quality findings for the
    // current text and push them keyed by element id, so the canvas can paint
    // in-place markers. Advisory only — failures never block rendering.
    const pushLint = () => {
      try {
        const text = document.getText();
        const items = mapLintToIds(text, lintDitaSource(text));
        void webview.postMessage({ type: 'lint', items });
      } catch (err) {
        this.host.debug.appendLine(`lint push skipped: ${String(err)}`);
      }
    };

    // Echo-guard: our own WorkspaceEdit fires onDidChangeTextDocument; skip the
    // re-render for it so the user's cursor/selection is preserved.
    let pendingSelfEdits = 0;
    // Optimistic-concurrency token for STRUCTURAL ops. data-struct-id is a positional index
    // (element-ids.ts) valid only within ONE render cycle; any structural/insert/transform edit
    // reassigns every id. We bump structVersion on each such apply and stamp it on every rerender;
    // a structural op whose baseStructVersion is stale was built against a superseded render and
    // would resolve its id to the WRONG element (the rapid-Enter-in-a-list text-duplication bug),
    // so it is rejected + resynced instead of applied. Text edits do NOT bump it (they keep element
    // identity/count, so their ids stay valid), which keeps "type then Enter" a single live cycle.
    let structVersion = 0;
    interface CanvasHistoryEntry {
      source: string;
      focusId: string | null;
      caretOffset: number | null;
      nextFocusId: string | null;
      nextCaretOffset: number | null;
    }
    const undoStack: CanvasHistoryEntry[] = [];
    const redoStack: CanvasHistoryEntry[] = [];
    let applyingCanvasHistory = false;
    const historyEntry = (
      source: string,
      focusId: string | null | undefined,
      caretOffset: number | null | undefined,
      nextFocusId: string | null | undefined,
      nextCaretOffset: number | null | undefined,
    ): CanvasHistoryEntry => ({
      source,
      focusId: focusId ?? null,
      caretOffset: caretOffset ?? null,
      nextFocusId: nextFocusId ?? null,
      nextCaretOffset: nextCaretOffset ?? null,
    });
    const recordCanvasEdit = (previousSource: string, history?: ApplyMinimalHistory) => {
      if (undoStack[undoStack.length - 1]?.source !== previousSource) {
        undoStack.push(historyEntry(
          previousSource,
          history?.beforeFocusId,
          history?.beforeCaretOffset,
          history?.afterFocusId,
          history?.afterCaretOffset,
        ));
      }
      while (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
    };
    const clearCanvasHistory = () => {
      undoStack.length = 0;
      redoStack.length = 0;
    };
    // Serialize applyEdit calls to avoid the "file changed in the meantime" race.
    let queue: Promise<unknown> = Promise.resolve();
    // A webview reload can replace the iframe while a queued stylesheet save is
    // completing. Keep only a small, document-scoped set of unacknowledged results
    // so the replacement iframe can resume the exact persisted request id.
    const styleSaveResults = createStyleSaveResultReplayCache();

    // Apply newSource as a minimal, echo-guarded WorkspaceEdit. Returns whether
    // a change was actually written (false when newSource === current text).
    const applyMinimal = async (newSource: string, history?: ApplyMinimalHistory): Promise<boolean> => {
      const previousSource = document.getText();
      const span = minimalEdit(previousSource, newSource);
      if (!span) return false;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
        span.text,
      );
      pendingSelfEdits++;
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        pendingSelfEdits = Math.max(0, pendingSelfEdits - 1);
        console.error('dita-editor: workspace.applyEdit rejected the change');
        postError('Your change could not be saved — the document may be read-only or was changed elsewhere.');
        void vscode.window.showErrorMessage('DITA Editor: failed to save an edit.');
        return false;
      }
      if (!applyingCanvasHistory) recordCanvasEdit(previousSource, history);
      return true;
    };

    const runCanvasHistory = async (op: 'undo' | 'redo'): Promise<void> => {
      const fromStack = op === 'undo' ? undoStack : redoStack;
      const toStack = op === 'undo' ? redoStack : undoStack;
      const target = fromStack[fromStack.length - 1];
      if (target == null) {
        announce(op === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
        return;
      }

      const currentSource = document.getText();
      if (target.source === currentSource) {
        fromStack.pop();
        return;
      }

      applyingCanvasHistory = true;
      let ok = false;
      try {
        ok = await applyMinimal(target.source);
      } finally {
        applyingCanvasHistory = false;
      }
      if (!ok) return;

      fromStack.pop();
      toStack.push(historyEntry(
        currentSource,
        target.nextFocusId,
        target.nextCaretOffset,
        target.focusId,
        target.caretOffset,
      ));
      while (toStack.length > 100) toStack.shift();
      this.host.diagnostics.delete(document.uri);
      structVersion++;
      pushBody(target.focusId, target.caretOffset);
      announce(op === 'undo' ? 'Undo.' : 'Redo.');
    };

    // Push a polite announcement into the webview's live region (the canvas sr-only navStatus),
    // so a host-driven action (the image picker) is announced to assistive tech.
    const announce = (message: string) => void webview.postMessage({ type: 'announce', message });
    const {
      imageActionContext,
      attributeActionContext,
      inlineActionContext,
      rangeActionContext,
      insertActionContext,
      lineBreakActionContext,
      structuralActionContext,
    } = createVisualActionContexts({
      document,
      folder,
      applyMinimal,
      pushBody,
      announce,
      postError,
      clearDiagnostics: () => this.host.diagnostics.delete(document.uri),
      setRefusedDiagnostic: (op: string) => {
        this.host.diagnostics.set(document.uri, [refusedOpDiagnostic(op)]);
      },
      getStructVersion: () => structVersion,
      bumpStructVersion: () => {
        structVersion++;
      },
      postRangeAvailability: (forIds: string[], actions: RangeActionAvailability[]) => {
        void webview.postMessage({ type: 'rangeAvailability', forIds, actions });
      },
    });

    const persistManagedStylesForCurrentTarget = async (
      styles: unknown,
      displayedSourceHash: string,
    ): Promise<ManagedStyleSaveOutcome> => {
      const target = authorStyleTarget;
      if (target === null) {
        const error = 'Styles cannot be saved because this document has no writable local workspace destination.';
        styleLog(error);
        await styleRefresh.refreshWith(async () => {
          const current = await loadManagedStyleSnapshot();
          return {
            target: current.target,
            inspection: { ...current.inspection, error },
          };
        });
        postError(error);
        return { ok: false, error };
      }
      const result = await persistManagedAuthorStylesheet({
        target,
        displayedSourceHash,
        styles,
        revalidateTarget: resolveManagedStyleTarget,
      }, {
        files: styleFiles,
        listDocuments: managedStyleDocuments,
        resolveDocumentIdentity,
        platform: process.platform,
        nonce: makeNonce,
        now: () => new Date(),
        pid: process.pid,
        hostname,
        log: styleLog,
      });
      if (!result.ok) {
        await styleRefresh.refreshWith(async () => {
          const current = await loadManagedStyleSnapshot();
          return {
            target: current.target,
            inspection: { ...current.inspection, error: result.error },
          };
        });
        postError(result.error);
        return { ok: false, error: result.error };
      }
      const changedAfterSaveError = 'The active managed stylesheet changed while the save was completing. Its current state was reloaded; retry before applying the style.';
      const savedSnapshot = { target, inspection: result.inspection };
      const reconciled = await reconcileManagedStyleSave({
        coordinator: styleRefresh,
        savedSnapshot,
        loadCurrent: loadManagedStyleSnapshot,
        getCurrent: () => ({ target: authorStyleTarget, inspection: authorStyleInspection }),
        changedError: changedAfterSaveError,
      });
      if (!reconciled) {
        styleLog(changedAfterSaveError);
        postError(changedAfterSaveError);
        return { ok: false, error: changedAfterSaveError };
      }
      return {
        ok: true,
        sourceHash: result.inspection.sourceHash,
        acceptedStyles: result.inspection.styles,
        acceptedGeneration: styleRefresh.generation(),
      };
    };

    const saveManagedStyles = async (
      styles: unknown,
      displayedSourceHash: string,
      requestedTargetToken: string,
    ): Promise<ManagedStyleSaveOutcome> => {
      const currentTargetToken = managedStyleTargetToken(authorStyleTarget);
      const targetChangedError = 'The active managed stylesheet destination changed. Reload the Styles panel before saving.';
      const targetMismatch = requestedTargetToken === '' || requestedTargetToken !== currentTargetToken;
      const outcome = await runTargetBoundManagedStyleSave({
        requestedTargetToken,
        currentTargetToken,
        mismatchError: targetChangedError,
        save: () => persistManagedStylesForCurrentTarget(styles, displayedSourceHash),
      });
      if (targetMismatch) {
        styleLog(targetChangedError);
        postError(targetChangedError);
      }
      return outcome;
    };

    const authorizeCurrentAttributeMessage = (message: CanvasMessage) =>
      authorizeAttributeMessage({
        source: document.getText(),
        message: message as unknown as Record<string, unknown>,
        taxonomy: currentTaxonomy,
        styles: authorStyleInspection.styles,
        structVersion,
      });
    const refuseAttributeMessage = (type: string, reason: string): void => {
      styleLog(`${type} refused: ${reason}`);
      announce(reason);
    };
    const applyAuthorizedShade = async (
      initialAction: Extract<AuthorizedAttributeAction, { kind: 'shade' }>,
      message: CanvasMessage,
    ): Promise<void> => {
      let action = initialAction;
      let color = action.color;
      if (color === 'custom') {
        const picked = await vscode.window.showInputBox({
          title: 'Custom shading color',
          prompt: 'Hex color for the shading',
          placeHolder: '#RRGGBB (e.g. #ffe8b3)',
          validateInput: (value) => (/^#[0-9a-fA-F]{6}$/.test(value.trim()) ? undefined : 'Enter a hex color like #ffe8b3'),
        });
        if (!picked) return;
        color = picked.trim().toLowerCase() as `#${string}`;
        const refreshed = authorizeAttributeMessage({
          source: document.getText(),
          message: {
            type: 'applyShade',
            ids: action.ids,
            color,
            sourceHash: message.sourceHash,
            targetToken: message.targetToken,
            baseStructVersion: message.baseStructVersion,
          },
          taxonomy: currentTaxonomy,
          styles: authorStyleInspection.styles,
          structVersion,
        });
        if (!refreshed.ok || refreshed.action.kind !== 'shade') {
          refuseAttributeMessage(message.type ?? 'applyShade', refreshed.ok ? 'The shading target changed.' : refreshed.reason);
          return;
        }
        action = refreshed.action;
      }

      let className = '';
      let newStyle: AuthorStyleDefinition | undefined;
      if (color !== '') {
        const derivedClass = shadeClassNameForColor(color, action.styleTarget);
        if (!derivedClass) {
          refuseAttributeMessage(message.type ?? 'applyShade', 'Shading color must be a normalized hex value like #ffe8b3.');
          return;
        }
        className = derivedClass;
        if (!authorStyleInspection.styles.some((style) => style.className === derivedClass)) {
          if (!authorStyleTarget) {
            const reason = 'Shading needs the style CSS file, which is unavailable outside a workspace.';
            styleLog(reason);
            postError(reason);
            announce(reason);
            return;
          }
          newStyle = {
            className: derivedClass,
            name: action.label,
            target: action.styleTarget,
            backgroundColor: color,
          };
        }
      }
      const intent = managedStyleSaveIntent({
        styles: undefined,
        sourceHash: message.sourceHash,
        targetToken: message.targetToken,
      });
      const applied = await applyPersistedShadeToIds({
        ids: action.ids,
        className,
        styleTarget: action.styleTarget,
        displayedSourceHash: intent.displayedSourceHash,
        targetToken: intent.targetToken,
        newStyle,
      }, {
        getAcceptedState: () => ({
          styles: authorStyleInspection.styles,
          sourceHash: authorStyleInspection.sourceHash,
          targetToken: managedStyleTargetToken(authorStyleTarget),
          generation: styleRefresh.generation(),
        }),
        persist: async (styles, sourceHash) =>
          saveManagedStyles(styles, sourceHash, intent.targetToken),
        applyDita: async ({ ids, className: acceptedClass, managedClassNames, styleTarget }) => {
          const freshMessage: Record<string, unknown> = acceptedClass
            ? {
                type: 'applyShade', ids, color, sourceHash: message.sourceHash,
                targetToken: message.targetToken, baseStructVersion: message.baseStructVersion,
              }
            : {
                type: 'clearShade', ids, sourceHash: message.sourceHash,
                targetToken: message.targetToken, baseStructVersion: message.baseStructVersion,
              };
          const fresh = authorizeAttributeMessage({
            source: document.getText(),
            message: freshMessage,
            taxonomy: currentTaxonomy,
            styles: authorStyleInspection.styles,
            structVersion,
          });
          if (!fresh.ok || fresh.action.kind !== 'shade' || fresh.action.styleTarget !== styleTarget) {
            const reason = fresh.ok ? 'The shading target changed before the edit could be applied.' : fresh.reason;
            refuseAttributeMessage(message.type ?? 'applyShade', reason);
            throw new Error(reason);
          }
          await applyOutputClassStyleToIds(
            attributeActionContext(),
            ids,
            acceptedClass,
            managedClassNames,
            styleTarget,
          );
        },
      });
      if (!applied) {
        const reason = 'The shading was not applied because the managed stylesheet changed. Reload the Styles panel and try again.';
        styleLog(reason);
        postError(reason);
      }
    };
    const onMessage = webview.onDidReceiveMessage((msg: CanvasMessage) => {
      if (msg && msg.type === 'resumeStyleSave') {
        if (!isValidStyleSaveRequestId(msg.requestId)) {
          styleLog('Ignored an invalid resumed style save request ID.');
          return;
        }
        const state = styleSaveResults.state(msg.requestId);
        if (state === 'replayable') styleSaveResults.replay(msg.requestId, (message) => {
          void webview.postMessage(message);
        });
        else if (state !== 'pending') {
          const message = styleSaveResultMessage(msg.requestId, {
            ok: false,
            error: 'The earlier style save result is no longer available. Reload the Styles panel before saving again.',
          });
          // Tombstone an unknown resume before responding. If an old iframe's
          // delayed save message arrives afterward, begin() replays this refusal
          // instead of executing a request the restored client already abandoned.
          styleSaveResults.remember(message);
          void webview.postMessage(message);
        }
        return;
      }
      if (msg && msg.type === 'styleSaveResultAck') {
        if (isValidStyleSaveRequestId(msg.requestId)) {
          styleSaveResults.acknowledge(msg.requestId);
        }
        return;
      }
      // One-time load handshake: the initial canvas comes from webview.html (no message),
      // so the client pings once it is ready and we reply with the current navMap. Handled
      // before the id guard since 'navready' carries no id. Not a per-keystroke message.
      if (msg && msg.type === 'navready') {
        const renderSnapshot = renderState.snapshot();
        void webview.postMessage({
          type: 'navmap',
          navMap: renderSnapshot.navMap,
          cmdMap: renderSnapshot.cmdMap,
          transformMap: renderSnapshot.transformMap,
          insertMap: renderSnapshot.insertMap,
          docProps: renderSnapshot.docProps,
          styleState: authorStyleState(),
          taxonomy: currentTaxonomy,
          structVersion, // sync the load-cycle token so the first structural op isn't seen as stale
        });
        pushLint();
        return;
      }
      if (msg && msg.type === 'saveStyles') {
        const silent = msg.silent === true;
        const intent = managedStyleSaveIntent(msg);
        if (!isValidStyleSaveRequestId(msg.requestId)) {
          const error = 'The style save request identifier was invalid. Reload the Styles panel before saving again.';
          styleLog(error);
          postError(error);
          if (typeof msg.requestId === 'string') {
            void webview.postMessage(styleSaveResultMessage(msg.requestId, { ok: false, error }));
          }
          return;
        }
        const requestId = msg.requestId;
        const registration = styleSaveResults.begin(requestId, (message) => {
          void webview.postMessage(message);
        });
        if (registration !== 'started') {
          if (registration === 'duplicate' || registration === 'full') {
            const error = registration === 'full'
              ? 'Too many style saves are still pending. Wait for them to finish, then reload the Styles panel.'
              : 'This style save request was already completed and will not be executed again.';
            const message = styleSaveResultMessage(requestId, { ok: false, error });
            if (registration === 'full') styleSaveResults.remember(message);
            void webview.postMessage(message);
            styleLog(error);
          }
          return;
        }
        queue = queue
          .then(async () => {
            const outcome = await runManagedStyleSaveRequest({
              requestId,
              save: () => saveManagedStyles(
                intent.styles,
                intent.displayedSourceHash,
                intent.targetToken,
              ),
              unexpectedError: (err) => {
                const error = 'The style CSS file could not be saved. See the DITA Editor output for details.';
                this.host.debug.appendLine(`saveStyles failed: ${String(err)}`);
                postError(error);
                return error;
              },
              post: (message) => {
                styleSaveResults.remember(message);
                void webview.postMessage(message);
              },
            });
            if (outcome.ok && !silent) announce('Styles saved.');
          })
          .catch((err) => {
            this.host.debug.appendLine(`styleSaveResult delivery failed: ${String(err)}`);
          });
        return;
      }
      if (msg && (msg.type === 'setAttr' || msg.type === 'setAttrMulti')) {
        refuseAttributeMessage(msg.type, 'The legacy generic attribute channel is disabled.');
        return;
      }
      if (msg && isAuthorizedAttributeMessageType(msg.type)) {
        queue = queue
          .then(async () => {
            const authorized = authorizeCurrentAttributeMessage(msg);
            if (!authorized.ok) {
              refuseAttributeMessage(msg.type!, authorized.reason);
              return;
            }
            const action = authorized.action;
            if (action.kind === 'element') {
              if (msg.type === 'setCalsAttrMulti') {
                await applyElementAttributeToIds(
                  attributeActionContext(), action.ids, action.attrName, action.attrValue,
                );
              } else {
                await applyElementAttribute(
                  attributeActionContext(), action.ids[0], action.attrName, action.attrValue,
                );
              }
              return;
            }
            if (action.kind === 'tgroup') {
              await applyTgroupAttributes(attributeActionContext(), action.tableId, action.attrs);
              return;
            }
            if (action.kind === 'style') {
              await applyOutputClassStyleToIds({
                ...attributeActionContext(),
                bumpStructVersion: () => {
                  structVersion++;
                },
              }, action.ids, action.className, action.managedClassNames, action.styleTarget);
              return;
            }
            await applyAuthorizedShade(action, msg);
          })
          .catch((error) => {
            this.host.debug.appendLine(`${msg.type} failed: ${String(error)}`);
            postError('The requested attribute change could not be applied. See the DITA Editor output for details.');
          });
        return;
      }
      // History group (undo / redo / find). Carries no id, so handle before the id guard. Undo/redo
      // use a canvas-local stack because VS Code's global undo command targets the active editor,
      // which is unreliable from a custom webview. Find stays on the native in-webview find widget.
      if (msg && msg.type === 'history' && typeof msg.op === 'string') {
        if (msg.op === 'undo' || msg.op === 'redo') {
          queue = queue
            .then(() => runCanvasHistory(msg.op as 'undo' | 'redo'))
            .catch((err) => {
              console.error('dita-editor: canvas history failed', err);
              postError('History could not be applied. See the developer console for details.');
            });
        } else if (msg.op === 'find') {
          const cmd = historyCommandForOp(msg.op);
          if (cmd) {
            void Promise.resolve(vscode.commands.executeCommand(cmd)).then(undefined, (err) =>
              console.warn(`dita-editor: history command "${cmd}" failed`, err),
            );
          }
        }
        return;
      }
      // Multi-element inline format: bold/italic/… every block in a multi-element selection. Carries an
      // `ids` array (no single id), so handle before the id guard. Wraps each selected block's text in
      // the phrase element; re-renders (the render-only selection re-resolves its ids on the new body).
      if (msg && msg.type === 'inlineMulti' && typeof msg.op === 'string' && Array.isArray(msg.ids)) {
        const op = msg.op;
        const ids = msg.ids.filter((x): x is string => typeof x === 'string');
        const baseV = msg.baseStructVersion;
        queue = queue
          .then(() => formatInlineBlocks(inlineActionContext(), ids, op, baseV))
          .catch((err) => {
            console.error('dita-editor: inline-multi failed', err);
            postError('The formatting could not be applied. See the developer console for details.');
          });
        return;
      }
      // Multi-element remove-all-styles. Same stale-render guard as inlineMulti, but strips every
      // highlighting phrase in the selected blocks while preserving xref/image/conref atoms.
      if (msg && msg.type === 'removeStyles' && Array.isArray(msg.ids)) {
        const ids = msg.ids.filter((x): x is string => typeof x === 'string');
        const baseV = msg.baseStructVersion;
        queue = queue
          .then(() => removeInlineStylesFromBlocks(inlineActionContext(), ids, baseV))
          .catch((err) => {
            console.error('dita-editor: remove-styles failed', err);
            postError('The styles could not be removed. See the developer console for details.');
          });
        return;
      }
      // P1-1 range-ops. These carry no `id` (they carry a selection / action+ids), so they MUST be
      // handled before the id guard below. The host is authoritative: it re-derives legality from
      // the CST via the planners/executors; canvas geometry is never trusted.
      if (msg && msg.type === 'rangeQuery' && msg.selection) {
        queryRangeActions(rangeActionContext(), msg.selection);
        return;
      }
      if (
        msg &&
        msg.type === 'rangeExecute' &&
        isRangeActionType(msg.action) &&
        Array.isArray(msg.ids)
      ) {
        const action = msg.action;
        const ids = msg.ids.filter((id): id is string => typeof id === 'string');
        const values = Array.isArray(msg.values)
          ? msg.values.filter((value: unknown): value is string => typeof value === 'string')
          : undefined;
        queue = queue
          .then(() => executeRangeAction(rangeActionContext(), action, ids, values))
          .catch((err) => {
            console.error('dita-editor: range execute failed', err);
            postError('That action could not be completed. See the developer console for details.');
          });
        return;
      }
      // #13 insert. Carries `op` + `payload` (no top-level `id`), so it MUST be handled before the
      // id guard below, like the range messages. The host re-derives the edit from the pure insert
      // core (src/commands/insert-ops.ts): applyInsert is the THROW-on-invalid primitive (unknown id
      // / content-model violation), so wrap it defensively — on throw, surface it + resync and write
      // NOTHING (mirrors the structural refusal path). On success, apply the composed source as ONE
      // WorkspaceEdit and push focus so the canvas lands the caret in the new node.
      if (msg && msg.type === 'insert' && typeof msg.op === 'string' && msg.payload) {
        const op = msg.op as InsertKind;
        const payload = msg.payload;
        queue = queue
          .then(() => applyInsertAction(insertActionContext(), op, payload))
          .catch((err) => {
            console.error('dita-editor: insert failed', err);
            postError('That action could not be completed. See the developer console for details.');
          });
        return;
      }
      // Multi-selected list-item transform. Carries ids rather than one focused id, so handle before
      // the single-id guard. The host maps each selected <li> to its parent list, dedupes, and applies
      // the batch as one WorkspaceEdit through executeMultiCommand.
      if (msg && msg.type === 'multiTransform' && typeof msg.transform === 'string' && Array.isArray(msg.ids)) {
        const transform = msg.transform as TransformType;
        const ids = msg.ids.filter((id): id is string => typeof id === 'string');
        queue = queue
          .then(() => applyMultiTransformAction(structuralActionContext(), transform, ids, msg.baseStructVersion))
          .catch((err) => {
            console.error('dita-editor: multi-transform failed', err);
            postError('That action could not be completed. See the developer console for details.');
          });
        return;
      }
      // UX-8 prev/next sibling topic. No id; queued so it never races an in-flight edit.
      if (msg && msg.type === 'navTopic' && (msg.delta === 1 || msg.delta === -1)) {
        const delta = msg.delta;
        queue = queue
          .then(async () => {
            const message = await openSiblingTopic(document.uri, delta, VIEW_TYPE);
            if (message) announce(message);
          })
          .catch((err) => {
            console.error('dita-editor: topic navigation failed', err);
            postError('Could not open the sibling topic. See the developer console for details.');
          });
        return;
      }
      // IX-3 copy-as-DITA: slice the elements' exact source bytes to the OS clipboard.
      // Carries an ids array (no single id) — handled before the id guard. Read-only.
      if (msg && msg.type === 'copyDita' && Array.isArray(msg.ids)) {
        const ids = msg.ids.filter((x): x is string => typeof x === 'string');
        queue = queue
          .then(async () => {
            const text = sliceElements(document.getText(), ids);
            if (text == null) {
              announce('Copy failed: the element is no longer in the document.');
              return;
            }
            await vscode.env.clipboard.writeText(text);
            announce('Copied ' + ids.length + ' element' + (ids.length === 1 ? '' : 's') + ' as DITA.');
          })
          .catch((err) => {
            console.error('dita-editor: copy as DITA failed', err);
            postError('Copy as DITA failed. See the developer console for details.');
          });
        return;
      }
      // #22 root cause: the id guard used to SILENTLY `return` for any message without a string
      // id. A block transform carries the focused p/li id, which the canvas reads via
      // getAttribute('data-struct-id') — that returns `null` for any node the renderer never
      // stamped, so the canvas can legitimately post `id: null`, and this guard would drop it
      // with no trace and no document change (exactly the #22 report: empty channel, no bytes).
      // Carve transform/insert OUT of the silent path: surface a visible reason in the channel +
      // a Problems entry so the failure is diagnosable instead of vanishing. The id guard itself
      // stays for the message types that legitimately require an id (edit/structural/pickImage/editImageAlt).
      if (!msg || typeof msg.id !== 'string') {
        if (msg && (msg.type === 'transform' || msg.type === 'insert')) {
          this.host.debug.appendLine(
            `dropped ${msg.type}: target has no data-struct-id anchor; nothing was written.`,
          );
          this.host.diagnostics.set(document.uri, [refusedOpDiagnostic(msg.type)]);
          announce('That action could not run because its target lost its anchor. Select the element again and retry.');
        }
        return;
      }
      const id = msg.id;
      if (msg.type === 'edit') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const html = typeof msg.html === 'string' ? msg.html : null;
        queue = queue
          .then(() => editInlineText(inlineActionContext(), id, text, html))
          .catch((err) => {
            console.error('dita-editor: text edit failed', err);
            postError('An edit could not be applied. See the developer console for details.');
          });
      } else if (msg.type === 'lineBreak') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const caretOffset = typeof msg.caretOffset === 'number' ? msg.caretOffset : undefined;
        queue = queue
          .then(() => applyLineBreakAction(lineBreakActionContext(), id, text, caretOffset))
          .catch((err) => {
            console.error('dita-editor: line break edit failed', err);
            postError('The line break could not be applied. See the developer console for details.');
          });
      } else if (msg.type === 'inline' && typeof msg.op === 'string') {
        // Inline formatting: wrap the focused run's selection in a phrase element (b/i/u/line-through/codeph/sub/sup).
        // The canvas supplies DECODED before/mid/after (like split), so the host never decodes entities.
        // Adding the phrase element shifts e{N} ids, so it re-renders + bumps structVersion, and rejects a
        // stale op (baseStructVersion guard) — else a rapid repeat re-wraps the just-added element.
        const op = msg.op;
        const before = typeof msg.before === 'string' ? msg.before : '';
        const mid = typeof msg.mid === 'string' ? msg.mid : '';
        const after = typeof msg.after === 'string' ? msg.after : '';
        const baseV = msg.baseStructVersion;
        const caret = typeof msg.caretOffset === 'number' ? msg.caretOffset : undefined;
        queue = queue
          .then(() => formatInlineSelection(inlineActionContext(), id, op, before, mid, after, baseV, caret))
          .catch((err) => {
            console.error('dita-editor: inline format failed', err);
            postError('The formatting could not be applied. See the developer console for details.');
          });
      } else if (msg.type === 'removeStyles') {
        const before = typeof msg.before === 'string' ? msg.before : '';
        const mid = typeof msg.mid === 'string' ? msg.mid : '';
        const after = typeof msg.after === 'string' ? msg.after : '';
        const baseV = msg.baseStructVersion;
        const caret = typeof msg.caretOffset === 'number' ? msg.caretOffset : undefined;
        queue = queue
          .then(() => removeInlineStylesFromSelection(inlineActionContext(), id, before, mid, after, baseV, caret))
          .catch((err) => {
            console.error('dita-editor: remove styles failed', err);
            postError('The styles could not be removed. See the developer console for details.');
          });
      } else if (msg.type === 'insertInline' && typeof msg.op === 'string') {
        // Insert a self-contained inline element at the caret: an image, a cross-reference, or a
        // reused-content (conref) phrase. The canvas supplies the decoded before/after split at
        // the caret; host prompts/pickers resolve the target before any bytes are written.
        const op = msg.op;
        const before = typeof msg.before === 'string' ? msg.before : '';
        const after = typeof msg.after === 'string' ? msg.after : '';
        const baseV = msg.baseStructVersion;
        queue = queue
          .then(async () => {
            const resolveInsert = async (): Promise<InlineInsertResolution | null> => {
              let spec: InlineInsertSpec | null = null;
              let successAnnouncement: string | undefined;
              if (op === 'image') {
                const href = await pickImageHrefForInsert(imageActionContext());
                if (!href) return null; // cancelled/unavailable -> no bytes change
                spec = { name: 'image', attrs: [{ name: 'href', value: href }], selfClosing: true };
                successAnnouncement = `Image inserted: ${href.split(/[\\/]/).pop() ?? href}.`;
              } else if (op === 'xref') {
                const href = await vscode.window.showInputBox({
                  title: 'Insert cross-reference',
                  prompt: 'Cross-reference target',
                  placeHolder: 'topic.dita#topic/section-id  or  https://…',
                });
                if (!href) return null; // cancelled -> no bytes change
                spec = { name: 'xref', attrs: [{ name: 'href', value: href }], innerText: href };
              } else if (op === 'conref') {
                const target = await vscode.window.showInputBox({
                  title: 'Insert reused content (conref)',
                  prompt: 'Content reference target',
                  placeHolder: 'topic.dita#topic/element-id',
                });
                if (!target) return null; // cancelled -> no bytes change
                spec = { name: 'ph', attrs: [{ name: 'conref', value: target }], selfClosing: true };
              }
              if (!spec) return null; // unknown op
              return {
                spec,
                successAnnouncement,
              };
            };
            await insertInlineElement(inlineActionContext(), id, before, after, baseV, resolveInsert);
          })
          .catch((err) => {
            console.error('dita-editor: inline insert failed', err);
            postError('The insertion could not be completed. See the developer console for details.');
          });
      } else if (msg.type === 'setTableColumnWidths' && Array.isArray(msg.widths)) {
        const widths = msg.widths.filter((width): width is number => typeof width === 'number');
        queue = queue
          .then(() => applyTableColumnWidthAction(structuralActionContext(), id, widths, msg.baseStructVersion))
          .catch((err) => {
            console.error('dita-editor: table column resize failed', err);
            postError('Column widths could not be updated. See the developer console for details.');
          });
      } else if (msg.type === 'structural' && typeof msg.op === 'string') {
        const op = msg.op as StructuralOp;
        const payload: StructuralPayload = {
          prefix: msg.prefix,
          suffix: msg.suffix,
          prefixHtml: msg.prefixHtml,
          suffixHtml: msg.suffixHtml,
          prevId: msg.prevId,
          merged: msg.merged,
          mergedHtml: msg.mergedHtml,
          boundary: msg.boundary,
          blocks: Array.isArray(msg.blocks) ? msg.blocks.filter((block): block is string => typeof block === 'string') : undefined,
          caret: msg.caret,
          refId: msg.refId,
        };
        queue = queue
          .then(() => applyStructuralAction(structuralActionContext(), op, id, payload, msg.baseStructVersion, msg.announceOnSuccess))
          .catch((err) => {
            console.error('dita-editor: structural edit failed', err);
            postError('That action could not be completed. See the developer console for details.');
          });
      } else if (msg.type === 'pasteDita' && (msg.op === 'before' || msg.op === 'after')) {
        // IX-3 paste-as-DITA: splice the clipboard fragment verbatim next to the
        // reference sibling. Same stale-render guard as structural ops; refusals
        // announce their reason and write nothing.
        const mode = msg.op;
        const baseV = msg.baseStructVersion;
        queue = queue
          .then(async () => {
            if (typeof baseV === 'number' && baseV !== structVersion) {
              pushBody(null, null);
              return;
            }
            const fragment = await vscode.env.clipboard.readText();
            let result;
            try {
              result = insertDitaFragment(document.getText(), id, mode, fragment);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              this.host.debug.appendLine(`pasteDita refused: ${reason}`);
              announce(reason);
              return;
            }
            const ok = await applyMinimal(result.source);
            if (!ok) return;
            this.host.diagnostics.delete(document.uri);
            structVersion++;
            pushBody(result.focusId, null);
            announce('Pasted DITA content.');
          })
          .catch((err) => {
            console.error('dita-editor: paste as DITA failed', err);
            postError('Paste as DITA failed. See the developer console for details.');
          });
      } else if (msg.type === 'transform' && typeof msg.transform === 'string') {
        // P1-3 block/list type transform. Carries the focused p/li `id` + the transform name.
        // resolveTransformFocus maps an <li> -> its parent list for list-kind transforms; planTransform
        // gates it (noop/invalid -> resync, no write — the transformMap should already have disabled the
        // control); the host maps the accepted intent to applyTransform (throws on a stale spec) -> ONE WorkspaceEdit ->
        // rerender + focus the transformed block.
        const transform = msg.transform as TransformType;
        queue = queue
          .then(() => applyTransformAction(structuralActionContext(), transform, id))
          .catch((err) => {
            console.error('dita-editor: transform failed', err);
            postError('That action could not be completed. See the developer console for details.');
          });
      } else if (msg.type === 'pickImage') {
        // P1-4: open the native image picker for the selected image. Queued behind any in-flight
        // edit so it reads/writes a settled document. All mutation guards live in the helper.
        queue = queue
          .then(() => pickAndApplyImageHref(imageActionContext(), id))
          .catch((err) => {
            console.error('dita-editor: image href edit failed', err);
            postError('The image could not be changed. See the developer console for details.');
          });
      } else if (msg.type === 'editImageAlt') {
        // P1-4: edit the selected image's DITA <alt> child. This is not an attribute edit:
        // DITA image alt text is element content, so the CST helper adds/updates/removes <alt>.
        queue = queue
          .then(() => promptAndApplyImageAlt(imageActionContext(), id))
          .catch((err) => {
            console.error('dita-editor: image alt edit failed', err);
            postError('The image alt text could not be changed. See the developer console for details.');
          });
      }
    });

    const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      // onDidChangeTextDocument also fires when ONLY the dirty-state flips, with an
      // empty contentChanges (per the vscode API doc: it fires "when other things
      // like the dirty-state changes"). That settle event is the authoritative
      // moment isDirty becomes true (after our applyEdit) or false (after an undo
      // back to the saved buffer), so the status refresh MUST run before the
      // content-change guard below — otherwise the dirty-only event is dropped and
      // the status bar sticks at a stale in-sync/unsaved until a later save event.
      this.host.scheduleStatusRefresh();
      if (e.contentChanges.length === 0) return;
      if (pendingSelfEdits > 0) {
        pendingSelfEdits--;
        return;
      }
      this.host.diagnostics.delete(document.uri); // doc changed externally -> any prior refusal is stale
      clearCanvasHistory();
      structVersion++; // external bytes may recycle positional ids; invalidate every queued render-bound intent
      pushBody(null, null); // external edit / undo / revert -> rebuild the canvas in place
    });

    // retainContextWhenHidden is false: hiding this tab (e.g. opening the Review
    // Changes panel in the same column) destroys the webview iframe, and VS Code
    // restores it from the LAST-ASSIGNED webview.html — the open-time snapshot,
    // NOT the pushBody rerenders posted since. Reload the full canvas on
    // hidden -> visible so the restored view always shows the current document
    // (the iframe was just recreated, so a full html assignment costs nothing
    // extra — there is no live scroll/caret to preserve).
    let wasVisible = webviewPanel.visible;
    const onViewState = webviewPanel.onDidChangeViewState(() => {
      this.host.notifyActive(document, webviewPanel.active);
      if (webviewPanel.visible && !wasVisible) render();
      wasVisible = webviewPanel.visible;
    });

    disposeEditorResources = () => {
      disposed = true;
      configurationGeneration++;
      taxonomyState.dispose();
      onMessage.dispose();
      onChange.dispose();
      onViewState.dispose();
      onConfiguration.dispose();
      onWorkspaceFolders.dispose();
      disposeStyleWatcher();
      disposeTaxonomyWatcher();
      for (const subscription of styleRefreshSubscriptions) subscription.dispose();
      for (const subscription of taxonomyRefreshSubscriptions) subscription.dispose();
      this.host.notifyActive(document, false);
      this.host.diagnostics.delete(document.uri);
      earlyDispose.dispose();
    };
    // New, empty .dita → scaffold a valid skeleton (topic + required <title> + body/<p>)
    // so the file opens with all required fields instead of being empty/invalid. Guarded to
    // truly-empty text, so a non-empty (possibly mid-edit/invalid) file is NEVER overwritten.
    // applyMinimal is echo-guarded, so we render explicitly once the scaffold is written. The
    // edit leaves the new file dirty (the author owns the save), and is byte-stable so saving
    // writes no further diff.
    if (document.getText().trim() === '') {
      void queue.then(async () => {
        if (document.getText().trim() !== '') return; // re-check: another path may have filled it
        await applyMinimal(newTopicSkeleton(document.uri.fsPath));
        render();
      });
    } else {
      render();
    }
    this.host.notifyActive(document, webviewPanel.active);
  }
}

// A refused/stale structural op carries no reliable element range (the id may no
// longer resolve), so the diagnostic anchors at the document start. It is cleared
// on the next successful edit or external change.
function refusedOpDiagnostic(op: string): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    `DITA Editor could not apply "${op}": the document changed or the action isn't valid in this position. The view was resynced and no change was written.`,
    vscode.DiagnosticSeverity.Warning,
  );
  diag.source = 'DITA Editor';
  return diag;
}
