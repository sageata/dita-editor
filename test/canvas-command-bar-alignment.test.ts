import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

function icons(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `<${name}>`]));
}

function controls(doc: TestDocument) {
  return {
    makeBtn: (_label: string, title: string) => {
      const btn = doc.createElement('button');
      btn.dataset.action = title;
      btn.setAttribute('aria-label', title);
      return btn;
    },
    isUnavailable: (btn: TestElement) => btn.getAttribute('aria-disabled') === 'true',
    setBtnEnabled: (btn: TestElement, enabled: boolean, title: string) => {
      if (enabled) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', 'true');
      btn.title = title;
      btn.setAttribute('aria-label', title);
    },
    nextRovingIndex: (_count: number, current: number) => current,
  };
}

function loadScripts(win: Record<string, unknown>, doc: TestDocument): void {
  for (const rel of [
    '../media/canvas-text-metrics.js',
    '../media/canvas-command-format.js',
    '../media/canvas-command-shortcuts.js',
    '../media/canvas-command-insert.js',
    '../media/canvas-command-structure.js',
    '../media/canvas-command-bar-ui.js',
    '../media/canvas-command-bar.js',
  ]) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    new Function('window', 'document', source)(win, doc);
  }
}

function block(doc: TestDocument, tag: string, id: string, kind: string, attrs: Record<string, string> = {}): TestElement {
  const el = new TestElement(tag, doc, {
    'data-struct-id': id,
    'data-struct-kind': kind,
    ...attrs,
  });
  el.textContent = id;
  return el;
}

function install(doc: TestDocument, getSelection: () => any) {
  const messages: unknown[] = [];
  const menus = new Map<string, Array<Record<string, any>>>();
  const domAnchor = doc.activeElement ?? doc.main;
  const win = {
    CSS: { escape: (value: string) => value },
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: domAnchor,
      getRangeAt: () => ({ startContainer: domAnchor, startOffset: 0, endContainer: domAnchor, endOffset: 0 }),
    }),
  } as Record<string, any>;
  loadScripts(win, doc);
  const api = win.DitaEditorCanvasCommandBar.installCommandBar({
    document: doc,
    window: win,
    vscode: { postMessage: (message: unknown) => messages.push(message) },
    menu: {
      createMenu: (label: string) => ({
        openAt: (defs: Array<Record<string, any>>) => menus.set(label, defs),
        close: () => undefined,
        isOpen: () => false,
      }),
    },
    fontFamily: 'sans-serif',
    controls: controls(doc),
    menuIcons: icons(['paragraph', 'section', 'ul', 'alphaOl', 'ol', 'lines', 'note', 'codeblock', 'indent', 'outdent', 'table']),
    barIcons: icons(['undo', 'redo', 'find', 'code', 'clearFormat', 'image', 'xref', 'conref']),
    getSelection,
    getStructVersion: () => 11,
    structTarget: (node: TestElement) => node.closest('[data-struct-id]'),
    caretOffset: () => 0,
    columnAnchorId: (node: TestElement) => node.getAttribute('data-cell-id'),
    availFor: () => ({ enabled: true }),
    applyAvail: (btn: TestElement, _id: string, _op: string, label: string) => controls(doc).setBtnEnabled(btn, true, label),
    insertAvailFor: () => ({ enabled: true }),
    transformAvailFor: () => ({ status: 'ok' }),
    postStructural: () => undefined,
    postTransform: () => undefined,
    announceNav: () => undefined,
  });
  const horizontal = doc.body.querySelectorAll('button').find((button) => button.dataset.action === 'Horizontal alignment');
  if (!horizontal) throw new Error('horizontal alignment button missing');
  return { api, horizontal, messages, menus };
}

function choice(menus: Map<string, Array<Record<string, any>>>, label: string): Record<string, any> {
  const item = menus.get('Horizontal alignment')?.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`alignment choice missing: ${label}`);
  return item;
}

