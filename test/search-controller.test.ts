import { describe, expect, test } from 'bun:test';
import type { FileRef, SearchIo } from '../src/search/search-controller';
import { createTopicSearchController } from '../src/search/search-controller';

function topic(id: string, body: string): string {
  return `<topic id="${id}"><title>Title ${id}</title><body>${body}</body></topic>`;
}

interface FakeFile {
  source: string;
  mtime: number;
  size?: number;
  open?: { text: string; version: number };
}

function fakeIo(files: Record<string, FakeFile>): SearchIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listFiles: async () => Object.keys(files).map((key) => ({ key, label: key })),
    stat: async (ref: FileRef) => {
      const file = files[ref.key];
      if (!file) return null;
      return { mtime: file.mtime, size: file.size ?? file.source.length };
    },
    read: async (ref: FileRef) => {
      reads.push(ref.key);
      return files[ref.key].source;
    },
    openDocumentText: (ref: FileRef) => files[ref.key]?.open ?? null,
  };
}

describe('createTopicSearchController', () => {
  test('groups matches per file, sorted by label, with titles', async () => {
    const io = fakeIo({
      'b.dita': { source: topic('b', '<p>needle here</p>'), mtime: 1 },
      'a.dita': { source: topic('a', '<p>a needle and another needle</p>'), mtime: 1 },
      'c.dita': { source: topic('c', '<p>nothing</p>'), mtime: 1 },
    });
    const controller = createTopicSearchController(io);
    const outcome = await controller.search('needle', false, 1);
    expect(outcome).not.toBeNull();
    expect(outcome!.groups.map((g) => g.label)).toEqual(['a.dita', 'b.dita']);
    expect(outcome!.groups[0].matches.length).toBe(2);
    expect(outcome!.groups[0].title).toBe('Title a');
    expect(outcome!.totalShown).toBe(3);
    expect(outcome!.fileCount).toBe(3);
    expect(outcome!.truncated).toBe(false);
  });

  test('caches extraction while mtime is unchanged and re-reads when it changes', async () => {
    const files: Record<string, FakeFile> = {
      'a.dita': { source: topic('a', '<p>needle</p>'), mtime: 1 },
    };
    const io = fakeIo(files);
    const controller = createTopicSearchController(io);
    await controller.search('needle', false, 1);
    await controller.search('needle', false, 2);
    expect(io.reads.length).toBe(1);
    files['a.dita'].mtime = 2;
    await controller.search('needle', false, 3);
    expect(io.reads.length).toBe(2);
  });

  test('prefers open-document text and re-extracts on version bump', async () => {
    const files: Record<string, FakeFile> = {
      'a.dita': {
        source: topic('a', '<p>disk text</p>'),
        mtime: 1,
        open: { text: topic('a', '<p>buffer text</p>'), version: 5 },
      },
    };
    const io = fakeIo(files);
    const controller = createTopicSearchController(io);
    const first = await controller.search('buffer', false, 1);
    expect(first!.totalShown).toBe(1);
    expect(io.reads.length).toBe(0);
    files['a.dita'].open = { text: topic('a', '<p>changed text</p>'), version: 6 };
    const second = await controller.search('changed', false, 2);
    expect(second!.totalShown).toBe(1);
  });

  test('abandons a superseded generation and returns null', async () => {
    const io = fakeIo({
      'a.dita': { source: topic('a', '<p>needle</p>'), mtime: 1 },
      'b.dita': { source: topic('b', '<p>needle</p>'), mtime: 1 },
    });
    const controller = createTopicSearchController(io);
    const stale = controller.search('needle', false, 1);
    const fresh = controller.search('needle', false, 2);
    expect(await stale).toBeNull();
    expect((await fresh)!.totalShown).toBe(2);
  });

  test('skips and counts unparseable files', async () => {
    const io = fakeIo({
      'bad.dita': { source: '<topic id="x"><title>Broken</unclosed', mtime: 1 },
      'good.dita': { source: topic('g', '<p>needle</p>'), mtime: 1 },
    });
    const controller = createTopicSearchController(io);
    const outcome = await controller.search('needle', false, 1);
    expect(outcome!.parseFailures).toBe(1);
    expect(outcome!.totalShown).toBe(1);
  });

  test('skips and counts oversized files', async () => {
    const io = fakeIo({
      'huge.dita': { source: topic('h', '<p>needle</p>'), mtime: 1, size: 11 * 1024 * 1024 },
      'ok.dita': { source: topic('o', '<p>needle</p>'), mtime: 1 },
    });
    const controller = createTopicSearchController(io);
    const outcome = await controller.search('needle', false, 1);
    expect(outcome!.skippedLarge).toBe(1);
    expect(outcome!.totalShown).toBe(1);
    expect(io.reads).toEqual(['ok.dita']);
  });

  test('reports a too-short query without scanning', async () => {
    const io = fakeIo({ 'a.dita': { source: topic('a', '<p>x</p>'), mtime: 1 } });
    const controller = createTopicSearchController(io);
    const outcome = await controller.search('x', false, 1);
    expect(outcome!.tooShort).toBe(true);
    expect(outcome!.groups.length).toBe(0);
    expect(io.reads.length).toBe(0);
  });

  test('caps per file at 50 with moreCount and total at 500 with truncated', async () => {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < 11; i += 1) {
      const label = `f${String(i).padStart(2, '0')}.dita`;
      files[label] = { source: topic(`t${i}`, `<p>${'zap '.repeat(60)}</p>`), mtime: 1 };
    }
    const io = fakeIo(files);
    const controller = createTopicSearchController(io);
    const outcome = await controller.search('zap', false, 1);
    expect(outcome!.groups[0].matches.length).toBe(50);
    expect(outcome!.groups[0].moreCount).toBe(10);
    expect(outcome!.totalShown).toBe(500);
    expect(outcome!.groups.length).toBe(10);
    expect(outcome!.truncated).toBe(true);
  });
});
