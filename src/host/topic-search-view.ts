// Host side of the Search DITA Topics activity-bar view: a WebviewViewProvider
// that adapts vscode workspace IO onto the pure search controller and forwards
// result clicks to the open-at-match delegate wired in extension.ts. Scans
// .dita files only, in file-scheme workspaces only, and only when trusted.

import * as vscode from 'vscode';
import type { SearchIo, TopicSearchController } from '../search/search-controller';
import { createTopicSearchController } from '../search/search-controller';
import { buildTopicSearchHtml } from '../webview/topic-search-html';
import type {
  TopicReplaceSummary,
  TopicSearchHostMessage,
  TopicSearchResultsMessage,
} from '../webview/topic-search-messages';
import { makeNonce } from './nonce';

export const TOPIC_SEARCH_VIEW_ID = 'ditaeditor.topicSearch';
const TOPIC_SEARCH_RESOURCE_REVISION = 'topic-search-3';

export interface TopicSearchDelegate {
  openMatch(
    target: vscode.Uri,
    sourceStart: number,
    renderedText: string,
    matchCase: boolean,
  ): Promise<void>;
  replaceMatch(
    target: vscode.Uri,
    args: { sourceStart: number; sourceEnd: number; renderedText: string; replacement: string },
  ): Promise<TopicReplaceSummary>;
  /** Resolves null when the user declines the confirmation dialog. */
  replaceAll(
    query: string,
    matchCase: boolean,
    replacement: string,
  ): Promise<TopicReplaceSummary | null>;
}

interface LastSearch {
  query: string;
  matchCase: boolean;
  generation: number;
}

