import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../media/canvas-scroll-anchor.js', import.meta.url), 'utf8');

interface FakeElement {
  id: string;
  top: number;
  bottom: number;
  parent?: FakeElement;
  scrollOptions?: ScrollIntoViewOptions;
  getAttribute(name: string): string | null;
  contains(other: FakeElement): boolean;
  getBoundingClientRect(): { top: number; bottom: number };
  scrollIntoView(options: ScrollIntoViewOptions): void;
}

function element(id: string, top: number, bottom: number, parent?: FakeElement, cell = false): FakeElement {
  return {
    id,
    top,
    bottom,
    parent,
    getAttribute(name) {
      if (cell && name === 'data-cell-id') return id;
      if (!cell && name === 'data-struct-id') return id;
      return null;
    },
    contains(other) {
      let cursor: FakeElement | undefined = other;
      while (cursor) {
        if (cursor === this) return true;
        cursor = cursor.parent;
      }
      return false;
    },
    getBoundingClientRect() {
      return { top: this.top, bottom: this.bottom };
    },
    scrollIntoView(options) {
      this.scrollOptions = options;
    },
  };
}

function harness(elements: FakeElement[]) {
  const posted: unknown[] = [];
  const listeners: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const main = { querySelectorAll: () => elements };
  const fakeWindow = {
    DitaEditorCanvasScrollAnchor: undefined as unknown,
    addEventListener(type: string, listener: () => void) {
      if (type === 'scroll') listeners.push(listener);
    },
    requestAnimationFrame(callback: () => void) {
      frames.push(callback);
      return frames.length;
    },
  };
  const fakeDocument = {
    querySelector(selector: string) {
      return selector === 'main' ? main : null;
    },
  };
  new Function('window', source)(fakeWindow);
  const factory = fakeWindow.DitaEditorCanvasScrollAnchor as {
    create(options: object): {
      start(): void;
      didRerender(): void;
      restore(id: string, block?: 'start' | 'center'): boolean;
    };
  };
  const controller = factory.create({
    window: fakeWindow,
    document: fakeDocument,
    postMessage: (message: unknown) => posted.push(message),
  });
  return {
    controller,
    posted,
    scroll: () => listeners.forEach((listener) => listener()),
    flush: () => frames.shift()?.(),
    pendingFrames: () => frames.length,
  };
}

describe('canvas scroll anchor', () => {
  test('reports the nearest visible addressable element on initial load and coalesces scroll events per frame', () => {
    const section = element('e5', -400, 800);
    const paragraph = element('e7', -12, 60, section);
    const cell = element('e12', 90, 160, section, true);
    const view = harness([section, paragraph, cell]);

    view.controller.start();
    view.scroll();
    view.scroll();
    expect(view.pendingFrames()).toBe(1);
    view.flush();
    expect(view.posted).toEqual([{ type: 'scrollAnchor', id: 'e7' }]);
  });

  test('reports again after rerender and restores without focusing or selecting', () => {
    const paragraph = element('e7', 12, 80);
    const view = harness([paragraph]);
    view.controller.didRerender();
    view.flush();
    expect(view.posted).toEqual([{ type: 'scrollAnchor', id: 'e7' }]);

    expect(view.controller.restore('e7')).toBe(true);
    expect(paragraph.scrollOptions).toEqual({ block: 'start' });
    expect(view.controller.restore('missing')).toBe(false);
  });

  test('restores centered when asked, defaulting to start otherwise', () => {
    const paragraph = element('e7', 12, 80);
    const view = harness([paragraph]);
    expect(view.controller.restore('e7', 'center')).toBe(true);
    expect(paragraph.scrollOptions).toEqual({ block: 'center' });
    expect(view.controller.restore('e7', 'bogus' as never)).toBe(true);
    expect(paragraph.scrollOptions).toEqual({ block: 'start' });
  });
});
