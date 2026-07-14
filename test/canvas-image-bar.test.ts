import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, keyEvent } from './canvas-test-dom';

function installImageBar(insideTable = false) {
  const source = readFileSync(new URL('../media/canvas-image-bar.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');

  const win = {} as {
    DitaEditorCanvasImageBar: {
      installImageBar: (opts: Record<string, unknown>) => ImageBar;
    };
  };
  const doc = new TestDocument();
  const image = doc.createElement('img');
  image.setAttribute('data-struct-id', 'i1');
  if (insideTable) {
    const cell = doc.createElement('td');
    cell.setAttribute('data-cell-id', 'entry1');
    doc.main.appendChild(cell);
    cell.appendChild(image);
  } else {
    doc.main.appendChild(image);
  }
  const posted: unknown[] = [];
  const announcements: string[] = [];
  const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  let selection: unknown = null;
  image.getBoundingClientRect = () => ({ left: 120, top: 40, right: 320, bottom: 140, width: 200, height: 100 }) as never;

  new Function('window', source)(win);
  const bar = win.DitaEditorCanvasImageBar.installImageBar({
    document: doc,
    window: {
      scrollX: 0,
      scrollY: 0,
      innerWidth: 1200,
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      },
    },
    vscode: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    },
    makeBtn: (text: string, label: string) => {
      const btn = doc.createElement('button');
      btn.textContent = text;
      btn.setAttribute('aria-label', label);
      return btn;
    },
    getSelection: () => selection,
    resolveMember: (_main: TestElement, unit: string, id: string) => (unit === 'image' && id === 'i1' ? image : null),
    getStructVersion: () => 7,
    announceNav: (message: string) => {
      announcements.push(message);
    },
  });

  const toolbar = doc.body.children[1];
  const changeButton = toolbar.children[0];
  const altButton = toolbar.children[1];
  const resizeButton = toolbar.children[2];
  const alignLeftButton = toolbar.children[3];
  const alignCenterButton = toolbar.children[4];
  const alignRightButton = toolbar.children[5];
  const alignTopButton = toolbar.children[6];
  const alignMiddleButton = toolbar.children[7];
  const alignBottomButton = toolbar.children[8];
  const resizeHandle = doc.body.children[2];
  return {
    bar,
    doc,
    toolbar,
    changeButton,
    altButton,
    resizeButton,
    alignLeftButton,
    alignCenterButton,
    alignRightButton,
    alignTopButton,
    alignMiddleButton,
    alignBottomButton,
    resizeHandle,
    posted: () => posted,
    announcements: () => announcements,
    dispatchWindow: (type: string, event: Record<string, unknown>) => {
      for (const listener of windowListeners.get(type) ?? []) listener(event);
    },
    selectImage: () => {
      selection = { mode: 'single', unit: 'image', id: 'i1' };
    },
    clearSelection: () => {
      selection = null;
    },
  };
}

interface ImageBar {
  hide(): void;
  update(): void;
  isShown(): boolean;
  focusChangeButton(): void;
}

