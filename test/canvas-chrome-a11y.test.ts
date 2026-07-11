import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, TestText } from './canvas-test-dom';

function loadChrome() {
  const source = readFileSync(new URL('../media/canvas-chrome.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasChrome: {
      installCanvasChrome(opts: Record<string, unknown>): {
        announceNav(message: string): void;
        showError(message: string): void;
        hideError(): void;
        elementPath(node: unknown): string;
      };
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasChrome;
}

describe('canvas chrome screen-reader contract', () => {
  test('installs a polite status live region and alert surface for assistive tech', async () => {
    const doc = new TestDocument();
    const paragraph = new TestElement('p', doc, { 'data-edit-id': 'e1', contenteditable: 'true' });
    paragraph.classList.add('p');
    paragraph.append(new TestText('Hello'));
    doc.main.appendChild(paragraph);

    const chrome = loadChrome().installCanvasChrome({
      document: doc,
      window: {
        setTimeout,
        getSelection: () => ({ anchorNode: paragraph.childNodes[0] }),
      },
      editableTarget: (node: unknown) =>
        node instanceof TestElement && node.hasAttribute('contenteditable') ? node : null,
      clearNavFocus: () => undefined,
    });

    const status = doc.body.querySelector('[role="status"]');
    const note = doc.body.querySelector('[role="note"]');
    const alert = doc.body.querySelector('[role="alert"]');
    const dismiss = doc.body.querySelector('[aria-label="Dismiss error"]');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-label')).toBe('Navigation status');
    expect(note?.getAttribute('aria-hidden')).toBe('true');
    expect(alert).toBeInstanceOf(TestElement);
    expect(dismiss).toBeInstanceOf(TestElement);

    chrome.announceNav('Already at the last cell in the table');
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(status?.textContent).toBe('Already at the last cell in the table');

    chrome.showError('Save failed');
    expect(alert?.style.display).toBe('block');
    expect(alert?.textContent).toContain('Save failed');
    chrome.hideError();
    expect(alert?.style.display).toBe('none');
  });

  test('path breadcrumb follows the editor inset and can be hidden', () => {
    const doc = new TestDocument();
    doc.main.style.paddingLeft = '36px';
    const table = new TestElement('table', doc);
    table.classList.add('table');
    const tbody = new TestElement('tbody', doc);
    tbody.classList.add('tbody');
    const row = new TestElement('tr', doc);
    row.classList.add('row');
    const entry = new TestElement('td', doc);
    entry.classList.add('entry');
    const text = new TestText('Cell');
    entry.append(text);
    row.appendChild(entry);
    tbody.appendChild(row);
    table.appendChild(tbody);
    doc.main.appendChild(table);

    const chrome = loadChrome().installCanvasChrome({
      document: doc,
      window: {
        setTimeout,
        getSelection: () => ({ anchorNode: text }),
      },
      editableTarget: () => null,
      clearNavFocus: () => undefined,
    });

    for (const listener of doc.listeners.get('selectionchange') ?? []) listener({});

    const bar = doc.body.querySelector('[data-ditaeditor-breadcrumb="bar"]');
    const hide = doc.body.querySelector('[aria-label="Hide path bar"]');
    const show = doc.body.querySelector('[aria-label="Show path bar"]');

    expect(bar?.style.left).toBe('36px');
    expect(bar?.style.display).toBe('flex');
    expect(chrome.elementPath(text)).toBe('Table › Body rows › Row › Cell');
    expect(bar?.textContent).toContain('Structure');
    expect(bar?.textContent).toContain('Table');
    expect(bar?.textContent).toContain('<table>');
    expect(bar?.textContent).toContain('Cell');
    expect(bar?.textContent).toContain('<entry>');
    expect(show?.style.left).toBe('44px');
    expect(show?.style.display).toBe('none');

    hide?.click();
    expect(bar?.style.display).toBe('none');
    expect(show?.style.display).toBe('inline-flex');

    doc.main.style.paddingLeft = '308px';
    show?.click();
    expect(bar?.style.left).toBe('308px');
    expect(show?.style.left).toBe('316px');
    expect(bar?.style.display).toBe('flex');
  });
});
