// Dynamic ARIA selection reflection for the DITA Editor canvas.
//
// The renderer deliberately avoids static aria-selected on native document
// elements. This helper mirrors table-cell selections only when the canvas is
// in selection mode, by temporarily promoting the native table to an ARIA grid
// and restoring its previous attributes when selection clears or repaints.
(function () {
  function installSelectionAria(opts) {
    const doc = (opts && opts.document) || document;
    let promotedTables = new Map();

    function restoreAttr(el, name, value) {
      if (value == null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }

    function clear(main) {
      if (main) {
        for (const el of main.querySelectorAll('[data-selection-kind][aria-selected]')) {
          el.removeAttribute('aria-selected');
        }
      }
      for (const [table, prev] of promotedTables) {
        restoreAttr(table, 'role', prev.role);
        restoreAttr(table, 'aria-multiselectable', prev.multi);
      }
      promotedTables = new Map();
    }

    function promoteTable(table) {
      if (!promotedTables.has(table)) {
        promotedTables.set(table, {
          role: table.getAttribute('role'),
          multi: table.getAttribute('aria-multiselectable'),
        });
      }
      table.setAttribute('role', 'grid');
      table.setAttribute('aria-multiselectable', 'true');
    }

    function apply(main, selectedEls) {
      clear(main);
      if (!main || !selectedEls || selectedEls.length === 0) return;

      const selectedByTable = new Map();
      for (const el of selectedEls) {
        if (!el || !el.matches || !el.matches('[data-selection-kind="cell"],[data-selection-kind="header"]')) continue;
        const table = el.closest('table');
        if (!table || !main.contains(table)) continue;
        let selected = selectedByTable.get(table);
        if (!selected) {
          selected = new Set();
          selectedByTable.set(table, selected);
        }
        selected.add(el);
      }

      for (const [table, selected] of selectedByTable) {
        promoteTable(table);
        for (const cell of table.querySelectorAll('[data-selection-kind="cell"],[data-selection-kind="header"]')) {
          cell.setAttribute('aria-selected', selected.has(cell) ? 'true' : 'false');
        }
      }
    }

    return {
      apply: apply,
      clear: function () {
        clear(doc.querySelector('main'));
      },
    };
  }

  window.DitaEditorCanvasSelectionAria = { installSelectionAria: installSelectionAria };
})();
