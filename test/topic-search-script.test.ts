import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TestDocument, keyEvent } from './canvas-test-dom';

const source = readFileSync(new URL('../media/topic-search.js', import.meta.url), 'utf8');

interface Harness {
  doc: TestDocument;
  posted: Array<Record<string, unknown>>;
  savedState: Array<Record<string, unknown>>;
  windowListeners: Map<string, Array<(event: { data?: unknown }) => void>>;
  timers: Array<() => void>;
  flushTimers(): void;
  deliver(message: Record<string, unknown>): void;
  input: ReturnType<TestDocument['createElement']>;
  caseBtn: ReturnType<TestDocument['createElement']>;
  status: ReturnType<TestDocument['createElement']>;
  results: ReturnType<TestDocument['createElement']>;
  toggleBtn: ReturnType<TestDocument['createElement']>;
  replaceRow: ReturnType<TestDocument['createElement']>;
  replaceInput: ReturnType<TestDocument['createElement']>;
  replaceAllBtn: ReturnType<TestDocument['createElement']>;
}

function boot(initialState: Record<string, unknown> | null = null): Harness {
  const doc = new TestDocument();
  const input = doc.createElement('input');
  input.setAttribute('id', 'topic-search-input');
  (input as unknown as { value: string }).value = '';
  const caseBtn = doc.createElement('button');
  caseBtn.setAttribute('id', 'topic-search-case');
  caseBtn.setAttribute('aria-pressed', 'false');
  const status = doc.createElement('div');
  status.setAttribute('id', 'topic-search-status');
  const results = doc.createElement('div');
  results.setAttribute('id', 'topic-search-results');
  const toggleBtn = doc.createElement('button');
  toggleBtn.setAttribute('id', 'topic-search-toggle-replace');
  toggleBtn.setAttribute('aria-expanded', 'false');
  const replaceRow = doc.createElement('div');
  replaceRow.setAttribute('id', 'topic-search-replace-row');
  replaceRow.setAttribute('hidden', '');
  const replaceInput = doc.createElement('input');
  replaceInput.setAttribute('id', 'topic-search-replace-input');
  (replaceInput as unknown as { value: string }).value = '';
  const replaceAllBtn = doc.createElement('button');
  replaceAllBtn.setAttribute('id', 'topic-search-replace-all');
  replaceRow.append(replaceInput, replaceAllBtn);
  doc.body.append(input, caseBtn, status, results, toggleBtn, replaceRow);

  const posted: Array<Record<string, unknown>> = [];
  const savedState: Array<Record<string, unknown>> = [];
  const windowListeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const timers: Array<() => void> = [];
  const windowObj = {
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
  };
  const vscode = {
    getState: () => initialState,
    setState(value: Record<string, unknown>) {
      savedState.push(value);
    },
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
    },
  };
  new Function('window', 'document', 'acquireVsCodeApi', 'setTimeout', 'clearTimeout', source)(
    windowObj,
    doc,
    () => vscode,
    (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    () => {
      timers.length = 0;
    },
  );
  return {
    doc,
    posted,
    savedState,
    windowListeners,
    timers,
    flushTimers() {
      const pending = [...timers];
      timers.length = 0;
      for (const timer of pending) timer();
    },
    deliver(message: Record<string, unknown>) {
      for (const listener of windowListeners.get('message') ?? []) listener({ data: message });
    },
    input,
    caseBtn,
    status,
    results,
    toggleBtn,
    replaceRow,
    replaceInput,
    replaceAllBtn,
  };
}

function sampleResults(generation: number): Record<string, unknown> {
  return {
    type: 'searchResults',
    generation,
    groups: [
      {
        uri: 'file:///ws/a.dita',
        label: 'a.dita',
        title: 'Topic A',
        matches: [
          {
            sourceStart: 40,
            sourceEnd: 46,
            snippetBefore: 'before ',
            matchText: 'needle',
            snippetAfter: ' after',
          },
        ],
        moreCount: 0,
      },
    ],
    totalShown: 1,
    truncated: false,
    parseFailures: 0,
    skippedLarge: 0,
    fileCount: 3,
    tooShort: false,
  };
}

