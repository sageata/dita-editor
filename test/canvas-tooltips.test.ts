import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

interface TooltipController {
  attach(container: TestElement): void;
  hide(): void;
}

function loadHarness() {
  const source = readFileSync(new URL('../media/canvas-tooltips.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasTooltips: {
      createTooltipController(opts: Record<string, unknown>): TooltipController;
    };
  };
  new Function('window', source)(win);
  const doc = new TestDocument();
  const timers: Array<{ id: number; fn: () => void }> = [];
  let timerSeq = 0;
  let clock = 0;
  const controller = win.DitaEditorCanvasTooltips.createTooltipController({
    document: doc,
    windowObj: { innerWidth: 800 },
    setTimeoutFn: (fn: () => void) => {
      timerSeq += 1;
      timers.push({ id: timerSeq, fn });
      return timerSeq;
    },
    clearTimeoutFn: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    now: () => clock,
    showDelayMs: 120,
    graceMs: 300,
  });
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const makeBtn = (label: string) => {
    const btn = doc.createElement('button');
    btn.dataset.action = label;
    btn.dataset.tooltipOnly = '1';
    btn.setAttribute('aria-label', label);
    container.appendChild(btn);
    return btn;
  };
  controller.attach(container);
  return {
    doc,
    container,
    controller,
    makeBtn,
    flush: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    pendingTimers: () => timers.length,
    advance: (ms: number) => {
      clock += ms;
    },
    tip: () => doc.body.children.find((child) => child.className === 'cmd-tooltip') ?? null,
  };
}

describe('canvas-tooltips', () => {
  test('shows after the short delay with the aria-label text, aria-hidden', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');

    h.container.dispatch('pointerover', { target: bold });
    expect(h.tip()).toBeNull();
    expect(h.pendingTimers()).toBe(1);

    h.flush();
    const tip = h.tip();
    expect(tip).not.toBeNull();
    expect(tip?.style.display).toBe('block');
    expect(tip?.textContent).toBe('Bold');
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
  });

  test('hides on pointerout and re-shows instantly within the grace window', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');
    const italic = h.makeBtn('Italic');

    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    h.container.dispatch('pointerout', { target: bold, relatedTarget: null });
    expect(h.tip()?.style.display).toBe('none');

    h.advance(100);
    h.container.dispatch('pointerover', { target: italic });
    expect(h.pendingTimers()).toBe(0);
    expect(h.tip()?.style.display).toBe('block');
    expect(h.tip()?.textContent).toBe('Italic');
  });

  test('waits for the delay again once the grace window has passed', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');

    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    h.container.dispatch('pointerout', { target: bold, relatedTarget: null });
    h.advance(1000);
    h.container.dispatch('pointerover', { target: bold });
    expect(h.tip()?.style.display).toBe('none');
    expect(h.pendingTimers()).toBe(1);
    h.flush();
    expect(h.tip()?.style.display).toBe('block');
  });

  test('moving straight onto another button swaps the tooltip instantly', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');
    const italic = h.makeBtn('Italic');

    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    h.container.dispatch('pointerover', { target: italic });
    expect(h.pendingTimers()).toBe(0);
    expect(h.tip()?.textContent).toBe('Italic');
    expect(h.tip()?.style.display).toBe('block');
  });

  test('roving focus shows the tooltip and focusout hides it', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');

    h.container.dispatch('focusin', { target: bold });
    h.flush();
    expect(h.tip()?.style.display).toBe('block');
    h.container.dispatch('focusout', { target: bold });
    expect(h.tip()?.style.display).toBe('none');
  });

  test('Escape and pointerdown dismiss the tooltip', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');

    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    for (const listener of h.doc.listeners.get('keydown') ?? []) listener({ key: 'Escape' } as never);
    expect(h.tip()?.style.display).toBe('none');

    h.advance(1000);
    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    expect(h.tip()?.style.display).toBe('block');
    h.container.dispatch('pointerdown', { target: bold });
    expect(h.tip()?.style.display).toBe('none');
  });

  test('ignores elements without the tooltipOnly opt-in and leaving over a child keeps it open', () => {
    const h = loadHarness();
    const plain = h.container.appendChild(h.doc.createElement('button'));
    plain.dataset.action = 'Native title button';

    h.container.dispatch('pointerover', { target: plain });
    expect(h.pendingTimers()).toBe(0);
    expect(h.tip()).toBeNull();

    const bold = h.makeBtn('Bold');
    const glyph = h.doc.createElement('span');
    bold.appendChild(glyph);
    h.container.dispatch('pointerover', { target: glyph });
    h.flush();
    expect(h.tip()?.style.display).toBe('block');
    // pointerout to a node still inside the button must not hide.
    h.container.dispatch('pointerout', { target: bold, relatedTarget: glyph });
    expect(h.tip()?.style.display).toBe('block');
  });

  test('reads refreshed unavailable reasons from aria-label at show time', () => {
    const h = loadHarness();
    const bold = h.makeBtn('Bold');
    bold.setAttribute('aria-label', 'Bold. Unavailable: Select text to format');

    h.container.dispatch('pointerover', { target: bold });
    h.flush();
    expect(h.tip()?.textContent).toBe('Bold. Unavailable: Select text to format');
  });
});
