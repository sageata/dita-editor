// The native Properties view bootstrap (media/properties-view.js) + the ported
// panel engine (media/properties-panel.js), run together in the fake-DOM
// harness the way the view webview loads them: engine first, bootstrap second.

import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

const engineSource = readFileSync(new URL('../media/properties-panel.js', import.meta.url), 'utf8');
const bootstrapSource = readFileSync(new URL('../media/properties-view.js', import.meta.url), 'utf8');

const TAXONOMY = {
  version: 1,
  fields: [
    { attribute: 'owner', label: 'Owner', input: 'text', group: 'Authoring' },
  ],
};

function viewState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'propertiesViewState',
    active: true,
    docLabel: 'topic.dita',
    docProps: {
      id: 'topic1',
      kind: 'topic',
      attrs: [
        { name: 'id', value: 'topic1' },
        { name: 'xml:lang', value: 'en-US' },
        { name: 'owner', value: 'Manuals' },
      ],
    },
    taxonomy: TAXONOMY,
    structVersion: 6,
    ...overrides,
  };
}

function boot() {
  const doc = new TestDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'inspector-root');
  const status = doc.createElement('div');
  status.setAttribute('id', 'inspector-status');
  doc.body.append(root, status);

  const posted: Array<Record<string, unknown>> = [];
  const windowListeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const windowObj = {
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
  } as Record<string, unknown>;
  const vscode = {
    getState: () => null,
    setState: () => undefined,
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
    },
  };
  // The engine attaches its namespace to the shared window object.
  new Function('window', engineSource)(windowObj);
  new Function('window', 'document', 'acquireVsCodeApi', bootstrapSource)(windowObj, doc, () => vscode);
  return {
    doc,
    root,
    status,
    posted,
    deliver(message: Record<string, unknown>) {
      for (const listener of windowListeners.get('message') ?? []) listener({ data: message });
    },
  };
}

describe('properties-view bootstrap', () => {
  test('boots into the empty state and announces readiness', () => {
    const h = boot();
    expect(h.posted).toEqual([{ type: 'propertiesReady' }]);
    expect(h.root.textContent).toContain('Open a DITA topic in the visual editor');
  });

  test('an active snapshot mounts the panel with taxonomy and attributes', () => {
    const h = boot();
    h.deliver(viewState());
    expect(h.root.querySelector('[data-taxonomy-field="owner"]')).not.toBeNull();
    expect(h.root.textContent).toContain('xml:lang');
    const langInput = h.root.querySelector('[aria-label="xml:lang"]') as (TestElement & { value: string }) | null;
    expect(langInput?.value).toBe('en-US');
    expect(h.root.textContent).not.toContain('Open a DITA topic');
  });

  test('edits post the unchanged op shape stamped with the snapshot structVersion', () => {
    const h = boot();
    h.deliver(viewState());
    const input = h.root.querySelector('[aria-label="xml:lang"]') as TestElement & { value: string };
    input.value = 'de-DE';
    input.dispatch('change', {});
    expect(h.posted.at(-1)).toEqual({
      type: 'setExistingPropertyAttr',
      id: 'topic1',
      attrName: 'xml:lang',
      attrValue: 'de-DE',
      baseStructVersion: 6,
    });
  });

  test('an inactive snapshot returns to the empty state', () => {
    const h = boot();
    h.deliver(viewState());
    h.deliver({ type: 'propertiesViewState', active: false, docLabel: '', docProps: null, taxonomy: null, structVersion: 0 });
    expect(h.root.textContent).toContain('Open a DITA topic in the visual editor');
  });

  test('refused ops surface their reason in the live status region', () => {
    const h = boot();
    h.deliver(viewState());
    h.deliver({ type: 'error', message: 'The attribute request was created from a stale render.' });
    expect(h.status.textContent).toBe('The attribute request was created from a stale render.');
  });
});
