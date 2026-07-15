import { describe, expect, test } from 'bun:test';
import {
  isManualSourceDiff,
  markManualSourceDiff,
  resolveReviewSelection,
  reviewPairFromDiffTab,
  shouldInterceptScmDiff,
  unmarkManualSourceDiff,
} from '../src/host/scm-intercept';

function diffTab(originalScheme: string, modifiedScheme: string, fsPath: string) {
  return {
    original: { scheme: originalScheme },
    modified: { scheme: modifiedScheme, fsPath },
  };
}

describe('shouldInterceptScmDiff', () => {
  test('git original vs file .dita intercepts', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'file', '/ws/topics/01-intro.dita'))).toBe(true);
  });

  test('.DITA matches case-insensitively', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'file', '/ws/topics/01-INTRO.DITA'))).toBe(true);
  });

  test('file vs file .dita does not intercept', () => {
    expect(shouldInterceptScmDiff(diffTab('file', 'file', '/ws/topics/01-intro.dita'))).toBe(false);
  });

  test('git vs file .md does not intercept', () => {
    expect(shouldInterceptScmDiff(diffTab('git', 'file', '/ws/README.md'))).toBe(false);
  });

  test('gitlens-scheme original does not intercept (only git does)', () => {
    expect(shouldInterceptScmDiff(diffTab('gitlens', 'file', '/ws/topics/01-intro.dita'))).toBe(false);
  });
});

describe('resolveReviewSelection', () => {
  const fileUri = (fsPath: string) => ({ scheme: 'file', fsPath });
  const isInWorkspace = (uri: { fsPath: string }) => uri.fsPath.startsWith('/ws/');

  test('preserves both Graph revisions and uses the working copy only for workspace resources', () => {
    for (const scheme of ['git', 'gitlens', 'vscode-local-history']) {
      const older = { scheme, fsPath: '/ws/topics/01-intro.dita', query: 'ref=older' };
      const newer = { scheme, fsPath: '/ws/topics/01-intro.dita', query: 'ref=newer' };

      expect(resolveReviewSelection(newer, { fileUri, isInWorkspace }, older)).toEqual({
        document: newer,
        base: older,
        workspace: { scheme: 'file', fsPath: '/ws/topics/01-intro.dita' },
      });
    }
  });

  test('uses an existing working-copy file as both document and workspace target', () => {
    const workingCopy = { scheme: 'file', fsPath: '/ws/topics/01-intro.dita' };

    expect(resolveReviewSelection(workingCopy, { fileUri, isInWorkspace })).toEqual({
      document: workingCopy,
      base: undefined,
      workspace: workingCopy,
    });
  });

  test('does not invent a workspace target for a historical resource outside the workspace', () => {
    const historical = { scheme: 'git', fsPath: '/other/topics/01-intro.dita' };

    expect(resolveReviewSelection(historical, { fileUri, isInWorkspace })).toEqual({
      document: historical,
      base: undefined,
      workspace: historical,
    });
  });
});

describe('reviewPairFromDiffTab', () => {
  test('keeps the native diff left/right documents as base/newer review content', () => {
    const older = { scheme: 'git', fsPath: '/ws/topics/01-intro.dita', query: 'ref=older' };
    const newer = { scheme: 'git', fsPath: '/ws/topics/01-intro.dita', query: 'ref=newer' };

    expect(reviewPairFromDiffTab({ original: older, modified: newer })).toEqual({
      document: newer,
      base: older,
    });
  });

  test('ignores a native diff that is not a DITA topic', () => {
    const older = { scheme: 'git', fsPath: '/ws/README.md' };
    const newer = { scheme: 'git', fsPath: '/ws/README.md' };

    expect(reviewPairFromDiffTab({ original: older, modified: newer })).toBeUndefined();
  });
});

describe('manual source-diff suppression', () => {
  test('marked file is suppressed until unmarked; other files unaffected', () => {
    const marked = '/ws/topics/01-intro.dita';
    expect(isManualSourceDiff(marked)).toBe(false);
    markManualSourceDiff(marked);
    expect(isManualSourceDiff(marked)).toBe(true);
    expect(isManualSourceDiff('/ws/topics/02-other.dita')).toBe(false);
    unmarkManualSourceDiff(marked);
    expect(isManualSourceDiff(marked)).toBe(false);
  });

  test('mark/lookup are case-insensitive (mirrors the .dita predicate)', () => {
    markManualSourceDiff('/ws/Topics/01-INTRO.DITA');
    expect(isManualSourceDiff('/ws/topics/01-intro.dita')).toBe(true);
    unmarkManualSourceDiff('/WS/TOPICS/01-intro.DITA');
    expect(isManualSourceDiff('/ws/topics/01-intro.dita')).toBe(false);
  });

  test('unmark of an unmarked file is a no-op', () => {
    expect(() => unmarkManualSourceDiff('/ws/never-marked.dita')).not.toThrow();
    expect(isManualSourceDiff('/ws/never-marked.dita')).toBe(false);
  });
});
