import type * as vscode from 'vscode';
import { CANVAS_SCRIPT_FILES } from '../webview/canvas-scripts';
import type { ResolvedWorkspaceFile } from './workspace-files';

export interface VisualWebviewResourceUris {
  contentStyleUris: string[];
  surfaceStyleUri: string;
  baseHref: string;
  scriptUris: string[];
}

export function configureVisualWebviewResources(params: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  documentUri: vscode.Uri;
  folder: vscode.WorkspaceFolder | undefined;
  contentStylesheets: ResolvedWorkspaceFile[];
  joinPath(base: vscode.Uri, ...pathSegments: string[]): vscode.Uri;
}): VisualWebviewResourceUris {
  const { webview, extensionUri, documentUri, folder, contentStylesheets, joinPath } = params;
  const localResourceRoots = [extensionUri];
  if (folder) localResourceRoots.push(folder.uri);
  webview.options = { enableScripts: true, localResourceRoots };

  const neutralThemeUri = webview
    .asWebviewUri(joinPath(extensionUri, 'media', 'content-theme.css'))
    .toString();
  const configuredStyleUris = contentStylesheets.map((file) =>
    webview.asWebviewUri(file.uri).toString(),
  );
  const contentStyleUris = [neutralThemeUri, ...configuredStyleUris];
  const surfaceStyleUri = webview
    .asWebviewUri(joinPath(extensionUri, 'media', 'editor.css'))
    .toString();
  // Non-file documents (e.g. the git:-scheme side of a diff) cannot map to a
  // webview resource URI, so a document-relative base would be broken anyway.
  const baseHref = folder && documentUri.scheme === 'file'
    ? `${webview.asWebviewUri(joinPath(documentUri, '..')).toString()}/`
    : '';
  const scriptUris = CANVAS_SCRIPT_FILES.map((file) =>
    webview.asWebviewUri(joinPath(extensionUri, 'media', file)).toString(),
  );

  return { contentStyleUris, surfaceStyleUri, baseHref, scriptUris };
}

export interface RedlineWebviewResourceUris {
  contentStyleUris: string[];
  surfaceStyleUri: string;
  baseHref: string;
  scriptUris: string[];
}

/** Resource wiring for the read-only Review Changes (track-changes) panel. Same
 *  corpus sheets as the canvas, but redline.css instead of editor.css (no editing
 *  chrome on this surface). The ONLY script is media/redline.js — scroll
 *  persistence across auto-refresh html swaps; it never edits anything. */
export function configureRedlineWebviewResources(params: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  documentUri: vscode.Uri;
  folder: vscode.WorkspaceFolder | undefined;
  contentStylesheets: ResolvedWorkspaceFile[];
  joinPath(base: vscode.Uri, ...pathSegments: string[]): vscode.Uri;
}): RedlineWebviewResourceUris {
  const { webview, extensionUri, documentUri, folder, contentStylesheets, joinPath } = params;
  const localResourceRoots = [extensionUri];
  if (folder) localResourceRoots.push(folder.uri);
  webview.options = { enableScripts: true, localResourceRoots };

  const neutralThemeUri = webview
    .asWebviewUri(joinPath(extensionUri, 'media', 'content-theme.css'))
    .toString();
  const configuredStyleUris = contentStylesheets.map((file) =>
    webview.asWebviewUri(file.uri).toString(),
  );
  const contentStyleUris = [neutralThemeUri, ...configuredStyleUris];
  const surfaceStyleUri = webview
    .asWebviewUri(joinPath(extensionUri, 'media', 'redline.css'))
    .toString();
  // Same file:-scheme guard as the canvas; the panel always receives the
  // working-copy uri, so this holds in practice.
  const baseHref = folder && documentUri.scheme === 'file'
    ? `${webview.asWebviewUri(joinPath(documentUri, '..')).toString()}/`
    : '';
  const scriptUris = [
    webview.asWebviewUri(joinPath(extensionUri, 'media', 'redline.js')).toString(),
  ];

  return { contentStyleUris, surfaceStyleUri, baseHref, scriptUris };
}
