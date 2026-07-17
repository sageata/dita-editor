import { describe, expect, test } from 'bun:test';
import {
  validateReviewRevert,
  type ReviewRevertAuthorization,
} from '../src/host/review-revert-authorization';

function authorization(
  overrides: Partial<ReviewRevertAuthorization> = {},
): ReviewRevertAuthorization {
  return {
    token: 'opaque-token',
    uri: 'file:///workspace/topic.dita',
    generation: 7,
    documentVersion: 12,
    source: '<p>Newer</p>',
    key: 'modified:0-14:0-12',
    label: 'Restore changed <p>',
    start: 3,
    end: 8,
    expected: 'Newer',
    replacement: 'Earlier',
    ...overrides,
  };
}

const current = {
  uri: 'file:///workspace/topic.dita',
  generation: 7,
  documentVersion: 12,
  source: '<p>Newer</p>',
};

describe('validateReviewRevert', () => {
  test('returns the authorized single edit when every guard still matches', () => {
    const result = validateReviewRevert(authorization(), current);

    expect(result).toEqual({
      ok: true,
      plan: {
        key: 'modified:0-14:0-12',
        label: 'Restore changed <p>',
        start: 3,
        end: 8,
        expected: 'Newer',
        replacement: 'Earlier',
      },
    });
  });

  test.each([
    ['URI', authorization({ uri: 'file:///workspace/other.dita' }), current],
    ['generation', authorization({ generation: 6 }), current],
    ['version', authorization({ documentVersion: 11 }), current],
    ['snapshot', authorization({ source: '<p>Stale</p>' }), current],
    ['range bytes', authorization({ expected: 'Older' }), current],
  ])('refuses a stale or mismatched %s guard', (_name, action, document) => {
    const result = validateReviewRevert(action, document);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test('refuses malformed offsets before slicing', () => {
    const result = validateReviewRevert(authorization({ start: -1 }), current);

    expect(result).toEqual({
      ok: false,
      reason: 'The Review action contains an invalid document range.',
    });
  });
});
