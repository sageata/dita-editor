// Overflow manager for the two-row command bar.
//
// Loaded after canvas-command-bar-ui.js. When a fixed row cannot fit all of
// its groups, trailing groups move into a body-level popover opened by the
// bar's » caret, so no command is ever clipped or unreachable. Pure layout
// math lives in computeOverflowLayout; installOverflow owns the DOM moves.
// Width measurement is injected because the headless harness has no layout.
(function () {
  // Spacing consumed by a divider rendered before a group (1px + 12px margins).
  const DIVIDER_SPAN = 25;
  // Horizontal padding of the bar (8px 14px) and the caret's box + margin.
  const BAR_PADDING_X = 28;
  const CARET_SPAN = 38;

  // rows: [{ widths: number[], reserved: number }] in visual order. Greedy
  // left-to-right fit per row; the caret is reserved only when needed, so a
  // bar that fits exactly never shows it.
  function computeOverflowLayout(containerWidth, caretWidth, rows) {
    function fitCount(avail, widths) {
      let used = 0;
      let n = 0;
      for (const width of widths) {
        if (used + width > avail) break;
        used += width;
        n += 1;
      }
      return n;
    }
    const fullFit = rows.map((row) => fitCount(containerWidth - row.reserved, row.widths));
    const everythingFits = rows.every((row, i) => fullFit[i] === row.widths.length);
    if (everythingFits) return { caretVisible: false, fitCounts: fullFit };
    return {
      caretVisible: true,
      fitCounts: rows.map((row) => fitCount(containerWidth - caretWidth - row.reserved, row.widths)),
    };
  }

  function installOverflow(opts) {
    const documentObj = opts.document;
    const ui = opts.ui;
    const measureWidth = opts.measureWidth;
    const pop = ui.overflowPop;
    const moreBtn = ui.moreBtn;
    const cmdBar = ui.cmdBar;
    const rows = [
      { el: ui.cmdRow, entries: ui.cmdRowEntries, trailing: ui.cmdStatus, lastSig: '', inRowSet: new Set() },
    ];
    // Widths are remembered from the last time a group sat in a row, because a
    // popover-resident group cannot be measured against row layout.
    const widthCache = new Map();
    let open = false;

    function moveTo(parent, node) {
      if (node.parentElement) node.parentElement.removeChild(node);
      parent.appendChild(node);
    }

    function isHidden(el) {
      return el.style.display === 'none';
    }

    function entryWidth(entry) {
      let base = 0;
      if (entry.wrap.parentElement !== pop) {
        base = measureWidth(entry.wrap) || 0;
        if (base > 0) widthCache.set(entry.wrap, base);
      }
      if (base <= 0) base = widthCache.get(entry.wrap) || 0;
      return base + (entry.divider ? DIVIDER_SPAN : 0);
    }

    function firstVisibleButton(node) {
      for (const child of node.children || []) {
        if (String(child.tagName).toLowerCase() === 'button' && !isHidden(child)) return child;
        const inner = firstVisibleButton(child);
        if (inner) return inner;
      }
      return null;
    }

    function setOpen(next) {
      open = next;
      pop.style.display = next ? 'flex' : 'none';
      moreBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    }

    function openPop() {
      setOpen(true);
      const first = firstVisibleButton(pop);
      if (first && typeof first.focus === 'function') first.focus();
    }

    function closePop(refocusCaret) {
      if (!open) return;
      setOpen(false);
      if (refocusCaret && typeof moreBtn.focus === 'function') moreBtn.focus();
    }

    function toggle() {
      if (open) closePop(true);
      else openPop();
    }

    // Rebuilds one row's DOM in canonical order when membership changed.
    // Hidden groups (e.g. the Table group outside a cell) stay in the row so
    // they rejoin layout where they belong when refresh() reveals them.
    function applyRow(row, fitN) {
      const visible = row.entries.filter((entry) => !isHidden(entry.wrap));
      const inRowSet = new Set(visible.slice(0, fitN).map((entry) => entry.wrap));
      row.inRowSet = inRowSet;
      const sig = row.entries
        .map((entry) => (isHidden(entry.wrap) ? 'h' : inRowSet.has(entry.wrap) ? 'r' : 'p'))
        .join('');
      if (sig === row.lastSig) return false;
      row.lastSig = sig;
      let prevInRowVisible = false;
      for (const entry of row.entries) {
        const hidden = isHidden(entry.wrap);
        const inRow = hidden || inRowSet.has(entry.wrap);
        if (entry.divider) {
          moveTo(row.el, entry.divider);
          entry.divider.style.display = !hidden && inRow && prevInRowVisible ? '' : 'none';
        }
        if (inRow) {
          moveTo(row.el, entry.wrap);
          if (!hidden) prevInRowVisible = true;
        }
      }
      if (row.trailing) moveTo(row.el, row.trailing);
      return true;
    }

    function update() {
      const base = Math.max(0, (measureWidth(cmdBar) || 0) - BAR_PADDING_X);
      const specs = rows.map((row) => ({
        widths: row.entries.filter((entry) => !isHidden(entry.wrap)).map(entryWidth),
        reserved: row.trailing && !isHidden(row.trailing) ? measureWidth(row.trailing) || 0 : 0,
      }));
      const layout = computeOverflowLayout(base, CARET_SPAN, specs);
      let changed = false;
      rows.forEach((row, i) => {
        if (applyRow(row, layout.fitCounts[i])) changed = true;
      });
      if (changed) {
        for (const row of rows) {
          for (const entry of row.entries) {
            if (!isHidden(entry.wrap) && !row.inRowSet.has(entry.wrap)) moveTo(pop, entry.wrap);
          }
        }
      }
      moreBtn.style.display = layout.caretVisible ? 'inline-flex' : 'none';
      if (!layout.caretVisible) closePop(false);
    }

    documentObj.addEventListener('pointerdown', (event) => {
      if (!open) return;
      const target = event.target;
      if (target === moreBtn || target === pop) return;
      if (typeof pop.contains === 'function' && pop.contains(target)) return;
      if (typeof moreBtn.contains === 'function' && moreBtn.contains(target)) return;
      closePop(false);
    });
    documentObj.addEventListener('keydown', (event) => {
      if (open && event.key === 'Escape') closePop(true);
    });

    return {
      update: update,
      toggle: toggle,
      close: closePop,
      isOpen: () => open,
    };
  }

  window.DitaEditorCanvasCommandBarOverflow = {
    computeOverflowLayout: computeOverflowLayout,
    installOverflow: installOverflow,
  };
})();
