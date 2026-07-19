// Cross-file contract for the Styles-view live-selection pipeline. The apply
// guard ("Select an element before applying a style") fires whenever ANY link
// in bridge → provider → hub → view breaks, and no single-file unit test spans
// them — this pin does. It exists because the provider's styleTargetState
// inbound case was once missing entirely and every apply silently blocked.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../media/canvas-style-bridge.js', import.meta.url), 'utf8');
const stylesView = readFileSync(new URL('../media/styles-view.js', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../media/canvas.js', import.meta.url), 'utf8');

describe('styles view live-target pipeline', () => {
  test('the bridge publishes styleTargetState and the canvas re-emits on request', () => {
    expect(bridge).toContain("type: 'styleTargetState'");
    expect(canvas).toContain("msg.type === 'requestStyleTargetState'");
    expect(canvas).toContain('styleBridge.emitTargetState()');
  });

  test('the provider accepts styleTargetState and feeds the inspector hub', () => {
    expect(provider).toContain("msg.type === 'styleTargetState'");
    const handler = provider.slice(provider.indexOf("msg.type === 'styleTargetState'"));
    expect(handler.slice(0, 800)).toContain('this.host.inspectors.update(visualPanelKey');
  });

  test('the view resolves its apply target from the hub-fed snapshot', () => {
    expect(stylesView).toContain('getCurrentTarget: () => (cache.targetState ? cache.targetState.target : null)');
    expect(stylesView).toContain('getStructVersion: () => (cache.targetState ? cache.targetState.structVersion : 0)');
  });
});
