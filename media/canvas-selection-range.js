// Pure helpers for range-selection host queries and availability state.
(function () {
  function sameIds(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }

  function normalizeAvailability(msg) {
    return {
      forIds: Array.isArray(msg && msg.forIds) ? msg.forIds.filter((id) => typeof id === 'string') : [],
      actions: Array.isArray(msg && msg.actions)
        ? msg.actions.filter((action) => action && typeof action.action === 'string')
        : [],
    };
  }

  function rangeAvailFor(rangeAvail, ids, action) {
    if (!rangeAvail || !sameIds(rangeAvail.forIds, ids)) return null;
    return rangeAvail.actions.find((a) => a.action === action) || null;
  }

  function rangeQuerySelection(selection, ids) {
    return {
      kind: selection.mode,
      ids: ids,
      anchorId: selection.anchorId || selection.anchorCellId || null,
      focusId: selection.focusId || selection.focusCellId || null,
    };
  }

  window.DitaEditorCanvasSelectionRange = {
    normalizeAvailability: normalizeAvailability,
    rangeAvailFor: rangeAvailFor,
    rangeQuerySelection: rangeQuerySelection,
    sameIds: sameIds,
  };
})();
