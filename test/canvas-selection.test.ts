import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestElement } from './canvas-test-dom';

function block(tag: string, id: string, text = ''): TestElement {
  const el = new TestElement(tag);
  el.setAttribute('data-struct-id', id);
  el.setAttribute('data-struct-kind', tag);
  el.textContent = text;
  return el;
}

function setRect(el: TestElement, top: number, bottom: number): void {
  el.getBoundingClientRect = () => ({ left: 120, top, bottom });
}

function installSelectionHelpers() {
  const source = readFileSync(new URL('../media/canvas-selection.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasSelection: {
      createSelectionHelpers(options?: Record<string, unknown>): {
        buildSelection(anchorEl: TestElement, focusEl: TestElement): unknown;
        unitFromPoint(root: TestElement, clientY: number): { type: string; el: TestElement } | null;
        unitOf(node: TestElement): { type: string; el: TestElement } | null;
      };
    };
  };
  new Function('window', source)(win);
  return win.DitaEditorCanvasSelection.createSelectionHelpers({ editableTarget: () => null });
}

describe('canvas selection helpers', () => {
  test('a directly targeted image inside a table cell is an image selection unit', () => {
    const cell = new TestElement('td');
    cell.setAttribute('data-cell-id', 'cell1');
    const image = cell.appendChild(block('img', 'image1'));
    image.setAttribute('data-struct-kind', 'image');

    expect(installSelectionHelpers().unitOf(image)).toEqual({ type: 'image', el: image });
  });

  test('dragging from a paragraph across an indented list creates a document-order multi-selection', () => {
    const main = new TestElement('main');
    const p1 = main.appendChild(block('p', 'e1', 'Intro'));
    const list = main.appendChild(block('ul', 'e2'));
    const li1 = list.appendChild(block('li', 'e3', 'Parent item'));
    const nested = li1.appendChild(block('ul', 'e4'));
    nested.appendChild(block('li', 'e5', 'Nested item'));
    const p2 = main.appendChild(block('p', 'e6', 'After'));

    const helpers = installSelectionHelpers();

    expect(helpers.buildSelection(p1, p2)).toEqual({
      mode: 'multiSet',
      origin: 'documentRange',
      units: [
        { unit: 'block', id: 'e1', kind: 'p', text: 'Intro' },
        { unit: 'block', id: 'e3', kind: 'li', text: 'Parent item' },
        { unit: 'block', id: 'e5', kind: 'li', text: 'Nested item' },
        { unit: 'block', id: 'e6', kind: 'p', text: 'After' },
      ],
    });
  });

  test('dragging to an indented list container includes its selectable list items', () => {
    const main = new TestElement('main');
    const p1 = main.appendChild(block('p', 'e1', 'Intro'));
    const list = main.appendChild(block('ul', 'e2'));
    const li1 = list.appendChild(block('li', 'e3', 'Parent item'));
    const nested = li1.appendChild(block('ul', 'e4'));
    nested.appendChild(block('li', 'e5', 'Nested item'));

    const helpers = installSelectionHelpers();

    expect(helpers.buildSelection(p1, nested)).toEqual({
      mode: 'multiSet',
      origin: 'documentRange',
      units: [
        { unit: 'block', id: 'e1', kind: 'p', text: 'Intro' },
        { unit: 'block', id: 'e3', kind: 'li', text: 'Parent item' },
        { unit: 'block', id: 'e5', kind: 'li', text: 'Nested item' },
      ],
    });
  });

  test('dragging backward from a paragraph to an indented list container includes its selectable list items', () => {
    const main = new TestElement('main');
    const list = main.appendChild(block('ul', 'e1'));
    const li1 = list.appendChild(block('li', 'e2', 'Parent item'));
    const nested = li1.appendChild(block('ul', 'e3'));
    nested.appendChild(block('li', 'e4', 'Nested item'));
    const p2 = main.appendChild(block('p', 'e5', 'After'));

    const helpers = installSelectionHelpers();

    expect(helpers.buildSelection(p2, nested)).toEqual({
      mode: 'multiSet',
      origin: 'documentRange',
      units: [
        { unit: 'block', id: 'e2', kind: 'li', text: 'Parent item' },
        { unit: 'block', id: 'e4', kind: 'li', text: 'Nested item' },
        { unit: 'block', id: 'e5', kind: 'p', text: 'After' },
      ],
    });
  });

  test('vertical drag hit-testing resolves an indented list item from surrounding whitespace', () => {
    const main = new TestElement('main');
    const p1 = main.appendChild(block('p', 'e1', 'Intro'));
    const list = main.appendChild(block('ul', 'e2'));
    const li1 = list.appendChild(block('li', 'e3', 'Indented item'));
    const p2 = main.appendChild(block('p', 'e4', 'After'));
    setRect(p1, 0, 20);
    setRect(list, 20, 80);
    setRect(li1, 32, 52);
    setRect(p2, 80, 100);

    const helpers = installSelectionHelpers();
    const hit = helpers.unitFromPoint(main, 40);

    expect(hit).toEqual({ type: 'block', el: li1 });
    expect(helpers.buildSelection(p1, hit!.el)).toEqual({
      mode: 'multiSet',
      origin: 'documentRange',
      units: [
        { unit: 'block', id: 'e1', kind: 'p', text: 'Intro' },
        { unit: 'block', id: 'e3', kind: 'li', text: 'Indented item' },
      ],
    });
  });
});
