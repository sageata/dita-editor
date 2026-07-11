import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZED_ATTRIBUTE_MESSAGE_TYPES,
  historyCommandForOp,
  isAuthorizedAttributeMessageType,
  isRangeActionType,
} from '../src/webview/canvas-messages';

describe('canvas message protocol helpers', () => {
  test('maps webview history ops to VS Code commands', () => {
    expect(historyCommandForOp('undo')).toBe('undo');
    expect(historyCommandForOp('redo')).toBe('redo');
    expect(historyCommandForOp('find')).toBe('editor.action.webvieweditor.showFind');
  });

  test('rejects unknown history ops', () => {
    expect(historyCommandForOp('save')).toBeNull();
    expect(historyCommandForOp(undefined)).toBeNull();
  });

  test('recognizes host-supported range actions only', () => {
    expect(isRangeActionType('rangeDelete')).toBe(true);
    expect(isRangeActionType('cellRectMerge')).toBe(true);
    expect(isRangeActionType('cellClear')).toBe(true);
    expect(isRangeActionType('cellTextReplace')).toBe(true);
    expect(isRangeActionType('deleteRow')).toBe(false);
    expect(isRangeActionType(null)).toBe(false);
  });

  test('exposes only the explicit authorized attribute message families', () => {
    for (const type of AUTHORIZED_ATTRIBUTE_MESSAGE_TYPES) {
      expect(isAuthorizedAttributeMessageType(type)).toBe(true);
    }
    expect(isAuthorizedAttributeMessageType('setAttr')).toBe(false);
    expect(isAuthorizedAttributeMessageType('setAttrMulti')).toBe(false);
    expect(isAuthorizedAttributeMessageType('setArbitraryAttr')).toBe(false);
  });
});
