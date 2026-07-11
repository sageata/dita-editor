// Pure state helpers for the contextual structural toolbar.
(function () {
  function columnAnchorId(cellEl) {
    if (cellEl && cellEl.getAttribute && cellEl.getAttribute('data-cell-id')) {
      return cellEl.getAttribute('data-cell-id');
    }
    const tr = cellEl && cellEl.closest ? cellEl.closest('tr') : null;
    if (!tr) return null;
    const colIndex = Array.prototype.indexOf.call(tr.children, cellEl);
    if (colIndex < 0) return null;
    const table = cellEl.closest('table');
    if (!table) return null;
    for (const row of table.querySelectorAll('tr')) {
      const c = row.children[colIndex];
      if (c && c.hasAttribute('data-edit-id')) return c.getAttribute('data-edit-id');
    }
    return null;
  }

  function toolbarKindNoun(current) {
    if (current && current.cellEntryId) return 'a table cell';
    const m = {
      row: 'a table row',
      li: 'a list item',
      p: 'a paragraph',
      lines: 'a lines block',
      codeblock: 'a code block',
      note: 'a note',
      section: 'a section',
      shortdesc: 'a short description',
      title: 'a title',
    };
    return (current && m[current.kind]) || 'this element';
  }

  function rangeButtonState(action, count, availability) {
    const merge = action === 'cellRectMerge';
    const label = merge ? 'Merge ' + count + ' selected cells' : 'Delete ' + count + ' selected items';
    if (availability == null) {
      return { text: merge ? '▦' : '⌦', label: label, enabled: false, title: label + ' — checking…' };
    }
    return {
      text: merge ? '▦' : '⌦',
      label: label,
      enabled: !!availability.enabled,
      title: availability.enabled ? label : availability.reason || label,
    };
  }

  function resultMessage(action) {
    return action === 'cellRectMerge' ? 'Merging selected cells.' : 'Deleting selected items.';
  }

  function availabilitySummary(buttons, isUnavailable) {
    const available = buttons.filter((b) => !isUnavailable(b)).length;
    const unavailable = buttons.length - available;
    if (unavailable > 0) return available + ' available, ' + unavailable + ' unavailable';
    return available + ' action' + (available === 1 ? '' : 's');
  }

  function multiSelectionSummary(count, action, availability) {
    const what = action === 'cellRectMerge' ? 'Merge selected cells' : 'Delete selected items';
    if (availability == null) return count + ' items selected — checking available actions';
    if (availability.enabled) return count + ' items selected — "' + what + '" available';
    return count + ' items selected — ' + (availability.reason || 'range action unavailable');
  }

  function isSummonKey(e) {
    return (e.key === 'F10' && (e.altKey || e.shiftKey)) || e.key === 'ContextMenu';
  }

  window.DitaEditorCanvasContextToolbarState = {
    availabilitySummary: availabilitySummary,
    columnAnchorId: columnAnchorId,
    isSummonKey: isSummonKey,
    multiSelectionSummary: multiSelectionSummary,
    rangeButtonState: rangeButtonState,
    resultMessage: resultMessage,
    toolbarKindNoun: toolbarKindNoun,
  };
})();
