// VS Code entry point. Registers the visual editor as an OPTIONAL custom editor
// for *.dita so it coexists with the JeremyJeanne.ditacraft extension (open via the
// "Open Visual Editor" command/button or "Reopen Editor With…").
//
// Phase 1 slice 1: editable plain-text leaves. The render core marks editable
// leaves contenteditable; the webview client posts edits; here we map an edit
// back to its CST node, compute the MINIMAL document change, and apply it as a
// WorkspaceEdit (so VS Code owns undo/save and the on-disk diff stays tiny).
//
// NOTE: only exercisable inside VS Code. Headless tests cover the pure pieces
// (CST engine, render core, edit-bridge, text-targets, buildCanvasHtml).

import * as vscode from 'vscode';
import { formatDitaSource, lintDitaSource, type DitaLintIssue } from './cst/dita-quality';
import { minimalEdit } from './cst/edit-bridge';
import { DitaVisualEditorProvider, VIEW_TYPE, type VisualHost } from './host/visual-editor-provider';
import { openRedlinePanel } from './host/redline-panel';
import { openMultiRedlinePanel } from './host/multi-redline-panel';
import {
  closeNativeTabsIfPresent,
  isManualSourceDiff,
  renderReviewBeforeClosingNative,
  reviewComparisonFromCustomEditorCandidates,
  reviewComparisonFromDiffTab,
  reviewComparisonIdentity,
  reviewComparisonsFromMultiDiff,
  shouldInterceptScmDiff,
  unmarkManualSourceDiff,
  type DiffTabShape,
  type ReviewComparison,
} from './host/scm-intercept';
import {
  anchorAtSourceOffset,
  elementRangeForAnchor,
  openingTagOffsetForAnchor,
  type ScrollAnchor,
} from './host/scroll-handoff';
import { TOPIC_SEARCH_VIEW_ID, TopicSearchViewProvider } from './host/topic-search-view';
import { createInspectorHub } from './host/inspector-hub';
import {
  PROPERTIES_VIEW_ID,
  STYLES_VIEW_ID,
  createPropertiesViewProvider,
  createStylesViewProvider,
} from './host/inspector-views';
import { extractRenderedText } from './search/rendered-text';
import { MAX_FILE_BYTES } from './search/search-controller';
import { planReplaceAll, planReplaceOne, type ReplaceAllPlan } from './search/topic-replace';
import { occurrenceWithin } from './search/topic-search';

// Resolve the .dita document a command should act on: an explicit arg (passed by
// the editor-title button), else the active custom/text tab, else the active text
// editor. Lets "View/Edit Source" work from the toolbar, palette, or status bar.
function activeDitaUri(arg?: vscode.Uri): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) return input.uri;
  if (input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

function activeDitaDiff(): ReviewComparison<vscode.Uri> | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
  return reviewComparisonFromDiffTab(input);
}

// Toggle a .dita file between the visual editor and its XML source IN PLACE: open the
// requested viewType, then close any existing tab showing the SAME file in the OTHER
// editor — so the toggle reuses one tab instead of leaving a duplicate beside it.
// vscode.openWith creates a fresh editor input for a different viewType (it does not
// replace the current one), so we close the prior tab ourselves. Opening first and
// closing second keeps the shared TextDocument open throughout, so no save prompt
// fires even when the buffer is dirty. If no prior tab exists, this is a plain open.
async function reopenInPlace(
  target: vscode.Uri,
  viewType: string,
): Promise<vscode.ViewColumn | undefined> {
  const key = target.toString();
  const isPriorTab = (tab: vscode.Tab): boolean => {
    const input = tab.input;
    if (input instanceof vscode.TabInputCustom) {
      return input.uri.toString() === key && input.viewType !== viewType;
    }
    if (input instanceof vscode.TabInputText) {
      // A text tab is the "source" editor (viewType 'default'); it's the prior tab to
      // replace only when we're switching TO the visual editor.
      return input.uri.toString() === key && viewType !== 'default';
    }
    return false;
  };
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  let prior = activeGroup.tabs.find(isPriorTab);
  for (const group of vscode.window.tabGroups.all) {
    if (prior) break;
    prior = group.tabs.find(isPriorTab);
  }
  const viewColumn = prior?.group.viewColumn;
  await vscode.commands.executeCommand('vscode.openWith', target, viewType, viewColumn);
  const remainingPriorTabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(isPriorTab),
  );
  if (remainingPriorTabs.length > 0) {
    await vscode.window.tabGroups.close(remainingPriorTabs, false);
  }
  return viewColumn;
}