describe('canvas-image-bar', () => {
  test('shows a selected image toolbar with one roving tab stop', () => {
    const { bar, doc, toolbar, changeButton, altButton, resizeButton, announcements, selectImage } = installImageBar();
    selectImage();

    bar.update();
    bar.focusChangeButton();

    expect(bar.isShown()).toBe(true);
    expect(toolbar.style.display).toBe('flex');
    expect(changeButton.tabIndex).toBe(0);
    expect(altButton.tabIndex).toBe(-1);
    expect(resizeButton.tabIndex).toBe(-1);
    expect(doc.activeElement).toBe(changeButton);
    expect(announcements()).toEqual(['Change image']);
  });

  test('posts the selected image id when Resize image is activated', () => {
    const { bar, toolbar, resizeButton, posted, selectImage } = installImageBar();
    selectImage();
    bar.update();
    resizeButton.dispatch('click', {});

    expect(toolbar.getAttribute('aria-label')).toBe('Image editing controls');
    expect(resizeButton.getAttribute('aria-label')).toBe('Resize image');
    expect(posted()).toEqual([{ type: 'resizeImage', id: 'i1' }]);
  });

  test('offers horizontal alignment for any image and targets the image outside tables', () => {
    const { bar, alignLeftButton, alignCenterButton, alignRightButton, posted, selectImage } = installImageBar();
    selectImage();
    bar.update();

    expect(alignLeftButton.getAttribute('aria-label')).toBe('Align image left');
    expect(alignCenterButton.getAttribute('aria-label')).toBe('Align image center');
    expect(alignRightButton.getAttribute('aria-label')).toBe('Align image right');
    expect(alignCenterButton.textContent).toBe('C');
    alignCenterButton.dispatch('click', {});

    expect(posted()).toEqual([{ type: 'setImageAlign', id: 'i1', align: 'center' }]);
  });

  test('targets the enclosing entry for table image horizontal and vertical alignment', () => {
    const fixture = installImageBar(true);
    fixture.selectImage();
    fixture.bar.update();

    expect(fixture.alignTopButton.style.display).not.toBe('none');
    expect(fixture.alignMiddleButton.getAttribute('aria-label')).toBe('Align image vertically middle');
    fixture.alignRightButton.dispatch('click', {});
    fixture.alignMiddleButton.dispatch('click', {});

    expect(fixture.posted()).toEqual([
      { type: 'setImageAlign', id: 'i1', align: 'right' },
      { type: 'setCalsAttr', id: 'entry1', attrName: 'valign', attrValue: 'middle', baseStructVersion: 7 },
    ]);
  });

  test('hides vertical alignment controls outside tables', () => {
    const { bar, alignTopButton, alignMiddleButton, alignBottomButton, selectImage } = installImageBar();
    selectImage();
    bar.update();

    expect(alignTopButton.style.display).toBe('none');
    expect(alignMiddleButton.style.display).toBe('none');
    expect(alignBottomButton.style.display).toBe('none');
  });

  test('shows a drag handle and persists the dragged pixel width', () => {
    const { bar, resizeHandle, posted, selectImage, dispatchWindow } = installImageBar();
    selectImage();
    bar.update();

    expect(resizeHandle.getAttribute('aria-label')).toBe('Drag to resize image');
    expect(resizeHandle.style.display).toBe('block');
    resizeHandle.dispatch('mousedown', {
      button: 0,
      clientX: 320,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    dispatchWindow('mousemove', { clientX: 380, preventDefault: () => undefined });
    dispatchWindow('mouseup', { clientX: 380 });

    expect(posted()).toEqual([{ type: 'setImageWidth', id: 'i1', width: '260px' }]);
  });

  test('converts visual drag pixels to authored pixels when the canvas is zoomed', () => {
    const { bar, doc, resizeHandle, posted, selectImage, dispatchWindow } = installImageBar();
    doc.main.style.zoom = '2';
    selectImage();
    bar.update();

    resizeHandle.dispatch('mousedown', {
      button: 0,
      clientX: 320,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    dispatchWindow('mousemove', { clientX: 380, preventDefault: () => undefined });
    dispatchWindow('mouseup', { clientX: 380 });

    expect(posted()).toEqual([{ type: 'setImageWidth', id: 'i1', width: '130px' }]);
  });

  test('roves and activates image controls from the keyboard', () => {
    const { bar, doc, toolbar, changeButton, altButton, posted, announcements, selectImage } = installImageBar();
    selectImage();
    bar.update();
    bar.focusChangeButton();

    const right = keyEvent('ArrowRight');
    toolbar.dispatch('keydown', right);
    expect(right.prevented).toBe(true);
    expect(right.stopped).toBe(true);
    expect(doc.activeElement).toBe(altButton);
    expect(changeButton.tabIndex).toBe(-1);
    expect(altButton.tabIndex).toBe(0);

    const enter = keyEvent('Enter');
    toolbar.dispatch('keydown', enter);
    expect(enter.prevented).toBe(true);
    expect(enter.stopped).toBe(true);
    expect(posted()).toEqual([{ type: 'editImageAlt', id: 'i1' }]);

    const home = keyEvent('Home');
    toolbar.dispatch('keydown', home);
    const space = keyEvent(' ');
    toolbar.dispatch('keydown', space);

    expect(doc.activeElement).toBe(changeButton);
    expect(posted()).toEqual([
      { type: 'editImageAlt', id: 'i1' },
      { type: 'pickImage', id: 'i1' },
    ]);
    expect(announcements()).toEqual(['Change image', 'Edit image alt text', 'Change image']);
  });

  test('hides and removes tab stops when the image selection clears', () => {
    const { bar, toolbar, changeButton, altButton, resizeButton, resizeHandle, selectImage, clearSelection } = installImageBar();
    selectImage();
    bar.update();
    clearSelection();

    bar.update();

    expect(bar.isShown()).toBe(false);
    expect(toolbar.style.display).toBe('none');
    expect(changeButton.tabIndex).toBe(-1);
    expect(altButton.tabIndex).toBe(-1);
    expect(resizeButton.tabIndex).toBe(-1);
    expect(resizeHandle.style.display).toBe('none');
  });
});
