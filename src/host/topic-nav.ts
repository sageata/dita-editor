// UX-8 prev/next topic navigation: step through the sibling .dita files of the
// current document's folder (corpus chapters number their topics), reopening
// each in the SAME visual editor via vscode.openWith.

import * as vscode from 'vscode';
import { basename, dirname } from 'path';

/** Open the previous/next sibling .dita topic. Returns an announcement message
 *  when nothing was opened (boundary / error), or null after a successful open. */
export async function openSiblingTopic(
  documentUri: vscode.Uri,
  delta: -1 | 1,
  viewType: string,
): Promise<string | null> {
  const dir = vscode.Uri.file(dirname(documentUri.fsPath));
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return "Could not read this topic's folder.";
  }
  const files = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.dita'))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const current = basename(documentUri.fsPath);
  const index = files.indexOf(current);
  if (index < 0) return 'Could not locate this topic in its folder.';
  const next = index + delta;
  if (next < 0) return 'This is the first topic in the folder.';
  if (next >= files.length) return 'This is the last topic in the folder.';
  const target = vscode.Uri.joinPath(dir, files[next]);
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
  return null;
}
