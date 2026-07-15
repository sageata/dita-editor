import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { TestDocument, TestElement, TestText } from './canvas-test-dom';

function loadHelper() {
  const metricsSource = readFileSync(new URL('../media/canvas-text-metrics.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../media/canvas-command-structure.js', import.meta.url), 'utf8');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasTextMetrics: unknown;
    DitaEditorCanvasCommandStructure: {
      hasMultiListItemSelection(selection: unknown): boolean;
      isCaretBeforeEnd(current: unknown): boolean;
      isSameStructureInNote(op: string, current: unknown): boolean;
      isEditingBeforeEnd(current: unknown): boolean;
      listKindTransformForCurrent(transform: string, current: unknown): string;
      selectedListItemIds(selection: unknown): string[];
      selectedListStyles(document: TestDocument, windowObj: unknown, ids: string[]): string[];
      selectedListTags(document: TestDocument, windowObj: unknown, ids: string[]): string[];
      sourceTextLength(el: TestElement): number;
      structureTransformFor(op: string, current: unknown): string | null;
      structureTransformLabel(op: string, transform: string): string;
    };
  };
  new Function('window', metricsSource)(win);
  new Function('window', source)(win);
  return win.DitaEditorCanvasCommandStructure;
}

describe('canvas-command-structure', () => {
  test('maps mid-text structure buttons to transforms instead of inserts', () => {
    const helper = loadHelper();
    const paragraph = { id: 'e1', kind: 'p', isCollapsed: true, caretOffset: 3, textLength: 8 };
    const item = { id: 'e2', kind: 'li', isCollapsed: true, caretOffset: 3, textLength: 8 };
    const entry = { id: 'e3', kind: 'entry', isCollapsed: true, caretOffset: 8, textLength: 8 };

    expect(helper.isCaretBeforeEnd(paragraph)).toBe(true);
    expect(helper.structureTransformFor('unorderedList', paragraph)).toBe('paragraphToUnorderedList');
    expect(helper.structureTransformFor('alphabeticList', paragraph)).toBe('paragraphToAlphabeticList');
    expect(helper.structureTransformFor('orderedList', paragraph)).toBe('paragraphToOrderedList');
    expect(helper.structureTransformFor('section', paragraph)).toBe('paragraphToSection');
    expect(helper.structureTransformFor('note', paragraph)).toBe('paragraphToNote');
    expect(helper.structureTransformFor('codeblock', paragraph)).toBe('paragraphToCodeblock');
    expect(helper.structureTransformFor('paragraph', item)).toBe('itemToParagraph');
    expect(helper.structureTransformFor('unorderedList', item)).toBe('toUnorderedList');
    expect(helper.structureTransformFor('alphabeticList', item)).toBe('toAlphabeticList');
    expect(helper.structureTransformFor('orderedList', item)).toBe('toOrderedList');
    expect(helper.structureTransformFor('paragraph', entry)).toBe('entryToParagraph');
    expect(helper.structureTransformFor('unorderedList', entry)).toBe('entryToUnorderedList');
    expect(helper.structureTransformFor('alphabeticList', entry)).toBe('entryToAlphabeticList');
    expect(helper.structureTransformFor('orderedList', entry)).toBe('entryToOrderedList');
    expect(helper.structureTransformFor('lines', entry)).toBe('entryToLines');
    expect(helper.structureTransformFor('note', entry)).toBe('entryToNote');
    expect(helper.structureTransformFor('codeblock', entry)).toBe('entryToCodeblock');
  });

  test('maps selected text structure buttons to transforms instead of inserts', () => {
    const helper = loadHelper();
    const selectedParagraph = { id: 'e1', kind: 'p', isCollapsed: false, caretOffset: 8, textLength: 8 };

    expect(helper.isCaretBeforeEnd(selectedParagraph)).toBe(false);
    expect(helper.isEditingBeforeEnd(selectedParagraph)).toBe(true);
    expect(helper.structureTransformFor('unorderedList', selectedParagraph)).toBe('paragraphToUnorderedList');
    expect(helper.structureTransformFor('alphabeticList', selectedParagraph)).toBe('paragraphToAlphabeticList');
    expect(helper.structureTransformFor('section', selectedParagraph)).toBe('paragraphToSection');
  });

  test('maps direct and mixed note prose to in-place content transforms', () => {
    const helper = loadHelper();
    const direct = { id: 'e1', editId: 'e1', kind: 'note', isCollapsed: true, caretOffset: 11, textLength: 11 };
    const mixed = { id: 'e1', editId: 'e1:t0', kind: 'note', isCollapsed: true, caretOffset: 3, textLength: 11 };

    for (const note of [direct, mixed]) {
      expect(helper.structureTransformFor('paragraph', note)).toBe('noteContentToParagraph');
      expect(helper.structureTransformFor('unorderedList', note)).toBe('noteContentToUnorderedList');
      expect(helper.structureTransformFor('alphabeticList', note)).toBe('noteContentToAlphabeticList');
      expect(helper.structureTransformFor('orderedList', note)).toBe('noteContentToOrderedList');
      expect(helper.structureTransformFor('lines', note)).toBe('noteContentToLines');
      expect(helper.structureTransformFor('codeblock', note)).toBe('noteContentToCodeblock');
    }
  });

  test('keeps structure actions on the current paragraph at the end caret inside a note', () => {
    const helper = loadHelper();
    const noteParagraph = {
      id: 'e2', kind: 'p', insideNote: true,
      isCollapsed: true, caretOffset: 8, textLength: 8,
    };

    expect(helper.structureTransformFor('unorderedList', noteParagraph)).toBe('paragraphToUnorderedList');
    expect(helper.structureTransformFor('alphabeticList', noteParagraph)).toBe('paragraphToAlphabeticList');
    expect(helper.structureTransformFor('orderedList', noteParagraph)).toBe('paragraphToOrderedList');
    expect(helper.structureTransformFor('codeblock', noteParagraph)).toBe('paragraphToCodeblock');
    expect(helper.isSameStructureInNote('paragraph', noteParagraph)).toBe(true);
    expect(helper.isSameStructureInNote('paragraph', { ...noteParagraph, insideNote: false })).toBe(false);
  });

  test('does not transform when the caret is at the end or the target is unsupported', () => {
    const helper = loadHelper();

    expect(helper.isCaretBeforeEnd({ id: 'e1', kind: 'p', isCollapsed: true, caretOffset: 8, textLength: 8 })).toBe(false);
    expect(helper.isEditingBeforeEnd({ id: 'e1', kind: 'p', isCollapsed: true, caretOffset: 8, textLength: 8 })).toBe(false);
    expect(helper.structureTransformFor('unorderedList', { id: 'e1', kind: 'p', isCollapsed: true, caretOffset: 8, textLength: 8 })).toBeNull();
    expect(helper.structureTransformFor('note', { id: 'e2', kind: 'li', isCollapsed: true, caretOffset: 1, textLength: 3 })).toBeNull();
    expect(helper.structureTransformFor('orderedList', { id: null, kind: 'p', isCollapsed: true, caretOffset: 1, textLength: 3 })).toBeNull();
  });

  test('source text length ignores render-only conref labels for end-caret decisions', () => {
    const helper = loadHelper();
    const root = new TestElement('p');
    const chip = new TestElement('span', undefined, { 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' });
    root.append(new TestText('a '), chip, new TestText(' b'));
    chip.append(new TestText('reuse.dita#r/x'));

    expect(root.textContent.length).toBeGreaterThan(4);
    expect(helper.sourceTextLength(root)).toBe(4);
    expect(helper.isCaretBeforeEnd({
      id: 'e1',
      kind: 'p',
      isCollapsed: true,
      caretOffset: 4,
      textLength: helper.sourceTextLength(root),
    })).toBe(false);
  });

  test('labels structure transforms for toolbar affordances', () => {
    const helper = loadHelper();

    expect(helper.structureTransformLabel('paragraph', 'itemToParagraph')).toBe('Convert to paragraph');
    expect(helper.structureTransformLabel('paragraph', 'entryToParagraph')).toBe('Convert to paragraph');
    expect(helper.structureTransformLabel('unorderedList', 'paragraphToUnorderedList')).toBe('Convert to bulleted list');
    expect(helper.structureTransformLabel('unorderedList', 'entryToUnorderedList')).toBe('Convert to bulleted list');
    expect(helper.structureTransformLabel('alphabeticList', 'paragraphToAlphabeticList')).toBe('Convert to alphabetic list');
    expect(helper.structureTransformLabel('alphabeticList', 'entryToAlphabeticList')).toBe('Convert to alphabetic list');
    expect(helper.structureTransformLabel('orderedList', 'toOrderedList')).toBe('Convert to numbered list');
    expect(helper.structureTransformLabel('lines', 'entryToLines')).toBe('Convert to lines');
    expect(helper.structureTransformLabel('section', 'paragraphToSection')).toBe('Convert to section');
    expect(helper.structureTransformLabel('note', 'paragraphToNote')).toBe('Convert to note');
    expect(helper.structureTransformLabel('note', 'entryToNote')).toBe('Convert to note');
    expect(helper.structureTransformLabel('codeblock', 'paragraphToCodeblock')).toBe('Convert to code block');
    expect(helper.structureTransformLabel('codeblock', 'entryToCodeblock')).toBe('Convert to code block');
    expect(helper.structureTransformLabel('paragraph', 'noteContentToParagraph')).toBe('Convert to paragraph');
    expect(helper.structureTransformLabel('unorderedList', 'noteContentToUnorderedList')).toBe('Convert to bulleted list');
    expect(helper.structureTransformLabel('alphabeticList', 'noteContentToAlphabeticList')).toBe('Convert to alphabetic list');
    expect(helper.structureTransformLabel('orderedList', 'noteContentToOrderedList')).toBe('Convert to numbered list');
    expect(helper.structureTransformLabel('lines', 'noteContentToLines')).toBe('Convert to lines');
    expect(helper.structureTransformLabel('codeblock', 'noteContentToCodeblock')).toBe('Convert to code block');
  });

  test('resolves convert-list buttons to paragraph wrapping transforms for paragraph targets', () => {
    const helper = loadHelper();

    expect(helper.listKindTransformForCurrent('toUnorderedList', { id: 'e1', kind: 'p' })).toBe(
      'paragraphToUnorderedList',
    );
    expect(helper.listKindTransformForCurrent('toOrderedList', { id: 'e1', kind: 'p' })).toBe(
      'paragraphToOrderedList',
    );
    expect(helper.listKindTransformForCurrent('toAlphabeticList', { id: 'e1', kind: 'p' })).toBe(
      'paragraphToAlphabeticList',
    );
    expect(helper.listKindTransformForCurrent('toUnorderedList', { id: 'e2', kind: 'li' })).toBe(
      'toUnorderedList',
    );
    expect(helper.listKindTransformForCurrent('toUnorderedList', { id: 'e3', kind: 'entry' })).toBe(
      'entryToUnorderedList',
    );
    expect(helper.listKindTransformForCurrent('toOrderedList', { id: 'e3', kind: 'entry' })).toBe(
      'entryToOrderedList',
    );
    expect(helper.listKindTransformForCurrent('toAlphabeticList', { id: 'e3', kind: 'entry' })).toBe(
      'entryToAlphabeticList',
    );
  });

  test('derives selected list item ids only for list-item selections', () => {
    const helper = loadHelper();

    expect(helper.selectedListItemIds({ mode: 'single', unit: 'block', kind: 'li', id: 'e1' })).toEqual(['e1']);
    expect(helper.selectedListItemIds({ mode: 'single', unit: 'block', kind: 'p', id: 'e2' })).toEqual([]);
    expect(helper.selectedListItemIds({ mode: 'blockRange', kind: 'li', members: [{ id: 'e1' }, { id: 'e2' }] })).toEqual(['e1', 'e2']);
    expect(helper.selectedListItemIds({ mode: 'blockRange', kind: 'p', members: [{ id: 'e1' }] })).toEqual([]);
    expect(helper.selectedListItemIds({
      mode: 'multiSet',
      units: [
        { unit: 'block', kind: 'li', id: 'e1' },
        { unit: 'block', kind: 'li', id: 'e2' },
      ],
    })).toEqual(['e1', 'e2']);
    expect(helper.selectedListItemIds({
      mode: 'multiSet',
      units: [
        { unit: 'block', kind: 'li', id: 'e1' },
        { unit: 'block', kind: 'p', id: 'e2' },
      ],
    })).toEqual([]);
  });

  test('marks only multi list-item selections as batch-list transforms', () => {
    const helper = loadHelper();

    expect(helper.hasMultiListItemSelection({ mode: 'single', unit: 'block', kind: 'li', id: 'e1' })).toBe(false);
    expect(helper.hasMultiListItemSelection({ mode: 'blockRange', kind: 'li', members: [{ id: 'e1' }, { id: 'e2' }] })).toBe(true);
    expect(helper.hasMultiListItemSelection({ mode: 'multiSet', units: [{ unit: 'block', kind: 'li', id: 'e1' }] })).toBe(true);
    expect(helper.hasMultiListItemSelection({ mode: 'multiSet', units: [{ unit: 'block', kind: 'p', id: 'e1' }] })).toBe(false);
  });

  test('reads selected list tags from the DOM by struct id', () => {
    const helper = loadHelper();
    const doc = new TestDocument();
    const ul = new TestElement('ul');
    const ol = new TestElement('ol');
    const first = new TestElement('li', undefined, { 'data-struct-id': 'e1' });
    const second = new TestElement('li', undefined, { 'data-struct-id': 'e2' });
    ul.appendChild(first);
    ol.appendChild(second);
    doc.main.append(ul, ol);

    expect(helper.selectedListTags(doc, {}, ['e1', 'e2'])).toEqual(['ul', 'ol']);
  });

  test('reads selected list marker styles from DOM outputclass/class markers', () => {
    const helper = loadHelper();
    const doc = new TestDocument();
    const ul = new TestElement('ul');
    const alpha = new TestElement('ol', undefined, { 'data-outputclass': 'lower-alpha' });
    const ordered = new TestElement('ol');
    const first = new TestElement('li', undefined, { 'data-struct-id': 'e1' });
    const second = new TestElement('li', undefined, { 'data-struct-id': 'e2' });
    const third = new TestElement('li', undefined, { 'data-struct-id': 'e3' });
    ul.appendChild(first);
    alpha.appendChild(second);
    ordered.appendChild(third);
    doc.main.append(ul, alpha, ordered);

    expect(helper.selectedListStyles(doc, {}, ['e1', 'e2', 'e3'])).toEqual(['unordered', 'alpha', 'ordered']);
  });
});
