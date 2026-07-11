import { describe, expect, test } from 'bun:test';
import { createRefreshGeneration } from '../src/host/refresh-generation';

describe('refresh generation', () => {
  test('invalidates an older render when a newer refresh is scheduled', () => {
    const guard = createRefreshGeneration();
    const older = guard.begin();
    expect(older).toBeNumber();
    guard.invalidate();
    expect(guard.isCurrent(older!)).toBe(false);
    const newer = guard.begin();
    expect(guard.isCurrent(newer!)).toBe(true);
  });

  test('permanently blocks commit and new work after disposal', () => {
    const guard = createRefreshGeneration();
    const pending = guard.begin();
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
    expect(guard.isCurrent(pending!)).toBe(false);
    expect(guard.begin()).toBeNull();
    guard.invalidate();
    expect(guard.begin()).toBeNull();
  });
});
