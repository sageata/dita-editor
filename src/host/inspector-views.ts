// Host side of the two Secondary Side Bar inspector views (Styles and
// Properties): a parameterized WebviewViewProvider on the topic-search-view
// template. Each provider forwards hub snapshots/events into its webview and
// routes view-posted ops back through the hub into the active document's
// canvas-message handler.

import * as vscode from 'vscode';
import { buildInspectorViewHtml } from '../webview/inspector-view-html';
import type { InspectorHub } from './inspector-hub';
import { makeNonce } from './nonce';

export const STYLES_VIEW_ID = 'ditaeditor.stylesView';
export const PROPERTIES_VIEW_ID = 'ditaeditor.propertiesView';
export const INSPECTOR_CONTAINER_FOCUS_COMMAND = 'workbench.view.extension.ditaeditor-inspector';
const INSPECTOR_RESOURCE_REVISION = 'inspector-views-11';

interface InspectorViewConfig {
  viewId: string;
  /** Media scripts in load order (panel engine before its view bootstrap). */
  scriptFiles: string[];
  styleFile: string;
  bodyClass: string;
  ariaLabel: string;
  readyType: string;
  subscribe(hub: InspectorHub, listener: (message: unknown) => void): () => void;
  snapshot(hub: InspectorHub): unknown;
  dispatch(hub: InspectorHub, message: unknown): boolean;
  /** Extra work when the view announces ready (e.g. request live target state). */
  onReady?(hub: InspectorHub): void;
}

export class InspectorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  private pendingFocus = false;
  private readonly hubSubscription: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hub: InspectorHub,
    private readonly config: InspectorViewConfig,
  ) {
    this.hubSubscription = config.subscribe(hub, (message) => this.post(message));
  }

  dispose(): void {
    this.hubSubscription();
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
      return `${uri.toString()}?v=${INSPECTOR_RESOURCE_REVISION}`;
    };
    view.webview.html = buildInspectorViewHtml({
      cspSource: view.webview.cspSource,
      nonce,
      scriptUris: this.config.scriptFiles.map(mediaUri),
      styleUri: mediaUri(this.config.styleFile),
      bodyClass: this.config.bodyClass,
      ariaLabel: this.config.ariaLabel,
    });
    const messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
    view.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.view === view) this.view = null;
    });
  }

  /** Reveal the view (creating it on first use) and focus it. */
  focus(): void {
    this.pendingFocus = true;
    const revealed = this.view !== null;
    void vscode.commands
      .executeCommand(`${this.config.viewId}.focus`)
      .then(undefined, async () => {
        // Fallback if the auto-generated view focus command is unavailable.
        await vscode.commands.executeCommand(INSPECTOR_CONTAINER_FOCUS_COMMAND);
      })
      .then(() => {
        if (revealed && this.view) {
          this.pendingFocus = false;
          this.post({ type: 'focusView' });
        }
        // Otherwise the ready handshake of the freshly resolved view consumes
        // pendingFocus.
      });
  }

  private post(message: unknown): void {
    if (!this.view) return;
    void this.view.webview.postMessage(message);
  }

  private onMessage(message: unknown): void {
    const msg = (message ?? {}) as Record<string, unknown>;
    if (msg.type === this.config.readyType) {
      this.post(this.config.snapshot(this.hub));
      this.config.onReady?.(this.hub);
      if (this.pendingFocus) {
        this.pendingFocus = false;
        this.post({ type: 'focusView' });
      }
      return;
    }
    this.config.dispatch(this.hub, message);
  }
}

export function createStylesViewProvider(
  extensionUri: vscode.Uri,
  hub: InspectorHub,
): InspectorViewProvider {
  return new InspectorViewProvider(extensionUri, hub, {
    viewId: STYLES_VIEW_ID,
    scriptFiles: ['styles-preview-popup.js', 'styles-panel.js', 'styles-view.js'],
    styleFile: 'styles-view.css',
    bodyClass: 'ditaeditor-styles-view',
    ariaLabel: 'DITA styles',
    readyType: 'stylesReady',
    subscribe: (hub, listener) => hub.onStyles(listener),
    snapshot: (hub) => hub.stylesSnapshot(),
    dispatch: (hub, message) => hub.dispatchStyles(message),
    // A view resolved after the canvas last spoke needs a fresh live target;
    // the hub no-ops when no visual editor is active.
    onReady: (hub) => hub.requestTargetState(),
  });
}

export function createPropertiesViewProvider(
  extensionUri: vscode.Uri,
  hub: InspectorHub,
): InspectorViewProvider {
  return new InspectorViewProvider(extensionUri, hub, {
    viewId: PROPERTIES_VIEW_ID,
    scriptFiles: ['properties-panel.js', 'properties-view.js'],
    styleFile: 'properties-view.css',
    bodyClass: 'ditaeditor-properties-view',
    ariaLabel: 'DITA properties',
    readyType: 'propertiesReady',
    subscribe: (hub, listener) => hub.onProperties(listener),
    snapshot: (hub) => hub.propertiesSnapshot(),
    dispatch: (hub, message) => hub.dispatchProperties(message),
  });
}
