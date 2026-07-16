import { describe, expect, test } from 'bun:test';
import {
  clearNextManualWorkingCopyDiff,
  isManualSourceDiff,
  markManualSourceDiff,
  markNextManualWorkingCopyDiff,
  renderReviewBeforeClosingNative,
  resolveReviewSelection,
  reviewComparisonIdentity,
  reviewComparisonFromDiffTab,
  reviewComparisonFromCustomEditorCandidates,
  reviewComparisonsFromMultiDiff,
  shouldInterceptScmDiff,
  sourceDiffIdentity,
  unmarkManualSourceDiff,
} from '../src/host/scm-intercept';

interface TestUri {
  scheme: string;
  fsPath: string;
  query: string;
  toString(skipEncoding?: boolean): string;
}

function uri(scheme: string, fsPath: string, query = ''): TestUri {
  return {
    scheme,
    fsPath,
    query,
    toString: () => `${scheme}:${fsPath}${query ? `?${query}` : ''}`,
  };
}

function diffTab(originalScheme: string, modifiedScheme: string, fsPath: string) {
  return {
    original: uri(originalScheme, fsPath, 'ref=original'),
    modified: uri(modifiedScheme, fsPath, 'ref=modified'),
  };
}

describe('shouldInterceptScmDiff', () => {
  test('git original vs file .dita intercepts', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'file', '/ws/topics/01-intro.dita'))).toBe(true);
  });

  test('git original vs git .dita intercepts for committed history', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'git', '/ws/topics/01-intro.dita'))).toBe(true);
  });

  test('GitHub checked-out PR review original vs file .dita intercepts', () => {
    expect(shouldInterceptScmDiff(diffTab('review', 'file', '/ws/topics/01-intro.dita'))).toBe(true);
  });

  test('GitHub remote PR virtual pair intercepts', () => {
    expect(shouldInterceptScmDiff(diffTab('pr', 'pr', '/ws/topics/01-intro.dita'))).toBe(true);
  });

  test('.DITA matches case-insensitively', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'git', '/ws/topics/01-INTRO.DITA'))).toBe(true);
  });

  test('file vs file .dita does not intercept', () => {
    expect(shouldInterceptScmDiff(diffTab('file', 'file', '/ws/topics/01-intro.dita'))).toBe(false);
  });

  test('git vs file and git vs git non-DITA diffs do not intercept', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'file', '/ws/README.md'))).toBe(false);
    expect(shouldInterceptScmDiff(diffTab('git', 'git', '/ws/README.md'))).toBe(false);
  });

  test('gitlens-scheme original does not intercept (only built-in git does)', () => {
    expect(shouldInterceptScmDiff(diffTab('gitlens', 'file', '/ws/topics/01-intro.dita'))).toBe(false);
  });
});

describe('reviewComparisonsFromMultiDiff', () => {
  test('extracts every exact DITA revision pair from a Graph commit tab', () => {
    const first = diffTab('git', 'git', '/ws/topics/01-intro.dita');
    const second = diffTab('git', 'git', '/ws/topics/02-service.dita');
    const readme = diffTab('git', 'git', '/ws/README.md');

    const result = reviewComparisonsFromMultiDiff<TestUri>({
      textDiffs: [first, readme, second],
    });

    expect(result?.totalTextDiffs).toBe(3);
    expect(result?.comparisons).toEqual([
      { kind: 'historical', original: first.original, modified: first.modified },
      { kind: 'historical', original: second.original, modified: second.modified },
    ]);
  });

  test('recognizes only the structural proposed-API shape and ignores malformed entries', () => {
    expect(reviewComparisonsFromMultiDiff({})).toBeUndefined();
    expect(reviewComparisonsFromMultiDiff({ textDiffs: 'not-an-array' })).toBeUndefined();
    expect(reviewComparisonsFromMultiDiff({ textDiffs: [null, { original: {}, modified: {} }] })).toEqual({
      comparisons: [],
      totalTextDiffs: 2,
    });
  });
});

