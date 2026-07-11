import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, keyEvent } from './canvas-test-dom';

function loadMenu(doc: TestDocument) {
  const source = readFileSync(new URL('../media/canvas-menu.js', import.meta.url), 'utf8');
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
  } as {
    innerWidth: number;
    innerHeight: number;
    DitaEditorCanvasMenu?: {
      createMenu(
        ariaLabel: string,
        onToggle?: (open: boolean) => void,
        hooks?: Record<string, unknown>,
      ): {
        openAt(defs: Array<Record<string, unknown>>, x: number, y: number, opts?: Record<string, unknown>): void;
        close(restore: boolean): void;
        isOpen(): boolean;
      };
    };
  };
  new Function('window', 'document', source)(win, doc);
  return win.DitaEditorCanvasMenu!;
}

function menuRoot(doc: TestDocument): TestElement {
  const root = doc.body.children.find((el) => el.getAttribute('role') === 'menu');
  expect(root).toBeInstanceOf(TestElement);
  return root!;
}

function setBox(
  el: TestElement,
  width: number,
  height: number,
  rect?: { left: number; top: number; right: number; bottom: number; width: number; height: number },
): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  if (rect) el.getBoundingClientRect = () => rect;
}

describe('canvas-menu', () => {
  test('renders element headers and fly-out submenus from menu definitions', () => {
    const doc = new TestDocument();
    const activated: string[] = [];
    const menu = loadMenu(doc).createMenu('List item actions');

    menu.openAt(
      [
        { elementHeader: { label: 'List item', icon: '<svg></svg>', tag: '<li>' } },
        { separator: true },
        {
          label: 'Convert to',
          icon: '<svg></svg>',
          enabled: true,
          submenuWidth: 218,
          submenu: [
            {
              label: 'Paragraph',
              icon: '<svg></svg>',
              enabled: true,
              onActivate: () => activated.push('paragraph'),
            },
            {
              label: 'Bulleted list',
              icon: '<svg></svg>',
              enabled: false,
              reason: 'Already a bulleted list',
              onActivate: () => activated.push('bulleted'),
            },
          ],
        },
        {
          label: 'Delete this list item',
          icon: '<svg></svg>',
          shortcut: 'Del',
          del: true,
          enabled: true,
          onActivate: () => activated.push('delete'),
        },
      ],
      24,
      32,
      { width: 300, allowSubmenus: true },
    );

    const root = menuRoot(doc);
    expect(root.style.width).toBe('300px');
    expect(root.style.overflow).toBe('auto');
    expect(root.querySelector('[data-menu-header="List item"]')).toBeInstanceOf(TestElement);

    const convert = root.querySelector('[aria-label="Convert to"]')!;
    expect(convert.getAttribute('aria-haspopup')).toBe('menu');
    expect(convert.getAttribute('aria-expanded')).toBe('false');
    const submenu = root.querySelectorAll('[role="menu"]')[0]!;
    expect(submenu.style.cssText).toContain('display:none');

    const arrowDown = keyEvent('ArrowDown');
    root.dispatch('keydown', arrowDown);
    expect(arrowDown.prevented).toBe(true);
    expect(doc.activeElement?.getAttribute('aria-label')).toBe('Delete this list item');

    convert.focus();
    convert.click();
    expect(convert.getAttribute('aria-expanded')).toBe('true');
    expect(submenu.style.display).toBe('flex');
    expect(doc.activeElement?.getAttribute('aria-label')).toBe('Paragraph');

    const disabled = root
      .querySelectorAll('[role="menuitem"]')
      .find((el) => el.textContent === 'Bulleted list')!;
    expect(disabled.getAttribute('aria-disabled')).toBe('true');

    const paragraph = root.querySelector('[aria-label="Paragraph"]')!;
    paragraph.click();
    expect(activated).toEqual(['paragraph']);
    expect(root.style.display).toBe('none');
  });

  test('keeps the root menu fully above the visible bottom chrome', () => {
    const doc = new TestDocument();
    const crumb = doc.createElement('div');
    crumb.setAttribute('data-ditaeditor-breadcrumb', 'bar');
    crumb.style.display = 'flex';
    setBox(crumb, 1200, 34, { left: 0, top: 766, right: 1200, bottom: 800, width: 1200, height: 34 });
    doc.body.appendChild(crumb);

    const menu = loadMenu(doc).createMenu('List item actions');
    const root = menuRoot(doc);
    setBox(root, 260, 220);

    menu.openAt(
      [
        { label: 'Indent', icon: '<svg></svg>', enabled: true, onActivate: () => undefined },
        { label: 'Outdent', icon: '<svg></svg>', enabled: true, onActivate: () => undefined },
      ],
      1160,
      780,
      { width: 260, allowSubmenus: true },
    );

    expect(root.style.left).toBe('934px');
    expect(root.style.top).toBe('540px');
    expect(root.style.maxHeight).toBe('754px');
  });

  test('keeps fly-out submenus adjacent while clamping into the viewport', () => {
    const doc = new TestDocument();
    const menu = loadMenu(doc).createMenu('List item actions');
    const root = menuRoot(doc);
    setBox(root, 260, 260);

    menu.openAt(
      [
        {
          label: 'Insert inside',
          icon: '<svg></svg>',
          enabled: true,
          submenuWidth: 210,
          submenu: [
            { label: 'Paragraph', icon: '<svg></svg>', enabled: true, onActivate: () => undefined },
            { label: 'Bulleted list', icon: '<svg></svg>', enabled: true, onActivate: () => undefined },
            { label: 'Numbered list', icon: '<svg></svg>', enabled: true, onActivate: () => undefined },
          ],
        },
      ],
      900,
      520,
      { width: 260, allowSubmenus: true },
    );

    const trigger = root.querySelector('[aria-label="Insert inside"]')!;
    setBox(trigger, 130, 28, { left: 930, top: 720, right: 1060, bottom: 748, width: 130, height: 28 });
    setBox(trigger.parentElement!, 260, 28, { left: 930, top: 718, right: 1190, bottom: 750, width: 260, height: 32 });
    const submenu = root.querySelectorAll('[role="menu"]')[0]!;
    setBox(submenu, 210, 180);

    trigger.click();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(submenu.style.display).toBe('flex');
    expect(submenu.style.left).toBe('726px');
    expect(submenu.style.top).toBe('614px');
    expect(submenu.style.maxHeight).toBe('788px');
  });
});
