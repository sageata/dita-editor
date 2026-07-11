import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, type TestListener } from './canvas-test-dom';

interface TestWindow {
  innerWidth: number;
  listeners: Map<string, TestListener[]>;
  addEventListener(type: string, listener: TestListener): void;
  removeEventListener(type: string, listener: TestListener): void;
  dispatch(type: string, event: Record<string, unknown>): void;
}

function makeWindow(innerWidth = 1800): TestWindow {
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

function loadPanels() {
  const propertiesSource = readFileSync(new URL('../media/canvas-properties.js', import.meta.url), 'utf8');
  const stylesSource = readFileSync(new URL('../media/canvas-styles.js', import.meta.url), 'utf8');
  const win = {} as {
    DitaEditorCanvasProperties: {
      installPropertiesPanel(opts: Record<string, unknown>): {
        hideButton: { click(): void };
        showButton: { click(): void };
      };
    };
    DitaEditorCanvasStyles: {
      installStylesPanel(opts: Record<string, unknown>): {
        hideButton: { click(): void };
        showButton: { click(): void };
      };
    };
  };
  const doc = new TestDocument();
  const liveStyle = doc.createElement('style');
  liveStyle.id = 'ditaeditor-author-styles-live';
  doc.body.appendChild(liveStyle);
  const managedStyleData = doc.createElement('script');
  managedStyleData.id = 'ditaeditor-managed-style-data';
  managedStyleData.textContent = JSON.stringify({ consumer: 'canvas', cssText: '' });
  doc.body.appendChild(managedStyleData);
  const testWindow = makeWindow();
  new Function('window', propertiesSource)(win);
  new Function('window', stylesSource)(win);
  const properties = win.DitaEditorCanvasProperties.installPropertiesPanel({
    document: doc,
    window: testWindow,
    vscode: { postMessage: () => undefined },
    fontFamily: 'sans-serif',
    getDocProps: () => null,
    nounForKind: (kind: string) => kind || 'topic',
  });
  const styles = win.DitaEditorCanvasStyles.installStylesPanel({
    document: doc,
    window: testWindow,
    vscode: { postMessage: () => undefined },
    fontFamily: 'sans-serif',
    saveRequestSessionId: 'side-panel-layout-test-session',
    getStyleState: () => ({ styles: [], cssText: '', writable: true }),
    getCurrentTarget: () => null,
    announceNav: () => undefined,
  });
  return { doc, properties, styles };
}

describe('side panel layout reserves', () => {
  test('both panels start hidden by default, and showing them expands the editor box instead of narrowing document content', () => {
    const { doc, properties, styles } = loadPanels();

    expect(doc.main.style.paddingLeft).toBe('36px');
    expect(doc.main.style.paddingRight).toBe('36px');
    expect(doc.main.style.minWidth).toBe('1112px');
    expect(doc.main.style.maxWidth).toBe('1112px');

    properties.showButton.click();

    expect(doc.main.style.paddingLeft).toBe('308px');
    expect(doc.main.style.paddingRight).toBe('36px');
    expect(doc.main.style.minWidth).toBe('1384px');
    expect(doc.main.style.maxWidth).toBe('1384px');

    styles.showButton.click();

    expect(doc.main.style.paddingLeft).toBe('308px');
    expect(doc.main.style.paddingRight).toBe('308px');
    expect(doc.main.style.minWidth).toBe('1656px');
    expect(doc.main.style.maxWidth).toBe('1656px');

    properties.hideButton.click();
    styles.hideButton.click();

    expect(doc.main.style.paddingLeft).toBe('36px');
    expect(doc.main.style.paddingRight).toBe('36px');
    expect(doc.main.style.minWidth).toBe('1112px');
    expect(doc.main.style.maxWidth).toBe('1112px');
  });
});
