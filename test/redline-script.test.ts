import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('redline managed stylesheet script', () => {
  test('uses only the pre-existing slot for embedded and live CSS', () => {
    const source = readFileSync(new URL('../media/redline.js', import.meta.url), 'utf8');
    const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    const posted: unknown[] = [];
    const appended: unknown[] = [];
    const liveStyle = { textContent: '' };
    const data = {
      textContent: JSON.stringify({ consumer: 'redline', cssText: '.initial { color: red; }' }),
    };
    const document = {
      getElementById(id: string) {
        if (id === 'ditaeditor-author-styles-live') return liveStyle;
        if (id === 'ditaeditor-managed-style-data') return data;
        return null;
      },
      head: { appendChild(value: unknown) { appended.push(value); } },
      createElement() { throw new Error('redline must not create a live style element'); },
      addEventListener() { /* delegated banner click is outside this test */ },
    };
    const window = {
      scrollY: 0,
      scrollTo() { /* no persisted position */ },
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
    };
    const vscode = {
      getState: () => null,
      setState() { /* scroll persistence is outside this test */ },
      postMessage(message: unknown) { posted.push(message); },
    };

    new Function(
      'window',
      'document',
      'Element',
      'acquireVsCodeApi',
      'requestAnimationFrame',
      source,
    )(
      window,
      document,
      class {},
      () => vscode,
      (callback: () => void) => callback(),
    );

    expect(liveStyle.textContent).toBe('.initial { color: red; }');
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: { type: 'managedStyles', cssText: '.updated { color: blue; }' } });
    }
    expect(liveStyle.textContent).toBe('.updated { color: blue; }');
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: { type: 'managedStyles', cssText: '' } });
    }
    expect(liveStyle.textContent).toBe('');
    expect(appended).toEqual([]);
    expect(posted).toEqual([{ type: 'redlineReady' }]);
  });
});
