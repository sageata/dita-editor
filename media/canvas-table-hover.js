// Table hover cross-highlight for the DITA Editor canvas.
//
// Loaded before canvas.js. Render-only: while the pointer is over a table
// cell, every cell sharing its column gets a `.dc-col-hover` class (the row
// tint is pure CSS in editor.css). Span-aware via the shared DOM grid. Zero
// document bytes; no acquireVsCodeApi().
(function () {
  function installTableHover(opts) {
    const document = opts.document;
    const computeDomGrid = opts.computeDomGrid;

    let lastCell = null;
    let marked = [];

    function clearMarks() {
      for (const el of marked) el.classList.remove('dc-col-hover');
      marked = [];
      lastCell = null;
    }

    function markColumn(cell) {
      const table = cell.closest('table[data-table-resizable="true"]');
      if (!table) {
        clearMarks();
        return;
      }
      const grid = computeDomGrid(table);
      const hovered = grid.find((g) => g.el === cell);
      if (!hovered) {
        clearMarks();
        return;
      }
      clearMarks();
      lastCell = cell;
      for (const g of grid) {
        if (g.colStart <= hovered.colEnd && g.colEnd >= hovered.colStart) {
          g.el.classList.add('dc-col-hover');
          marked.push(g.el);
        }
      }
    }

    document.addEventListener('mouseover', (e) => {
      if (document.body.classList.contains('dc-table-column-resizing')) return;
      const t = e.target;
      const cell = t && t.closest ? t.closest('td[data-cell-id],th[data-cell-id]') : null;
      if (cell === lastCell) return;
      if (!cell) {
        clearMarks();
        return;
      }
      markColumn(cell);
    });

    document.addEventListener('mouseleave', clearMarks);

    return { clear: clearMarks };
  }

  window.DitaEditorCanvasTableHover = { installTableHover: installTableHover };
})();
