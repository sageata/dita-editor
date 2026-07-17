import { describe, expect, test } from 'bun:test';
import { planReviewReverts, type ReviewRevertPlan } from '../src/compare/revert-change';

function apply(source: string, plan: ReviewRevertPlan): string {
  expect(source.slice(plan.start, plan.end)).toBe(plan.expected);
  return source.slice(0, plan.start) + plan.replacement + source.slice(plan.end);
}

const wrap = (body: string): string => `<topic id="t"><body>\n${body}\n</body></topic>`;

describe('planReviewReverts', () => {
  test('restores a modified block with one exact replacement', () => {
    const earlier = wrap('<p>Earlier wording</p>');
    const newer = wrap('<p>Newer wording</p>');
    const plans = planReviewReverts(earlier, newer);

    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe('Restore changed <p>');
    expect(apply(newer, plans[0])).toBe(earlier);
  });

  test('removes an inserted block together with its adjacent layout text', () => {
    const earlier = wrap('<p>One</p>\n<p>Three</p>');
    const newer = wrap('<p>One</p>\n<p>Two</p>\n<p>Three</p>');
    const inserted = planReviewReverts(earlier, newer).find((plan) =>
      plan.label === 'Remove inserted <p>'
    );

    expect(inserted).toBeDefined();
    expect(apply(newer, inserted!)).toBe(earlier);
  });

  test('restores a deleted block at a surviving sibling anchor', () => {
    const earlier = wrap('<p>One</p>\n<p>Two</p>\n<p>Three</p>');
    const newer = wrap('<p>One</p>\n<p>Three</p>');
    const deleted = planReviewReverts(earlier, newer).find((plan) =>
      plan.label === 'Restore deleted <p>'
    );

    expect(deleted).toBeDefined();
    expect(deleted?.start).toBe(deleted?.end);
    expect(apply(newer, deleted!)).toBe(earlier);
  });

  test('restores a formatting-only change without rewriting its parent', () => {
    const earlier = wrap('<p outputclass="note">Same text</p>');
    const newer = wrap('<p outputclass="warning">Same text</p>');
    const plans = planReviewReverts(earlier, newer);

    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe('Restore formatting of <p>');
    expect(apply(newer, plans[0])).toBe(earlier);
  });

  test('uses the same transparent-container granularity as side-by-side rows', () => {
    const earlier = wrap('<section><p>Earlier</p><p>Same</p></section>');
    const newer = wrap('<section><p>Newer</p><p>Same</p></section>');
    const plans = planReviewReverts(earlier, newer);

    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe('Restore changed <p>');
    expect(apply(newer, plans[0])).toBe(earlier);
  });

  test('does not offer a one-range revert for relocated blocks', () => {
    const earlier = wrap('<p>One unique</p>\n<p>Two unique</p>');
    const newer = wrap('<p>Two unique</p>\n<p>One unique</p>');

    expect(planReviewReverts(earlier, newer)).toEqual([]);
  });
});
