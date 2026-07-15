import * as vscode from 'vscode';
import { applyImageAlt, imageAltText } from '../cst/image-alt';
import { parse } from '../cst/parse';
import { serialize } from '../cst/serialize';
import { removeAttrs, setAttr } from '../cst/edit';
import { imageDimensionError } from '../commands/attr-validity';
import { findElementById } from '../cst/element-ids';
import type { Document } from '../cst/types';
import { findElements } from '../cst/query';
import {
  buildImagePickItemsForDir,
  imageDirRelForHref,
  isImageAssetName,
} from '../commands/image-assets';

export interface ImageActionContext {
  document: vscode.TextDocument;
  folder: vscode.WorkspaceFolder | undefined;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  clearDiagnostics(): void;
}

type ImageItem = vscode.QuickPickItem & { href: string };

const INSERT_IMAGE_DIR_FALLBACKS = ['../images', 'images', ''];

function displayDir(dirRel: string): string {
  return dirRel || '.';
}

function imageDirCandidatesForInsert(source: string): string[] {
  const candidates: string[] = [];
  try {
    const doc = parse(source);
    for (const image of findElements(doc, 'image')) {
      const href = image.attrs.find((a) => a.name === 'href')?.value ?? '';
      if (!href) continue;
      candidates.push(imageDirRelForHref(href));
      break;
    }
  } catch (err) {
    console.warn(
      'dita-editor: could not infer image directory from current document',
      err instanceof Error ? err.message : err,
    );
  }
  candidates.push(...INSERT_IMAGE_DIR_FALLBACKS);
  return Array.from(new Set(candidates));
}

async function readImageNames(ctx: ImageActionContext, dirRel: string): Promise<string[] | null> {
  const dirUri = vscode.Uri.joinPath(ctx.document.uri, '..', dirRel);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch (err) {
    console.warn(
      `dita-editor: image directory unavailable at "${displayDir(dirRel)}"`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  return entries
    .filter(([n, type]) => (type & vscode.FileType.File) !== 0 && isImageAssetName(n))
    .map(([n]) => n);
}

async function pickImageHrefFromDir(
  names: string[],
  dirRel: string,
  current: string,
  title: string,
  placeHolder: string,
): Promise<string | null> {
  const items: ImageItem[] = buildImagePickItemsForDir(names, dirRel, current).map((item) => ({
    label: item.label,
    description: item.description,
    href: item.href,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    matchOnDescription: true,
  });
  return pick?.href ?? null;
}

export async function pickImageHrefForInsert(ctx: ImageActionContext): Promise<string | null> {
  if (!ctx.folder) {
    ctx.announce('Inserting an image needs an open workspace folder.');
    return null;
  }

  const checkedDirs: string[] = [];
  let foundReadableDir = false;
  for (const dirRel of imageDirCandidatesForInsert(ctx.document.getText())) {
    checkedDirs.push(displayDir(dirRel));
    const names = await readImageNames(ctx, dirRel);
    if (!names) continue;
    foundReadableDir = true;
    if (names.length === 0) continue;
    return pickImageHrefFromDir(
      names,
      dirRel,
      '',
      'Insert image',
      `Choose an image from ${displayDir(dirRel)}`,
    );
  }

  const where = checkedDirs.join(', ');
  const message = foundReadableDir
    ? `DITA Editor: no images found in "${where}".`
    : `DITA Editor: no image folder found at "${where}".`;
  void vscode.window.showInformationMessage(message);
  ctx.announce(foundReadableDir ? `No images found in ${where}.` : `No image folder found at ${where}.`);
  return null;
}

// P1-4: change a selected image's @href to another REAL asset from the topic's image folder.
// The webview only sends the image's stable id; the host owns asset enumeration (it has the
// filesystem) and runs a native, fully-accessible QuickPick. setAttr splices only the href
// value, so the on-disk diff is exactly the new path; cancelling, re-picking the same path, or
// an unreadable/empty image folder writes NOTHING.
export async function pickAndApplyImageHref(ctx: ImageActionContext, structId: string): Promise<void> {
  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null); // mid-edit / invalid XML -> resync, no mutation
    return;
  }
  const el = findElementById(doc, structId);
  if (!el || el.name !== 'image') {
    ctx.pushBody(null, null); // stale id (ids reassign after structural edits) -> resync
    return;
  }
  if (!ctx.folder) {
    ctx.announce('Changing an image needs an open workspace folder.');
    return;
  }
  const current = el.attrs.find((a) => a.name === 'href')?.value ?? '';
  // The directory the current href points into, resolved relative to the .dita file
  // (e.g. href "images/x.jpeg" -> "<topicDir>/images"; a bare filename -> the topic dir).
  const dirRel = imageDirRelForHref(current);
  const names = await readImageNames(ctx, dirRel);
  if (!names) {
    const where = dirRel || '.';
    void vscode.window.showInformationMessage(`DITA Editor: no image folder found at "${where}".`);
    ctx.announce(`No image folder found at ${where}.`);
    return; // missing/deleted folder -> no bytes change
  }
  if (names.length === 0) {
    const where = dirRel || '.';
    void vscode.window.showInformationMessage(`DITA Editor: no images found in "${where}".`);
    ctx.announce(`No images found in ${where}.`);
    return; // empty folder -> no bytes change
  }
  const href = await pickImageHrefFromDir(
    names,
    imageDirRelForHref(current),
    current,
    'Change image source',
    current ? `Current: ${current}` : 'Choose an image',
  );
  if (!href) return; // cancelled -> no-op, no bytes change
  if (href === current) {
    ctx.announce('Image source unchanged.');
    return; // same asset -> no mutation
  }
  setAttr(el, 'href', href, source); // splices only the href value span
  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(null, null); // re-render so the preview fetches the newly-referenced asset
    ctx.announce(`Image source changed to ${href.split(/[\\/]/).pop() ?? href}.`);
  }
}

