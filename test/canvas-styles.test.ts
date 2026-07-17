import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_AUTHOR_STYLES, parseAuthorStyles, serializeAuthorStyles } from '../src/styles/author-styles';
import { TestDocument, TestElement, type TestListener } from './canvas-test-dom';

interface TestWindow {
  innerWidth: number;
  listeners: Map<string, TestListener[]>;
  addEventListener(type: string, listener: TestListener): void;
  removeEventListener(type: string, listener: TestListener): void;
  dispatch(type: string, event: Record<string, unknown>): void;
}

function makeWindow(innerWidth = 1000): TestWindow {
  return {
    innerWidth,
    listeners: new Map(),
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter((item) => item !== listener));
    },
    dispatch(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    },
  };
}

interface HelperOverrides {
  styles?: unknown[];
  currentTarget?: { ids: string[]; kind: string; label: string; outputclass: string } | null;
  saveRequestSessionId?: string;
  vscodeState?: { value: Record<string, unknown> | undefined };
  windowExtras?: Record<string, unknown>;
  installExtras?: Record<string, unknown>;
}

function loadHelper(overrides: HelperOverrides = {}) {
  const source = readFileSync(new URL('../media/canvas-styles.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  interface StylesPanel {
    refresh(force?: boolean): void;
    acceptSaveResult(result: {
      type: 'styleSaveResult';
      requestId: string;
      ok: boolean;
      sourceHash?: string;
      acceptedStyles?: unknown[];
      error?: string;
    }): boolean;
    panel: TestElement;
    resizeHandle: TestElement;
    hideButton: TestElement;
    showButton: TestElement;
  }
  const win = {} as {
    DitaEditorCanvasStyles: {
      installStylesPanel(opts: Record<string, unknown>): StylesPanel;
    };
  };
  const doc = new TestDocument();
  const liveStyle = doc.createElement('style');
  liveStyle.id = 'ditaeditor-author-styles-live';
  doc.body.appendChild(liveStyle);
  const managedStyleData = doc.createElement('script');
  managedStyleData.id = 'ditaeditor-managed-style-data';
  managedStyleData.textContent = JSON.stringify({
    consumer: 'canvas',
    cssText: '.dc-embedded-first-paint { color: #123456; }',
  });
  doc.body.appendChild(managedStyleData);
  const testWindow = Object.assign(makeWindow(), overrides.windowExtras || {});
  const messages: unknown[] = [];
  const vscodeState = overrides.vscodeState ?? { value: undefined };
  const initialStyles = (overrides.styles ?? DEFAULT_AUTHOR_STYLES) as unknown as typeof DEFAULT_AUTHOR_STYLES;
  let styleState: {
    styles: typeof DEFAULT_AUTHOR_STYLES;
    cssText: string;
    writable: boolean;
    sourceHash: string;
    cssPath: string;
    targetToken: string;
    error?: string;
  } = {
    styles: initialStyles,
    cssText: serializeAuthorStyles(initialStyles),
    writable: true,
    sourceHash: 'displayed-source-hash',
    cssPath: '/workspace/css/ditaeditor-author-styles.css',
    targetToken: 'target-token-a',
  };
  let currentTarget: {
    ids: string[];
    kind: string;
    label: string;
    outputclass: string;
  } | null = 'currentTarget' in overrides
    ? overrides.currentTarget ?? null
    : {
      ids: ['e1'],
      kind: 'title',
      label: 'title',
      outputclass: 'dc-title-display',
    };
  new Function('window', source)(win);
  const panel = win.DitaEditorCanvasStyles.installStylesPanel({
    document: doc,
    window: testWindow,
    vscode: {
      postMessage: (msg: unknown) => messages.push(msg),
      getState: () => vscodeState.value,
      setState: (next: Record<string, unknown>) => { vscodeState.value = next; },
    },
    fontFamily: 'sans-serif',
    saveRequestSessionId: overrides.saveRequestSessionId ?? 'test-style-session',
    getStyleState: () => styleState,
    getCurrentTarget: () => currentTarget,
    announceNav: () => undefined,
    ...(overrides.installExtras || {}),
  });
  return {
    doc,
    liveStyle,
    panel,
    messages,
    vscodeState,
    setStyleState: (next: Omit<typeof styleState, 'targetToken'> & { targetToken?: string }) => {
      styleState = { ...next, targetToken: next.targetToken ?? styleState.targetToken };
    },
    setCurrentTarget: (next: typeof currentTarget) => {
      currentTarget = next;
    },
  };
}

function buttonByLabel(panel: TestElement, label: string): TestElement {
  const button = panel.querySelectorAll('button').find((btn) => btn.getAttribute('aria-label') === label);
  expect(button).toBeInstanceOf(TestElement);
  return button!;
}

function buttonByText(panel: TestElement, text: string): TestElement {
  const button = panel.querySelectorAll('button').find((btn) => btn.textContent === text);
  expect(button).toBeInstanceOf(TestElement);
  return button!;
}

function expandGroup(panel: TestElement, label: string): void {
  buttonByLabel(panel, 'Expand ' + label + ' styles').click();
}

// Style groups render collapsed by default; open every one (each click rebuilds
// the panel, so re-query the toggles until none remain collapsed).
function expandAllGroups(panel: TestElement): void {
  for (;;) {
    const btn = panel
      .querySelectorAll('button')
      .find((b) => /^Expand .+ styles$/.test(b.getAttribute('aria-label') || ''));
    if (!btn) break;
    btn.click();
  }
}

function changeControlValue(control: TestElement, value: string, eventType = 'change'): void {
  (control as TestElement & { value: string }).value = value;
  control.dispatch(eventType, { target: control });
}

function messagesOfType(messages: unknown[], type: string): Array<Record<string, unknown>> {
  return messages.filter((message) => (message as { type?: string }).type === type) as Array<Record<string, unknown>>;
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

function loadSaveRequestSessionIdFactory(crypto: unknown): () => string {
  const source = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');
  const start = source.indexOf('function createSaveRequestSessionId()');
  const end = source.indexOf('\n  const saveRequestSessionId = createSaveRequestSessionId();', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return new Function(
    'window',
    source.slice(start, end) + '\nreturn createSaveRequestSessionId;',
  )({ crypto }) as () => string;
}

describe('canvas-styles', () => {
  test('canvas routes explicit save results to the styles panel before generic style-state refreshes', () => {
    const source = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');
    const saveResultBranch = "if (msg.type === 'styleSaveResult') {\n      stylesPanel.acceptSaveResult(msg);\n      return;\n    }";

    expect(source).toContain(saveResultBranch);
    expect(source.indexOf(saveResultBranch)).toBeLessThan(source.indexOf("if (msg.type === 'styleState')"));
    expect(source).toContain('crypto.randomUUID');
    expect(source).toContain('crypto.getRandomValues');
    expect(source).toContain('saveRequestSessionId: saveRequestSessionId');
  });

  test('creates a secure per-frame session ID with randomUUID and getRandomValues fallback', () => {
    const direct = loadSaveRequestSessionIdFactory({ randomUUID: () => 'direct-session-uuid' });
    expect(direct()).toBe('direct-session-uuid');

    const fallback = loadSaveRequestSessionIdFactory({
      getRandomValues(bytes: Uint8Array) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });
    expect(fallback()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(() => loadSaveRequestSessionIdFactory({})()).toThrow('Secure randomness is unavailable');
  });

  test('starts hidden by default; showing it mounts a right sidebar and applies a CSS-backed style when pressing a style row', () => {
    const { doc, panel, messages } = loadHelper();

    expect(panel.panel.style.display).toBe('none');
    expect(doc.main.style.paddingRight).toBe('36px');

    panel.showButton.click();

    expect(panel.panel.style.width).toBe('324px');
    expect(doc.main.style.paddingRight).toBe('308px');
    expect(doc.main.style.minWidth).toBe('1348px');
    expect(doc.main.style.maxWidth).toBe('1348px');
    expect(panel.resizeHandle.getAttribute('role')).toBe('separator');

    expandGroup(panel.panel, 'Topic title');
    expect(panel.panel.textContent).toContain('Display title');

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Apply Muted element').click();

    expect(messages.at(-1)).toEqual({
      type: 'applyStyle',
      ids: ['e1'],
      className: 'dc-all-muted',
      baseStructVersion: 0,
    });
  });

  test('groups available styles by target', () => {
    const { panel } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    expandGroup(panel.panel, 'Topic title');
    expandGroup(panel.panel, 'Section heading');

    const groups = panel.panel.querySelectorAll('.style-target-group');
    expect(groups.length).toBeGreaterThan(5);
    expect(groups[0].textContent).toContain('Page');
    expect(groups[1].textContent).toContain('All elements (1)');
    expect(groups[1].textContent).toContain('Muted element');
    expect(groups[2].textContent).toContain('Topic title (1)');
    expect(groups[2].textContent).toContain('Display title');
    expect(groups[3].textContent).toContain('Section heading (2)');
    expect(groups[3].textContent).toContain('Accent heading');
    expect(groups[3].textContent).toContain('Compact heading');
  });

  test('shows row accent rails only when the style defines an accent border', () => {
    const { panel } = loadHelper();

    expandAllGroups(panel.panel);
    const expectedAccentCount = DEFAULT_AUTHOR_STYLES.filter((style) => !!style.borderColor).length;
    expect(panel.panel.querySelectorAll('.style-accent-rail')).toHaveLength(expectedAccentCount);
    expect(buttonByLabel(panel.panel, 'Apply Shaded table cell').querySelectorAll('.style-accent-rail')).toHaveLength(0);
    expect(buttonByLabel(panel.panel, 'Apply Accent heading').querySelectorAll('.style-accent-rail')).toHaveLength(1);
  });

  test('selected element summary only shows a leading rail for accented styles', () => {
    const { panel, setCurrentTarget } = loadHelper();

    let current = panel.panel.querySelector('.style-current');
    expect(current?.style.cssText || '').not.toContain('border-left:2px solid');

    setCurrentTarget({
      ids: ['heading-1'],
      kind: 'title',
      label: 'title',
      outputclass: 'dc-heading-gold',
    });
    panel.refresh(true);

    current = panel.panel.querySelector('.style-current');
    expect(current?.style.cssText || '').toContain('border-left:2px solid var(--dc-color-accent, #2563eb)');
  });

  test('resolves the live title target when a stale style row is clicked', () => {
    const { panel, messages, setCurrentTarget } = loadHelper();

    setCurrentTarget(null);
    panel.refresh(true);
    expect(panel.panel.textContent).toContain('No element selected');

    setCurrentTarget({
      ids: ['title-1'],
      kind: 'title',
      label: 'title',
      outputclass: '',
    });
    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Apply Display title').click();

    expect(messages.at(-1)).toEqual({
      type: 'applyStyle',
      ids: ['title-1'],
      className: 'dc-title-display',
      baseStructVersion: 0,
    });
  });

  test('hides and restores the right sidebar without losing its width', () => {
    const { doc, panel } = loadHelper();

    panel.hideButton.click();

    expect(panel.panel.style.display).toBe('none');
    expect(panel.resizeHandle.style.display).toBe('none');
    expect(panel.showButton.style.display).toBe('inline-flex');
    expect(doc.main.style.paddingRight).toBe('36px');
    expect(doc.main.style.minWidth).toBe('1076px');
    expect(doc.main.style.maxWidth).toBe('1076px');

    panel.showButton.click();

    expect(panel.panel.style.display).toBe('');
    expect(panel.resizeHandle.style.display).toBe('block');
    expect(panel.showButton.style.display).toBe('none');
    expect(doc.main.style.paddingRight).toBe('308px');
    expect(doc.main.style.minWidth).toBe('1348px');
    expect(doc.main.style.maxWidth).toBe('1348px');
  });

  test('expands and collapses an inline editor below a style without applying it', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    const expandButton = buttonByLabel(panel.panel, 'Expand editor for Muted element');
    expect(expandButton.textContent).toBe('▾');
    expandButton.click();

    expect(messages).toHaveLength(0);
    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    expect(form!.parentElement?.classList.contains('style-row-wrap')).toBe(true);
    expect(form!.parentElement?.textContent).toContain('Muted element');

    const collapseButton = buttonByLabel(panel.panel, 'Collapse editor for Muted element');
    expect(collapseButton.textContent).toBe('▴');
    collapseButton.click();

    expect(panel.panel.querySelector('form')).toBeNull();
    expect(messages).toHaveLength(0);
  });

  test('creates a new style through autosaved control changes', () => {
    const { panel, messages } = loadHelper();

    buttonByText(panel.panel, 'New').click();

    const inputs = panel.panel.querySelectorAll('input');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    (inputs[0] as TestElement & { value: string }).value = 'Cabin lead';
    (inputs[1] as TestElement & { value: string }).value = 'dc-cabin-lead';
    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    expect(form!.textContent).not.toContain('Save');
    changeControlValue(inputs[0], 'Cabin lead', 'input');
    changeControlValue(inputs[1], 'dc-cabin-lead', 'input');

    const last = messages.at(-1) as { type: string; silent?: boolean; styles: Array<{ className: string; name: string; target: string }> };
    expect(last.type).toBe('saveStyles');
    expect(last.silent).toBe(true);
    expect((last as { sourceHash?: string }).sourceHash).toBe('displayed-source-hash');
    expect(last.styles.at(-1)).toMatchObject({
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'title',
    });
  });

  test('posts metadata-hostile display names unchanged with the displayed source hash', () => {
    const { panel, messages } = loadHelper();
    const name = 'Cabin */ /* DITAEDITOR_MANAGED_STYLES_START */\r\n.fake { color: red; }';

    buttonByText(panel.panel, 'New').click();
    const inputs = panel.panel.querySelectorAll('input');
    (inputs[0] as TestElement & { value: string }).value = name;
    (inputs[1] as TestElement & { value: string }).value = 'dc-adversarial-name';
    inputs[1].dispatch('input', { target: inputs[1] });

    const last = messages.at(-1) as {
      type: string;
      sourceHash?: string;
      styles: Array<{ className: string; name: string }>;
    };
    expect(last.type).toBe('saveStyles');
    expect(last.sourceHash).toBe('displayed-source-hash');
    expect(last.styles.at(-1)).toMatchObject({ className: 'dc-adversarial-name', name });
  });

  test('autosaves an existing style when dropdown controls change', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();

    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    const selects = form!.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(10);

    const target = selects.find((select) => select.getAttribute('aria-label') === 'Target') as TestElement & { value: string };
    const weight = selects.find((select) => select.getAttribute('aria-label') === 'Weight') as TestElement & { value: string };
    const textColor = form!.querySelectorAll('input').find((input) =>
      input.getAttribute('aria-label') === 'Text CSS color value'
    ) as TestElement & { value: string };
    const textCase = selects.find((select) => select.getAttribute('aria-label') === 'Case') as TestElement & { value: string };
    const after = selects.find((select) => select.getAttribute('aria-label') === 'After') as TestElement & { value: string };
    expect(target).toBeInstanceOf(TestElement);
    expect(weight).toBeInstanceOf(TestElement);
    expect(textColor).toBeInstanceOf(TestElement);
    expect(textCase).toBeInstanceOf(TestElement);
    expect(after).toBeInstanceOf(TestElement);
    expect(form!.textContent).not.toContain('Save');
    target.value = 'heading';
    weight.value = '700';
    textColor.value = 'var(--dc-color-accent, #2563eb)';
    textCase.value = 'uppercase';
    after.value = '20px';
    after.dispatch('change', { target: after });

    const last = messages.at(-1) as {
      type: string;
      silent?: boolean;
      styles: Array<{
        className: string;
        target: string;
        fontWeight?: string;
        color?: string;
        textTransform?: string;
        spacingAfter?: string;
      }>;
    };
    expect(last.type).toBe('saveStyles');
    expect(last.silent).toBe(true);
    // Seeded structural base styles precede the presets, so locate by class rather
    // than a fixed index.
    expect(last.styles.find((s) => s.className === 'dc-all-muted')).toMatchObject({
      className: 'dc-all-muted',
      target: 'heading',
      fontWeight: '700',
      color: 'var(--dc-color-accent, #2563eb)',
      textTransform: 'uppercase',
      spacingAfter: '20px',
    });
  });

  test('preserves arbitrary authored CSS colors until the picker is explicitly changed', () => {
    const authored = 'color-mix(in srgb, var(--brand) 70%, white)';
    const styles = DEFAULT_AUTHOR_STYLES.map((style) =>
      style.className === 'dc-all-muted' ? { ...style, color: authored } : style
    );
    const { panel, messages } = loadHelper({ styles });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form')!;
    const raw = form.querySelectorAll('input').find((input) =>
      input.getAttribute('aria-label') === 'Text CSS color value'
    ) as TestElement & { value: string };
    const picker = form.querySelectorAll('input').find((input) =>
      input.getAttribute('aria-label') === 'Pick text color'
    ) as TestElement & { value: string };

    expect(raw.value).toBe(authored);
    expect(picker.getAttribute('data-color-representable')).toBe('false');
    expect(messages).toHaveLength(0);

    picker.value = '#aabbcc';
    picker.dispatch('input', { target: picker });
    const saved = messages.at(-1) as { styles: Array<{ className: string; color?: string }> };
    expect(saved.styles.find((style) => style.className === 'dc-all-muted')?.color).toBe('#aabbcc');
  });

  test('a non-forced refresh (the post-autosave styleState push) never steals focus from an open style-editor field', () => {
    const { doc, panel, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    expect(doc.activeElement).toBe(nameInput);

    // Mirrors media/canvas.js's 'styleState' handler after a saveStyles round-trip: the host
    // pushes the freshly-written style state back and the webview calls refresh(false) (NOT
    // forced), same as this call. A forced refresh here previously tore down and rebuilt the
    // panel on every autosave, destroying the focused input mid-keystroke.
    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'refreshed-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);

    expect(doc.activeElement).toBe(nameInput);
    expect(panel.panel.querySelector('form')).toBeInstanceOf(TestElement);
  });

  test('an open form keeps the source hash paired with its original style snapshot', () => {
    const { doc, panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'newer-watcher-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);
    expect(doc.activeElement).toBe(nameInput);

    changeControlValue(nameInput, 'Edited from stale form', 'input');

    expect(messages.at(-1)).toMatchObject({
      type: 'saveStyles',
      sourceHash: 'displayed-source-hash',
    });
  });

  test('a focused form advances only to the hash returned for its own explicit successful save result', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    changeControlValue(nameInput, 'First accepted edit', 'input');
    const first = messages.at(-1) as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };
    expect(first.requestId).toBe('test-style-session:style-save-1');
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'hash-after-first-save',
      acceptedStyles: first.styles,
    })).toBe(true);
    changeControlValue(nameInput, 'Second edit', 'input');

    expect(messages.at(-1)).toMatchObject({
      type: 'saveStyles',
      requestId: 'test-style-session:style-save-2',
      sourceHash: 'hash-after-first-save',
    });
  });

  test('a result from a previous webview session cannot acknowledge the first request after reload', () => {
    const sessionA = loadHelper({ saveRequestSessionId: 'webview-session-a' });
    expandGroup(sessionA.panel.panel, 'All elements');
    buttonByLabel(sessionA.panel.panel, 'Expand editor for Muted element').click();
    const inputA = sessionA.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    inputA.focus();
    changeControlValue(inputA, 'Session A edit', 'input');
    const requestA = sessionA.messages[0] as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };

    const sessionB = loadHelper({ saveRequestSessionId: 'webview-session-b' });
    expandGroup(sessionB.panel.panel, 'All elements');
    buttonByLabel(sessionB.panel.panel, 'Expand editor for Muted element').click();
    const inputB = sessionB.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    inputB.focus();
    changeControlValue(inputB, 'Session B first edit', 'input');
    changeControlValue(inputB, 'Session B queued edit', 'input');
    const requestB = sessionB.messages[0] as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };

    expect(requestA.requestId).toBe('webview-session-a:style-save-1');
    expect(requestB.requestId).toBe('webview-session-b:style-save-1');
    expect(requestA.requestId).not.toBe(requestB.requestId);
    expect(sessionB.panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: requestA.requestId,
      ok: true,
      sourceHash: 'session-a-hash',
      acceptedStyles: requestA.styles,
    })).toBe(false);
    expect(sessionB.messages).toHaveLength(1);

    expect(sessionB.panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: requestB.requestId,
      ok: true,
      sourceHash: 'session-b-hash',
      acceptedStyles: requestB.styles,
    })).toBe(true);
    expect(messagesOfType(sessionB.messages, 'saveStyles')).toHaveLength(2);
    expect(messagesOfType(sessionB.messages, 'saveStyles').at(-1)).toMatchObject({
      requestId: 'webview-session-b:style-save-2',
      sourceHash: 'session-b-hash',
    });
    expect(sessionB.messages).toContainEqual({ type: 'styleSaveResultAck', requestId: requestB.requestId });
  });

  test('coalesces drafts without assigning an ID until a matching explicit result advances the source hash', () => {
    const { panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();

    changeControlValue(nameInput, 'First queued edit', 'input');
    const first = messages.at(-1) as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
      sourceHash: string;
    };
    changeControlValue(nameInput, 'Latest queued edit', 'input');

    expect(messages).toHaveLength(1);
    expect(first.requestId).toBe('test-style-session:style-save-1');
    expect(first.sourceHash).toBe('displayed-source-hash');
    expect(first.styles.find((style) => style.className === 'dc-all-muted')?.name).toBe('First queued edit');

    // A clean watcher/styleState push with the exact submitted styles is not an
    // acknowledgement and must not release the queued draft.
    const firstPersisted = parseAuthorStyles(serializeAuthorStyles(first.styles));
    setStyleState({
      styles: firstPersisted,
      cssText: serializeAuthorStyles(firstPersisted),
      writable: true,
      sourceHash: 'hash-after-first-queued-save',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);
    expect(messages).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: 'unrelated-old-request',
      ok: true,
      sourceHash: 'must-not-be-used',
    })).toBe(false);
    expect(messages).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'hash-after-first-queued-save',
      acceptedStyles: firstPersisted,
    })).toBe(true);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(2);
    const second = messagesOfType(messages, 'saveStyles').at(-1) as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
      sourceHash: string;
    };
    expect(second.requestId).toBe('test-style-session:style-save-2');
    expect(second.sourceHash).toBe('hash-after-first-queued-save');
    expect(second.styles.find((style) => style.className === 'dc-all-muted')?.name).toBe('Latest queued edit');

    // A duplicate/late result for request 1 cannot acknowledge request 2.
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: false,
      error: 'late failure',
    })).toBe(false);
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: second.requestId,
      ok: true,
      sourceHash: 'hash-after-latest-queued-save',
      acceptedStyles: second.styles,
    })).toBe(true);
    changeControlValue(nameInput, 'Edit after both acknowledgements', 'input');

    expect(messages.at(-1)).toMatchObject({
      type: 'saveStyles',
      requestId: 'test-style-session:style-save-3',
      sourceHash: 'hash-after-latest-queued-save',
    });
  });

  test('a forced panel rebuild keeps the in-flight correlation and releases the latest queued draft', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'First edit before rebuild', 'input');
    changeControlValue(nameInput, 'Latest edit before rebuild', 'input');
    const first = messages[0] as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };
    expect(messages).toHaveLength(1);

    panel.refresh(true);
    expect(panel.panel.querySelector('form')).not.toBe(form);
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'hash-after-rebuilt-form-save',
      acceptedStyles: first.styles,
    })).toBe(true);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(2);
    expect(messagesOfType(messages, 'saveStyles').at(-1)).toMatchObject({
      type: 'saveStyles',
      requestId: 'test-style-session:style-save-2',
      sourceHash: 'hash-after-rebuilt-form-save',
    });
    expect((messagesOfType(messages, 'saveStyles').at(-1) as unknown as { styles: typeof DEFAULT_AUTHOR_STYLES }).styles
      .find((style) => style.className === 'dc-all-muted')?.name).toBe('Latest edit before rebuild');
  });

  test('editing form B cannot cancel form A before A is durably queued', () => {
    const timers = makeDeferredTimers();
    const { panel, messages } = loadHelper({ windowExtras: timers.windowExtras });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Durable form A edit', 'input');

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(timers.pendingCount()).toBe(0);
    const submitted = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    buttonByLabel(panel.panel, 'Collapse editor for Muted element').click();
    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Expand editor for Display title').click();
    form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Durable form B edit', 'input');

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(timers.pendingCount()).toBe(0);
    timers.runAll();
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-after-durable-form-a',
      acceptedStyles: submitted.styles,
    })).toBe(true);
    const combined = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(combined.styles.find((style) => style.className === 'dc-all-muted')?.name)
      .toBe('Durable form A edit');
    expect(combined.styles.find((style) => style.className === 'dc-title-display')?.name)
      .toBe('Durable form B edit');
  });

  test('an edit survives iframe reload without waiting for a deferred autosave timer', () => {
    const timers = makeDeferredTimers();
    const vscodeState = {
      value: { unrelatedPanelState: { expanded: true } } as Record<string, unknown> | undefined,
    };
    const firstFrame = loadHelper({
      saveRequestSessionId: 'pre-timer-frame',
      vscodeState,
      windowExtras: timers.windowExtras,
    });
    expandGroup(firstFrame.panel.panel, 'All elements');
    buttonByLabel(firstFrame.panel.panel, 'Expand editor for Muted element').click();
    const form = firstFrame.panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Reload-safe immediate edit', 'input');

    const submitted = messagesOfType(firstFrame.messages, 'saveStyles')[0] as {
      requestId: string;
      sourceHash: string;
      targetToken: string;
    };
    expect(submitted).toMatchObject({
      requestId: 'pre-timer-frame:style-save-1',
      sourceHash: 'displayed-source-hash',
      targetToken: 'target-token-a',
    });
    expect(timers.pendingCount()).toBe(0);
    expect(vscodeState.value!.unrelatedPanelState).toEqual({ expanded: true });

    const reloaded = loadHelper({
      saveRequestSessionId: 'post-timer-frame',
      vscodeState,
    });
    expect(reloaded.messages).toEqual([{
      type: 'resumeStyleSave',
      requestId: submitted.requestId,
    }]);
    expect(vscodeState.value!.unrelatedPanelState).toEqual({ expanded: true });
  });

  test('the same immediate draft is not queued twice when a control fires input then change', () => {
    const { panel, messages } = loadHelper();
    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const input = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(input, 'One immediate draft', 'input');
    input.dispatch('change', { target: input });
    const submitted = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-after-one-immediate-draft',
      acceptedStyles: submitted.styles,
    })).toBe(true);
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
  });

  test('a stale rebuilt form patches its changed field without erasing another accepted field', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form')!;
    const firstName = form.querySelectorAll('input')[0] as TestElement;
    changeControlValue(firstName, 'Accepted name from first form', 'input');
    const submitted = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    panel.refresh(true);
    form = panel.panel.querySelector('form')!;
    const weight = form.querySelectorAll('select')
      .find((select) => select.getAttribute('aria-label') === 'Weight') as TestElement;
    changeControlValue(weight, '700');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-after-accepted-name',
      acceptedStyles: submitted.styles,
    })).toBe(true);

    const rebased = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(rebased.styles.find((style) => style.className === 'dc-all-muted')).toMatchObject({
      name: 'Accepted name from first form',
      fontWeight: '700',
    });
  });

  test('queued edits to a second style rebase onto the first accepted style instead of overwriting it', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const mutedName = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(mutedName, 'Accepted muted edit', 'input');
    const first = messages[0] as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };

    buttonByLabel(panel.panel, 'Collapse editor for Muted element').click();
    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Expand editor for Display title').click();
    const titleName = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(titleName, 'Queued title edit', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'hash-after-muted-edit',
      acceptedStyles: first.styles,
    })).toBe(true);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(2);
    const rebased = messagesOfType(messages, 'saveStyles').at(-1) as unknown as { styles: typeof DEFAULT_AUTHOR_STYLES; sourceHash: string };
    expect(rebased.sourceHash).toBe('hash-after-muted-edit');
    expect(rebased.styles.find((style) => style.className === 'dc-all-muted')?.name).toBe('Accepted muted edit');
    expect(rebased.styles.find((style) => style.className === 'dc-title-display')?.name).toBe('Queued title edit');
  });

  test('a distinct stale form opened before A succeeds cannot pair H1 with an H0-plus-B payload', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Accepted style A', 'input');
    const requestA = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    buttonByLabel(panel.panel, 'Collapse editor for Muted element').click();
    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Expand editor for Display title').click();
    form = panel.panel.querySelector('form')!;
    const staleFormBName = form.querySelectorAll('input')[0] as TestElement;
    staleFormBName.focus();

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: requestA.requestId,
      ok: true,
      sourceHash: 'accepted-h1-hash',
      acceptedStyles: requestA.styles,
    })).toBe(true);
    changeControlValue(staleFormBName, 'Edited style B after A succeeded', 'input');

    const requestB = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(requestB.sourceHash).toBe('accepted-h1-hash');
    expect(requestB.styles.find((style) => style.className === 'dc-all-muted')?.name)
      .toBe('Accepted style A');
    expect(requestB.styles.find((style) => style.className === 'dc-title-display')?.name)
      .toBe('Edited style B after A succeeded');
  });

  test('a same-style stale form patches H1 after the earlier form succeeds', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Accepted same-style name', 'input');
    const first = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    panel.refresh(true);
    form = panel.panel.querySelector('form')!;
    const staleWeight = form.querySelectorAll('select')
      .find((select) => select.getAttribute('aria-label') === 'Weight') as TestElement;
    staleWeight.focus();
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'accepted-same-style-h1',
      acceptedStyles: first.styles,
    })).toBe(true);
    changeControlValue(staleWeight, '700');

    const second = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(second.sourceHash).toBe('accepted-same-style-h1');
    expect(second.styles.find((style) => style.className === 'dc-all-muted')).toMatchObject({
      name: 'Accepted same-style name',
      fontWeight: '700',
    });
  });

  test('renaming A to B cannot redirect a fresh reused-A form back onto B', () => {
    const originalA = { className: 'dc-a', name: 'Original A', target: 'all' as const };
    const { panel, messages, setStyleState } = loadHelper({ styles: [originalA] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    let form = panel.panel.querySelector('form')!;
    const renameInputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    renameInputs[0].value = 'Renamed B';
    changeControlValue(renameInputs[1], 'dc-b', 'input');
    const rename = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: rename.requestId,
      ok: true,
      sourceHash: 'hash-after-a-to-b',
      acceptedStyles: rename.styles,
    })).toBe(true);
    setStyleState({
      styles: rename.styles,
      cssText: serializeAuthorStyles(rename.styles),
      writable: true,
      sourceHash: 'hash-after-a-to-b',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);

    buttonByText(panel.panel, 'New').click();
    form = panel.panel.querySelector('form')!;
    const createInputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    createInputs[0].value = 'Reused A';
    changeControlValue(createInputs[1], 'dc-a', 'input');
    const create = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: create.requestId,
      ok: true,
      sourceHash: 'hash-after-reused-a',
      acceptedStyles: create.styles,
    })).toBe(true);
    setStyleState({
      styles: create.styles,
      cssText: serializeAuthorStyles(create.styles),
      writable: true,
      sourceHash: 'hash-after-reused-a',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);

    form = panel.panel.querySelector('form')!;
    const reusedAName = form.querySelectorAll('input')[0] as TestElement;
    changeControlValue(reusedAName, 'Edited reused A', 'input');
    const edit = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    expect(edit.sourceHash).toBe('hash-after-reused-a');
    expect(edit.styles.find((style) => style.className === 'dc-b')?.name).toBe('Renamed B');
    expect(edit.styles.find((style) => style.className === 'dc-a')?.name).toBe('Edited reused A');
  });

  test('the genuinely stale form that performed A-to-B continues editing B', () => {
    const originalA = { className: 'dc-a', name: 'Original A', target: 'all' as const };
    const { panel, messages } = loadHelper({ styles: [originalA] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    const form = panel.panel.querySelector('form')!;
    const inputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    changeControlValue(inputs[1], 'dc-b', 'input');
    const rename = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: rename.requestId,
      ok: true,
      sourceHash: 'hash-after-stale-a-to-b',
      acceptedStyles: rename.styles,
    })).toBe(true);

    changeControlValue(inputs[0], 'Edited through stale renamed form', 'input');
    const edit = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(edit.sourceHash).toBe('hash-after-stale-a-to-b');
    expect(edit.styles).toContainEqual(expect.objectContaining({
      className: 'dc-b',
      name: 'Edited through stale renamed form',
    }));
    expect(edit.styles.some((style) => style.className === 'dc-a')).toBe(false);
  });

  test('reused A edited behind an unrelated C save cannot inherit the original A-to-B lineage', () => {
    const originalA = { className: 'dc-a', name: 'Original A', target: 'all' as const };
    const unrelatedC = { className: 'dc-c', name: 'Unrelated C', target: 'all' as const };
    const { panel, messages, setStyleState } = loadHelper({ styles: [originalA, unrelatedC] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    let form = panel.panel.querySelector('form')!;
    const renameInputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    renameInputs[0].value = 'Renamed B';
    changeControlValue(renameInputs[1], 'dc-b', 'input');
    const rename = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: rename.requestId,
      ok: true,
      sourceHash: 'critic-h1',
      acceptedStyles: rename.styles,
    })).toBe(true);
    setStyleState({
      styles: rename.styles,
      cssText: serializeAuthorStyles(rename.styles),
      writable: true,
      sourceHash: 'critic-h1',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);

    buttonByText(panel.panel, 'New').click();
    form = panel.panel.querySelector('form')!;
    const createInputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    createInputs[0].value = 'Reused A';
    changeControlValue(createInputs[1], 'dc-a', 'input');
    const create = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: create.requestId,
      ok: true,
      sourceHash: 'critic-h2',
      acceptedStyles: create.styles,
    })).toBe(true);
    setStyleState({
      styles: create.styles,
      cssText: serializeAuthorStyles(create.styles),
      writable: true,
      sourceHash: 'critic-h2',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);

    buttonByLabel(panel.panel, 'Collapse editor for Reused A').click();
    buttonByLabel(panel.panel, 'Expand editor for Unrelated C').click();
    form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Accepted C change', 'input');
    const requestC = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Expand editor for Reused A').click();
    form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Edited reused A behind C', 'input');
    expect(messagesOfType(messages, 'saveStyles').at(-1)?.requestId).toBe(requestC.requestId);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: requestC.requestId,
      ok: true,
      sourceHash: 'critic-h3',
      acceptedStyles: requestC.styles,
    })).toBe(true);
    const released = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(released.sourceHash).toBe('critic-h3');
    expect(released.styles.find((style) => style.className === 'dc-b')?.name).toBe('Renamed B');
    expect(released.styles.find((style) => style.className === 'dc-a')?.name)
      .toBe('Edited reused A behind C');
    expect(released.styles.find((style) => style.className === 'dc-c')?.name).toBe('Accepted C change');
  });

  test('two rapid New forms from H0 remain distinct create intents after X succeeds', () => {
    const { panel, messages } = loadHelper({ styles: [] });

    buttonByText(panel.panel, 'New').click();
    let form = panel.panel.querySelector('form')!;
    let inputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    inputs[0].value = 'Created X';
    changeControlValue(inputs[1], 'dc-x', 'input');
    const requestX = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    buttonByText(panel.panel, 'New').click();
    form = panel.panel.querySelector('form')!;
    inputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    inputs[0].value = 'Created Y';
    changeControlValue(inputs[1], 'dc-y', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: requestX.requestId,
      ok: true,
      sourceHash: 'hash-after-created-x',
      acceptedStyles: requestX.styles,
    })).toBe(true);
    const releasedY = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(releasedY.sourceHash).toBe('hash-after-created-x');
    expect(releasedY.styles).toContainEqual(expect.objectContaining({
      className: 'dc-x',
      name: 'Created X',
    }));
    expect(releasedY.styles).toContainEqual(expect.objectContaining({
      className: 'dc-y',
      name: 'Created Y',
    }));
  });

  test('an exact A-to-B-to-A hash cycle gives a reopened A form fresh lineage', () => {
    const originalA = { className: 'dc-a', name: 'Original A', target: 'all' as const };
    const { panel, messages, setStyleState } = loadHelper({ styles: [originalA] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    let form = panel.panel.querySelector('form')!;
    let classInput = form.querySelectorAll('input')[1] as TestElement;
    changeControlValue(classInput, 'dc-b', 'input');
    const toB = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: toB.requestId,
      ok: true,
      sourceHash: 'aba-h1',
      acceptedStyles: toB.styles,
    })).toBe(true);
    setStyleState({
      styles: toB.styles,
      cssText: serializeAuthorStyles(toB.styles),
      writable: true,
      sourceHash: 'aba-h1',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);

    form = panel.panel.querySelector('form')!;
    classInput = form.querySelectorAll('input')[1] as TestElement;
    changeControlValue(classInput, 'dc-a', 'input');
    const backToA = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: backToA.requestId,
      ok: true,
      sourceHash: 'displayed-source-hash',
      acceptedStyles: backToA.styles,
    })).toBe(true);
    setStyleState({
      styles: backToA.styles,
      cssText: serializeAuthorStyles(backToA.styles),
      writable: true,
      sourceHash: 'displayed-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);
    buttonByLabel(panel.panel, 'Collapse editor for Original A').click();
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();

    form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'Edited fresh ABA A', 'input');
    const editA = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(editA.sourceHash).toBe('displayed-source-hash');
    expect(editA.styles).toContainEqual(expect.objectContaining({
      className: 'dc-a',
      name: 'Edited fresh ABA A',
    }));
    expect(editA.styles.some((style) => style.className === 'dc-b')).toBe(false);
  });

  test('queued A-to-B rename and a rebuilt stale A field edit coalesce before H1 releases them', () => {
    const originalA = { className: 'dc-a', name: 'Original A', target: 'all' as const };
    const { panel, messages } = loadHelper({ styles: [originalA] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    let form = panel.panel.querySelector('form')!;
    let inputs = form.querySelectorAll('input') as Array<TestElement & { value: string }>;
    changeControlValue(inputs[0], 'Accepted H1 name', 'input');
    const h1 = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    changeControlValue(inputs[1], 'dc-b', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    buttonByLabel(panel.panel, 'Collapse editor for Original A').click();
    buttonByLabel(panel.panel, 'Expand editor for Original A').click();
    form = panel.panel.querySelector('form')!;
    const staleWeight = form.querySelectorAll('select')
      .find((select) => select.getAttribute('aria-label') === 'Weight') as TestElement;
    changeControlValue(staleWeight, '700');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: h1.requestId,
      ok: true,
      sourceHash: 'hash-after-h1-name',
      acceptedStyles: h1.styles,
    })).toBe(true);
    const released = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      sourceHash: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(released.sourceHash).toBe('hash-after-h1-name');
    expect(released.styles).toContainEqual(expect.objectContaining({
      className: 'dc-b',
      name: 'Accepted H1 name',
      fontWeight: '700',
    }));
    expect(released.styles.some((style) => style.className === 'dc-a')).toBe(false);
    expect(form.textContent).not.toContain('could not be safely combined');
  });

  test('a reloaded webview resumes the exact persisted request before releasing its latest draft', () => {
    const vscodeState = { value: undefined as Record<string, unknown> | undefined };
    const firstFrame = loadHelper({ saveRequestSessionId: 'webview-session-before-reload', vscodeState });
    expandGroup(firstFrame.panel.panel, 'All elements');
    buttonByLabel(firstFrame.panel.panel, 'Expand editor for Muted element').click();
    const firstInput = firstFrame.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(firstInput, 'First frame submitted edit', 'input');
    changeControlValue(firstInput, 'Latest draft survives reload', 'input');
    const submitted = firstFrame.messages[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(submitted.requestId).toBe('webview-session-before-reload:style-save-1');

    const reloaded = loadHelper({ saveRequestSessionId: 'webview-session-after-reload', vscodeState });
    expect(reloaded.messages).toEqual([{
      type: 'resumeStyleSave',
      requestId: submitted.requestId,
    }]);
    expect(reloaded.panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: 'some-other-old-session:style-save-1',
      ok: true,
      sourceHash: 'unrelated-hash',
      acceptedStyles: submitted.styles,
    })).toBe(false);

    expect(reloaded.panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-after-restored-request',
      acceptedStyles: submitted.styles,
    })).toBe(true);

    expect(reloaded.messages).toContainEqual({
      type: 'styleSaveResultAck',
      requestId: submitted.requestId,
    });
    const resumedSave = reloaded.messages.find((message) =>
      (message as { type?: string }).type === 'saveStyles') as {
        requestId: string;
        sourceHash: string;
        targetToken: string;
        styles: typeof DEFAULT_AUTHOR_STYLES;
      };
    expect(resumedSave).toMatchObject({
      requestId: 'webview-session-after-reload:style-save-1',
      sourceHash: 'hash-after-restored-request',
      targetToken: 'target-token-a',
    });
    expect(resumedSave.styles.find((style) => style.className === 'dc-all-muted')?.name)
      .toBe('Latest draft survives reload');
  });

  test('pending mutations coalesce per style without dropping edits queued for another style', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let nameInput = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Submitted muted edit', 'input');
    changeControlValue(nameInput, 'First queued muted edit', 'input');
    const submitted = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    buttonByLabel(panel.panel, 'Collapse editor for Muted element').click();
    expandGroup(panel.panel, 'Topic title');
    buttonByLabel(panel.panel, 'Expand editor for Display title').click();
    nameInput = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Queued title edit', 'input');

    buttonByLabel(panel.panel, 'Collapse editor for Display title').click();
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    nameInput = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Latest queued muted edit', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-after-submitted-muted-edit',
      acceptedStyles: submitted.styles,
    })).toBe(true);

    const combined = messagesOfType(messages, 'saveStyles').at(-1) as unknown as {
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };
    expect(combined.styles.find((style) => style.className === 'dc-all-muted')?.name)
      .toBe('Latest queued muted edit');
    expect(combined.styles.find((style) => style.className === 'dc-title-display')?.name)
      .toBe('Queued title edit');
  });

  test('restores and resumes a persisted request with the maximum 16-digit sequence', () => {
    const vscodeState = { value: undefined as Record<string, unknown> | undefined };
    const firstFrame = loadHelper({ saveRequestSessionId: 'trusted-session', vscodeState });
    expandGroup(firstFrame.panel.panel, 'All elements');
    buttonByLabel(firstFrame.panel.panel, 'Expand editor for Muted element').click();
    const nameInput = firstFrame.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Persist a resumable request', 'input');

    const persisted = vscodeState.value!.ditaeditorStyleSaveController as {
      inFlight: { requestId: string; requestSessionId: string };
    };
    persisted.inFlight.requestSessionId = 'previous-session';
    persisted.inFlight.requestId = 'previous-session:style-save-9999999999999999';

    const reloaded = loadHelper({ saveRequestSessionId: 'new-session', vscodeState });

    expect(reloaded.messages).toEqual([{
      type: 'resumeStyleSave',
      requestId: 'previous-session:style-save-9999999999999999',
    }]);
  });

  test('rejects and clears a persisted 17-digit request without losing unrelated state or blocking edits', () => {
    const vscodeState = { value: undefined as Record<string, unknown> | undefined };
    const firstFrame = loadHelper({ saveRequestSessionId: 'trusted-session', vscodeState });
    expandGroup(firstFrame.panel.panel, 'All elements');
    buttonByLabel(firstFrame.panel.panel, 'Expand editor for Muted element').click();
    const firstInput = firstFrame.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(firstInput, 'Persist a request to corrupt', 'input');

    vscodeState.value!.unrelatedPanelState = { expanded: true };
    const persisted = vscodeState.value!.ditaeditorStyleSaveController as {
      inFlight: { requestId: string; requestSessionId: string };
    };
    persisted.inFlight.requestSessionId = 'previous-session';
    persisted.inFlight.requestId = 'previous-session:style-save-99999999999999999';

    const reloaded = loadHelper({ saveRequestSessionId: 'new-session', vscodeState });

    expect(reloaded.messages).toHaveLength(0);
    expect(vscodeState.value).toEqual({ unrelatedPanelState: { expanded: true } });

    expandGroup(reloaded.panel.panel, 'All elements');
    buttonByLabel(reloaded.panel.panel, 'Expand editor for Muted element').click();
    const reloadedInput = reloaded.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(reloadedInput, 'A fresh request is not blocked', 'input');

    expect(messagesOfType(reloaded.messages, 'saveStyles')).toEqual([expect.objectContaining({
      requestId: 'new-session:style-save-1',
    })]);
    expect(vscodeState.value!.unrelatedPanelState).toEqual({ expanded: true });
  });

  test('malformed persisted correlation cannot weaken the per-frame request barrier', () => {
    const vscodeState = { value: undefined as Record<string, unknown> | undefined };
    const firstFrame = loadHelper({ saveRequestSessionId: 'trusted-session', vscodeState });
    expandGroup(firstFrame.panel.panel, 'All elements');
    buttonByLabel(firstFrame.panel.panel, 'Expand editor for Muted element').click();
    const nameInput = firstFrame.panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Persist a real request', 'input');

    const persisted = vscodeState.value!.ditaeditorStyleSaveController as {
      inFlight: { requestId: string; requestSessionId: string };
    };
    persisted.inFlight.requestId = 'untrusted-session:style-save-1';
    const reloaded = loadHelper({ saveRequestSessionId: 'new-session', vscodeState });

    expect(reloaded.messages).toHaveLength(0);
    expect(reloaded.panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: 'untrusted-session:style-save-1',
      ok: true,
      sourceHash: 'untrusted-hash',
      acceptedStyles: DEFAULT_AUTHOR_STYLES,
    })).toBe(false);
  });

  test('a malformed success without accepted styles drops queued work and blocks the mounted form', () => {
    const { panel, messages } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form')!;
    const nameInput = form.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Submitted edit', 'input');
    changeControlValue(nameInput, 'Queued edit must be dropped', 'input');
    const submitted = messagesOfType(messages, 'saveStyles')[0] as { requestId: string };

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'hash-without-accepted-styles',
    })).toBe(true);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(messages).toContainEqual({ type: 'styleSaveResultAck', requestId: submitted.requestId });
    expect(form.textContent).toContain('accepted stylesheet snapshot');
    changeControlValue(nameInput, 'Still blocked', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
  });

  test('does not post a style save until the host supplies a non-empty target token', () => {
    const { panel, messages, setStyleState } = loadHelper();
    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'displayed-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
      targetToken: '',
    });
    panel.refresh(true);
    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form')!;
    changeControlValue(form.querySelectorAll('input')[0] as TestElement, 'No unbound save', 'input');

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(0);
    expect(form.textContent).toContain('has not finished identifying the active managed stylesheet');
  });

  test('a matching explicit failure drops queued drafts and requires a clean form reload before saving again', () => {
    const { panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form');
    let nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    changeControlValue(nameInput, 'Refused first edit', 'input');
    changeControlValue(nameInput, 'Queued draft that must be dropped', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    const refused = messages[0] as { requestId: string };

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'external-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(form!.textContent).not.toContain('The stylesheet changed on disk. Reload before saving.');

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: refused.requestId,
      ok: false,
      error: 'The stylesheet changed on disk. Reload before saving.',
    })).toBe(true);
    expect(form!.textContent).toContain('The stylesheet changed on disk. Reload before saving.');

    changeControlValue(nameInput, 'Still blocked', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'external-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(true);
    form = panel.panel.querySelector('form');
    nameInput = form!.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Accepted after reload', 'input');

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(2);
    expect(messagesOfType(messages, 'saveStyles').at(-1)).toMatchObject({
      type: 'saveStyles',
      requestId: 'test-style-session:style-save-2',
      sourceHash: 'external-hash',
    });
  });

  test('a clean same-signature target-B state cannot release a queued target-A draft before A fails', () => {
    const { panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form');
    const nameInput = form!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    changeControlValue(nameInput, 'Same styles on both targets', 'input');
    const submitted = messages.at(-1) as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };
    changeControlValue(nameInput, 'Queued edit must not cross targets', 'input');
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);

    const matchingStyles = parseAuthorStyles(serializeAuthorStyles(submitted.styles));
    setStyleState({
      styles: matchingStyles,
      cssText: serializeAuthorStyles(matchingStyles),
      writable: true,
      sourceHash: 'new-target-hash',
      cssPath: '/workspace/css/reconfigured-author-styles.css',
    });
    panel.refresh(false);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(form!.textContent).not.toContain('The active managed stylesheet changed');
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: false,
      error: 'The active managed stylesheet changed while the save was completing.',
    })).toBe(true);
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(form!.textContent).toContain('The active managed stylesheet changed');
  });

  test('a target-A success does not release its queued draft after generic state switches to target B', () => {
    const { panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    const form = panel.panel.querySelector('form')!;
    const nameInput = form.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    changeControlValue(nameInput, 'Target A submitted edit', 'input');
    changeControlValue(nameInput, 'Target A queued edit', 'input');
    const submitted = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
    };

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'displayed-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
      targetToken: 'target-token-b',
    });
    panel.refresh(false);

    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: submitted.requestId,
      ok: true,
      sourceHash: 'target-a-result-hash',
      acceptedStyles: submitted.styles,
    })).toBe(true);

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(messages).toContainEqual({ type: 'styleSaveResultAck', requestId: submitted.requestId });
    expect(form.textContent).toContain('active managed stylesheet changed');
  });

  test('a rebuilt target-B form cannot queue a stale full snapshot behind target A', () => {
    const { panel, messages, setStyleState } = loadHelper();

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Muted element').click();
    let form = panel.panel.querySelector('form')!;
    let nameInput = form.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Target A accepted edit', 'input');
    const targetA = messagesOfType(messages, 'saveStyles')[0] as {
      requestId: string;
      styles: typeof DEFAULT_AUTHOR_STYLES;
      targetToken: string;
    };
    expect(targetA.targetToken).toBe('target-token-a');

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: serializeAuthorStyles(DEFAULT_AUTHOR_STYLES),
      writable: true,
      sourceHash: 'displayed-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
      targetToken: 'target-token-b',
    });
    panel.refresh(true);
    form = panel.panel.querySelector('form')!;
    nameInput = form.querySelectorAll('input')[0] as TestElement;
    changeControlValue(nameInput, 'Must not cross into target A', 'input');

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
    expect(form.textContent).toContain('active managed stylesheet changed');
    expect(panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: targetA.requestId,
      ok: true,
      sourceHash: 'target-a-result-hash',
      acceptedStyles: targetA.styles,
    })).toBe(true);
    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(1);
  });

  test('a reordered generic styleState cannot impersonate an own-save acknowledgement', () => {
    const preset = { className: 'dc-preset', name: 'Preset', target: 'all' as const, color: '#123456' };
    const shippedDefault = {
      className: 'dc-default-heading',
      name: 'Base heading',
      target: 'heading' as const,
      isDefault: true,
      color: '#222222',
    };
    const { panel, messages, setStyleState } = loadHelper({ styles: [preset, shippedDefault] });

    expandGroup(panel.panel, 'All elements');
    buttonByLabel(panel.panel, 'Expand editor for Preset').click();
    const nameInput = panel.panel.querySelector('form')!.querySelectorAll('input')[0] as TestElement;
    nameInput.focus();
    changeControlValue(nameInput, 'First preset edit', 'input');
    const first = messages.at(-1) as { requestId: string; styles: typeof DEFAULT_AUTHOR_STYLES };
    const persistedStyles = parseAuthorStyles(serializeAuthorStyles(first.styles));
    expect(persistedStyles[0].isDefault).toBe(true);

    setStyleState({
      styles: persistedStyles,
      cssText: serializeAuthorStyles(persistedStyles),
      writable: true,
      sourceHash: 'hash-after-reordered-save',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);
    changeControlValue(nameInput, 'Second preset edit', 'input');
    expect(messages).toHaveLength(1);

    panel.acceptSaveResult({
      type: 'styleSaveResult',
      requestId: first.requestId,
      ok: true,
      sourceHash: 'hash-after-reordered-save',
      acceptedStyles: persistedStyles,
    });

    expect(messagesOfType(messages, 'saveStyles')).toHaveLength(2);
    expect(messagesOfType(messages, 'saveStyles').at(-1)).toMatchObject({
      requestId: 'test-style-session:style-save-2',
      sourceHash: 'hash-after-reordered-save',
    });
  });

  test('renders all 18 element kinds even when no styles exist', () => {
    const { panel } = loadHelper({ styles: [] });

    const groups = panel.panel.querySelectorAll('.style-target-group');
    expect(groups).toHaveLength(19); // 18 element kinds + the Page group
    expect(panel.panel.querySelectorAll('.style-page-group')).toHaveLength(1);
    expect(panel.panel.textContent).toContain('Paragraph (0)');
    expect(panel.panel.textContent).toContain('List item (0)');
    expandGroup(panel.panel, 'Note'); // groups render collapsed; the empty note lives in the body
    expect(panel.panel.textContent).toContain('No styles yet.');
  });

  test('the per-group add button opens the create form pre-targeted to that kind', () => {
    const { panel, messages } = loadHelper({ styles: [] });

    buttonByLabel(panel.panel, 'Add Note style').click();

    expect(messages).toHaveLength(0);
    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    const target = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Target') as TestElement & { value: string };
    expect(target.value).toBe('note');
  });

  test('every kind shows a base row; editing it saves an isDefault style without class or target controls', () => {
    const { panel, messages } = loadHelper({ styles: [] });

    expandAllGroups(panel.panel);
    const baseRows = panel.panel.querySelectorAll('.style-base-wrap');
    // page + 17 kinds (all 18 except the 'all' pseudo-kind) + 2 structural variant rows
    // (table: single column, empty caption). Zebra is now an applied preset, not a base row.
    expect(baseRows).toHaveLength(20);
    expect(panel.panel.textContent).toContain('DITA Editor surface stylesheet');

    buttonByLabel(panel.panel, 'Expand base style editor for Paragraph').click();

    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    expect(form!.querySelectorAll('input').some((input) => input.getAttribute('aria-label') === 'Class')).toBe(false);
    expect(form!.querySelectorAll('input').some((input) => input.getAttribute('aria-label') === 'Name')).toBe(true);
    expect(form!.querySelectorAll('input').filter((input) =>
      (input as TestElement & { type?: string }).type === 'color'
    )).toHaveLength(3);
    expect(form!.querySelectorAll('select').some((s) => s.getAttribute('aria-label') === 'Target')).toBe(false);

    const weight = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Weight') as TestElement & { value: string };
    changeControlValue(weight, '700');

    const last = messages.at(-1) as { type: string; styles: Array<Record<string, unknown>> };
    expect(last.type).toBe('saveStyles');
    expect(last.styles.at(-1)).toMatchObject({
      className: 'dc-default-body',
      target: 'body',
      isDefault: true,
      fontWeight: '700',
    });
  });

  test('clicking a base row clears the applied style; the caret edits without applying', () => {
    const baseStyle = { className: 'dc-default-body', name: 'Base paragraph', target: 'body', isDefault: true, fontWeight: '600' };
    const { panel, messages } = loadHelper({ styles: [...DEFAULT_AUTHOR_STYLES, baseStyle] });

    expandGroup(panel.panel, 'Paragraph');
    expect(panel.panel.textContent).toContain('Base paragraph');
    // The default must not render as an applyable preset row.
    expect(panel.panel.querySelectorAll('button').some((b) => b.getAttribute('aria-label') === 'Apply Base paragraph')).toBe(false);
    expect(panel.panel.textContent).toContain('Paragraph (1)'); // count excludes the base style

    // Clicking the base row's meta posts a CLEAR (className '') to the selection —
    // reverting it to the always-on base look — and does NOT open the editor form.
    buttonByLabel(panel.panel, 'Apply base style for Paragraph').click();

    const clearMessages = messages.filter((m) => (m as { type: string }).type === 'clearStyle');
    expect(clearMessages).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'clearStyle', ids: ['e1'], styleTarget: 'body', baseStructVersion: 0,
    });
    expect(panel.panel.querySelector('form')).toBeNull();

    // The caret is the only thing that expands the base editor, and it applies nothing.
    buttonByLabel(panel.panel, 'Expand base style editor for Paragraph').click();

    expect(messages.filter((m) => (m as { type: string }).type === 'clearStyle')).toHaveLength(1); // unchanged by the caret
    expect(panel.panel.querySelector('form')).toBeInstanceOf(TestElement);
  });

  test('preset class names may not squat the reserved dc-default- namespace', () => {
    const { panel, messages } = loadHelper();

    buttonByText(panel.panel, 'New').click();
    const inputs = panel.panel.querySelectorAll('input');
    (inputs[0] as TestElement & { value: string }).value = 'Sneaky';
    (inputs[1] as TestElement & { value: string }).value = 'dc-default-title';
    changeControlValue(inputs[1], 'dc-default-title', 'input');

    expect(messages.filter((m) => (m as { type: string }).type === 'saveStyles')).toHaveLength(0);
    const form = panel.panel.querySelector('form');
    expect(form!.textContent).toContain('reserved for base styles');
  });

  test('single selection shows an effective-styles inspector with model-based provenance', () => {
    const baseStyle = { className: 'dc-default-title', name: 'Base topic title', target: 'title', isDefault: true, letterSpacing: '.02em' };
    const computedValues: Record<string, string> = {
      'font-size': '34px',
      'font-weight': '700',
      'color': 'rgb(27, 41, 50)',
      'background-color': 'rgba(0, 0, 0, 0)',
      'border-left-color': 'rgb(27, 41, 50)',
      'text-transform': 'none',
      'letter-spacing': '0.26px',
      'margin-top': '0px',
      'margin-bottom': '18px',
    };
    const fakeElement = { id: 'e1' };
    const { panel } = loadHelper({
      // This fixture exercises the provenance mechanism with a title base that defines
      // letterSpacing; replace the real dc-default-title (which has no letterSpacing) so the
      // fixture is the effective base rather than being dropped as a duplicate class.
      styles: [...DEFAULT_AUTHOR_STYLES.filter((s) => s.className !== baseStyle.className), baseStyle],
      windowExtras: {
        getComputedStyle: (el: unknown) => {
          expect(el).toBe(fakeElement);
          return { getPropertyValue: (prop: string) => computedValues[prop] ?? '' };
        },
      },
      installExtras: {
        resolveElement: (id: string) => (id === 'e1' ? fakeElement : null),
      },
    });

    const inspector = panel.panel.querySelector('.style-inspector');
    expect(inspector).toBeInstanceOf(TestElement);
    const rows = inspector!.querySelectorAll('.style-inspect-row');
    expect(rows).toHaveLength(9);
    expect(panel.panel.textContent).toContain('<title>');
    expect(inspector!.textContent).toContain('34px');

    expect(inspector!.querySelector('.style-source-summary')?.textContent)
      .toBe('DITA Editor surface stylesheet');
    const rowFor = (label: string) => rows.find((row) => row.children[0]?.textContent === label);
    // Model-owned values retain field-level provenance.
    expect(rowFor('Size')?.querySelector('.style-inspect-prov')?.textContent)
      .toBe('managed author stylesheet');
    expect(rowFor('Tracking')?.querySelector('.style-inspect-prov')?.textContent)
      .toBe('managed author stylesheet');
    // UA/inherited values can be computed without being owned by any loaded stylesheet.
    expect(rowFor('Case')?.querySelector('.style-inspect-prov')).toBeNull();
    expect(rowFor('Fill')?.querySelector('.style-inspect-prov')).toBeNull();
  });

  test('style editor empty choices show the actual inherited value instead of a bare "Default"', () => {
    const sampleParagraph = { tag: 'p' };
    const computedValues: Record<string, string> = {
      'font-size': '16px',
      'font-weight': '400',
      'color': 'rgb(37, 50, 58)',
      'background-color': 'rgba(0, 0, 0, 0)',
      'border-left-color': 'rgb(37, 50, 58)',
      'text-transform': 'none',
      'letter-spacing': 'normal',
      'margin-top': '0px',
      'margin-bottom': '12px',
    };
    const { panel } = loadHelper({
      styles: [],
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => computedValues[prop] ?? '' }),
      },
      installExtras: { sampleElement: () => sampleParagraph },
    });

    expandGroup(panel.panel, 'Paragraph');
    buttonByLabel(panel.panel, 'Expand base style editor for Paragraph').click();

    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    const selects = form!.querySelectorAll('select');
    const emptyOptionOf = (label: string) => {
      const select = selects.find((s) => s.getAttribute('aria-label') === label);
      expect(select).toBeInstanceOf(TestElement);
      return select!.querySelectorAll('option')[0].textContent;
    };
    expect(emptyOptionOf('Size')).toBe('16px (default)');
    expect(emptyOptionOf('Weight')).toBe('400 (default)');
    expect(emptyOptionOf('Text color preset')).toBe('#25323a (default)'); // rgb() shown as hex
    expect(emptyOptionOf('Fill color preset')).toBe('transparent (default)'); // rgba(0,0,0,0)
    expect(emptyOptionOf('After')).toBe('12px (default)');
  });

  test('empty choices fall back to "Default" when no value can be computed', () => {
    const { panel } = loadHelper({ styles: [] }); // window has no getComputedStyle

    expandGroup(panel.panel, 'Paragraph');
    buttonByLabel(panel.panel, 'Expand base style editor for Paragraph').click();

    const form = panel.panel.querySelector('form');
    const size = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Size');
    expect(size!.querySelectorAll('option')[0].textContent).toBe('Default');
  });

  test('a missing sample element degrades through the probe path without crashing', () => {
    // The fake DOM cannot parse the probe markup (innerHTML is not a parser here),
    // so mountProbe must bail out cleanly and the labels fall back to "Default".
    const { panel } = loadHelper({
      styles: [],
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: () => '99px' }),
      },
      installExtras: { sampleElement: () => null },
    });

    expandGroup(panel.panel, 'Section heading');
    buttonByLabel(panel.panel, 'Expand base style editor for Section heading').click();

    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    const size = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Size');
    expect(size!.querySelectorAll('option')[0].textContent).toBe('Default');
  });

  test('multi-selection and missing getComputedStyle render no inspector', () => {
    const multi = loadHelper({
      currentTarget: { ids: ['e1', 'e2'], kind: 'selection', label: '2 elements', outputclass: '' },
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: () => '12px' }),
      },
      installExtras: { resolveElement: () => ({}) },
    });
    expect(multi.panel.panel.querySelector('.style-inspector')).toBeNull();

    const noCompute = loadHelper();
    expect(noCompute.panel.panel.querySelector('.style-inspector')).toBeNull();
  });

  test('the Page group renders first as base-style-only: no add button, no preset target option', () => {
    const { panel } = loadHelper({ styles: [] });

    expandGroup(panel.panel, 'Page');
    const groups = panel.panel.querySelectorAll('.style-target-group');
    expect(groups[0].getAttribute('aria-label')).toBe('Page styles');
    expect(groups[0].querySelectorAll('.style-base-wrap')).toHaveLength(1);
    expect(panel.panel.querySelectorAll('button').some((b) => b.getAttribute('aria-label') === 'Add Page style')).toBe(false);

    // The create form's target dropdown must keep offering only the 18 element kinds.
    buttonByText(panel.panel, 'New').click();
    const form = panel.panel.querySelector('form');
    const target = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Target');
    expect(target!.querySelectorAll('option')).toHaveLength(18);
    expect(target!.querySelectorAll('option').some((o) => (o as TestElement & { value: string }).value === 'page')).toBe(false);
  });

  test('editing the Page base style shows exactly the 3 page fields and autosaves dc-default-page', () => {
    const { panel, messages } = loadHelper({ styles: [] });

    expandGroup(panel.panel, 'Page');
    buttonByLabel(panel.panel, 'Expand base style editor for Page').click();

    const form = panel.panel.querySelector('form');
    expect(form).toBeInstanceOf(TestElement);
    expect(form!.textContent).toContain('Page style — sets the document canvas');
    const valueControls = [
      ...form!.querySelectorAll('select'),
      ...form!.querySelectorAll('input'),
    ].filter((control) => control.getAttribute('data-style-field'));
    const controlLabels = valueControls.map((control) => control.getAttribute('aria-label'));
    // The Page group now also exposes the app-shell "site chrome" controls.
    expect(controlLabels).toContain('Page fill CSS color value');
    expect(controlLabels).toContain('Content width');
    expect(controlLabels).toContain('Table shadow');
    expect(controlLabels).toContain('Sidebar fill CSS color value');
    expect(controlLabels).toContain('Link hover CSS color value');
    // The masthead title is a free-text field, not a select.
    const titleInput = form!.querySelectorAll('input').find((i) => i.getAttribute('data-style-field') === 'mastheadTitle');
    expect(titleInput).toBeInstanceOf(TestElement);

    const width = form!.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Content width') as TestElement & { value: string };
    changeControlValue(width, '840px');

    const last = messages.at(-1) as { type: string; styles: Array<Record<string, unknown>> };
    expect(last.type).toBe('saveStyles');
    expect(last.styles.at(-1)).toMatchObject({
      className: 'dc-default-page',
      target: 'page',
      isDefault: true,
      contentWidth: '840px',
    });
    expect(last.styles.at(-1)).not.toHaveProperty('fontSize');
  });

  test('a re-enabled table shadow autosaves through the Page base style', () => {
    const { panel, messages } = loadHelper({ styles: [] });

    expandGroup(panel.panel, 'Page');
    buttonByLabel(panel.panel, 'Expand base style editor for Page').click();
    const form = panel.panel.querySelector('form');
    const shadow = form!.querySelectorAll('select')
      .find((s) => s.getAttribute('aria-label') === 'Table shadow') as TestElement & { value: string };
    changeControlValue(shadow, 'var(--dc-shadow-md, 0 6px 24px rgb(15 23 42 / 12%))');

    const last = messages.at(-1) as { type: string; styles: Array<Record<string, unknown>> };
    expect(last.styles.at(-1)).toMatchObject({
      className: 'dc-default-page',
      tableShadow: 'var(--dc-shadow-md, 0 6px 24px rgb(15 23 42 / 12%))',
    });
  });

  test('the inline width math honors --dc-page-content-width from the page style', () => {
    const { doc, panel } = loadHelper({
      windowExtras: {
        getComputedStyle: () => ({
          getPropertyValue: (prop: string) => (prop === '--dc-page-content-width' ? '840px' : ''),
        }),
      },
    });

    panel.showButton.click();

    expect(doc.main.style.paddingRight).toBe('308px');
    expect(doc.main.style.minWidth).toBe('1148px'); // 840px page width + 308px panel inset
    expect(doc.main.style.maxWidth).toBe('1148px');
  });

  test('managed provenance badges and the general source summary use neutral tooltips', () => {
    const baseStyle = { className: 'dc-default-title', name: 'Base topic title', target: 'title', isDefault: true, letterSpacing: '.02em' };
    const fakeElement = { id: 'e1' };
    const { panel } = loadHelper({
      styles: [...DEFAULT_AUTHOR_STYLES, baseStyle],
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop.startsWith('--') ? '' : '12px') }),
      },
      installExtras: {
        resolveElement: (id: string) => (id === 'e1' ? fakeElement : null),
      },
    });

    const summary = panel.panel.querySelector('.style-source-summary') as TestElement & { title?: string };
    expect(summary.textContent).toBe('DITA Editor surface stylesheet');
    expect(summary.title).toBe('DITA Editor surface stylesheet');
    const provs = panel.panel.querySelectorAll('.style-inspect-prov') as Array<TestElement & { title?: string }>;
    expect(provs.length).toBeGreaterThan(0);
    expect(provs.every((el) => el.textContent === 'managed author stylesheet')).toBe(true);
    expect(provs.every((el) => el.title === 'managed author stylesheet')).toBe(true);
  });

  test('a configured stylesheet link never claims unrelated field-level provenance', () => {
    const fakeElement = { id: 'e1' };
    const computedValues: Record<string, string> = {
      'font-size': '34px',
      'text-transform': 'uppercase',
    };
    const { doc, panel } = loadHelper({
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => computedValues[prop] ?? '' }),
      },
      installExtras: {
        resolveElement: (id: string) => (id === 'e1' ? fakeElement : null),
      },
    });
    const configured = doc.createElement('link');
    configured.setAttribute('rel', 'stylesheet');
    configured.setAttribute('href', 'configured-workspace.css');
    configured.setAttribute('data-ditaeditor-style-origin', 'configured');
    doc.body.appendChild(configured);
    panel.refresh(true);

    expect(panel.panel.querySelector('.style-source-summary')?.textContent)
      .toBe('configured workspace stylesheet');

    const rows = panel.panel.querySelectorAll('.style-inspect-row');
    const rowFor = (label: string) => rows.find((row) => row.children[0]?.textContent === label);
    expect(rowFor('Size')?.querySelector('.style-inspect-prov')?.textContent)
      .toBe('managed author stylesheet');
    expect(rowFor('Case')?.querySelector('.style-inspect-prov')).toBeNull();
    expect(panel.panel.querySelectorAll('.style-inspect-prov').map((el) => el.textContent))
      .not.toContain('configured workspace stylesheet');
    expect(panel.panel.querySelectorAll('.style-inspect-prov').map((el) => el.textContent))
      .not.toContain('DITA Editor surface stylesheet');
  });

  test('configured source detection uses an explicit marker even when basenames collide', () => {
    const fakeElement = { id: 'e1' };
    const { doc, panel } = loadHelper({
      windowExtras: {
        getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop === 'font-size' ? '34px' : '') }),
      },
      installExtras: {
        resolveElement: (id: string) => (id === 'e1' ? fakeElement : null),
      },
    });
    const builtIn = doc.createElement('link');
    builtIn.setAttribute('rel', 'stylesheet');
    builtIn.setAttribute('href', 'content-theme.css');
    doc.body.appendChild(builtIn);
    panel.refresh(true);
    expect(panel.panel.querySelector('.style-source-summary')?.textContent)
      .toBe('DITA Editor surface stylesheet');

    const configured = doc.createElement('link');
    configured.setAttribute('rel', 'stylesheet');
    configured.setAttribute('href', 'content-theme.css');
    configured.setAttribute('data-ditaeditor-style-origin', 'configured');
    doc.body.appendChild(configured);
    panel.refresh(true);
    expect(panel.panel.querySelector('.style-source-summary')?.textContent)
      .toBe('configured workspace stylesheet');
  });

  test('updates live CSS even while focus stays inside the panel', () => {
    const { doc, panel, setStyleState } = loadHelper();
    const input = panel.panel.querySelector('input') ?? panel.panel.querySelector('button');
    expect(input).toBeInstanceOf(TestElement);
    input!.focus();

    setStyleState({
      styles: DEFAULT_AUTHOR_STYLES,
      cssText: '.dc-live-refresh { color: red; }',
      writable: true,
      sourceHash: 'live-source-hash',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);

    expect(doc.getElementById('ditaeditor-author-styles-live')?.textContent).toContain('.dc-live-refresh');
  });

  test('uses the pre-existing live slot and applies the embedded first paint without appending a style', () => {
    const { doc, liveStyle, panel, setStyleState } = loadHelper();
    expect(doc.body.querySelectorAll('style')).toEqual([liveStyle]);
    expect(liveStyle.textContent).toContain('.dc-embedded-first-paint');

    setStyleState({
      styles: [],
      cssText: '',
      writable: false,
      sourceHash: 'empty-source',
      cssPath: '/workspace/css/ditaeditor-author-styles.css',
    });
    panel.refresh(false);
    expect(liveStyle.textContent).toBe('');
  });
});