describe('reviewComparisonFromDiffTab', () => {
  test('keeps the exact Graph left/right URIs in a historical descriptor', () => {
    const older = uri('git', '/ws/topics/01-intro.dita', 'ref=older');
    const newer = uri('git', '/ws/topics/01-intro.dita', 'ref=newer');

    expect(reviewComparisonFromDiffTab({ original: older, modified: newer })).toEqual({
      kind: 'historical',
      original: older,
      modified: newer,
    });
  });

  test('retains exact source pairs for supported revision providers when Review is invoked manually', () => {
    for (const scheme of ['gitlens', 'vscode-local-history']) {
      const older = uri(scheme, '/ws/topics/01-intro.dita', 'ref=older');
      const newer = uri(scheme, '/ws/topics/01-intro.dita', 'ref=newer');
      expect(reviewComparisonFromDiffTab({ original: older, modified: newer })).toEqual({
        kind: 'historical',
        original: older,
        modified: newer,
      });
    }
  });

  test('preserves working-copy Review behavior for git to file', () => {
    const original = uri('git', '/ws/topics/01-intro.dita', 'ref=HEAD');
    const modified = uri('file', '/ws/topics/01-intro.dita');

    expect(reviewComparisonFromDiffTab({ original, modified })).toEqual({
      kind: 'working-copy',
      modified,
    });
  });

  test('preserves checked-out GitHub PR content as a working-copy review', () => {
    const original = uri('review', '/ws/topics/01-intro.dita', 'base=true');
    const modified = uri('file', '/ws/topics/01-intro.dita');

    expect(reviewComparisonFromDiffTab({ original, modified })).toEqual({
      kind: 'working-copy',
      modified,
    });
  });

  test('preserves both virtual GitHub PR documents for a remote PR', () => {
    const original = uri('pr', '/ws/topics/01-intro.dita', 'isBase=true');
    const modified = uri('pr', '/ws/topics/01-intro.dita', 'isBase=false');

    expect(reviewComparisonFromDiffTab({ original, modified })).toEqual({
      kind: 'historical',
      original,
      modified,
    });
  });

  test('ignores a native diff that is not a DITA topic', () => {
    const older = uri('git', '/ws/README.md', 'ref=older');
    const newer = uri('git', '/ws/README.md', 'ref=newer');
    expect(reviewComparisonFromDiffTab({ original: older, modified: newer })).toBeUndefined();
  });

  test('different revision pairs for the same path have different panel identities', () => {
    const first = {
      kind: 'historical' as const,
      original: uri('git', '/ws/topics/01-intro.dita', 'ref=a'),
      modified: uri('git', '/ws/topics/01-intro.dita', 'ref=b'),
    };
    const second = {
      kind: 'historical' as const,
      original: uri('git', '/ws/topics/01-intro.dita', 'ref=b'),
      modified: uri('git', '/ws/topics/01-intro.dita', 'ref=c'),
    };
    expect(reviewComparisonIdentity(first)).not.toBe(reviewComparisonIdentity(second));
  });
});

describe('reviewComparisonFromCustomEditorCandidates', () => {
  test('pairs a virtual Git pane with its local working-copy pane regardless of event order', () => {
    const original = uri('git', '/ws/topics/01-intro.dita', 'ref=base');
    const modified = uri('file', '/ws/topics/01-intro.dita');
    const pair = reviewComparisonFromCustomEditorCandidates([
      { target: modified, order: 2, triggered: true },
      { target: original, order: 1, triggered: false },
    ]);
    expect(pair?.original.target).toBe(original);
    expect(pair?.modified.target).toBe(modified);
    expect(pair?.comparison).toEqual({ kind: 'working-copy', modified });
  });

  test('orders two remote PR panes left-to-right and preserves both virtual sources', () => {
    const original = uri('pr', '/ws/topics/01-intro.dita', 'isBase=true');
    const modified = uri('pr', '/ws/topics/01-intro.dita', 'isBase=false');
    expect(reviewComparisonFromCustomEditorCandidates([
      { target: modified, order: 2, triggered: false },
      { target: original, order: 1, triggered: true },
    ])?.comparison).toEqual({ kind: 'historical', original, modified });
  });

  test('does not pair unrelated topics or ordinary duplicate visual tabs', () => {
    expect(reviewComparisonFromCustomEditorCandidates([
      { target: uri('file', '/ws/topics/a.dita'), order: 1, triggered: true },
      { target: uri('file', '/ws/topics/b.dita'), order: 2, triggered: false },
    ])).toBeUndefined();
  });
});