// P1-4: edit the selected image's DITA <alt> child. This is not an attribute edit:
// DITA image alt text is element content, so the CST helper adds/updates/removes <alt>.
export async function promptAndApplyImageAlt(ctx: ImageActionContext, structId: string): Promise<void> {
  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null); // mid-edit / invalid XML -> resync, no mutation
    return;
  }
  const el = findElementById(doc, structId);
  if (!el || el.name !== 'image') {
    ctx.pushBody(null, null); // stale id -> resync
    return;
  }
  const current = imageAltText(el);
  const next = await vscode.window.showInputBox({
    title: 'Edit image alt text',
    value: current,
    prompt: 'This writes a DITA <alt> child on the selected image. Clear it to remove the alt text.',
    placeHolder: 'Describe the image',
  });
  if (next === undefined) return; // cancelled -> no-op, no bytes change
  const result = applyImageAlt(el, next);
  if (result === 'unchanged') {
    ctx.announce('Image alt text unchanged.');
    return;
  }
  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(null, null); // re-render so the image alt attribute reflects the DITA <alt>
    ctx.announce(result === 'cleared' ? 'Image alt text cleared.' : 'Image alt text updated.');
  }
}

export async function applyImageWidth(
  ctx: ImageActionContext,
  structId: string,
  requestedWidth: string,
): Promise<void> {
  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }
  const el = findElementById(doc, structId);
  if (!el || el.name !== 'image') {
    ctx.pushBody(null, null);
    return;
  }
  const current = el.attrs.find((attr) => attr.name === 'width')?.value ?? '';
  const next = requestedWidth.trim();
  const reason = imageDimensionError(next);
  if (reason) {
    ctx.announce(reason);
    return;
  }
  if (next === current) {
    ctx.announce('Image width unchanged.');
    return;
  }
  if (next === '') removeAttrs(el, ['width'], source);
  else setAttr(el, 'width', next, source);
  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(null, null);
    ctx.announce(next === '' ? 'Image width cleared.' : `Image width updated to ${next}.`);
  }
}

export async function applyImageAlignment(
  ctx: ImageActionContext,
  structId: string,
  requestedAlign: string,
): Promise<void> {
  if (!['left', 'center', 'right'].includes(requestedAlign)) {
    ctx.announce('Image alignment must be left, center, or right.');
    return;
  }
  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }
  const el = findElementById(doc, structId);
  if (!el || el.name !== 'image') {
    ctx.pushBody(null, null);
    return;
  }
  const currentAlign = el.attrs.find((attr) => attr.name === 'align')?.value ?? '';
  const currentPlacement = el.attrs.find((attr) => attr.name === 'placement')?.value ?? '';
  if (currentAlign === requestedAlign && currentPlacement === 'break') {
    ctx.announce(`Image already aligned ${requestedAlign}.`);
    return;
  }
  setAttr(el, 'placement', 'break', source);
  setAttr(el, 'align', requestedAlign, source);
  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    ctx.pushBody(null, null);
    ctx.announce(`Image aligned ${requestedAlign}.`);
  }
}

export async function promptAndApplyImageWidth(ctx: ImageActionContext, structId: string): Promise<void> {
  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }
  const el = findElementById(doc, structId);
  if (!el || el.name !== 'image') {
    ctx.pushBody(null, null);
    return;
  }
  const current = el.attrs.find((attr) => attr.name === 'width')?.value ?? '';
  const entered = await vscode.window.showInputBox({
    title: 'Resize image',
    value: current,
    prompt: 'Set the DITA image width (for example 320px or 12.5cm). Clear it to restore intrinsic size.',
    placeHolder: '320px',
  });
  if (entered === undefined) return;
  await applyImageWidth(ctx, structId, entered);
}
