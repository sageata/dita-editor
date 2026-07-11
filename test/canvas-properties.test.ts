import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, type TestListener } from './canvas-test-dom';

interface TestWindow {
  innerWidth: number;
  listeners: Map<string, TestListener[]>;
  addEventListener(type: string, listener: TestListener): void;
  removeEventListener(type: string, listener: TestListener): void;
  dispatch(type: string, event: Record<string, unknown>): void;
}

function makeWindow(innerWidth = 900): TestWindow {
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

type DocProps = {
  id: string;
  kind: string;
  attrs: Array<{ name: string; value: string }>;
} | null;

const TEST_TAXONOMY = {
  version: 1,
  fields: [
    {
      attribute: 'cabin', label: 'Cabin', input: 'multi-select', group: 'Flight context',
      options: [
        { value: 'P', label: 'P - The Residence' },
        { value: 'F', label: 'F - First' },
        { value: 'J', label: 'J - Business' },
        { value: 'Y', label: 'Y - Economy' },
      ],
    },
    { attribute: 'aircraft-type', label: 'Aircraft type', input: 'multi-select', group: 'Flight context', options: [{ value: 'A380', label: 'A380' }] },
    { attribute: 'subfleet', label: 'Subfleet', input: 'multi-select', group: 'Flight context', options: [{ value: '38B', label: '38B' }] },
    { attribute: 'route', label: 'Route', input: 'multi-select', group: 'Flight context', options: [{ value: 'AUH-LHR', label: 'AUH-LHR' }] },
    { attribute: 'crew-role', label: 'Crew role', input: 'multi-select', group: 'Crew role / position', options: [{ value: 'cabin_crew', label: 'Cabin crew' }] },
    { attribute: 'crew-position', label: 'Crew position', input: 'multi-select', group: 'Crew role / position', options: [{ value: 'cabin_manager', label: 'Cabin manager' }] },
    { attribute: 'owner', label: 'Owner', input: 'text', group: 'Authoring / approval' },
  ],
};

function loadHelper(initialDocProps: DocProps = null, taxonomy: unknown = TEST_TAXONOMY) {
  const source = readFileSync(new URL('../media/canvas-properties.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  interface PropertiesPanel {
    refresh(): void;
    setTaxonomy(next: unknown): boolean;
    panel: TestElement;
    resizeHandle: TestElement;
    hideButton: TestElement;
    showButton: TestElement;
  }
  const win = {} as {
    DitaEditorCanvasProperties: {
      installPropertiesPanel(opts: Record<string, unknown>): PropertiesPanel;
    };
  };
  let docProps = initialDocProps;
  const messages: unknown[] = [];
  const doc = new TestDocument();
  const testWindow = makeWindow();
  new Function('window', source)(win);
  const panel = win.DitaEditorCanvasProperties.installPropertiesPanel({
    document: doc,
    window: testWindow,
    vscode: { postMessage: (message: unknown) => messages.push(message) },
    fontFamily: 'sans-serif',
    getDocProps: () => docProps,
    nounForKind: (kind: string) => kind || 'topic',
    taxonomy,
  });
  return {
    doc,
    testWindow,
    panel,
    messages,
    setDocProps(next: DocProps) {
      docProps = next;
    },
  };
}

describe('canvas-properties', () => {
  test('starts hidden by default, collapsed into the reveal rail', () => {
    const { doc, panel } = loadHelper();

    expect(panel.panel.style.display).toBe('none');
    expect(panel.resizeHandle.style.display).toBe('none');
    expect(panel.showButton.style.display).toBe('inline-flex');
    expect(doc.main.style.paddingLeft).toBe('36px');
    expect(panel.showButton.getAttribute('aria-expanded')).toBe('false');
  });

  test('showing the sidebar mounts it flush with the top chrome and offsets the editor by its width', () => {
    const { doc, panel } = loadHelper();

    panel.showButton.click();

    expect(panel.panel.style.display).toBe('flex');
    expect(panel.panel.style.top).toBe('0px');
    expect(panel.panel.style.width).toBe('308px');
    expect(panel.panel.style.paddingTop).toBe('90px');
    expect(doc.main.style.paddingLeft).toBe('308px');
    expect(doc.main.style.minWidth).toBe('1348px');
    expect(doc.main.style.maxWidth).toBe('1348px');
    expect(panel.resizeHandle.getAttribute('role')).toBe('separator');
    expect(panel.resizeHandle.getAttribute('aria-orientation')).toBe('vertical');
    expect(panel.resizeHandle.getAttribute('aria-valuenow')).toBe('308');
  });

  test('resizes the sidebar from the right edge and clamps the editor offset', () => {
    const { doc, testWindow, panel } = loadHelper();

    panel.showButton.click();
    panel.resizeHandle.dispatch('pointerdown', {
      button: 0,
      clientX: 308,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    testWindow.dispatch('pointermove', {
      clientX: 408,
      preventDefault: () => undefined,
    });

    expect(panel.panel.style.width).toBe('408px');
    expect(doc.main.style.paddingLeft).toBe('408px');
    expect(doc.main.style.minWidth).toBe('1448px');
    expect(doc.main.style.maxWidth).toBe('1448px');
    expect(panel.resizeHandle.getAttribute('aria-valuenow')).toBe('408');

    testWindow.dispatch('pointermove', {
      clientX: 40,
      preventDefault: () => undefined,
    });

    expect(panel.panel.style.width).toBe('240px');
    expect(doc.main.style.paddingLeft).toBe('240px');
    expect(doc.main.style.minWidth).toBe('1280px');
    expect(doc.main.style.maxWidth).toBe('1280px');
    expect(panel.resizeHandle.getAttribute('aria-valuenow')).toBe('240');
  });

  test('hides the sidebar into a reveal rail and restores the previous width', () => {
    const { doc, testWindow, panel } = loadHelper();

    panel.showButton.click();
    panel.resizeHandle.dispatch('pointerdown', {
      button: 0,
      clientX: 308,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    testWindow.dispatch('pointermove', {
      clientX: 408,
      preventDefault: () => undefined,
    });
    testWindow.dispatch('pointerup', {});

    panel.hideButton.click();

    expect(panel.panel.style.display).toBe('none');
    expect(panel.resizeHandle.style.display).toBe('none');
    expect(panel.showButton.style.display).toBe('inline-flex');
    expect(doc.main.style.paddingLeft).toBe('36px');
    expect(doc.main.style.minWidth).toBe('1076px');
    expect(doc.main.style.maxWidth).toBe('1076px');
    expect(panel.showButton.getAttribute('aria-expanded')).toBe('false');

    panel.showButton.click();

    expect(panel.panel.style.display).toBe('flex');
    expect(panel.resizeHandle.style.display).toBe('block');
    expect(panel.showButton.style.display).toBe('none');
    expect(doc.main.style.paddingLeft).toBe('408px');
    expect(doc.main.style.minWidth).toBe('1448px');
    expect(doc.main.style.maxWidth).toBe('1448px');
    expect(panel.panel.style.width).toBe('408px');
    expect(panel.hideButton.getAttribute('aria-expanded')).toBe('true');
  });

  test('renders manual-topic taxonomy chips from whitespace token attributes', () => {
    const { panel } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'cabin', value: 'Y J' },
        { name: 'route', value: 'AUH-LHR legacy-route' },
        { name: 'governance-status', value: 'draft' },
        { name: 'owner', value: 'Manuals' },
      ],
    });

    expect(panel.panel.textContent).toContain('Flight context');
    expect(panel.panel.querySelector('[data-taxonomy-field="cabin"]')?.textContent).toContain('Y - Economy');
    expect(panel.panel.querySelector('[data-taxonomy-field="cabin"]')?.textContent).toContain('J - Business');
    expect(panel.panel.querySelector('[data-taxonomy-chip="legacy-route"]')?.textContent).toContain('legacy-route');
    expect(panel.panel.querySelector('[data-taxonomy-field="route"]')?.textContent).toContain('AUH-LHR');
  });

  test('omits generic file properties and source governance fields from the sidebar', () => {
    const { panel } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'platform', value: 'legacy-platform' },
        { name: 'manual-topic-id', value: 'manual-1' },
        { name: 'source-document', value: 'manual.pdf' },
        { name: 'source-lineage', value: 'verbatim' },
        { name: 'cabin', value: 'Y' },
      ],
    });

    expect(panel.panel.textContent).not.toContain('File properties');
    expect(panel.panel.textContent).not.toContain('Topic ID');
    expect(panel.panel.textContent).not.toContain('Platform');
    expect(panel.panel.textContent).not.toContain('Product');
    expect(panel.panel.textContent).not.toContain('Props');
    expect(panel.panel.textContent).not.toContain('Other props');
    expect(panel.panel.textContent).not.toContain('Source / governance');
    expect(panel.panel.textContent).not.toContain('Manual topic ID');
    expect(panel.panel.textContent).not.toContain('Source document');
    expect(panel.panel.textContent).not.toContain('Source lineage');
    expect(panel.panel.textContent).not.toContain('manual-1');
    expect(panel.panel.textContent).not.toContain('manual.pdf');
    expect(panel.panel.textContent).toContain('Flight context');
    expect(panel.panel.textContent).toContain('Y - Economy');
  });

  test('selecting multiple taxonomy values posts one setTaxonomyAttr message with ordered tokens', () => {
    const { panel, messages } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'cabin', value: 'Y' },
      ],
    });

    const search = panel.panel.querySelector('[aria-label="Cabin search"]') as (TestElement & { value: string });
    search.focus();
    search.value = 'F';
    search.dispatch('input', {});
    panel.panel.querySelector('[data-taxonomy-option="F"]')?.click();

    expect(messages[messages.length - 1]).toEqual({ type: 'setTaxonomyAttr', id: 'topic1', attrName: 'cabin', attrValue: 'Y F', baseStructVersion: 0 });

    search.value = 'J';
    search.dispatch('input', {});
    panel.panel.querySelector('[data-taxonomy-option="J"]')?.click();

    expect(messages[messages.length - 1]).toEqual({ type: 'setTaxonomyAttr', id: 'topic1', attrName: 'cabin', attrValue: 'Y F J', baseStructVersion: 0 });
  });

  test('closes an open taxonomy value list when clicking outside the combo', () => {
    const { doc, panel } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
      ],
    });
    const search = panel.panel.querySelector('[aria-label="Crew role search"]') as (TestElement & { value: string });
    search.focus();
    search.value = 'crew';
    search.dispatch('input', {});

    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(panel.panel.querySelector('[data-taxonomy-option="cabin_crew"]')).not.toBeNull();

    for (const listener of doc.listeners.get('pointerdown') ?? []) listener({ target: doc.main });

    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(panel.panel.querySelector('[data-taxonomy-option="cabin_crew"]')).toBeNull();
  });

  test('removing taxonomy chips updates the token list and clearing the last chip sends empty attrValue', () => {
    const { panel, messages } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'cabin', value: 'Y J' },
      ],
    });

    panel.panel.querySelector('[data-taxonomy-chip="Y"]')?.click();
    expect(messages[messages.length - 1]).toEqual({ type: 'setTaxonomyAttr', id: 'topic1', attrName: 'cabin', attrValue: 'J', baseStructVersion: 0 });

    panel.panel.querySelector('[data-taxonomy-chip="J"]')?.click();
    expect(messages[messages.length - 1]).toEqual({ type: 'setTaxonomyAttr', id: 'topic1', attrName: 'cabin', attrValue: '', baseStructVersion: 0 });
  });

  test('does not mark empty taxonomy fields as required', () => {
    const { panel } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'subfleet', value: '38B' },
        { name: 'crew-role', value: 'cabin_manager' },
      ],
    });

    expect(panel.panel.textContent).not.toContain('Required for POC');
    expect(panel.panel.textContent).not.toContain('required for POC');
    expect(panel.panel.querySelector('[data-taxonomy-field="cabin"]')?.classList.has('is-missing')).toBe(false);
    expect(panel.panel.querySelector('[data-taxonomy-field="aircraft-type"]')?.classList.has('is-missing')).toBe(false);
    expect(panel.panel.querySelector('[data-taxonomy-field="crew-position"]')?.classList.has('is-missing')).toBe(false);
    expect(panel.panel.querySelector('[data-taxonomy-field="owner"]')?.classList.has('is-missing')).toBe(false);
  });

  test('does not rebuild the taxonomy panel while a field is focused', () => {
    const { doc, panel, setDocProps } = loadHelper({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'cabin', value: 'Y' },
      ],
    });
    const search = panel.panel.querySelector('[aria-label="Cabin search"]') as TestElement;
    search.focus();

    setDocProps({
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'cabin', value: 'F' },
      ],
    });
    panel.refresh();

    expect(doc.activeElement).toBe(search);
    expect(panel.panel.querySelector('[data-taxonomy-chip="Y"]')).not.toBeNull();
    expect(panel.panel.querySelector('[data-taxonomy-chip="F"]')).toBeNull();
  });

  test('posts Other edits through the existing-property-only message family', () => {
    const { panel, messages } = loadHelper({
      id: 'topic1', kind: 'topic',
      attrs: [{ name: 'id', value: 'topic1' }, { name: 'legacy', value: 'old' }],
    });
    const input = panel.panel.querySelector('[aria-label="legacy"]') as TestElement & { value: string };
    input.value = 'new';
    input.dispatch('change', {});
    expect(messages.at(-1)).toEqual({
      type: 'setExistingPropertyAttr', id: 'topic1', attrName: 'legacy', attrValue: 'new', baseStructVersion: 0,
    });
  });

  test('renders hostile configured text as text only and keeps unknown select values removable', () => {
    const hostile = '</script><img onerror=marker>\u202e';
    const { panel } = loadHelper({
      id: 'topic1', kind: 'topic',
      attrs: [{ name: 'id', value: 'topic1' }, { name: 'cabin', value: 'legacy' }],
    }, {
      version: 1,
      fields: [{
        attribute: 'cabin', label: hostile, input: 'multi-select', group: hostile,
        options: [{ value: 'Y', label: hostile }],
      }],
    });
    expect(panel.panel.textContent).toContain(hostile);
    expect(panel.panel.querySelector('img')).toBeNull();
    expect(panel.panel.querySelector('[data-taxonomy-chip="legacy"]')?.textContent).toContain('legacy');
  });

  test('rebuilds only when the normalized taxonomy changes', () => {
    const { doc, panel } = loadHelper({ id: 'topic1', kind: 'topic', attrs: [{ name: 'id', value: 'topic1' }] });
    const firstField = panel.panel.querySelector('[data-taxonomy-field="cabin"]');
    (panel.panel.querySelector('[aria-label="Cabin search"]') as TestElement).focus();
    expect(panel.setTaxonomy(TEST_TAXONOMY)).toBe(false);
    expect(doc.activeElement).not.toBeNull();
    expect(panel.panel.querySelector('[data-taxonomy-field="cabin"]')).toBe(firstField);
    expect(panel.setTaxonomy({ version: 1, fields: [{ attribute: 'owner', label: 'Owner', input: 'text' }] })).toBe(true);
    expect(panel.panel.querySelector('[data-taxonomy-field="cabin"]')).toBeNull();
    expect(panel.panel.querySelector('[data-taxonomy-field="owner"]')).not.toBeNull();
  });
});
