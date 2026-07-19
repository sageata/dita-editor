import { Buffer } from 'node:buffer';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  type ReviewExportResource,
  type ReviewExportSaveAdapter,
  type ReviewExportStylesheet,
} from '../compare/review-html-export';
import { isCanonicalPathInside } from './workspace-files';

async function canonicalFileRoots(roots: readonly vscode.Uri[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    if (root.scheme !== 'file') continue;
    canonical.push(await realpath(root.fsPath));
  }
  return canonical;
}

export function createReviewExportResourceReader(
  allowedFileRoots: readonly vscode.Uri[],
): (absoluteUri: string) => Promise<ReviewExportResource> {
  let rootsPromise: Promise<string[]> | undefined;
  return async (absoluteUri) => {
    const uri = vscode.Uri.parse(absoluteUri, true);
    if (uri.scheme === 'file') {
      rootsPromise ??= canonicalFileRoots(allowedFileRoots);
      const [target, roots] = await Promise.all([realpath(uri.fsPath), rootsPromise]);
      if (!roots.some((root) => isCanonicalPathInside(root, target, process.platform))) {
        throw new Error(`Export resource escapes the allowed workspace roots: ${absoluteUri}.`);
      }
      return { content: await vscode.workspace.fs.readFile(vscode.Uri.file(target)) };
    }
    if (uri.scheme === 'https') {
      const response = await fetch(absoluteUri);
      if (!response.ok) {
        throw new Error(`${absoluteUri} returned HTTP ${response.status} ${response.statusText}.`);
      }
      const resolved = vscode.Uri.parse(response.url, true);
      if (resolved.scheme !== 'https') {
        throw new Error(`HTTPS export resource redirected to unsupported protocol ${resolved.scheme}: ${response.url}.`);
      }
      return {
        content: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get('content-type') ?? undefined,
        resolvedUri: response.url,
      };
    }
    throw new Error(`Unsupported export resource protocol ${uri.scheme}: ${absoluteUri}.`);
  };
}

async function capturedStylesheet(
  uri: vscode.Uri,
  readResource: (absoluteUri: string) => Promise<ReviewExportResource>,
): Promise<ReviewExportStylesheet> {
  const baseUri = uri.toString(true);
  const resource = await readResource(baseUri);
  return {
    cssText: new TextDecoder().decode(resource.content),
    baseUri: resource.resolvedUri ?? baseUri,
  };
}

export async function captureReviewExportStylesheets(params: {
  extensionUri: vscode.Uri;
  configuredStyleUris: readonly vscode.Uri[];
  authorStylesheet?: ReviewExportStylesheet;
  managedCssText: string;
  managedBaseUri: vscode.Uri;
  allowedFileRoots: readonly vscode.Uri[];
}): Promise<ReviewExportStylesheet[]> {
  const readResource = createReviewExportResourceReader(params.allowedFileRoots);
  const neutral = await capturedStylesheet(
    vscode.Uri.joinPath(params.extensionUri, 'media', 'content-theme.css'),
    readResource,
  );
  const configured: ReviewExportStylesheet[] = [];
  for (const uri of params.configuredStyleUris) {
    configured.push(await capturedStylesheet(uri, readResource));
  }
  const managed = {
    cssText: params.managedCssText,
    baseUri: params.managedBaseUri.toString(true),
  };
  const redline = await capturedStylesheet(
    vscode.Uri.joinPath(params.extensionUri, 'media', 'redline.css'),
    readResource,
  );
  return [
    neutral,
    ...configured,
    ...(params.authorStylesheet ? [params.authorStylesheet] : []),
    managed,
    redline,
  ];
}

export function reviewDocumentDirectory(documentUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(documentUri, '..');
}

export function reviewExportSaveAdapter(
  defaultDirectory: vscode.Uri,
  debug: vscode.OutputChannel,
  allowedFileRoots: readonly vscode.Uri[],
): ReviewExportSaveAdapter {
  return {
    chooseDestination: async (defaultFilename) => {
      const selected = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDirectory, defaultFilename),
        filters: { 'HTML files': ['html'] },
        saveLabel: 'Export comparison',
      });
      return selected?.toString(true);
    },
    readResource: createReviewExportResourceReader(allowedFileRoots),
    write: async (destination, completeHtml) => {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.parse(destination, true),
        Buffer.from(completeHtml, 'utf8'),
      );
    },
    log: (message) => debug.appendLine(message),
    showError: (message) => vscode.window.showErrorMessage(message),
  };
}
