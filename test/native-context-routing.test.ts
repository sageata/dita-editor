import { describe, expect, test } from 'bun:test';
import {
  createNativeContextExecutionGate,
  isFreshNativeContextMessage,
  nativeContextCommandIds,
  routeNativeContextCommand,
  withoutNativeContextTransportMetadata,
} from '../src/host/native-context-routing';

describe('native context command routing', () => {
  test('discovers only internal native context commands from the manifest', () => {
    expect(nativeContextCommandIds({ contributes: { commands: [
      { command: 'ditaeditor.context.image.alt' },
      { command: 'ditaeditor.openVisual' },
      null,
    ] } })).toEqual(['ditaeditor.context.image.alt']);
  });

  test('routes a command only to its originating live webview session', () => {
    const received: unknown[] = [];
    const endpoints = new Map([['session-a', { postMessage: (message: unknown) => received.push(message) }]]);
    const context = { webview: 'ditaeditor.visual', ditaNativeSession: 'session-a', ditaNativeTargetId: 'p1' };
    expect(routeNativeContextCommand('ditaeditor.context.delete.p', context, endpoints)).toEqual({ ok: true });
    expect(received).toEqual([{ type: 'nativeContextCommand', command: 'ditaeditor.context.delete.p', context }]);
  });

  test('rejects missing, foreign, and disposed-session arguments', () => {
    const endpoints = new Map<string, { postMessage(message: unknown): unknown }>();
    expect(routeNativeContextCommand('ditaeditor.context.delete.p', null, endpoints)).toEqual({ ok: false, reason: 'missing-context' });
    expect(routeNativeContextCommand('ditaeditor.context.delete.p', { webview: 'other', ditaNativeSession: 's' }, endpoints)).toEqual({ ok: false, reason: 'foreign-context' });
    expect(routeNativeContextCommand('ditaeditor.context.delete.p', { webview: 'ditaeditor.visual', ditaNativeSession: 'gone' }, endpoints)).toEqual({ ok: false, reason: 'unknown-session' });
  });

  test('accepts only the current native session and render generation', () => {
    expect(isFreshNativeContextMessage({}, 'session-a', 4)).toBe(true);
    expect(isFreshNativeContextMessage({ nativeContextSession: 'session-a', baseStructVersion: 4 }, 'session-a', 4)).toBe(true);
    expect(isFreshNativeContextMessage({ nativeContextSession: 'session-b', baseStructVersion: 4 }, 'session-a', 4)).toBe(false);
    expect(isFreshNativeContextMessage({ nativeContextSession: 'session-a', baseStructVersion: 3 }, 'session-a', 4)).toBe(false);
  });

  test('removes only verified native transport metadata before strict payload authorization', () => {
    const original = {
      type: 'setCalsAttr', id: 'table1', attrName: 'frame', attrValue: 'all',
      baseStructVersion: 4, nativeContextSession: 'session-a',
    };
    expect(withoutNativeContextTransportMetadata(original)).toEqual({
      type: 'setCalsAttr', id: 'table1', attrName: 'frame', attrValue: 'all', baseStructVersion: 4,
    });
    expect(original.nativeContextSession).toBe('session-a');
  });

  test('refuses a queued native action after an earlier action advances the generation', () => {
    let generation = 4;
    let refused = 0;
    let secondExecuted = false;
    const message = { nativeContextSession: 'session-a', baseStructVersion: 4 };
    const first = createNativeContextExecutionGate(message, 'session-a', () => generation, () => refused++);
    const second = createNativeContextExecutionGate(message, 'session-a', () => generation, () => refused++);

    first.run(() => { generation++; });
    second.run(() => { secondExecuted = true; });

    expect(secondExecuted).toBe(false);
    expect(refused).toBe(1);
  });
});
