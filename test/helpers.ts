// Shared test utilities.

/** Index of the first differing character between two strings, or -1 if equal. */
export function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

/** A short, human-readable context window around an offset in both strings. */
export function diffContext(a: string, b: string, at: number, span = 40): string {
  const from = Math.max(0, at - span);
  const slice = (s: string) => JSON.stringify(s.slice(from, at + span));
  return `@${at}\n  original: ${slice(a)}\n  actual:   ${slice(b)}`;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
