import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');
const extension = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');

describe('scroll-preserving editor switch wiring', () => {
  test('provider retains visual anchors and delivers one queued restore through navready', () => {
    expect(provider).toContain("msg.type === 'scrollAnchor'");
    expect(provider).toContain('rememberVisualAnchor');
    expect(provider).toContain('consumeVisualRestore');
    expect(provider).toContain("type: 'scrollToAnchor'");
  });

  test('source switching uses the opening tag and reveals it at the top', () => {
    expect(extension).toContain('openingTagOffsetForAnchor');
    expect(extension).toContain('revealRange');
    expect(extension).toContain('vscode.TextEditorRevealType.AtTop');
  });

  test('visual switching captures the first visible source position before reopening', () => {
    expect(extension).toContain('visibleRanges[0]?.start');
    expect(extension).toContain('anchorAtSourceOffset');
    expect(extension).toContain('queueVisualRestore');
  });

  test('duplicate split editors use the active or reopened editor column', () => {
    expect(extension).toContain('vscode.window.tabGroups.activeTabGroup');
    expect(extension).toContain('editor.viewColumn === preferredColumn');
    expect(extension).toContain('visibleSourceEditor(target, reopenedColumn)');
  });

  test('a missing restored DOM anchor is reported back to the host', () => {
    expect(canvas).toContain("type: 'scrollRestoreFailed'");
    expect(provider).toContain("msg.type === 'scrollRestoreFailed'");
    expect(provider).toContain('showWarningMessage');
  });
});