describe('resolveReviewSelection', () => {
  const fileUri = (fsPath: string) => uri('file', fsPath);
  const isInWorkspace = (target: { fsPath: string }) => target.fsPath.startsWith('/ws/');

  test('preserves both Graph revisions and uses the working copy only for workspace resources', () => {
    const older = uri('git', '/ws/topics/01-intro.dita', 'ref=older');
    const newer = uri('git', '/ws/topics/01-intro.dita', 'ref=newer');

    const selection = resolveReviewSelection(
      { kind: 'historical', original: older, modified: newer },
      { fileUri, isInWorkspace },
    );
    expect(selection.document).toBe(newer);
    expect(selection.base).toBe(older);
    expect(selection.resource.scheme).toBe('file');
    expect(selection.resource.fsPath).toBe('/ws/topics/01-intro.dita');
    expect(selection.historical).toBe(true);
  });

  test('uses an existing working-copy file as the document and resource target', () => {
    const workingCopy = uri('file', '/ws/topics/01-intro.dita');

    expect(resolveReviewSelection(
      { kind: 'working-copy', modified: workingCopy },
      { fileUri, isInWorkspace },
    )).toEqual({
      document: workingCopy,
      base: undefined,
      resource: workingCopy,
      historical: false,
    });
  });

  test('uses a local workspace file only for resources when working-copy content is virtual', () => {
    const virtualDocument = uri('review', '/ws/topics/01-intro.dita', 'base=false');

    const selection = resolveReviewSelection(
      { kind: 'working-copy', modified: virtualDocument },
      { fileUri, isInWorkspace },
    );
    expect(selection.document).toBe(virtualDocument);
    expect(selection.resource.scheme).toBe('file');
    expect(selection.resource.fsPath).toBe('/ws/topics/01-intro.dita');
    expect(selection.historical).toBe(false);
  });

  test('keeps an unmappable virtual working-copy resource virtual', () => {
    const virtualDocument = uri('review', '/other/topics/01-intro.dita', 'base=false');

    expect(resolveReviewSelection(
      { kind: 'working-copy', modified: virtualDocument },
      { fileUri, isInWorkspace },
    )).toEqual({
      document: virtualDocument,
      base: undefined,
      resource: virtualDocument,
      historical: false,
    });
  });

  test('does not invent a workspace target for a historical resource outside the workspace', () => {
    const older = uri('git', '/other/topics/01-intro.dita', 'ref=older');
    const newer = uri('git', '/other/topics/01-intro.dita', 'ref=newer');

    expect(resolveReviewSelection(
      { kind: 'historical', original: older, modified: newer },
      { fileUri, isInWorkspace },
    )).toEqual({
      document: newer,
      base: older,
      resource: newer,
      historical: true,
    });
  });
});

describe('manual source-diff suppression', () => {
  test('historical suppression is scoped to the exact URI pair, not merely the path', () => {
    const first = {
      original: uri('git', '/ws/topics/01-intro.dita', 'ref=a'),
      modified: uri('git', '/ws/topics/01-intro.dita', 'ref=b'),
    };
    const second = {
      original: uri('git', '/ws/topics/01-intro.dita', 'ref=b'),
      modified: uri('git', '/ws/topics/01-intro.dita', 'ref=c'),
    };

    expect(sourceDiffIdentity(first)).not.toBe(sourceDiffIdentity(second));
    markManualSourceDiff(first);
    expect(isManualSourceDiff(first)).toBe(true);
    expect(isManualSourceDiff(second)).toBe(false);
    unmarkManualSourceDiff(first);
    expect(isManualSourceDiff(first)).toBe(false);
  });

  test('working-copy request promotes only the next matching git-to-file diff to an exact pair', () => {
    const modified = uri('file', '/ws/topics/01-intro.dita');
    const opened = { original: uri('git', modified.fsPath, 'ref=HEAD'), modified };
    const unrelated = {
      original: uri('git', '/ws/topics/02-other.dita', 'ref=HEAD'),
      modified: uri('file', '/ws/topics/02-other.dita'),
    };

    markNextManualWorkingCopyDiff(modified);
    expect(isManualSourceDiff(unrelated)).toBe(false);
    expect(isManualSourceDiff(opened)).toBe(true);
    expect(isManualSourceDiff(opened)).toBe(true);
    unmarkManualSourceDiff(opened);
    expect(isManualSourceDiff(opened)).toBe(false);
  });

  test('failed working-copy open can clear its pending suppression', () => {
    const modified = uri('file', '/ws/topics/01-intro.dita');
    const opened = { original: uri('git', modified.fsPath, 'ref=HEAD'), modified };
    markNextManualWorkingCopyDiff(modified);
    clearNextManualWorkingCopyDiff(modified);
    expect(isManualSourceDiff(opened)).toBe(false);
  });

  test('unmark of an unmarked exact pair is a no-op', () => {
    const diff = diffTab('git', 'git', '/ws/topics/never-marked.dita');
    expect(() => unmarkManualSourceDiff(diff)).not.toThrow();
    expect(isManualSourceDiff(diff)).toBe(false);
  });
});

describe('native diff fallback ordering', () => {
  test('closes the native diff only after the rendered Review is ready', async () => {
    const events: string[] = [];
    const closed = await renderReviewBeforeClosingNative(
      async () => { events.push('review-rendered'); },
      async () => { events.push('native-closed'); return true; },
    );
    expect(closed).toBe(true);
    expect(events).toEqual(['review-rendered', 'native-closed']);
  });

  test('keeps the native diff open when Review loading or rendering fails', async () => {
    let closeCalled = false;
    await expect(renderReviewBeforeClosingNative(
      async () => { throw new Error('historical document unavailable'); },
      async () => { closeCalled = true; return true; },
    )).rejects.toThrow('historical document unavailable');
    expect(closeCalled).toBe(false);
  });

  test('returns VS Code close refusal instead of treating it as success', async () => {
    expect(await renderReviewBeforeClosingNative(async () => {}, async () => false)).toBe(false);
  });
});
