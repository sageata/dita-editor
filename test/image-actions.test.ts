import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import type { ImageActionContext } from '../src/host/image-actions';

const SRC =
  '<topic id="t"><body>\n' +
  '  <fig><image href="images/img_005.jpeg" placement="break"/></fig>\n' +
  '  <p>after</p>\n' +
  '</body></topic>\n';

const FILE = 1;
const DIRECTORY = 2;

let directoryEntries: [string, number][] = [];
let readDirectoryCalls: unknown[] = [];
let quickPickCalls: { items: Array<{ label: string; description?: string; href: string }>; options: unknown }[] = [];
let quickPickChoice:
  | undefined
  | null
  | ((items: Array<{ label: string; description?: string; href: string }>) => { label: string; href: string } | undefined);
let inputBoxChoice: string | undefined;
let inputBoxCalls: unknown[] = [];
let infoMessages: string[] = [];
let throwReadDirectory = false;

mock.module('vscode', () => ({
  FileType: {
    File: FILE,
    Directory: DIRECTORY,
  },
  Uri: {
    joinPath(base: { fsPath?: string }, ...parts: string[]) {
      return {
        base,
        parts,
        fsPath: [base.fsPath ?? '', ...parts].filter(Boolean).join('/'),
      };
    },
  },
  workspace: {
    fs: {
      async readDirectory(uri: unknown) {
        readDirectoryCalls.push(uri);
        if (throwReadDirectory) throw new Error('missing image folder');
        return directoryEntries;
      },
    },
  },
  window: {
    async showQuickPick(
      items: Array<{ label: string; description?: string; href: string }>,
      options: unknown,
    ) {
      quickPickCalls.push({ items, options });
      if (typeof quickPickChoice === 'function') return quickPickChoice(items);
      return quickPickChoice === null ? undefined : quickPickChoice;
    },
    async showInputBox(options: unknown) {
      inputBoxCalls.push(options);
      return inputBoxChoice;
    },
    async showInformationMessage(message: string) {
      infoMessages.push(message);
      return undefined;
    },
  },
}));

const { pickAndApplyImageHref, pickImageHrefForInsert, promptAndApplyImageAlt } = await import('../src/host/image-actions');

function imageId(source = SRC): string {
  const doc = parse(source);
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name === 'image') return id;
  }
  throw new Error('no image element in fixture');
}

function makeCtx(initialSource = SRC) {
  let source = initialSource;
  const applied: string[] = [];
  const pushed: Array<[string | null, number | null]> = [];
  const announced: string[] = [];
  let cleared = 0;
  const ctx: ImageActionContext = {
    document: {
      getText: () => source,
      uri: { fsPath: '/workspace/topics/current.dita' },
    } as ImageActionContext['document'],
    folder: { uri: { fsPath: '/workspace' } } as ImageActionContext['folder'],
    async applyMinimal(newSource: string) {
      applied.push(newSource);
      source = newSource;
      return true;
    },
    pushBody(focusId, caretOffset) {
      pushed.push([focusId, caretOffset]);
    },
    announce(message) {
      announced.push(message);
    },
    clearDiagnostics() {
      cleared += 1;
    },
  };

  return {
    ctx,
    applied,
    pushed,
    announced,
    get cleared() {
      return cleared;
    },
    get source() {
      return source;
    },
  };
}

beforeEach(() => {
  directoryEntries = [
    ['img_005.jpeg', FILE],
    ['img_006.jpeg', FILE],
    ['notes.txt', FILE],
    ['subfolder', DIRECTORY],
  ];
  readDirectoryCalls = [];
  quickPickCalls = [];
  quickPickChoice = (items) => items.find((item) => item.href === 'images/img_006.jpeg');
  inputBoxChoice = undefined;
  inputBoxCalls = [];
  infoMessages = [];
  throwReadDirectory = false;
});

