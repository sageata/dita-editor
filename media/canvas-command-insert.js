// Command-bar insert placement helpers for the DITA Editor canvas.
//
// Loaded before canvas-command-bar.js. Pure helper: no DOM ownership, no VS Code API.
(function () {
  function blockInsertPlacement(current) {
    if (!current) return null;
    if ((current.kind === 'row' || current.kind === 'entry') && current.cellEntryId) {
      return {
        mode: 'into',
        idField: 'containerId',
        id: current.cellEntryId,
        label: 'inside this cell',
      };
    }
    if (current.id && (current.kind === 'p' || current.kind === 'li')) {
      const atStart = current.isCollapsed === true && current.caretOffset === 0;
      return {
        mode: atStart ? 'before' : 'after',
        idField: 'refId',
        id: current.id,
        label: atStart ? 'before' : 'after',
      };
    }
    if (current.id && (current.kind === 'table' || current.kind === 'fig')) {
      return {
        mode: 'after',
        idField: 'refId',
        id: current.id,
        label: 'after',
      };
    }
    return null;
  }

  function payloadForPlacement(placement) {
    const payload = { mode: placement.mode };
    payload[placement.idField] = placement.id;
    return payload;
  }

  window.DitaEditorCanvasCommandInsert = {
    blockInsertPlacement: blockInsertPlacement,
    payloadForPlacement: payloadForPlacement,
  };
})();
