// Selection restoration helpers for rerendered DITA Editor canvas documents.
//
// Loaded before canvas-selection-controller.js. Kept independent from VS Code
// so restoration behavior can be reused by the controller without widening the
// VS Code API boundary.
(function () {
  function restoreSelectionAfterRerender(selection, main, deps) {
    if (!selection) return null;
    const resolveMember = deps.resolveMember;
    const fingerprintOf = deps.fingerprintOf;
    const buildCellRect = deps.buildCellRect;

    if (selection.mode === 'single') {
      const el = resolveMember(main, selection.unit, selection.id);
      if (!el) return null;
      if (selection.unit === 'cell') return Object.assign({}, selection, { text: fingerprintOf(el, 'cell') });
      if ((selection.unit === 'block' || selection.unit === 'image') && el.getAttribute('data-struct-kind') !== selection.kind) {
        return null;
      }
      if (fingerprintOf(el, selection.unit) !== selection.text) return null;
      return selection;
    }

    if (selection.mode === 'blockRange') {
      for (const member of selection.members) {
        const el = resolveMember(main, 'block', member.id);
        if (!el || el.getAttribute('data-struct-kind') !== selection.kind || el.textContent !== member.text) return null;
      }
      return selection;
    }

    if (selection.mode === 'cellRect') {
      for (const member of selection.members) {
        if (!resolveMember(main, 'cell', member.id)) return null;
      }
      const anchorEl = resolveMember(main, 'cell', selection.anchorCellId);
      const focusEl = resolveMember(main, 'cell', selection.focusCellId);
      const rebuilt = anchorEl && focusEl ? buildCellRect(anchorEl, focusEl) : null;
      if (!rebuilt) return null;
      const oldRect = selection.rect;
      const newRect = rebuilt.rect;
      const sameRect =
        newRect.section === oldRect.section &&
        newRect.r0 === oldRect.r0 &&
        newRect.r1 === oldRect.r1 &&
        newRect.c0 === oldRect.c0 &&
        newRect.c1 === oldRect.c1;
      const ids = new Set(rebuilt.members.map((member) => member.id));
      const sameMembers = ids.size === selection.members.length && selection.members.every((member) => ids.has(member.id));
      return sameRect && sameMembers ? Object.assign({}, selection, { members: rebuilt.members, rect: rebuilt.rect }) : null;
    }

    if (selection.mode === 'multiSet') {
      const kept = [];
      for (const unit of selection.units) {
        const el = resolveMember(main, unit.unit, unit.id);
        if (!el) continue;
        const kindOk = (unit.unit !== 'block' && unit.unit !== 'image') || el.getAttribute('data-struct-kind') === unit.kind;
        if (unit.unit === 'cell') kept.push(Object.assign({}, unit, { text: fingerprintOf(el, 'cell') }));
        else if (kindOk && fingerprintOf(el, unit.unit) === unit.text) kept.push(unit);
      }
      return kept.length > 0 ? { mode: 'multiSet', units: kept } : null;
    }

    return selection;
  }

  window.DitaEditorCanvasSelectionRestore = {
    restoreSelectionAfterRerender: restoreSelectionAfterRerender,
  };
})();
