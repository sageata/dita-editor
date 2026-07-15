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
    expect(selection.workspace.scheme).toBe('file');
    expect(selection.workspace.fsPath).toBe('/ws/topics/01-intro.dita');
    expect(selection.historical).toBe(true);
  });

  test('uses an existing working-copy file as the document and workspace target', () => {
    const workingCopy = uri('file', '/ws/topics/01-intro.dita');

    expect(resolveReviewSelection(
      { kind: 'working-copy', modified: workingCopy },
      { fileUri, isInWorkspace },
    )).toEqual({
      document: workingCopy,
      base: undefined,
      workspace: workingCopy,
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
      workspace: newer,
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
