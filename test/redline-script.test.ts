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

  test('restores mode, toggles groups and views, and navigates visible changes', () => {
    const source = readFileSync(new URL('../media/redline.js', import.meta.url), 'utf8');
    const documentListeners = new Map<string, Array<(event: { target: FakeElement }) => void>>();
    const windowListeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    const posted: unknown[] = [];
    const saved: Array<Record<string, unknown>> = [];
    const scrolledWindow: number[] = [];

    class FakeElement {
      hidden = false;
      textContent = '';
      hiddenAncestor = false;
      scrolled = 0;
      focused = 0;
      private attrs = new Map<string, string>();

      constructor(attrs: Record<string, string> = {}) {
        for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
      }

      getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
      setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
      hasAttribute(name: string): boolean { return this.attrs.has(name); }
      closest(selector: string): FakeElement | null {
        if (selector === '[hidden]') return this.hidden || this.hiddenAncestor ? this : null;
        const name = selector.slice(1, -1);
        return this.hasAttribute(name) ? this : null;
      }
      scrollIntoView(): void { this.scrolled += 1; }
      focus(): void { this.focused += 1; }
    }

    const liveStyle = new FakeElement();
    const managedData = new FakeElement();
    managedData.textContent = JSON.stringify({ consumer: 'redline', cssText: '' });
    const inlineView = new FakeElement({ 'data-redline-view': 'inline' });
    const sideView = new FakeElement({ 'data-redline-view': 'side-by-side' });
    const inlineButton = new FakeElement({ 'data-redline-mode': 'inline', 'aria-pressed': 'true' });
    const sideButton = new FakeElement({ 'data-redline-mode': 'side-by-side', 'aria-pressed': 'false' });
    const sideControls = new FakeElement({ 'data-redline-side-only': '' });
    sideControls.hidden = true;
    const expandButton = new FakeElement({
      'data-redline-expand': 'unchanged-1',
      'aria-expanded': 'false',
    });
    const unchangedRows = new FakeElement({ 'data-redline-unchanged-rows': 'unchanged-1' });
    unchangedRows.hidden = true;
    const firstChange = new FakeElement({ 'data-redline-change': '' });
    const hiddenChange = new FakeElement({ 'data-redline-change': '' });
    hiddenChange.hiddenAncestor = true;
    const secondChange = new FakeElement({ 'data-redline-change': '' });
    const nextButton = new FakeElement({ 'data-redline-nav': 'next' });
    const previousButton = new FakeElement({ 'data-redline-nav': 'previous' });
    const xmlButton = new FakeElement({ 'data-redline-action': 'openSourceDiff' });
    const body = new FakeElement();
    const elements = [
      inlineView, sideView, inlineButton, sideButton, sideControls, expandButton,
      unchangedRows, firstChange, hiddenChange, secondChange,
    ];

    const document = {
      body,
      getElementById(id: string) {
        if (id === 'ditaeditor-author-styles-live') return liveStyle;
        if (id === 'ditaeditor-managed-style-data') return managedData;
        return null;
      },
      querySelectorAll(selector: string) {
        const name = selector.slice(1, -1);
        return elements.filter((element) => element.hasAttribute(name));
      },
      addEventListener(type: string, listener: (event: { target: FakeElement }) => void) {
        const listeners = documentListeners.get(type) ?? [];
        listeners.push(listener);
        documentListeners.set(type, listeners);
      },
    };
    const window = {
      scrollY: 44,
      scrollTo(_x: number, y: number) { scrolledWindow.push(y); },
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      },
    };
    const vscode = {
      getState: () => ({ mode: 'side-by-side', expandedGroups: ['stale-group'], y: 21 }),
      setState(value: Record<string, unknown>) { saved.push(value); },
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
      FakeElement,
      () => vscode,
      (callback: () => void) => callback(),
    );

    expect(inlineView.hidden).toBe(true);
    expect(sideView.hidden).toBe(false);
    expect(sideControls.hidden).toBe(false);
    expect(sideButton.getAttribute('aria-pressed')).toBe('true');
    expect(unchangedRows.hidden).toBe(true);
    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    expect(scrolledWindow).toEqual([21]);

    const click = (target: FakeElement): void => {
      for (const listener of documentListeners.get('click') ?? []) listener({ target });
    };
    click(nextButton);
    click(nextButton);
    click(previousButton);
    expect(firstChange.scrolled).toBe(2);
    expect(firstChange.focused).toBe(2);
    expect(secondChange.scrolled).toBe(1);
    expect(hiddenChange.scrolled).toBe(0);

    click(expandButton);
    expect(unchangedRows.hidden).toBe(false);
    expect(expandButton.getAttribute('aria-expanded')).toBe('true');

    click(inlineButton);
    expect(inlineView.hidden).toBe(false);
    expect(sideView.hidden).toBe(true);
    expect(sideControls.hidden).toBe(true);
    expect(inlineButton.getAttribute('aria-pressed')).toBe('true');

    click(xmlButton);
    expect(posted).toContainEqual({ type: 'openSourceDiff' });
    expect(saved.at(-1)).toEqual({ mode: 'inline', y: 21 });
  });
});
