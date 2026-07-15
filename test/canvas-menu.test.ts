import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, keyEvent } from './canvas-test-dom';

function loadMenu(doc: TestDocument, viewport: { width?: number; height?: number } = {}) {
  const source = readFileSync(new URL('../media/canvas-menu.js', import.meta.url), 'utf8');
  const win = {
    innerWidth: viewport.width ?? 1200,
    innerHeight: viewport.height ?? 800,
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
  test('renders fly-out submenus from menu definitions', () => {
    const doc = new TestDocument();
    const activated: string[] = [];
    const menu = loadMenu(doc).createMenu('List item actions');

    menu.openAt(
      [
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
    expect(root.querySelector('[data-menu-header="List item"]')).toBeNull();

    const convert = root.querySelector('[aria-label="Convert to"]')!;
    expect(convert.getAttribute('aria-haspopup')).toBe('menu');
    expect(convert.getAttribute('aria-expanded')).toBe('false');
    const submenu = doc.body.children.find((el) => el !== root && el.getAttribute('role') === 'menu')!;
    expect(submenu.parentElement).toBe(doc.body);
    expect(convert.style.cssText).toContain('width:calc(100% - 10px)');
    expect(convert.style.cssText).toContain('box-sizing:border-box');
    expect(convert.children[convert.children.length - 1].style.cssText).toContain('margin-left:auto');
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

    const disabled = submenu
      .querySelectorAll('[role="menuitem"]')
      .find((el) => el.textContent === 'Bulleted list')!;
    expect(disabled.getAttribute('aria-disabled')).toBe('true');

    const paragraph = submenu.querySelector('[aria-label="Paragraph"]')!;
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
    const submenu = doc.body.children.find((el) => el !== root && el.getAttribute('role') === 'menu')!;
    setBox(submenu, 210, 180);

    trigger.click();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(submenu.style.display).toBe('flex');
    expect(submenu.style.left).toBe('726px');
    expect(submenu.style.top).toBe('614px');
    expect(submenu.style.maxHeight).toBe('788px');
  });

  test('keeps a portal flyout reachable in a short viewport', () => {
    const doc = new TestDocument();
    const factory = loadMenu(doc, { height: 240 });
    const menu = factory.createMenu('Table cell actions');
    const root = menuRoot(doc);
    setBox(root, 280, 220);

    menu.openAt([
      {
        label: 'Table settings',
        enabled: true,
        submenu: Array.from({ length: 12 }, (_, index) => ({
          label: `Choice ${index + 1}`,
          enabled: true,
          onActivate: () => undefined,
        })),
      },
    ], 400, 180, { width: 280 });

    const trigger = root.querySelector('[aria-label="Table settings"]')!;
    setBox(trigger, 270, 28, { left: 400, top: 198, right: 670, bottom: 226, width: 270, height: 28 });
    const submenu = doc.body.children.find((el) => el !== root && el.getAttribute('role') === 'menu')!;
    setBox(submenu, 210, 400);
    trigger.click();

    expect(submenu.parentElement).toBe(doc.body);
    expect(submenu.style.maxHeight).toBe('228px');
    expect(submenu.style.top).toBe('6px');
  });

  test('keeps only one portal flyout open at a time', () => {
    const doc = new TestDocument();
    const menu = loadMenu(doc).createMenu('Table cell actions');
    menu.openAt([
      { label: 'Row', enabled: true, submenu: [{ label: 'Add row', enabled: true, onActivate: () => undefined }] },
      { label: 'Column', enabled: true, submenu: [{ label: 'Add column', enabled: true, onActivate: () => undefined }] },
    ], 100, 100, { width: 280 });
    const root = menuRoot(doc);
    const row = root.querySelector('[aria-label="Row"]')!;
    const column = root.querySelector('[aria-label="Column"]')!;
    const panels = doc.body.children.filter((el) => el !== root && el.getAttribute('role') === 'menu');

    row.click();
    expect(panels[0].style.display).toBe('flex');
    column.click();

    expect(panels[0].style.display).toBe('none');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(panels[1].style.display).toBe('flex');
    expect(column.getAttribute('aria-expanded')).toBe('true');
  });

  test('ArrowLeft closes a portal flyout and returns focus to its trigger', () => {
    const doc = new TestDocument();
    const menu = loadMenu(doc).createMenu('Table cell actions');
    menu.openAt([
      { label: 'Row', enabled: true, submenu: [{ label: 'Add row', enabled: true, onActivate: () => undefined }] },
    ], 100, 100, { width: 280 });
    const root = menuRoot(doc);
    const row = root.querySelector('[aria-label="Row"]')!;
    const panel = doc.body.children.find((el) => el !== root && el.getAttribute('role') === 'menu')!;

    row.focus();
    root.dispatch('keydown', keyEvent('ArrowRight'));
    expect(panel.style.display).toBe('flex');
    expect(doc.activeElement?.getAttribute('aria-label')).toBe('Add row');
    panel.dispatch('keydown', keyEvent('ArrowLeft'));

    expect(panel.style.display).toBe('none');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(doc.activeElement).toBe(row);
  });
});
