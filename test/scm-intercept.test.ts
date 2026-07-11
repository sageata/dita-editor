import { describe, expect, test } from 'bun:test';
import {
  isManualSourceDiff,
  markManualSourceDiff,
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