function isDitaUri(uri: vscode.Uri): boolean {
  return uri.fsPath.toLowerCase().endsWith('.dita');
}

function isTabOpen(tab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab));
}

async function closeTabsIfStillOpen(
  tabs: readonly vscode.Tab[],
  debug: vscode.OutputChannel,
): Promise<boolean> {
  return closeNativeTabsIfPresent(
    tabs,
    isTabOpen,
    (openTabs) => vscode.window.tabGroups.close([...openTabs], true),
    (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      const alreadyClosed = detail.includes('Tab close: Invalid tab not found');
      if (alreadyClosed) {
        debug.appendLine(`dita-editor: native diff was already closed during rendered-review cleanup: ${detail}`);
      }
      return alreadyClosed;
    },
  );
}

function diagnosticForIssue(document: vscode.TextDocument, issue: DitaLintIssue): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(
    new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
    issue.message,
    vscode.DiagnosticSeverity.Warning,
  );
  diag.source = 'DITA Editor DITA lint';
  diag.code = issue.code;
  return diag;
}

export function activate(context: vscode.ExtensionContext): void {
  // C2: refused/stale structural ops become Problems entries instead of a silent resync.
  const diagnostics = vscode.languages.createDiagnosticCollection('dita-editor');

  // #22 diagnosis: a real, clearly-named Output channel so inbound canvas messages and
  // refusal reasons are inspectable in the Output dropdown ("DITA Editor"). Prior to
  // this there was NO OutputChannel anywhere — logging went to console.* only — which is
  // why the channel QA looked at appeared empty (it did not exist).
  const debug = vscode.window.createOutputChannel('DITA Editor');
  const pendingMultiDiffTabs = new WeakSet<vscode.Tab>();
  const pendingCustomDiffs = new Set<string>();
  const pendingTextDiffTabs = new WeakSet<vscode.Tab>();
  const manualCustomDiffs = new WeakMap<vscode.Tab, DiffTabShape<vscode.Uri>>();

  // C4: a status-bar trust indicator for the active visual editor — byte-safe vs. unsaved.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'ditaeditor.viewSource';
  let activeVisualDoc: vscode.TextDocument | undefined;

  const updateStatusBar = (): void => {
    if (!activeVisualDoc) {
      statusItem.hide();
      return;
    }
    const dirty = activeVisualDoc.isDirty;
    statusItem.text = dirty ? '$(circle-filled) DITA: unsaved' : '$(check) DITA: in sync';
    statusItem.tooltip =
      (dirty ? 'DITA Editor — unsaved changes.\n' : 'DITA Editor — in sync with the file.\n') +
      'Edits are written as minimal diffs; the document round-trips byte-for-byte. Click to view/edit the source.';
    statusItem.show();
  };

  // Coalesced next-tick refresh: a programmatic workspace.applyEdit commits the
  // document dirty flag AFTER onDidChangeTextDocument fires, so reading isDirty
  // synchronously in the change handler is stale (it reports "in sync" right after
  // a webview edit). Deferring to the next tick reads the settled flag; coalescing
  // avoids a timer per keystroke under the webview's debounced edits.
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStatusRefresh = (): void => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      updateStatusBar();
    }, 0);
  };

  // Secondary Side Bar inspector views (Styles, Properties): the hub latches
  // the active visual document and fans its state out to both views. Latched
  // on activation only — focusing an inspector view blurs the canvas, and
  // clearing then would blank the view the user just clicked into.
  const inspectors = createInspectorHub();
  const host: VisualHost = {
    diagnostics,
    debug,
    inspectors,
    notifyActive(doc, active) {
      if (active) {
        activeVisualDoc = doc;
        inspectors.noteActive(doc.uri.toString(true));
      } else if (activeVisualDoc === doc) activeVisualDoc = undefined;
      updateStatusBar();
    },
    scheduleStatusRefresh,
  };
  const visualProvider = new DitaVisualEditorProvider(context, host);
  const stylesViewProvider = createStylesViewProvider(context.extensionUri, inspectors);
  const propertiesViewProvider = createPropertiesViewProvider(context.extensionUri, inspectors);
  const warnScrollHandoff = (detail: string, userMessage: string): void => {
    debug.appendLine(`DITA Editor scroll handoff skipped: ${detail}`);
    void vscode.window.showWarningMessage(userMessage);
  };
  const visibleSourceEditor = (
    target: vscode.Uri,
    preferredColumn = vscode.window.tabGroups.activeTabGroup.viewColumn,
  ): vscode.TextEditor | undefined => {
    const key = target.toString();
    const matching = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === key,
    );
    const active = vscode.window.activeTextEditor;
    if (
      active?.document.uri.toString() === key &&
      (active.viewColumn === preferredColumn || preferredColumn === undefined)
    ) return active;
    return matching.find((editor) => editor.viewColumn === preferredColumn)
      ?? (preferredColumn === undefined ? matching[0] : undefined);
  };
  const openVisualPreservingScroll = async (target: vscode.Uri): Promise<void> => {
    const sourceEditor = visibleSourceEditor(target);
    if (!sourceEditor) {
      await reopenInPlace(target, VIEW_TYPE);
      return;
    }
    const topPosition = sourceEditor.visibleRanges[0]?.start;
    let failure: string | null = null;
    if (!topPosition) {
      failure = `the source editor for ${target.toString(true)} had no visible range`;
    } else {
      const mapping = anchorAtSourceOffset(
        sourceEditor.document.getText(),
        sourceEditor.document.offsetAt(topPosition),
      );
      if (mapping.ok) visualProvider.queueVisualRestore(target, mapping.anchor);
      else failure = mapping.reason;
    }
    await reopenInPlace(target, VIEW_TYPE);
    if (failure) {
      warnScrollHandoff(
        `${target.toString(true)} (XML to Visual): ${failure}`,
        'DITA Editor: switched to the Visual editor, but the previous source position could not be restored.',
      );
    }
  };
  // Search DITA Topics side view: result clicks land in the visual editor at the
  // match. The anchor is computed against the CURRENT text (open buffer first,
  // else disk), so a stale search index degrades to nearest-element, never a wrong
  // file position.
  const topicSearchProvider: TopicSearchViewProvider = new TopicSearchViewProvider(
    context.extensionUri,
    debug,
    {
      async openMatch(target, sourceStart, renderedText, matchCase) {
        try {
          await vscode.workspace.fs.stat(target);
        } catch {
          void vscode.window.showWarningMessage(
            'DITA Editor: that file no longer exists. Refreshing the search results.',
          );
          topicSearchProvider.refresh();
          return;
        }
        const key = target.toString(true);
        const openDoc = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString(true) === key,
        );
        const text = openDoc
          ? openDoc.getText()
          : new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(target));
        const mapping = anchorAtSourceOffset(text, sourceStart);
        if (!mapping.ok) {
          warnScrollHandoff(
            `${key} (topic search): ${mapping.reason}`,
            'DITA Editor: opened the topic, but the matched position could not be located.',
          );
          await reopenInPlace(target, VIEW_TYPE);
          return;
        }
        // Exact-match payload: the canvas re-finds the nth occurrence of the
        // rendered text inside the anchored element and selects it. Occurrence
        // is counted against the CURRENT text; any residual drift falls back
        // silently to the element-level scroll in the canvas.
        let anchor: ScrollAnchor = mapping.anchor;
        if (renderedText !== '') {
          const range = elementRangeForAnchor(text, mapping.anchor.id);
          if (range.ok) {
            try {
              const occurrence = occurrenceWithin(
                extractRenderedText(text), renderedText, matchCase, sourceStart, range.range);
              anchor = {
                id: mapping.anchor.id,
                highlight: { text: renderedText, occurrence, matchCase },
              };
            } catch {
              // Unparseable current text cannot happen here (anchor mapping just
              // parsed it) — but if it does, keep the element-level anchor.
            }
          }
        }
        // Visible panel: direct post. Hidden panel: queued + revealed (its reload
        // consumes the queue). No panel: queued — open the editor ourselves.
        const delivery = visualProvider.scrollVisualEditorTo(target, anchor);
        if (delivery === 'queued') await reopenInPlace(target, VIEW_TYPE);
      },
      // Replace one previously-found match. The plan re-verifies the rendered
      // text against the CURRENT buffer; a changed file yields 'stale' and no
      // edit. Applied as a WorkspaceEdit so VS Code owns undo/save.
      async replaceMatch(target, args) {
        const stale = { replaced: 0, fileCount: 0, skippedStyled: 0, stale: true };
        try {
          await vscode.workspace.fs.stat(target);
        } catch {
          return stale;
        }
        const doc = await vscode.workspace.openTextDocument(target);
        let plan: ReturnType<typeof planReplaceOne>;
        try {
          plan = planReplaceOne(
            doc.getText(), args.renderedText, args.sourceStart, args.sourceEnd, args.replacement);
        } catch {
          return stale; // the buffer no longer parses — treat as changed-since-search
        }
        if (!plan.ok) {
          return plan.reason === 'styled'
            ? { replaced: 0, fileCount: 0, skippedStyled: 1, stale: false }
            : stale;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          target,
          new vscode.Range(doc.positionAt(plan.edit.start), doc.positionAt(plan.edit.end)),
          plan.edit.text,
        );
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error('the workspace edit was rejected');
        }
        return { replaced: 1, fileCount: 1, skippedStyled: 0, stale: false };
      },
      // Replace every match in the workspace, after a modal confirmation.
      // Files that will be edited are opened as TextDocuments first, so the
      // edit hits the live buffer and the follow-up re-search sees it.
      async replaceAll(query, matchCase, replacement) {
        const uris = (await vscode.workspace.findFiles('**/*.dita'))
          .filter((uri) => uri.scheme === 'file');
        const files: Array<{ doc: vscode.TextDocument; plan: ReplaceAllPlan }> = [];
        let skippedStyled = 0;
        for (const uri of uris) {
          const key = uri.toString(true);
          const open = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString(true) === key,
          );
          let probeText: string;
          try {
            if (open) {
              probeText = open.getText();
            } else {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.size > MAX_FILE_BYTES) continue; // search skips these too
              probeText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
            }
          } catch {
            continue; // vanished or unreadable — nothing to replace here
          }
          let plan: ReplaceAllPlan;
          try {
            plan = planReplaceAll(probeText, query, matchCase, replacement);
          } catch {
            continue; // malformed XML is skipped by search, so also by replace
          }
          skippedStyled += plan.skippedStyled;
          if (plan.edits.length === 0) continue;
          const doc = open ?? (await vscode.workspace.openTextDocument(uri));
          if (!open && doc.getText() !== probeText) {
            // The file changed between the disk read and the open — re-plan on
            // the authoritative buffer.
            try {
              plan = planReplaceAll(doc.getText(), query, matchCase, replacement);
            } catch {
              continue;
            }
            if (plan.edits.length === 0) continue;
          }
          files.push({ doc, plan });
        }
        const replaced = files.reduce((sum, file) => sum + file.plan.replaced, 0);
        if (replaced === 0) {
          return { replaced: 0, fileCount: 0, skippedStyled, stale: false };
        }
        const confirmed = await vscode.window.showWarningMessage(
          `Replace ${replaced} occurrence${replaced === 1 ? '' : 's'} of "${query}" in ` +
            `${files.length} file${files.length === 1 ? '' : 's'}?`,
          { modal: true },
          'Replace',
        );
        if (confirmed !== 'Replace') return null;
        const edit = new vscode.WorkspaceEdit();
        for (const file of files) {
          for (const change of file.plan.edits) {
            edit.replace(
              file.doc.uri,
              new vscode.Range(file.doc.positionAt(change.start), file.doc.positionAt(change.end)),
              change.text,
            );
          }
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error('the workspace edit was rejected');
        }
        return { replaced, fileCount: files.length, skippedStyled, stale: false };
      },
    },
  );
  const openSourcePreservingScroll = async (target: vscode.Uri): Promise<void> => {
    const anchor = visualProvider.latestVisualAnchor(target);
    let sourceDocument: vscode.TextDocument | null = null;
    let offset: number | null = null;
    let failure: string | null = null;
    if (!anchor) {
      failure = 'the visual canvas had not reported a current scroll anchor';
    } else {
      try {
        sourceDocument = await vscode.workspace.openTextDocument(target);
        const mapping = openingTagOffsetForAnchor(sourceDocument.getText(), anchor.id);
        if (mapping.ok) offset = mapping.offset;
        else failure = mapping.reason;
      } catch (error) {
        failure = `the source document could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const reopenedColumn = await reopenInPlace(target, 'default');
    if (offset !== null && sourceDocument) {
      const sourceEditor = visibleSourceEditor(target, reopenedColumn);
      if (sourceEditor) {
        const position = sourceDocument.positionAt(offset);
        sourceEditor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.AtTop,
        );
        return;
      }
      failure = 'VS Code did not expose the reopened source editor';
    }
    warnScrollHandoff(
      `${target.toString(true)} (Visual to XML): ${failure ?? 'no source offset was available'}`,
      'DITA Editor: switched to XML, but the previous visual position could not be restored.',
    );
  };

  // OPEN-1: persist the user's default-editor preference for *.dita as a
  // workbench.editorAssociations entry — the VS Code setting that OVERRIDES the
  // static manifest `priority`, so the choice survives reloads and is reachable from
  // the Command Palette. Visual -> our viewType; Source -> the built-in text editor
  // ('default', the same id ditaeditor.viewSource opens). Scoped to the *.dita glob,
  // so no other file type is ever affected.
  const DITA_GLOB = '*.dita';
  const setDefaultEditor = async (
    viewType: typeof VIEW_TYPE | 'default',
    label: string,
  ): Promise<void> => {
    const config = vscode.workspace.getConfiguration();
    const current = config.get<Record<string, string>>('workbench.editorAssociations') ?? {};
    await config.update(
      'workbench.editorAssociations',
      { ...current, [DITA_GLOB]: viewType },
      vscode.ConfigurationTarget.Global,
    );
    void vscode.window.showInformationMessage(
      `DITA Editor: .dita files will now open in the ${label} by default.`,
    );
  };

  const lintDocument = (document: vscode.TextDocument): DitaLintIssue[] => {
    if (!isDitaUri(document.uri)) return [];
    const issues = lintDitaSource(document.getText());
    diagnostics.set(document.uri, issues.map((issue) => diagnosticForIssue(document, issue)));
    return issues;
  };

  const openActiveDitaDocument = async (uri?: vscode.Uri): Promise<vscode.TextDocument | null> => {
    const target = activeDitaUri(uri);
    if (!target || !isDitaUri(target)) {
      void vscode.window.showInformationMessage('Open a .dita file first.');
      return null;
    }
    return vscode.workspace.openTextDocument(target);
  };

  const formatActiveDita = async (uri?: vscode.Uri): Promise<void> => {
    const document = await openActiveDitaDocument(uri);
    if (!document) return;
    const formatted = formatDitaSource(document.getText());
    const span = minimalEdit(document.getText(), formatted);
    if (!span) {
      void vscode.window.showInformationMessage('DITA Editor: DITA source is already formatted.');
      lintDocument(document);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
      span.text,
    );
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage('DITA Editor: failed to format DITA source.');
      return;
    }
    lintDocument(document);
  };

  const lintActiveDita = async (uri?: vscode.Uri): Promise<void> => {
    const document = await openActiveDitaDocument(uri);
    if (!document) return;
    const issues = lintDocument(document);
    void vscode.window.showInformationMessage(
      issues.length === 0
        ? 'DITA Editor: no DITA source issues found.'
        : `DITA Editor: found ${issues.length} DITA source issue${issues.length === 1 ? '' : 's'}.`,
    );
  };

  context.subscriptions.push(
    diagnostics,
    debug,
    statusItem,
    { dispose: () => statusTimer && clearTimeout(statusTimer) },
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      visualProvider,
      {
        // enableFindWidget lets the History group's Find button (and Cmd/Ctrl+F) open VS Code's
        // native in-webview find over the rendered canvas text.
        webviewOptions: { retainContextWhenHidden: false, enableFindWidget: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
    ...visualProvider.registerNativeContextCommands(),
    topicSearchProvider,
    vscode.window.registerWebviewViewProvider(TOPIC_SEARCH_VIEW_ID, topicSearchProvider),
    vscode.commands.registerCommand('ditaeditor.searchTopics', () => topicSearchProvider.focus()),
    vscode.commands.registerCommand('ditaeditor.refreshTopicSearch', () => topicSearchProvider.refresh()),
    stylesViewProvider,
    propertiesViewProvider,
    vscode.window.registerWebviewViewProvider(STYLES_VIEW_ID, stylesViewProvider),
    vscode.window.registerWebviewViewProvider(PROPERTIES_VIEW_ID, propertiesViewProvider),
    vscode.commands.registerCommand('ditaeditor.focusStyles', () => stylesViewProvider.focus()),
    vscode.commands.registerCommand('ditaeditor.focusProperties', () => propertiesViewProvider.focus()),
    vscode.commands.registerCommand('ditaeditor.openVisual', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage(
          'Open a .dita file first, then run "DITA Editor: Open Visual Editor".',
        );
        return;
      }
      void openVisualPreservingScroll(target);
    }),
    // C4: reopen the same document in VS Code's default text editor (the raw DITA
    // XML). Read-only round-trip — it opens a different editor, it never edits.
    // reopenInPlace replaces the visual tab so the toggle leaves no duplicate tab.
    vscode.commands.registerCommand('ditaeditor.viewSource', (uri?: vscode.Uri) => {
      const target = activeDitaUri(uri);
      if (!target) {
        void vscode.window.showInformationMessage(
          'Open a .dita file in the visual editor first, then run "DITA Editor: View/Edit Source".',
        );
        return;
      }
      void openSourcePreservingScroll(target);
    }),
    // OPEN-1: Command Palette toggles for the persisted default editor (see setDefaultEditor).
    vscode.commands.registerCommand('ditaeditor.useVisualByDefault', () =>
      setDefaultEditor(VIEW_TYPE, 'Visual editor'),
    ),
    vscode.commands.registerCommand('ditaeditor.useSourceByDefault', () =>
      setDefaultEditor('default', 'source (text) editor'),
    ),
    vscode.commands.registerCommand('ditaeditor.formatDita', formatActiveDita),
    vscode.commands.registerCommand('ditaeditor.lintDita', lintActiveDita),
    // Review Changes: read-only track-changes redline of the working copy vs its
    // git base (merge-base with main). Renders in its own webview panel; writes
    // nothing. Errors surface as messages — never a broken panel. The arg may be
    // a Uri (editor title / explorer) or a SourceControlResourceState (SCM menu).
    vscode.commands.registerCommand('ditaeditor.compareRevision', async (arg?: unknown) => {
      const fromScm =
        arg && typeof arg === 'object' && 'resourceUri' in arg && arg.resourceUri instanceof vscode.Uri
          ? arg.resourceUri
          : undefined;
      const explicit = fromScm ?? (arg instanceof vscode.Uri ? arg : undefined);
      const comparison = explicit
        ? { kind: 'working-copy', modified: explicit } satisfies ReviewComparison<vscode.Uri>
        : activeDitaDiff();
      const target = comparison?.modified ?? activeDitaUri();
      if (!target || !isDitaUri(target)) {
        void vscode.window.showInformationMessage(
          'Open a .dita file first, then run "DITA Editor: Review Changes (Track Changes)".',
        );
        return;
      }
      try {
        await openRedlinePanel(
          context,
          comparison ?? { kind: 'working-copy', modified: target },
          debug,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        debug.appendLine(`compareRevision failed for ${target.fsPath}: ${detail}`);
        void vscode.window.showErrorMessage(`DITA Editor: could not build the review view. ${detail}`);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => scheduleStatusRefresh()),
    // Default review view: Source Control may surface a .dita comparison as one
    // text-diff tab or as two custom-editor panes when the visual editor is the
    // default. Replace either shape with the rendered Review panel. SCM preview
    // tabs are REUSED, so the diff can surface via `changed`, not just `opened`.
    // Escape hatch: ditaeditor.redline.openFromScm = false.
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      // Bookkeeping first (runs even with openFromScm off): closing a manually
      // requested side-by-side diff re-arms Review as the default for that file.
      for (const tab of event.closed) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && shouldInterceptScmDiff(input)) {
          unmarkManualSourceDiff(input);
        }
        const customDiff = manualCustomDiffs.get(tab);
        if (customDiff) {
          unmarkManualSourceDiff(customDiff);
          manualCustomDiffs.delete(tab);
        }
      }
      if (!vscode.workspace.getConfiguration('ditaeditor').get<boolean>('redline.openFromScm', true)) {
        return;
      }
      for (const tab of [...event.opened, ...event.changed]) {
        const input = tab.input;
        const multiDiff = reviewComparisonsFromMultiDiff<vscode.Uri>(input);
        if (multiDiff && multiDiff.comparisons.length > 0) {
          if (pendingMultiDiffTabs.has(tab)) continue;
          pendingMultiDiffTabs.add(tab);
          void (async () => {
            try {
              await openMultiRedlinePanel(
                context,
                multiDiff.comparisons,
                multiDiff.totalTextDiffs,
                tab.label,
                debug,
              );
              // Keep the native multi-file diff behind the rendered panel.
              // Unlike a single-file diff, VS Code exposes no stable API for
              // reconstructing this proposed editor input after it is closed.
              // Review's XML button switches back with previousEditor.
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              debug.appendLine(`dita-editor: multi-redline scm intercept failed for "${tab.label}": ${detail}`);
              void vscode.window.showErrorMessage(
                `DITA Editor: could not build the rendered commit review; the native multi-file diff was kept open. ${detail}`,
              );
            } finally {
              pendingMultiDiffTabs.delete(tab);
            }
          })();
          continue;
        }
        if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
          const candidateTabs = new Map<object, vscode.Tab>();
          const candidates = vscode.window.tabGroups.all.flatMap((group) =>
            group.tabs.flatMap((candidateTab, tabIndex) => {
              const candidateInput = candidateTab.input;
              if (!(candidateInput instanceof vscode.TabInputCustom) || candidateInput.viewType !== VIEW_TYPE) {
                return [];
              }
              const candidate = {
                target: candidateInput.uri,
                order: (group.viewColumn * 10_000) + tabIndex,
                triggered: candidateTab === tab,
              };
              candidateTabs.set(candidate, candidateTab);
              return [candidate];
            }),
          );
          const customPair = reviewComparisonFromCustomEditorCandidates(candidates);
          if (!customPair) continue;
          const originalTab = candidateTabs.get(customPair.original);
          const modifiedTab = candidateTabs.get(customPair.modified);
          if (!originalTab || !modifiedTab) continue;
          const diff = {
            original: customPair.original.target,
            modified: customPair.modified.target,
          };
          if (isManualSourceDiff(diff)) {
            manualCustomDiffs.set(originalTab, diff);
            manualCustomDiffs.set(modifiedTab, diff);
            continue;
          }
          const identity = reviewComparisonIdentity(customPair.comparison);
          if (pendingCustomDiffs.has(identity)) continue;
          pendingCustomDiffs.add(identity);
          void (async () => {
            try {
              const closed = await renderReviewBeforeClosingNative(
                () => openRedlinePanel(context, customPair.comparison, debug),
                () => closeTabsIfStillOpen([originalTab, modifiedTab], debug),
              );
              if (!closed) {
                const detail = `VS Code returned false while closing the custom diff panes for ${diff.modified.toString(true)}.`;
                debug.appendLine(`dita-editor: custom-editor redline intercept failed: ${detail}`);
                void vscode.window.showErrorMessage(
                  `DITA Editor: the rendered review opened, but the visual diff panes could not be closed. ${detail}`,
                );
              }
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              debug.appendLine(
                `dita-editor: custom-editor redline intercept failed for ${diff.original.toString(true)} -> ${diff.modified.toString(true)}: ${detail}`,
              );
              void vscode.window.showErrorMessage(
                `DITA Editor: could not build the rendered review; the visual diff panes were kept open. ${detail}`,
              );
            } finally {
              pendingCustomDiffs.delete(identity);
            }
          })();
          continue;
        }
        if (!(input instanceof vscode.TabInputTextDiff)) continue;
        if (!shouldInterceptScmDiff(input)) continue;
        // The Review panel's "side-by-side XML diff" button opened this one on
        // purpose — leave it alone until the user closes it.
        if (isManualSourceDiff(input)) continue;
        const comparison = reviewComparisonFromDiffTab(input);
        if (!comparison) continue;
        if (pendingTextDiffTabs.has(tab)) continue;
        pendingTextDiffTabs.add(tab);
        void (async () => {
          try {
            // The native diff is the fallback. Build the complete rendered review
            // first; only remove the XML diff after both selected sources loaded
            // and the Review webview rendered successfully.
            const closed = await renderReviewBeforeClosingNative(
              () => openRedlinePanel(context, comparison, debug),
              () => closeTabsIfStillOpen([tab], debug),
            );
            if (!closed) {
              const detail = `VS Code returned false while closing the native diff for ${input.modified.toString(true)}.`;
              debug.appendLine(`dita-editor: redline scm intercept failed: ${detail}`);
              void vscode.window.showErrorMessage(
                `DITA Editor: the rendered review opened, but the native XML diff could not be closed. ${detail}`,
              );
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            debug.appendLine(
              `dita-editor: redline scm intercept failed for ${input.original.toString(true)} -> ${input.modified.toString(true)}: ${detail}`,
            );
            void vscode.window.showErrorMessage(
              `DITA Editor: could not build the rendered review; the native XML diff was kept open. ${detail}`,
            );
          } finally {
            pendingTextDiffTabs.delete(tab);
          }
        })();
      }
    }),
  );
}

export function deactivate(): void {}