describe('canvas command bar horizontal alignment', () => {
  test('lives in Format and exposes authored state for a single content block', () => {
    const doc = new TestDocument();
    const p = block(doc, 'p', 'p1', 'p', { 'data-outputclass': 'keep ditaeditor-align-center' });
    doc.main.appendChild(p);
    doc.activeElement = p;
    const fixture = install(doc, () => ({ mode: 'single', unit: 'block', id: 'p1', kind: 'p' }));

    expect(fixture.horizontal.style.display).toBe('inline-flex');
    expect(fixture.horizontal.getAttribute('aria-disabled')).toBeNull();
    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Center');
    fixture.horizontal.click();
    expect(choice(fixture.menus, 'Center').enabled).toBe(false);
    expect(choice(fixture.menus, 'Default').enabled).toBe(true);
    choice(fixture.menus, 'Right').onActivate();

    expect(fixture.messages).toEqual([{
      type: 'setHorizontalAlign', ids: ['p1'], align: 'right', baseStructVersion: 11,
    }]);
  });

  test('reports Mixed and applies once to every block-range member', () => {
    const doc = new TestDocument();
    const first = block(doc, 'p', 'p1', 'p', { 'data-outputclass': 'ditaeditor-align-left' });
    const second = block(doc, 'p', 'p2', 'p', { 'data-outputclass': 'ditaeditor-align-center' });
    doc.main.append(first, second);
    doc.activeElement = first;
    const fixture = install(doc, () => ({
      mode: 'blockRange', kind: 'p', members: [{ id: 'p1' }, { id: 'p2' }],
    }));

    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Mixed');
    fixture.horizontal.click();
    choice(fixture.menus, 'Center').onActivate();
    expect(fixture.messages).toEqual([{
      type: 'setHorizontalAlign', ids: ['p1', 'p2'], align: 'center', baseStructVersion: 11,
    }]);
  });

  test('allows the precedence-selected value to normalize conflicting managed tokens', () => {
    const doc = new TestDocument();
    const p = block(doc, 'p', 'p1', 'p', {
      'data-outputclass': 'keep ditaeditor-align-left ditaeditor-align-justify',
    });
    doc.main.appendChild(p);
    doc.activeElement = p;
    const fixture = install(doc, () => ({ mode: 'single', unit: 'block', id: 'p1', kind: 'p' }));

    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Justify');
    fixture.horizontal.click();
    expect(choice(fixture.menus, 'Justify').enabled).toBe(true);
    choice(fixture.menus, 'Justify').onActivate();
    expect(fixture.messages).toEqual([{
      type: 'setHorizontalAlign', ids: ['p1'], align: 'justify', baseStructVersion: 11,
    }]);
  });

  test('uses authored cell alignment rather than inherited effective CALS alignment', () => {
    const doc = new TestDocument();
    const table = new TestElement('table', doc);
    const cell = new TestElement('td', doc, {
      'data-cell-id': 'e1',
      'data-edit-id': 'e1',
      contenteditable: 'true',
      'data-authored-align': '',
      'data-align': 'center',
    });
    table.appendChild(cell);
    doc.main.appendChild(table);
    doc.activeElement = cell;
    const fixture = install(doc, () => ({ mode: 'cellRect', members: [{ id: 'e1' }] }));

    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Default');
    fixture.horizontal.click();
    expect(choice(fixture.menus, 'Default').enabled).toBe(false);
    choice(fixture.menus, 'Right').onActivate();
    expect(fixture.messages).toEqual([{
      type: 'setHorizontalAlign', ids: ['e1'], align: 'right', baseStructVersion: 11,
    }]);
  });

  test('filters only document-range wrapper artifacts and keeps inline image repair actionable', () => {
    const doc = new TestDocument();
    const section = block(doc, 'section', 's1', 'section');
    const p = block(doc, 'p', 'p1', 'p', { 'data-outputclass': 'ditaeditor-align-right' });
    const image = block(doc, 'img', 'i1', 'image', {
      'data-authored-align': 'right',
      'data-authored-placement': 'inline',
    });
    section.append(p, image);
    doc.main.appendChild(section);
    doc.activeElement = p;
    const fixture = install(doc, () => ({
      mode: 'multiSet',
      origin: 'documentRange',
      units: [
        { unit: 'block', id: 's1', kind: 'section' },
        { unit: 'block', id: 'p1', kind: 'p' },
        { unit: 'image', id: 'i1', kind: 'image' },
      ],
    }));

    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Right');
    fixture.horizontal.click();
    expect(choice(fixture.menus, 'Right').enabled).toBe(true);
    expect(choice(fixture.menus, 'Justify').enabled).toBe(false);
    expect(choice(fixture.menus, 'Justify').reason).toContain('Images');
    choice(fixture.menus, 'Right').onActivate();
    expect(fixture.messages).toEqual([{
      type: 'setHorizontalAlign', ids: ['p1', 'i1'], align: 'right', baseStructVersion: 11,
    }]);
  });

  test('rejects an explicitly selected structural container without falling back to the caret', () => {
    const doc = new TestDocument();
    const section = block(doc, 'section', 's1', 'section');
    const p = block(doc, 'p', 'p1', 'p');
    section.appendChild(p);
    doc.main.appendChild(section);
    doc.activeElement = p;
    const fixture = install(doc, () => ({
      mode: 'multiSet',
      units: [
        { unit: 'block', id: 's1', kind: 'section' },
        { unit: 'block', id: 'p1', kind: 'p' },
      ],
    }));

    expect(fixture.horizontal.getAttribute('aria-disabled')).toBe('true');
    expect(fixture.horizontal.getAttribute('aria-label')).toContain('not available');
    fixture.horizontal.click();
    expect(fixture.menus.has('Horizontal alignment')).toBe(false);
    expect(fixture.messages).toEqual([]);
  });

  test('rejects mixed/block notes while keeping whole editable notes eligible', () => {
    const doc = new TestDocument();
    const note = block(doc, 'div', 'n1', 'note');
    doc.main.appendChild(note);
    doc.activeElement = note;
    let selection = { mode: 'single', unit: 'block', id: 'n1', kind: 'note' };
    const fixture = install(doc, () => selection);

    expect(fixture.horizontal.getAttribute('aria-disabled')).toBe('true');
    note.setAttribute('data-edit-id', 'n1');
    note.setAttribute('contenteditable', 'true');
    fixture.api.refresh();
    expect(fixture.horizontal.getAttribute('aria-disabled')).toBeNull();
    expect(fixture.horizontal.getAttribute('aria-label')).toBe('Horizontal alignment: Default');
  });
});
