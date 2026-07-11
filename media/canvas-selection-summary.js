// Derived selection state helpers for the DITA Editor canvas.
//
// Loaded before canvas-selection-controller.js. This module stays independent
// from VS Code and DOM mutation; the controller owns event wiring and styling.
(function () {
  function currentSelectionIds(selection) {
    if (!selection) return [];
    if (selection.mode === 'single') return [selection.id];
    if (selection.mode === 'multiSet') return selection.units.map((unit) => unit.id);
    if (selection.members) return selection.members.map((member) => member.id);
    return [];
  }

  function selectionCount(selection) {
    if (!selection) return 0;
    if (selection.mode === 'single') return 1;
    if (selection.mode === 'multiSet') return selection.units.length;
    return selection.members.length;
  }

  function isMultiSelection(selection) {
    return selectionCount(selection) > 1;
  }

  function selectionCountText(selection) {
    if (!selection) return '';
    let n = 1;
    let noun = 'block';
    if (selection.mode === 'single') noun = selection.unit === 'cell' ? 'cell' : selection.unit === 'image' ? 'image' : 'block';
    else if (selection.mode === 'cellRect') { n = selection.members.length; noun = 'cell'; }
    else if (selection.mode === 'multiSet') {
      n = selection.units.length;
      const kinds = new Set(selection.units.map((unit) => unit.unit));
      noun = kinds.size > 1 ? 'item' : kinds.has('cell') ? 'cell' : kinds.has('image') ? 'image' : 'block';
    } else { n = selection.members.length; noun = 'block'; }
    const shape = selection.mode === 'blockRange' ? ' (range)' : selection.mode === 'cellRect' ? ' (rectangle)' : '';
    return n + ' ' + noun + (n === 1 ? '' : 's') + ' selected' + shape;
  }

  function selectionStateForAnnouncement(selection) {
    const ids = currentSelectionIds(selection);
    return {
      anchorId: selection ? selection.anchorId || selection.anchorCellId || ids[0] || null : null,
      focusId: selection ? selection.focusId || selection.focusCellId || ids[ids.length - 1] || null : null,
      ids: ids,
    };
  }

  function kindOfSelectedId(selection, id) {
    if (!selection) return undefined;
    if (selection.mode === 'single') return selection.id === id ? selection.unit : undefined;
    if (selection.mode === 'multiSet') {
      const unit = selection.units.find((candidate) => candidate.id === id);
      return unit ? unit.unit : undefined;
    }
    if (selection.mode === 'cellRect') return selection.members.some((member) => member.id === id) ? 'cell' : undefined;
    if (selection.mode === 'blockRange') return selection.members.some((member) => member.id === id) ? 'block' : undefined;
    return undefined;
  }

  function rangeActionForSelection(selection) {
    if (!selection) return null;
    if (selection.mode === 'cellRect') return 'cellRectMerge';
    if (selection.mode === 'blockRange' || selection.mode === 'multiSet') return 'rangeDelete';
    return null;
  }

  function selectionIsAllCells(selection) {
    if (!selection) return false;
    if (selection.mode === 'single') return selection.unit === 'cell';
    if (selection.mode === 'cellRect') return true;
    if (selection.mode === 'multiSet') return selection.units.length > 0 && selection.units.every((unit) => unit.unit === 'cell');
    return false;
  }

  window.DitaEditorCanvasSelectionSummary = {
    currentSelectionIds: currentSelectionIds,
    isMultiSelection: isMultiSelection,
    kindOfSelectedId: kindOfSelectedId,
    rangeActionForSelection: rangeActionForSelection,
    selectionCount: selectionCount,
    selectionCountText: selectionCountText,
    selectionIsAllCells: selectionIsAllCells,
    selectionStateForAnnouncement: selectionStateForAnnouncement,
  };
})();
