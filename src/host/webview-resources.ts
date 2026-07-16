import type * as vscode from 'vscode';
import { parseFragment, serialize } from 'parse5';
import { CANVAS_SCRIPT_FILES } from '../webview/canvas-scripts';
import type { ResolvedWorkspaceFile } from './workspace-files';

const REDLINE_RESOURCE_REVISION = 'navigation-3';

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

interface ReviewHtmlNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ReviewHtmlNode[];
}

function isRelativeImageReference(value: string): boolean {
  const pathEnd = value.search(/[?#]/);
  const pathValue = pathEnd < 0 ? value : value.slice(0, pathEnd);
  return pathValue !== ''
    && !value.startsWith('#')
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** Rewrite generated review images without touching absolute/data/web URLs. Multi-file
 *  panels use this per topic because one HTML document cannot have multiple <base>s. */
export function rewriteRedlineImageSources(
  html: string,
  resolveRelativeSource: (source: string) => string,
): string {
  const fragment = parseFragment(html);
  const visit = (node: ReviewHtmlNode): void => {
    if (node.tagName === 'img') {
      const source = node.attrs?.find((attribute) => attribute.name === 'src');
      if (source && isRelativeImageReference(source.value)) {
        source.value = resolveRelativeSource(source.value);
      }
    }
    node.childNodes?.forEach(visit);
  };
  visit(fragment as unknown as ReviewHtmlNode);
  return serialize(fragment);
}

/** Resource wiring for the read-only Review Changes panel. Same
 *  corpus sheets as the canvas, but redline.css instead of editor.css (no editing
 *  chrome on this surface). The ONLY script is media/redline-review.js — persisted
 *  mode/scroll state plus comparison navigation; it never edits anything. */
export function configureRedlineWebviewResources(params: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  resourceUri: vscode.Uri;
  additionalResourceUris?: readonly vscode.Uri[];
  folder: vscode.WorkspaceFolder | undefined;
  contentStylesheets: ResolvedWorkspaceFile[];
  joinPath(base: vscode.Uri, ...pathSegments: string[]): vscode.Uri;
}): RedlineWebviewResourceUris {
  const {
    webview,
    extensionUri,
    resourceUri,
    additionalResourceUris = [],
    folder,
    contentStylesheets,
    joinPath,
  } = params;
  const localResourceRoots: vscode.Uri[] = [];
  const rootKeys = new Set<string>();
  const addRoot = (root: vscode.Uri): void => {
    const key = root.toString(true);
    if (rootKeys.has(key)) return;
    rootKeys.add(key);
    localResourceRoots.push(root);
  };
  addRoot(extensionUri);
  if (folder) addRoot(folder.uri);
  for (const candidate of [resourceUri, ...additionalResourceUris]) {
    if (candidate.scheme === 'file') addRoot(joinPath(candidate, '..'));
  }
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
    .toString() + `?v=${REDLINE_RESOURCE_REVISION}`;
  const baseHref = resourceUri.scheme === 'file'
    ? `${webview.asWebviewUri(joinPath(resourceUri, '..')).toString()}/`
    : '';
  const scriptUris = [
    webview.asWebviewUri(joinPath(extensionUri, 'media', 'redline-review.js')).toString()
      + `?v=${REDLINE_RESOURCE_REVISION}`,
  ];

  return { contentStyleUris, surfaceStyleUri, baseHref, scriptUris };
}
