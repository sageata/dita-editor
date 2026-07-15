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
  isManualSourceDiff,
  renderReviewBeforeClosingNative,
  reviewComparisonFromDiffTab,
  reviewComparisonsFromMultiDiff,
  shouldInterceptScmDiff,
  unmarkManualSourceDiff,
  type ReviewComparison,
} from './host/scm-intercept';

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
async function reopenInPlace(target: vscode.Uri, viewType: string): Promise<void> {
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
  let prior: vscode.Tab | undefined;
  for (const group of vscode.window.tabGroups.all) {
    prior = group.tabs.find(isPriorTab);
    if (prior) break;
  }
  const viewColumn = prior?.group.viewColumn;
  await vscode.commands.executeCommand('vscode.openWith', target, viewType, viewColumn);
  const remainingPriorTabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(isPriorTab),
  );
  if (remainingPriorTabs.length > 0) {
    await vscode.window.tabGroups.close(remainingPriorTabs, false);
  }
}

function isDitaUri(uri: vscode.Uri): boolean {
  return uri.fsPath.toLowerCase().endsWith('.dita');
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

  const host: VisualHost = {
    diagnostics,
    debug,
    notifyActive(doc, active) {
      if (active) activeVisualDoc = doc;
      else if (activeVisualDoc === doc) activeVisualDoc = undefined;
      updateStatusBar();
    },
    scheduleStatusRefresh,
  };
  const visualProvider = new DitaVisualEditorProvider(context, host);

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
    vscode.commands.registerCommand('ditaeditor.openVisual', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage(
          'Open a .dita file first, then run "DITA Editor: Open Visual Editor".',
        );
        return;
      }
      void reopenInPlace(target, VIEW_TYPE);
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
      void reopenInPlace(target, 'default');
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
    // Default review view: a Source-Control click on a modified .dita opens a raw
    // XML text diff (per the workspace's git-scheme editorAssociations rule) — for
    // authors we replace that tab with the rendered Review panel. SCM preview tabs
    // are REUSED, so the diff can surface via `changed`, not just `opened`. No
    // re-entrancy: closing fires only `closed`, and the webview panel is never a
    // TabInputTextDiff. Escape hatch: ditaeditor.redline.openFromScm = false.
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      // Bookkeeping first (runs even with openFromScm off): closing a manually
      // requested side-by-side diff re-arms Review as the default for that file.
      for (const tab of event.closed) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && shouldInterceptScmDiff(input)) {
          unmarkManualSourceDiff(input);
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
              const closed = await vscode.window.tabGroups.close(tab, true);
              if (!closed) {
                const detail = `VS Code returned false while closing the native multi-file diff "${tab.label}".`;
                debug.appendLine(`dita-editor: multi-redline scm intercept failed: ${detail}`);
                void vscode.window.showErrorMessage(
                  `DITA Editor: the rendered commit review opened, but the native XML diff could not be closed. ${detail}`,
                );
              }
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
        if (!(input instanceof vscode.TabInputTextDiff)) continue;
        if (!shouldInterceptScmDiff(input)) continue;
        // The Review panel's "side-by-side XML diff" button opened this one on
        // purpose — leave it alone until the user closes it.
        if (isManualSourceDiff(input)) continue;
        const comparison = reviewComparisonFromDiffTab(input);
        if (!comparison) continue;
        void (async () => {
          try {
            // The native diff is the fallback. Build the complete rendered review
            // first; only remove the XML diff after both selected sources loaded
            // and the Review webview rendered successfully.
            const closed = await renderReviewBeforeClosingNative(
              () => openRedlinePanel(context, comparison, debug),
              () => vscode.window.tabGroups.close(tab, true),
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
          }
        })();
      }
    }),
  );
}

export function deactivate(): void {}
