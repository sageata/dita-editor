import { describe, expect, test } from 'bun:test';
import { createVisualRenderState } from '../src/host/render-state';

const validTopic = `<?xml version="1.0" encoding="UTF-8"?>
<topic id="t">
  <title>Render State</title>
  <body>
    <p>Hello</p>
  </body>
</topic>`;

describe('createVisualRenderState', () => {
  test('renders editable HTML and exposes state maps from the same parsed document', () => {
    const renderState = createVisualRenderState({ getText: () => validTopic }, 'img-v1');

    const body = renderState.renderBody();
    const snapshot = renderState.snapshot();

    expect(body).toContain('contenteditable="true"');
    expect(body).toContain('Hello');
    expect(Object.keys(snapshot.navMap).length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.cmdMap).length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.transformMap).length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.insertMap).length).toBeGreaterThan(0);
    expect(snapshot.docProps).not.toBeNull();
  });

  test('clears state maps and returns a parse-error body when parsing fails', () => {
    const logged: unknown[] = [];
    let source = validTopic;
    const renderState = createVisualRenderState(
      { getText: () => source },
      'img-v1',
      (_message, error) => {
        logged.push(error);
      },
    );
    renderState.renderBody();

    source = '<topic><title>Broken</title><body><p>Missing close</body></topic>';
    const body = renderState.renderBody();
    const snapshot = renderState.snapshot();

    expect(body).toContain('class="dita-parse-error"');
    expect(Object.keys(snapshot.navMap)).toEqual([]);
    expect(Object.keys(snapshot.cmdMap)).toEqual([]);
    expect(Object.keys(snapshot.transformMap)).toEqual([]);
    expect(Object.keys(snapshot.insertMap)).toEqual([]);
    expect(snapshot.docProps).toBeNull();
    expect(logged.length).toBe(1);
  });
});
