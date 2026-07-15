import { describe, expect, test } from 'bun:test';
import { gitRevisionLocation } from '../src/host/git-revision-uri';

describe('gitRevisionLocation', () => {
  test('extracts the exact ref and repository-relative path from built-in Git URIs', () => {
    expect(gitRevisionLocation({
      scheme: 'git',
      query: JSON.stringify({
        path: '/workspace/topics/one.dita',
        ref: '7e5fb4785b203a8058973a5d5784c80c0e1e9d59',
      }),
    }, '/workspace')).toEqual({
      ref: '7e5fb4785b203a8058973a5d5784c80c0e1e9d59',
      relPath: 'topics/one.dita',
    });
  });

  test('falls back for other providers, malformed queries, empty refs, and paths outside the repository', () => {
    expect(gitRevisionLocation({ scheme: 'gitlens', query: '{}' }, '/workspace')).toBeUndefined();
    expect(gitRevisionLocation({ scheme: 'git', query: '{' }, '/workspace')).toBeUndefined();
    expect(gitRevisionLocation({
      scheme: 'git',
      query: JSON.stringify({ path: '/workspace/topics/one.dita', ref: '' }),
    }, '/workspace')).toBeUndefined();
    expect(gitRevisionLocation({
      scheme: 'git',
      query: JSON.stringify({ path: '/other/one.dita', ref: 'abc' }),
    }, '/workspace')).toBeUndefined();
  });
});
