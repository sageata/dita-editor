import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('../media/canvas-command-bar.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../media/canvas-command-bar-ui.js', import.meta.url), 'utf8');

describe('canvas-command-bar source contract', () => {
  test('exposes paragraph insertion as a first-class persistent Structure command', () => {
    expect(uiSource).toContain("const biParagraph = makeBarBtn(menuIcons.paragraph, 'Paragraph', true);");
    expect(uiSource).toContain('structGroup.row.append(biParagraph, biSection, biList, aiList, niList, biLines, biNote, biCode, biIndent, biOutdent);');
    expect(uiSource).toContain('biParagraph, biSection, biList, aiList, niList, biLines, biNote, biCode, biIndent, biOutdent, biTable');
    expect(source).toContain("biParagraph._barRun = function () { runStructureAction('paragraph'); };");
    expect(source).toContain("{ b: biParagraph, op: 'paragraph', label: 'Insert paragraph after' },");
  });

  test('routes structure buttons through transform-before-end behavior', () => {
    expect(source).toContain('const commandStructure = window.DitaEditorCanvasCommandStructure;');
    expect(source).toContain('const current = refreshBarCurrent();');
    expect(source).toContain('commandStructure.structureTransformFor(op, current)');
    expect(source).toContain('Move the caret to the end to insert here');
    expect(source).toContain("biList._barRun = function () { runStructureAction('unorderedList'); };");
    expect(source).toContain("aiList._barRun = function () { runStructureAction('alphabeticList'); };");
    expect(source).toContain('const transform = commandStructure.structureTransformFor(s.op, c);');
  });

  test('preserves editor focus for command clicks so structure actions see the caret', () => {
    expect(source).toContain("b.addEventListener('mousedown', (e) => { e.preventDefault(); });");
    expect(source).toContain('function refreshBarCurrent()');
  });

  test('wires multi-selected list items to the batch list transform protocol', () => {
    expect(source).toContain('function selectedListItemIds()');
    expect(source).toContain('return commandStructure.selectedListItemIds(getSelection());');
    expect(source).toContain("vscode.postMessage({ type: 'multiTransform', transform: transform, ids: ids");
    expect(source).toContain('function listItemSelectionTransformFor(op)');
    expect(source).toContain("if (op === 'alphabeticList') return 'toAlphabeticList';");
    expect(source).toContain("if (op === 'orderedList') return 'toOrderedList';");
    expect(source).toContain("if (op === 'unorderedList') return 'toUnorderedList';");
    expect(source).toContain('return commandStructure.selectedListStyles(document, windowObj, ids);');
    expect(source).toContain('applyBarMultiListTransform(');
  });

  test('exposes lines in Structure and removes the duplicate Transform group', () => {
    expect(uiSource).toContain("const biLines = makeBarBtn(menuIcons.lines, 'Lines', true);");
    expect(source).toContain("biLines._barRun = function () { runStructureAction('lines'); };");
    expect(source).toContain("{ b: biLines, op: 'lines', label: 'Insert lines after' },");
    expect(uiSource).not.toContain("makeBarGroup('Transform')");
    expect(uiSource).not.toContain('transformGroup.row.append');
    expect(source).not.toContain('transformGroup.wrap.style.display');
  });

  test('derives table controls from cell context even inside nested cell blocks', () => {
    expect(source).toContain("node.closest('td[data-cell-id], th[data-cell-id]')");
    expect(source).toContain("cell.closest('[data-struct-id][data-struct-kind=\"row\"]')");
    expect(source).toContain("const directEntryEdit = !!(cellEntryId && editId === cellEntryId);");
    expect(source).toContain("const kind = directEntryEdit ? 'entry' : struct.getAttribute('data-struct-kind');");
    expect(source).toContain('rowId: rowStruct ? rowStruct.getAttribute');
    expect(source).toContain("const inCell = !!(c && c.cellEntryId);");
    expect(source).toContain("postStructural('addRowAfter', barCurrent.rowId");
    expect(source).toContain("postStructural('addColumnAfter', barCurrent.cellEntryId");
  });

  test('falls back to the selected block when the DOM caret is unavailable', () => {
    expect(source).toContain('function selectedBlockNode()');
    expect(source).toContain("selection.mode !== 'single' || selection.unit !== 'block'");
    expect(source).toContain('return contextFromNode(node) || contextFromNode(selectedBlockNode());');
  });
});
