import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement } from './canvas-test-dom';

interface EndInsertApi {
  installEndInsert(opts: {
    document: TestDocument;
    vscode: { postMessage(message: unknown): void };
    insertAvailFor?: (id: string, mode: string, op: string) => { enabled: boolean; reason?: string };
    announceNav?: (message: string) => void;
  }): {
    refresh(): void;
    findEndAnchor(): { id: string; kind: string } | null;
  };
  findEndAnchor(document: TestDocument): { id: string; kind: string } | null;
}

function loadHelper(): EndInsertApi {
  const source = readFileSync(new URL('../media/canvas-end-insert.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as { DitaEditorCanvasEndInsert?: EndInsertApi };
  new Function('window', 'document', source)(win, new TestDocument());
  return win.DitaEditorCanvasEndInsert!;
}

function struct(
  doc: TestDocument,
  tag: string,
  id: string,
  kind: string,
  rect: { top: number; bottom: number },
): TestElement {
  const el = doc.createElement(tag);
  el.setAttribute('data-struct-id', id);
  el.setAttribute('data-struct-kind', kind);
  el.getBoundingClientRect = () => ({ left: 0, top: rect.top, bottom: rect.bottom });
  return el;
}

function endButton(doc: TestDocument): TestElement {
  const button = doc.main.querySelector('.dc-end-insert');
  expect(button).toBeInstanceOf(TestElement);
  return button!;
}

describe('canvas-end-insert', () => {
  test('clicking the trailing hit area posts a host-backed paragraph insert after the last block', () => {
    const doc = new TestDocument();
    const article = doc.createElement('article');
    const first = struct(doc, 'p', 'e1', 'p', { top: 20, bottom: 40 });
    const last = struct(doc, 'p', 'e2', 'p', { top: 60, bottom: 90 });
    article.append(first, last);
    doc.main.appendChild(article);
    const messages: unknown[] = [];
    const announced: string[] = [];

    loadHelper().installEndInsert({
      document: doc,
      vscode: { postMessage: (message) => messages.push(message) },
      insertAvailFor: () => ({ enabled: true }),
      announceNav: (message) => announced.push(message),
    });

    endButton(doc).click();

    expect(messages).toEqual([
      { type: 'insert', op: 'paragraph', payload: { mode: 'after', refId: 'e2' } },
    ]);
    expect(announced).toEqual(['Insert paragraph at end...']);
  });

  test('prefers an outer table over editable descendants when the document ends with a table', () => {
    const doc = new TestDocument();
    const article = doc.createElement('article');
    const table = struct(doc, 'table', 'e10', 'table', { top: 40, bottom: 140 });
    const rowParagraph = struct(doc, 'p', 'e11', 'p', { top: 100, bottom: 140 });
    table.appendChild(rowParagraph);
    article.appendChild(table);
    doc.main.appendChild(article);
    const messages: unknown[] = [];

    const endInsert = loadHelper().installEndInsert({
      document: doc,
      vscode: { postMessage: (message) => messages.push(message) },
      insertAvailFor: () => ({ enabled: true }),
    });

    expect(endInsert.findEndAnchor()).toEqual({ id: 'e10', kind: 'table' });
    endButton(doc).click();
    expect(messages).toEqual([
      { type: 'insert', op: 'paragraph', payload: { mode: 'after', refId: 'e10' } },
    ]);
  });

  test('clicking body-level blank canvas below a final table inserts after that table', () => {
    const doc = new TestDocument();
    const article = doc.createElement('article');
    const table = struct(doc, 'table', 'e10', 'table', { top: 40, bottom: 140 });
    article.appendChild(table);
    doc.main.appendChild(article);
    const messages: unknown[] = [];
    const event = {
      target: doc.body,
      clientY: 170,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };

    loadHelper().installEndInsert({
      document: doc,
      vscode: { postMessage: (message) => messages.push(message) },
      insertAvailFor: () => ({ enabled: true }),
    });

    for (const listener of doc.listeners.get('click') ?? []) listener(event);

    expect(event.prevented).toBe(true);
    expect(event.stopped).toBe(true);
    expect(messages).toEqual([
      { type: 'insert', op: 'paragraph', payload: { mode: 'after', refId: 'e10' } },
    ]);
  });

  test('hides the hit area when paragraph insertion is unavailable at the end anchor', () => {
    const doc = new TestDocument();
    const article = doc.createElement('article');
    article.appendChild(struct(doc, 'p', 'e1', 'p', { top: 20, bottom: 40 }));
    doc.main.appendChild(article);
    const messages: unknown[] = [];

    loadHelper().installEndInsert({
      document: doc,
      vscode: { postMessage: (message) => messages.push(message) },
      insertAvailFor: () => ({ enabled: false, reason: 'Cannot insert a paragraph here' }),
    });

    const button = endButton(doc);
    expect(button.style.display).toBe('none');

    button.click();
    expect(messages).toEqual([]);
  });
});
