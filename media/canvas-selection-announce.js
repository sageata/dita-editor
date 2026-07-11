// Accessible selection wording for the DITA Editor canvas.
//
// Mirrors src/selection/selection-announce.ts for the browser-only canvas code:
// no DOM access, no VS Code API access, no document writes.
(function () {
  const NOUN = {
    block: { one: 'item', many: 'items' },
    cell: { one: 'cell', many: 'cells' },
    image: { one: 'image', many: 'images' },
  };

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function describeSelection(state, kindOf) {
    const ids = state && Array.isArray(state.ids) ? state.ids : [];
    const n = ids.length;
    if (n === 0) return 'Selection cleared';

    const kinds = new Set(ids.map((id) => kindOf(id)));
    const uniform = kinds.size === 1 ? Array.from(kinds)[0] : undefined;
    if (uniform && NOUN[uniform]) {
      if (uniform === 'image' && n === 1) return 'Image selected';
      const noun = NOUN[uniform];
      return n === 1 ? cap(noun.one) + ' selected' : n + ' ' + noun.many + ' selected';
    }

    return n === 1 ? 'Item selected' : n + ' items selected';
  }

  function selectionEditability(state) {
    const ids = state && Array.isArray(state.ids) ? state.ids : [];
    if (ids.length > 1) {
      return {
        enabled: false,
        reason: 'Multiple items selected — select one item for single-target structural edits',
      };
    }
    return { enabled: true };
  }

  window.DitaEditorCanvasSelectionAnnounce = {
    describeSelection: describeSelection,
    selectionEditability: selectionEditability,
  };
})();
