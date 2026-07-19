import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');

describe('canvas scroll anchor wiring', () => {
  test('reports initial and rerender positions and handles one-shot host restoration', () => {
    expect(source).toContain('DitaEditorCanvasScrollAnchor.create');
    expect(source).toContain('scrollAnchor.start()');
    expect(source).toContain('scrollAnchor.didRerender()');
    expect(source).toContain("msg.type === 'scrollToAnchor'");
    expect(source).toContain("scrollAnchor.restore(msg.id, msg.highlight ? 'center' : 'start')");
  });
});