describe('topic-search view script', () => {
  test('posts a single searchReady ping on load', () => {
    const h = boot();
    expect(h.posted.filter((m) => m.type === 'searchReady').length).toBe(1);
    expect(h.posted.filter((m) => m.type === 'search').length).toBe(0);
  });

  test('restores persisted query and immediately re-searches', () => {
    const h = boot({ query: 'fox', matchCase: true });
    expect((h.input as unknown as { value: string }).value).toBe('fox');
    expect(h.caseBtn.getAttribute('aria-pressed')).toBe('true');
    const searches = h.posted.filter((m) => m.type === 'search');
    expect(searches.length).toBe(1);
    expect(searches[0].query).toBe('fox');
    expect(searches[0].matchCase).toBe(true);
  });

  test('debounces typing into one search with a fresh generation', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'ne';
    h.input.dispatch('input', {});
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    expect(h.posted.filter((m) => m.type === 'search').length).toBe(0);
    h.flushTimers();
    const searches = h.posted.filter((m) => m.type === 'search');
    expect(searches.length).toBe(1);
    expect(searches[0].query).toBe('needle');
    expect(typeof searches[0].generation).toBe('number');
  });

  test('renders result groups as inert text and drops stale generations', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    h.deliver(sampleResults(generation - 1));
    expect(h.results.children.length).toBe(0);
    const hostile = sampleResults(generation);
    (hostile.groups as Array<{ matches: Array<{ matchText: string }> }>)[0].matches[0].matchText =
      '<img onerror=alert(1)>';
    h.deliver(hostile);
    expect(h.results.children.length).toBeGreaterThan(0);
    expect(h.results.textContent).toContain('<img onerror=alert(1)>');
    expect(h.status.textContent).toContain('1 result');
  });

  test('clicking a match posts openMatch with source offsets and rendered text', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    h.deliver(sampleResults(generation));
    const row = h.results.querySelector('[data-match-row]');
    expect(row).not.toBeNull();
    row!.click();
    const opens = h.posted.filter((m) => m.type === 'openMatch');
    expect(opens.length).toBe(1);
    expect(opens[0].uri).toBe('file:///ws/a.dita');
    expect(opens[0].sourceStart).toBe(40);
    expect(opens[0].sourceEnd).toBe(46);
    expect(opens[0].renderedText).toBe('needle');
  });

  test('Enter on a match row opens it too', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    h.deliver(sampleResults(generation));
    h.results.querySelector('[data-match-row]')!.dispatch('keydown', keyEvent('Enter'));
    expect(h.posted.filter((m) => m.type === 'openMatch').length).toBe(1);
  });

  test('case toggle flips aria-pressed, persists, and re-searches', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.caseBtn.click();
    expect(h.caseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(h.savedState[h.savedState.length - 1].matchCase).toBe(true);
    expect(h.posted.filter((m) => m.type === 'search').length).toBe(1);
  });

  test('searchUnavailable clears results and shows the reason', () => {
    const h = boot();
    h.deliver({ type: 'searchUnavailable', reason: 'Topic search requires a local workspace.' });
    expect(h.results.children.length).toBe(0);
    expect(h.status.textContent).toBe('Topic search requires a local workspace.');
  });

  test('never assigns innerHTML (host strings stay inert)', () => {
    expect(source).not.toContain('innerHTML');
  });

  test('group headers show the file name with its directory dimmed, native-search style', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    const results = sampleResults(generation);
    (results.groups as Array<{ label: string }>)[0].label = 'src/dita/guide/a.dita';
    h.deliver(results);
    const name = h.results.querySelector('.group-label');
    const path = h.results.querySelector('.group-path');
    expect(name?.textContent).toBe('a.dita');
    expect(path?.textContent).toBe('src/dita/guide');
    const icon = h.results.querySelector('.file-icon');
    expect(icon).not.toBeNull();
  });

  test('the replace row stays hidden until toggled, then persists its state', () => {
    const h = boot();
    expect(h.replaceRow.hasAttribute('hidden')).toBe(true);
    h.toggleBtn.click();
    expect(h.replaceRow.hasAttribute('hidden')).toBe(false);
    expect(h.toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(h.doc.body.classList.contains('replace-open')).toBe(true);
    expect(h.savedState[h.savedState.length - 1].replaceOpen).toBe(true);
    h.toggleBtn.click();
    expect(h.replaceRow.hasAttribute('hidden')).toBe(true);
    expect(h.toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(h.doc.body.classList.contains('replace-open')).toBe(false);
  });

  test('restores a persisted open replace row and replacement text', () => {
    const h = boot({ query: 'needle', matchCase: false, replaceOpen: true, replaceText: 'cod' });
    expect(h.replaceRow.hasAttribute('hidden')).toBe(false);
    expect(h.toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect((h.replaceInput as unknown as { value: string }).value).toBe('cod');
  });

  test('the per-row replace action posts replaceMatch, not openMatch', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    h.deliver(sampleResults(generation));
    (h.replaceInput as unknown as { value: string }).value = 'cod';
    const action = h.results.querySelector('.replace-action');
    expect(action).not.toBeNull();
    action!.click();
    const replaces = h.posted.filter((m) => m.type === 'replaceMatch');
    expect(replaces.length).toBe(1);
    expect(replaces[0].uri).toBe('file:///ws/a.dita');
    expect(replaces[0].sourceStart).toBe(40);
    expect(replaces[0].sourceEnd).toBe(46);
    expect(replaces[0].renderedText).toBe('needle');
    expect(replaces[0].replacement).toBe('cod');
    expect(h.posted.filter((m) => m.type === 'openMatch').length).toBe(0);
  });

  test('the replace action handler stops propagation so the row never opens', () => {
    // The fake DOM does not bubble events; the real one does, so the handler
    // must stop propagation before the row click fires openMatch.
    expect(source).toContain('stopPropagation');
  });

  test('Replace All posts replaceAll with query, case, and replacement', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    (h.replaceInput as unknown as { value: string }).value = 'cod';
    h.replaceAllBtn.click();
    const alls = h.posted.filter((m) => m.type === 'replaceAll');
    expect(alls.length).toBe(1);
    expect(alls[0].query).toBe('needle');
    expect(alls[0].matchCase).toBe(false);
    expect(alls[0].replacement).toBe('cod');
  });

  test('Replace All with an empty query posts nothing', () => {
    const h = boot();
    h.replaceAllBtn.click();
    expect(h.posted.filter((m) => m.type === 'replaceAll').length).toBe(0);
  });

  test('replaceDone summarises the outcome in the status line', () => {
    const h = boot();
    h.deliver({ type: 'replaceDone', replaced: 3, fileCount: 2, skippedStyled: 1, stale: false });
    expect(h.status.textContent).toContain('Replaced 3 occurrences in 2 files');
    expect(h.status.textContent).toContain('1 styled match skipped');
    h.deliver({ type: 'replaceDone', replaced: 1, fileCount: 1, skippedStyled: 0, stale: false });
    expect(h.status.textContent).toContain('Replaced 1 occurrence in 1 file');
    h.deliver({ type: 'replaceDone', replaced: 0, fileCount: 0, skippedStyled: 0, stale: true });
    expect(h.status.textContent).toContain('changed since');
  });

  test('a group label without directories renders no path span', () => {
    const h = boot();
    (h.input as unknown as { value: string }).value = 'needle';
    h.input.dispatch('input', {});
    h.flushTimers();
    const generation = h.posted.filter((m) => m.type === 'search')[0].generation as number;
    h.deliver(sampleResults(generation));
    expect(h.results.querySelector('.group-label')?.textContent).toBe('a.dita');
    expect(h.results.querySelector('.group-path')).toBeNull();
  });
});
