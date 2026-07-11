import { describe, expect, test } from 'bun:test';
import { serializeEmbeddedJson } from '../src/webview/embedded-json';

describe('serializeEmbeddedJson', () => {
  test('round-trips hostile text without leaving HTML-significant characters', () => {
    const value = {
      consumer: 'canvas',
      cssText: '</ScRiPt><style>&\u2028\u2029 .x::before { content: "<>&"; }',
    };
    const serialized = serializeEmbeddedJson(value);

    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(serialized.toLowerCase()).not.toContain('</script');
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
