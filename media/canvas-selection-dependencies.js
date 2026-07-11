// Dependency resolver for the selection controller browser module.
(function () {
  function requireFunctions(api, names, errorMessage) {
    if (!api || names.some((name) => typeof api[name] !== 'function')) {
      throw new Error(errorMessage);
    }
    return api;
  }

  function resolveSelectionDependencies(opts, windowObj, rootWindow) {
    const selectionAnnouncement = opts.selectionAnnouncement || windowObj.DitaEditorCanvasSelectionAnnounce;
    const selectionSummary =
      opts.selectionSummary || windowObj.DitaEditorCanvasSelectionSummary || rootWindow.DitaEditorCanvasSelectionSummary;
    const selectionRestore =
      opts.selectionRestore || windowObj.DitaEditorCanvasSelectionRestore || rootWindow.DitaEditorCanvasSelectionRestore;
    const selectionClipboard =
      opts.selectionClipboard || windowObj.DitaEditorCanvasSelectionClipboard || rootWindow.DitaEditorCanvasSelectionClipboard;
    const selectionRange =
      opts.selectionRange || windowObj.DitaEditorCanvasSelectionRange || rootWindow.DitaEditorCanvasSelectionRange;

    return {
      selectionAnnouncement: requireFunctions(
        selectionAnnouncement,
        ['describeSelection', 'selectionEditability'],
        'DitaEditorCanvasSelectionAnnounce is required before canvas-selection-controller.js',
      ),
      selectionSummary: requireFunctions(
        selectionSummary,
        [
          'currentSelectionIds',
          'isMultiSelection',
          'kindOfSelectedId',
          'rangeActionForSelection',
          'selectionCount',
          'selectionCountText',
          'selectionIsAllCells',
          'selectionStateForAnnouncement',
        ],
        'DitaEditorCanvasSelectionSummary is required before canvas-selection-controller.js',
      ),
      selectionClipboard: requireFunctions(
        selectionClipboard,
        [
          'clipboardHtml',
          'clipboardText',
          'selectionHtml',
          'selectionPlainText',
          'tabularPasteMatrix',
          'htmlTablePasteMatrix',
          'cellRectPasteValuesFromMatrix',
          'flattenPasteMatrix',
          'singleCellTabularPasteTarget',
          'cellPasteValues',
        ],
        'DitaEditorCanvasSelectionClipboard is required before canvas-selection-controller.js',
      ),
      selectionRestore: requireFunctions(
        selectionRestore,
        ['restoreSelectionAfterRerender'],
        'DitaEditorCanvasSelectionRestore is required before canvas-selection-controller.js',
      ),
      selectionRange: requireFunctions(
        selectionRange,
        ['normalizeAvailability', 'rangeAvailFor', 'rangeQuerySelection', 'sameIds'],
        'DitaEditorCanvasSelectionRange is required before canvas-selection-controller.js',
      ),
    };
  }

  window.DitaEditorCanvasSelectionDependencies = {
    resolveSelectionDependencies: resolveSelectionDependencies,
  };
})();
