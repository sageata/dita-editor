// The Styles view hover preview popup (media/styles-preview-popup.js): pure
// sample-document builder + placement math, and the DOM manager's hover
// lifecycle. The fake DOM has no attachShadow, so the manager runs its
// innerHTML fallback here; Shadow-DOM isolation is verified live in the
// Extension Development Host.

import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, keyEvent } from './canvas-test-dom';

const source = readFileSync(new URL('../media/styles-preview-popup.js', import.meta.url), 'utf8');

interface PlacementInput {
  anchorTop: number;
  anchorBottom: number;
  viewportHeight: number;
  popupHeight: number;
  margin?: number;
}

interface PopupManager {
  scheduleOpen(anchor: unknown, kind: string, presetClassName: string | null, styleName: string): void;
  scheduleClose(): void;
  closeNow(): void;
  isOpen(): boolean;
}

interface PopupNs {
  buildStylePreviewHtml(kind: string, presetClassName: string | null, cssText: string): string;
  computePreviewPlacement(input: PlacementInput): { top: number; placement: string };
  installPreviewPopup(options: Record<string, unknown>): PopupManager;
}

function loadNs(): PopupNs {
  const win = {} as { DitaEditorStylesPreviewPopup: PopupNs };
  new Function('window', source)(win);
  return win.DitaEditorStylesPreviewPopup;
}

function makeDeferredTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    windowExtras: {
      setTimeout(callback: () => void) {
        const id = nextId++;
        pending.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        pending.delete(id);
      },
    },
    pendingCount: () => pending.size,
    runAll() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function mountManager(windowOverrides: Record<string, unknown> = {}) {
  const ns = loadNs();
  const doc = new TestDocument();
  const timers = makeDeferredTimers();
  const windowObj = { innerHeight: 600, ...timers.windowExtras, ...windowOverrides };
  const manager = ns.installPreviewPopup({
    document: doc,
    window: windowObj,
    getCssText: () => '.body p.p.p{color:#123456}',
  });
  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  const host = () => doc.body.children.find((el) => el.classList.contains('style-preview-popup')) ?? null;
  return { ns, doc, timers, manager, anchor, host };
}

describe('buildStylePreviewHtml', () => {
  const ns = loadNs();

  test('frames a preset paragraph with the context title and a default paragraph', () => {
    const html = ns.buildStylePreviewHtml('body', 'dc-body-lead', '.body p.p.p{color:#123456}');
    expect(html).toContain('<div class="body">');
    expect(html).toContain('class="title topictitle1"');
    expect(html).toContain('class="p"');
    expect(html).toContain('class="p dc-body-lead"');
    expect(html).toContain('.body p.p.p{color:#123456}');
    expect(html).toContain('dc-style-preview-paper');
  });

  test('base previews render the target classless', () => {
    const html = ns.buildStylePreviewHtml('body', null, '');
    expect(html).not.toContain('null');
    expect(html).not.toContain('class="p dc-');
    // Context paragraph + classless target paragraph.
    expect(html.split('class="p"').length - 1).toBe(2);
  });

  test('a title preview leads the sample instead of duplicating the context title', () => {
    const html = ns.buildStylePreviewHtml('title', 'dc-title-display', '');
    expect(html).toContain('class="title topictitle1 dc-title-display"');
    expect(html.split('topictitle1').length - 1).toBe(1);
  });

  test('table kinds compose the class onto the right node of the shared skeleton', () => {
    expect(ns.buildStylePreviewHtml('table', 'dc-table-ruled', '')).toContain('class="table dc-table-ruled"');
    expect(ns.buildStylePreviewHtml('tableHeadCell', 'dc-header-gold', '')).toContain('class="entry dc-header-gold"');
    expect(ns.buildStylePreviewHtml('tableRow', 'dc-row-highlight', '')).toContain('class="row dc-row-highlight"');
  });

  test('the table sample has enough body rows for zebra striping to show', () => {
    // The zebraEven selector is `tbody.tbody tr.row:nth-child(even) td.entry`:
    // with four body rows, rows 2 and 4 stripe against 1 and 3.
    const html = ns.buildStylePreviewHtml('table', 'dc-table-striped', '');
    const tbody = html.slice(html.indexOf('<tbody class="tbody">'));
    expect(tbody.split('<tr class="row"').length - 1).toBe(4);
  });

  test('page and unknown kinds fall back to safe samples', () => {
    const page = ns.buildStylePreviewHtml('page', null, '');
    expect(page).toContain('class="title topictitle1"');
    expect(page).toContain('<div class="body">');
    const unknown = ns.buildStylePreviewHtml('nope', null, '');
    expect(unknown).toContain('class="p"');
  });

  test('rejects markup-bearing class names and style-terminating CSS', () => {
    const injected = ns.buildStylePreviewHtml('body', 'x" onmouseover="alert(1)', '');
    expect(injected).not.toContain('onmouseover');
    const css = ns.buildStylePreviewHtml('body', null, 'a{}</style><script>bad()</script>');
    expect(css).not.toContain('</style><script>');
  });
});