export class TopicSearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  private readonly controller: TopicSearchController;
  private lastSearch: LastSearch | null = null;
  private lastResults: TopicSearchResultsMessage | null = null;
  private pendingFocus = false;
  private readonly trustListener: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly debug: vscode.OutputChannel,
    private readonly delegate: TopicSearchDelegate,
  ) {
    this.controller = createTopicSearchController(this.createIo());
    this.trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => this.rerunLastSearch());
  }

  dispose(): void {
    this.trustListener.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = makeNonce();
    const mediaUri = (file: string): string => {
      const uri = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
      return `${uri.toString()}?v=${TOPIC_SEARCH_RESOURCE_REVISION}`;
    };
    view.webview.html = buildTopicSearchHtml({
      cspSource: view.webview.cspSource,
      nonce,
      scriptUri: mediaUri('topic-search.js'),
      styleUri: mediaUri('topic-search.css'),
    });
    const messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    view.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.view === view) this.view = null;
    });
  }

  /** Reveal the view (creating it on first use) and focus its search input. */
  focus(): void {
    this.pendingFocus = true;
    const revealed = this.view !== null;
    void vscode.commands
      .executeCommand(`${TOPIC_SEARCH_VIEW_ID}.focus`)
      .then(undefined, async () => {
        // Fallback if the auto-generated view focus command is unavailable.
        await vscode.commands.executeCommand('workbench.view.extension.ditaeditor-search');
      })
      .then(() => {
        if (revealed && this.view) {
          this.pendingFocus = false;
          this.post({ type: 'focusSearchInput' });
        }
        // Otherwise the searchReady handshake of the freshly resolved view
        // consumes pendingFocus.
      });
  }

  /** Toolbar refresh: drop the extraction cache and re-run the last query. */
  refresh(): void {
    this.controller.clearCache();
    this.rerunLastSearch();
  }

  private rerunLastSearch(): void {
    if (this.lastSearch) {
      void this.runSearch(this.lastSearch.query, this.lastSearch.matchCase, this.lastSearch.generation);
    }
  }

  private post(message: TopicSearchHostMessage): void {
    if (!this.view) return;
    void this.view.webview.postMessage(message);
  }

  private unavailableReason(): string | null {
    if (!vscode.workspace.isTrusted) {
      return 'Topic search is disabled in Restricted Mode. Trust this workspace to search.';
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.some((folder) => folder.uri.scheme === 'file')) {
      return 'Topic search requires a local (file) workspace folder.';
    }
    return null;
  }

  private createIo(): SearchIo {
    return {
      listFiles: async () => {
        const uris = await vscode.workspace.findFiles('**/*.dita');
        const multiRoot = (vscode.workspace.workspaceFolders ?? []).length > 1;
        return uris
          .filter((uri) => uri.scheme === 'file')
          .map((uri) => ({
            key: uri.toString(true),
            label: vscode.workspace.asRelativePath(uri, multiRoot),
          }));
      },
      stat: async (ref) => {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(ref.key));
          return { mtime: stat.mtime, size: stat.size };
        } catch {
          return null; // deleted between listing and stat — the file is just skipped
        }
      },
      read: async (ref) =>
        new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(ref.key))),
      openDocumentText: (ref) => {
        const doc = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString(true) === ref.key,
        );
        return doc ? { text: doc.getText(), version: doc.version } : null;
      },
    };
  }

  private async runSearch(query: string, matchCase: boolean, generation: number): Promise<void> {
    this.lastSearch = { query, matchCase, generation };
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.post({ type: 'searchUnavailable', reason: unavailable });
      return;
    }
    this.post({ type: 'searchBusy', generation });
    try {
      const outcome = await this.controller.search(query, matchCase, generation);
      if (!outcome) return; // superseded by a newer generation
      const results: TopicSearchResultsMessage = { type: 'searchResults', generation, ...outcome };
      this.lastResults = results;
      this.post(results);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.debug.appendLine(`DITA Editor topic search failed: ${detail}`);
      this.post({ type: 'searchUnavailable', reason: 'Topic search failed — see the DITA Editor output channel.' });
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    const msg = (message ?? {}) as Record<string, unknown>;
    if (msg.type === 'searchReady') {
      if (this.lastResults) this.post(this.lastResults);
      if (this.pendingFocus) {
        this.pendingFocus = false;
        this.post({ type: 'focusSearchInput' });
      }
      return;
    }
    if (msg.type === 'search') {
      if (typeof msg.query !== 'string' || typeof msg.generation !== 'number') return;
      await this.runSearch(msg.query, msg.matchCase === true, msg.generation);
      return;
    }
    if (msg.type === 'refreshSearch') {
      this.refresh();
      return;
    }
    if (msg.type === 'openMatch') {
      const target = this.validTarget(msg);
      if (!target) return;
      try {
        await this.delegate.openMatch(
          target,
          msg.sourceStart as number,
          msg.renderedText as string,
          msg.matchCase === true,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.debug.appendLine(`DITA Editor topic search open failed for ${msg.uri}: ${detail}`);
        void vscode.window.showErrorMessage(`DITA Editor: could not open the search result. ${detail}`);
      }
      return;
    }
    if (msg.type === 'replaceMatch') {
      const target = this.validTarget(msg);
      const sourceStart = msg.sourceStart as number;
      const sourceEnd = msg.sourceEnd;
      const renderedText = msg.renderedText as string;
      const replacement = msg.replacement;
      if (
        !target ||
        typeof sourceEnd !== 'number' ||
        !Number.isFinite(sourceEnd) ||
        sourceEnd <= sourceStart ||
        renderedText === '' ||
        typeof replacement !== 'string'
      ) return;
      await this.runReplace(
        () => this.delegate.replaceMatch(target, { sourceStart, sourceEnd, renderedText, replacement }),
        String(msg.uri),
      );
      return;
    }
    if (msg.type === 'replaceAll') {
      const query = msg.query;
      const replacement = msg.replacement;
      const matchCase = msg.matchCase === true;
      if (typeof query !== 'string' || typeof replacement !== 'string') return;
      await this.runReplace(
        () => this.delegate.replaceAll(query, matchCase, replacement),
        'workspace replace all',
      );
    }
  }

  /** Shared openMatch/replaceMatch payload validation: a file-scheme .dita URI
   *  plus a sane sourceStart. Returns null (drop the message) otherwise. */
  private validTarget(msg: Record<string, unknown>): vscode.Uri | null {
    if (
      typeof msg.uri !== 'string' ||
      typeof msg.sourceStart !== 'number' ||
      !Number.isFinite(msg.sourceStart) ||
      msg.sourceStart < 0 ||
      typeof msg.renderedText !== 'string'
    ) return null;
    let target: vscode.Uri;
    try {
      target = vscode.Uri.parse(msg.uri, true);
    } catch {
      return null;
    }
    if (target.scheme !== 'file' || !target.fsPath.toLowerCase().endsWith('.dita')) return null;
    return target;
  }

  /** Run a replace action, then refresh the results the webview shows and
   *  report the outcome on its status line. Extraction caches are dropped so
   *  the re-search always sees the just-edited buffers. */
  private async runReplace(
    action: () => Promise<TopicReplaceSummary | null>,
    label: string,
  ): Promise<void> {
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.post({ type: 'searchUnavailable', reason: unavailable });
      return;
    }
    try {
      const summary = await action();
      if (!summary) return; // the user declined the Replace All confirmation
      this.controller.clearCache();
      if (this.lastSearch) {
        await this.runSearch(this.lastSearch.query, this.lastSearch.matchCase, this.lastSearch.generation);
      }
      this.post({ type: 'replaceDone', ...summary });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.debug.appendLine(`DITA Editor topic replace failed (${label}): ${detail}`);
      void vscode.window.showErrorMessage(`DITA Editor: replace failed. ${detail}`);
    }
  }
}