describe('image host actions', () => {
  test('picks a real image href for insertion before mutating the document', async () => {
    const fixture = makeCtx();

    const href = await pickImageHrefForInsert(fixture.ctx);

    expect(href).toBe('images/img_006.jpeg');
    expect(readDirectoryCalls).toHaveLength(1);
    expect(quickPickCalls).toHaveLength(1);
    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([]);
    expect(fixture.source).toBe(SRC);
  });

  test('image insertion falls back to the shared sibling images folder for documents with no images', async () => {
    quickPickChoice = (items) => items.find((item) => item.href === '../images/img_006.jpeg');
    const source = '<topic id="t"><body><p>Text only</p></body></topic>\n';
    const fixture = makeCtx(source);

    const href = await pickImageHrefForInsert(fixture.ctx);

    expect(href).toBe('../images/img_006.jpeg');
    expect(readDirectoryCalls).toHaveLength(1);
    expect(quickPickCalls[0].items.map((item) => item.href)).toEqual([
      '../images/img_005.jpeg',
      '../images/img_006.jpeg',
    ]);
    expect(fixture.source).toBe(source);
  });

  test('cancelling insert image selection leaves bytes untouched', async () => {
    quickPickChoice = null;
    const fixture = makeCtx();

    const href = await pickImageHrefForInsert(fixture.ctx);

    expect(href).toBeNull();
    expect(quickPickCalls).toHaveLength(1);
    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([]);
    expect(fixture.source).toBe(SRC);
  });

  test('applies the selected real image asset and re-renders the preview', async () => {
    const fixture = makeCtx();

    await pickAndApplyImageHref(fixture.ctx, imageId());

    expect(readDirectoryCalls).toHaveLength(1);
    expect(quickPickCalls).toHaveLength(1);
    expect(quickPickCalls[0].items.map((item) => item.href)).toEqual([
      'images/img_005.jpeg',
      'images/img_006.jpeg',
    ]);
    expect(fixture.applied).toEqual([
      SRC.replace('images/img_005.jpeg', 'images/img_006.jpeg'),
    ]);
    expect(fixture.cleared).toBe(1);
    expect(fixture.pushed).toEqual([[null, null]]);
    expect(fixture.announced).toEqual(['Image source changed to img_006.jpeg.']);
    expect(infoMessages).toEqual([]);
  });

  test('cancelling the image QuickPick leaves bytes untouched', async () => {
    quickPickChoice = null;
    const fixture = makeCtx();

    await pickAndApplyImageHref(fixture.ctx, imageId());

    expect(quickPickCalls).toHaveLength(1);
    expect(fixture.applied).toEqual([]);
    expect(fixture.cleared).toBe(0);
    expect(fixture.pushed).toEqual([]);
    expect(fixture.announced).toEqual([]);
    expect(fixture.source).toBe(SRC);
  });

  test('choosing the current image announces unchanged without writing', async () => {
    quickPickChoice = (items) => items.find((item) => item.href === 'images/img_005.jpeg');
    const fixture = makeCtx();

    await pickAndApplyImageHref(fixture.ctx, imageId());

    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([]);
    expect(fixture.announced).toEqual(['Image source unchanged.']);
  });

  test('unreadable image directories report the issue without writing', async () => {
    throwReadDirectory = true;
    const fixture = makeCtx();

    await pickAndApplyImageHref(fixture.ctx, imageId());

    expect(quickPickCalls).toEqual([]);
    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([]);
    expect(infoMessages).toEqual(['DITA Editor: no image folder found at "images".']);
    expect(fixture.announced).toEqual(['No image folder found at images.']);
  });

  test('stale image ids resync the webview without mutating the document', async () => {
    const fixture = makeCtx();

    await pickAndApplyImageHref(fixture.ctx, 'e999');

    expect(readDirectoryCalls).toEqual([]);
    expect(quickPickCalls).toEqual([]);
    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([[null, null]]);
    expect(fixture.source).toBe(SRC);
  });

  test('updates image alt text through the host prompt path', async () => {
    inputBoxChoice = 'Cabin & seat photo';
    const fixture = makeCtx();

    await promptAndApplyImageAlt(fixture.ctx, imageId());

    expect(inputBoxCalls).toHaveLength(1);
    expect(fixture.applied).toEqual([
      SRC.replace(
        '<image href="images/img_005.jpeg" placement="break"/>',
        '<image href="images/img_005.jpeg" placement="break"><alt>Cabin &amp; seat photo</alt></image>',
      ),
    ]);
    expect(fixture.cleared).toBe(1);
    expect(fixture.pushed).toEqual([[null, null]]);
    expect(fixture.announced).toEqual(['Image alt text updated.']);
  });

  test('cancelling image alt text editing leaves bytes untouched', async () => {
    inputBoxChoice = undefined;
    const fixture = makeCtx();

    await promptAndApplyImageAlt(fixture.ctx, imageId());

    expect(inputBoxCalls).toHaveLength(1);
    expect(fixture.applied).toEqual([]);
    expect(fixture.pushed).toEqual([]);
    expect(fixture.announced).toEqual([]);
    expect(fixture.source).toBe(SRC);
  });
});