describe('computePreviewPlacement', () => {
  const ns = loadNs();

  test('places below when the popup fits', () => {
    expect(ns.computePreviewPlacement({ anchorTop: 100, anchorBottom: 120, viewportHeight: 600, popupHeight: 200 }))
      .toEqual({ top: 124, placement: 'below' });
  });

  test('flips above when below overflows', () => {
    expect(ns.computePreviewPlacement({ anchorTop: 500, anchorBottom: 520, viewportHeight: 600, popupHeight: 200 }))
      .toEqual({ top: 296, placement: 'above' });
  });

  test('clamps when neither side fits', () => {
    expect(ns.computePreviewPlacement({ anchorTop: 150, anchorBottom: 170, viewportHeight: 600, popupHeight: 590 }))
      .toEqual({ top: 8, placement: 'clamped' });
  });

  test('degrades to below when the viewport height is unknown', () => {
    expect(ns.computePreviewPlacement({ anchorTop: 40, anchorBottom: 60, viewportHeight: 0, popupHeight: 200 }))
      .toEqual({ top: 64, placement: 'below' });
  });
});

describe('installPreviewPopup', () => {
  test('opens only after the hover delay, rendering the sample with the managed CSS', () => {
    const { timers, manager, anchor, host } = mountManager();

    manager.scheduleOpen(anchor, 'body', 'dc-body-lead', 'Lead paragraph');
    expect(manager.isOpen()).toBe(false);
    expect(timers.pendingCount()).toBe(1);

    timers.runAll();

    expect(manager.isOpen()).toBe(true);
    const el = host();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('tooltip');
    expect(el!.getAttribute('aria-hidden')).toBe('false');
    expect(el!.getAttribute('aria-label')).toBe('Preview of Lead paragraph');
    expect(el!.innerHTML).toContain('class="p dc-body-lead"');
    expect(el!.innerHTML).toContain('.body p.p.p{color:#123456}');
    // Fixed anchor rect {top:40, bottom:60} + offsetHeight 20 → below at 64px.
    expect(el!.style.top).toBe('64px');
  });

  test('a leave closes after the grace period; re-entering within it cancels the close', () => {
    const { timers, manager, anchor } = mountManager();
    manager.scheduleOpen(anchor, 'body', null, 'Default');
    timers.runAll();
    expect(manager.isOpen()).toBe(true);

    manager.scheduleClose();
    expect(manager.isOpen()).toBe(true); // still open during the grace window
    manager.scheduleOpen(anchor, 'body', null, 'Default'); // re-enter cancels
    timers.runAll();
    expect(manager.isOpen()).toBe(true);

    manager.scheduleClose();
    timers.runAll();
    expect(manager.isOpen()).toBe(false);
  });

  test('Escape closes immediately and closeNow cancels a pending open', () => {
    const { doc, timers, manager, anchor, host } = mountManager();
    manager.scheduleOpen(anchor, 'note', 'dc-note-panel', 'Note panel');
    timers.runAll();
    expect(manager.isOpen()).toBe(true);

    for (const listener of doc.listeners.get('keydown') ?? []) listener(keyEvent('Escape'));
    expect(manager.isOpen()).toBe(false);
    expect(host()!.getAttribute('aria-hidden')).toBe('true');

    manager.scheduleOpen(anchor, 'note', 'dc-note-panel', 'Note panel');
    manager.closeNow();
    expect(timers.pendingCount()).toBe(0);
    timers.runAll();
    expect(manager.isOpen()).toBe(false);
  });

  test('hovering a second eye retargets the singleton popup instantly while open', () => {
    const { doc, timers, manager, anchor, host } = mountManager();
    manager.scheduleOpen(anchor, 'body', 'dc-body-lead', 'Lead paragraph');
    timers.runAll();

    const second = doc.createElement('button');
    doc.body.appendChild(second);
    manager.scheduleOpen(second, 'note', 'dc-note-panel', 'Note panel');
    // No second hover delay: the open popup swaps content immediately.
    expect(timers.pendingCount()).toBe(0);

    expect(manager.isOpen()).toBe(true);
    expect(doc.body.children.filter((el) => el.classList.contains('style-preview-popup'))).toHaveLength(1);
    expect(host()!.innerHTML).toContain('class="note dc-note-panel"');
    expect(host()!.getAttribute('aria-label')).toBe('Preview of Note panel');
  });

  test('degrades to immediate open/close when the window has no timers', () => {
    const ns = loadNs();
    const doc = new TestDocument();
    const manager = ns.installPreviewPopup({
      document: doc,
      window: { innerHeight: 0 },
      getCssText: () => '',
    });
    const anchor = doc.createElement('button');
    doc.body.appendChild(anchor);

    manager.scheduleOpen(anchor, 'body', null, 'Default');
    expect(manager.isOpen()).toBe(true);
    manager.scheduleClose();
    expect(manager.isOpen()).toBe(false);
  });

  test('the module is structurally unable to post messages', () => {
    expect(source).not.toContain('postMessage');
    expect(source).not.toContain('acquireVsCodeApi');
    expect(source).not.toContain('getState');
    expect(source).not.toContain('setState');
  });
});
