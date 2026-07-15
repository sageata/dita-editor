import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { renderRedline } from '../src/compare/render-redline';
import { renderReviewSources, shouldRefreshReviewContent } from '../src/host/redline-sources';
import type { ReviewSelection } from '../src/host/scm-intercept';

interface TestUri {
  scheme: string;
  fsPath: string;
  id: string;
}

const oldCommittedSource = '<topic id="history"><title>Before</title><body><p>Old committed text.</p></body></topic>';
const newCommittedSource = '<topic id="history"><title>After</title><body><p>New committed text.</p></body></topic>';

function historicalSelection(): ReviewSelection<TestUri> {
  return {
    document: { scheme: 'git', fsPath: '/ws/topics/history.dita', id: 'commit-b' },
    base: { scheme: 'git', fsPath: '/ws/topics/history.dita', id: 'commit-a' },
    workspace: { scheme: 'file', fsPath: '/ws/topics/history.dita', id: 'working-tree' },
    historical: true,
  };
}

describe('renderReviewSources', () => {
  test('passes the exact two historical document sources to the Review renderer', async () => {
    const selection = historicalSelection();
    const opened: TestUri[] = [];
    let rendererInput: [string, string] | undefined;

    const result = await renderReviewSources(
      selection,
      {
        openTextDocument: async (target) => {
          opened.push(target);
          if (target === selection.base) return { getText: () => oldCommittedSource };
          if (target === selection.document) return { getText: () => newCommittedSource };
          throw new Error(`unexpected document ${target.id}`);
        },
        resolveBaseRevision: async () => { throw new Error('historical Review resolved a working-copy base'); },
        readFileAtRevision: async () => { throw new Error('historical Review read a working-copy revision'); },
      },
      (oldSource, newSource) => {
        rendererInput = [oldSource, newSource];
        return renderRedline(parse(oldSource), parse(newSource));
      },
    );

    expect(opened).toEqual([selection.document, selection.base!]);
    expect(rendererInput).toEqual([oldCommittedSource, newCommittedSource]);
    expect(result.label).toBe('the selected earlier revision');
    expect(result.rendered.changeCount).toBeGreaterThan(0);
  });

  test('committed changes remain visible when the working tree equals HEAD', async () => {
    const selection = historicalSelection();
    const workingTreeAtHead = newCommittedSource;
    let workingTreeWasOpened = false;

    const result = await renderReviewSources(
      selection,
      {
        openTextDocument: async (target) => {
          if (target === selection.workspace) {
            workingTreeWasOpened = true;
            return { getText: () => workingTreeAtHead };
          }
          return {
            getText: () => target === selection.base ? oldCommittedSource : newCommittedSource,
          };
        },
        resolveBaseRevision: async () => ({ label: 'HEAD' }),
        readFileAtRevision: async () => workingTreeAtHead,
      },
      (oldSource, newSource) => renderRedline(parse(oldSource), parse(newSource)),
    );

    expect(workingTreeWasOpened).toBe(false);
    expect(result.rendered.changeCount).toBeGreaterThan(0);
    expect(result.rendered.html).toContain('<del class="redline">Old</del>');
    expect(result.rendered.html).toContain('<ins class="redline">New</ins>');
  });

  test('retains working-copy base resolution when no historical original is supplied', async () => {
    const working = { scheme: 'file', fsPath: '/ws/topics/history.dita', id: 'working-tree' };
    const selection: ReviewSelection<TestUri> = {
      document: working,
      base: undefined,
      workspace: working,
      historical: false,
    };
    const resolvedPaths: string[] = [];

    const result = await renderReviewSources(
      selection,
      {
        openTextDocument: async () => ({ getText: () => newCommittedSource }),
        resolveBaseRevision: async (fsPath) => {
          resolvedPaths.push(fsPath);
          return { label: 'HEAD' };
        },
        readFileAtRevision: async () => oldCommittedSource,
      },
      (oldSource, newSource) => [oldSource, newSource] as const,
    );

    expect(resolvedPaths).toEqual([working.fsPath]);
    expect(result.label).toBe('HEAD');
    expect(result.rendered).toEqual([oldCommittedSource, newCommittedSource]);
  });
});

describe('historical snapshot refresh behavior', () => {
  const identity = (target: TestUri) => `${target.scheme}:${target.id}`;

  test('working-file edits do not refresh an immutable historical comparison', () => {
    const selection = historicalSelection();
    expect(shouldRefreshReviewContent(selection, selection.workspace, identity)).toBe(false);
  });

  test('working-copy reviews still refresh when their document changes', () => {
    const working = { scheme: 'file', fsPath: '/ws/topics/history.dita', id: 'working-tree' };
    const selection: ReviewSelection<TestUri> = {
      document: working,
      base: undefined,
      workspace: working,
      historical: false,
    };
    expect(shouldRefreshReviewContent(selection, working, identity)).toBe(true);
  });
});
