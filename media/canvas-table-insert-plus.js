// Intersection "+" row/column inserters for the DITA Editor canvas.
//
// Loaded before canvas.js. While the pointer is near a table's LEFT edge or
// inside its first column (row boundaries), or near its TOP edge or inside its
// first row (column boundaries), a single proximity-revealed "+" button appears
// at the nearest boundary — including before the first and after the last
// row/column. Clicking it posts the
// matching structural intent (addRowBefore/addRowAfter/addColumnBefore/
// addColumnAfter); the host validates and applies the edit. Hover work writes
// zero document bytes — only the click posts. No acquireVsCodeApi().
(function () {
  const SIZE = 18; // button diameter (matches the ruler chip height)
  const EDGE_REACH = 28; // how far outside the table edge the pointer may sit
  const SNAP = 14; // max distance from a boundary for the button to appear

  function installTableInsertPlus(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const computeDomGrid = opts.computeDomGrid;
    const availFor = opts.availFor;
    const postStructural = opts.postStructural;
    const withStructuralSuccess = opts.withStructuralSuccess;
    const announceNav = opts.announceNav || function () {};

    function vRect(el) {
      const geom = window.DitaEditorCanvasGeom;
      return geom ? geom.visualRect(el) : el.getBoundingClientRect();
    }

    const layer = document.createElement('div');
    layer.className = 'dc-table-insert-plus-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:49;';
    document.body.appendChild(layer);

    // One reusable insertion-guide line + one reusable "+" button.
    const guide = document.createElement('div');
    guide.className = 'dc-table-insert-plus-guide';
    guide.style.cssText = 'position:fixed;display:none;background:#0b6bcb;pointer-events:none;';
    layer.appendChild(guide);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.className = 'dc-table-insert-plus';
    btn.textContent = '+';
    btn.style.cssText =
      'position:fixed;display:none;width:' + SIZE + 'px;height:' + SIZE + 'px;box-sizing:border-box;' +
      'pointer-events:auto;align-items:center;justify-content:center;padding:0;' +
      'border:1px solid #9fb4c0;border-radius:50%;background:#f7fafb;color:#2c3a44;cursor:pointer;' +
      'font:600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;';
    layer.appendChild(btn);

    let active = null; // { op, id, kind, guideRect } for the currently shown button
    let raf = 0;

    function hide() {
      active = null;
      btn.style.display = 'none';
      guide.style.display = 'none';
    }

    function cmdBarBottom() {
      const bar = document.querySelector('.cmd-bar');
      if (!bar) return 64;
      const r = bar.getBoundingClientRect();
      return r.bottom || 64;
    }

    function cellsOf(tr) {
      return Array.prototype.slice.call(tr.children).filter((c) => {
        const tag = (c.tagName || '').toLowerCase();
        return tag === 'td' || tag === 'th';
      });
    }

    // Row boundaries for `table`: y positions between (and around) its <tr>s,
    // each mapped to the structural op/id that inserts a row exactly there.
    // A boundary is offered only when the reference row is full-width and
    // span-free AND no rowspan crosses the boundary (makeEmptyRowLike copies
    // the reference row's cell count, so a spanned reference would corrupt
    // the grid; addRowAfter/Before have no host-side span guard today).
    function rowBoundaries(table, grid, colCount) {
      const trs = Array.prototype.slice.call(table.querySelectorAll('thead tr, tbody tr'));
      if (!trs.length) return [];

      const sectionOf = (tr) => (tr.closest('thead') ? 'thead' : 'tbody');
      const rowIndexInSection = (tr) => {
        const section = tr.closest('thead, tbody');
        if (!section) return -1;
        return Array.prototype.slice.call(section.querySelectorAll('tr')).indexOf(tr);
      };
      const rowIsPlain = (tr) => {
        const cells = cellsOf(tr);
        if (cells.length !== colCount) return false;
        return cells.every(
          (c) =>
            Number(c.getAttribute('rowspan') || '1') === 1 &&
            Number(c.getAttribute('colspan') || '1') === 1,
        );
      };
      // Does a rowspan cross the gap ABOVE `tr` (within its own section)?
      const spanCrossesAbove = (tr) => {
        const k = rowIndexInSection(tr);
        if (k <= 0) return false; // first row of its section: CALS spans never cross sections
        const s = sectionOf(tr);
        return grid.some((g) => g.section === s && g.row < k && g.row + g.rowSpan > k);
      };
      const okFor = (op, tr) => {
        const id = tr.getAttribute('data-struct-id');
        if (!id) return null;
        if (!rowIsPlain(tr)) return null;
        const a = availFor(id, op);
        if (a && a.enabled === false) return null;
        return id;
      };

      const out = [];
      for (let i = 0; i < trs.length; i += 1) {
        const id = okFor('addRowBefore', trs[i]);
        if (id && !spanCrossesAbove(trs[i])) {
          out.push({ y: vRect(trs[i]).top, op: 'addRowBefore', id: id });
        }
      }
      const last = trs[trs.length - 1];
      const lastId = okFor('addRowAfter', last);
      if (lastId) out.push({ y: vRect(last).bottom, op: 'addRowAfter', id: lastId });
      return out;
    }

    // Column boundaries: x positions from a span-free full-width row, including
    // BOTH outer edges. Each maps to addColumnBefore (leftmost) / addColumnAfter.
    // A cmdMap refusal (merged table) does NOT hide the boundary — it renders the
    // "+" DISABLED with the reason (C3 discoverability pattern), so authors learn
    // why column edits refuse instead of seeing nothing.
    function columnBoundaries(table, colCount) {
      const rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
      for (const row of rows) {
        const cells = cellsOf(row);
        if (cells.length !== colCount) continue;
        if (cells.some((c) => Number(c.getAttribute('colspan') || '1') !== 1)) continue;
        const ids = cells.map((c) => c.getAttribute('data-cell-id'));
        if (ids.some((id) => !id)) return [];
        const withAvail = (b, id, op) => {
          const a = availFor(id, op);
          if (a && a.enabled === false) {
            b.disabled = true;
            b.reason = a.reason || 'Not available here';
          }
          return b;
        };
        const out = [];
        const first = vRect(cells[0]);
        out.push(withAvail({ x: first.left, op: 'addColumnBefore', id: ids[0] }, ids[0], 'addColumnBefore'));
        for (let j = 1; j < cells.length; j += 1) {
          const prev = vRect(cells[j - 1]);
          const cur = vRect(cells[j]);
          out.push(withAvail(
            { x: (prev.right + cur.left) / 2, op: 'addColumnAfter', id: ids[j - 1] },
            ids[j - 1], 'addColumnAfter',
          ));
        }
        const lastRect = vRect(cells[cells.length - 1]);
        out.push(withAvail(
          { x: lastRect.right, op: 'addColumnAfter', id: ids[cells.length - 1] },
          ids[cells.length - 1], 'addColumnAfter',
        ));
        return out;
      }
      return []; // every row is spanned/short: no trustworthy boundary geometry
    }

    // Visible horizontal clip (mirror of the ruler's clipXFor): chips outside an
    // overflow-x clip would float over unrelated content.
    function clipXFor(el) {
      const root = document.documentElement;
      const range = { left: 0, right: root ? root.clientWidth : 1e9 };
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = windowObj.getComputedStyle ? windowObj.getComputedStyle(node) : null;
        if (cs && cs.overflowX && cs.overflowX !== 'visible') {
          const r = vRect(node);
          range.left = Math.max(range.left, r.left);
          range.right = Math.min(range.right, r.right);
        }
        node = node.parentElement;
      }
      return range;
    }

    function candidateFor(table, px, py) {
      const rect = vRect(table);
      if (!rect.width || !rect.height) return null;
      const barBottom = cmdBarBottom();
      const grid = computeDomGrid(table);
      if (!grid.length) return null;
      let colCount = 0;
      for (const g of grid) colCount = Math.max(colCount, g.colEnd);
      if (!colCount) return null;

      let best = null;
      const consider = (dist, make) => {
        if (dist > SNAP) return;
        if (!best || dist < best.dist) best = { dist: dist, make: make };
      };

      // The in-table reach of each band: the column "+" triggers anywhere in the
      // FIRST ROW's height, the row "+" anywhere in the FIRST COLUMN's width
      // (runtime QA: a pointer between two header cells sits well below the top
      // edge, so a thin edge-only inset never fired).
      const firstTr = table.querySelector('thead tr, tbody tr');
      const firstRowBottom = firstTr ? vRect(firstTr).bottom : rect.top + SNAP;
      const firstCells = firstTr ? cellsOf(firstTr) : [];
      const firstColRight = firstCells.length ? vRect(firstCells[0]).right : rect.left + SNAP;

      // Row band: pointer near the LEFT outer edge or within the first column.
      if (px >= rect.left - EDGE_REACH && px <= firstColRight &&
          py >= rect.top - SNAP && py <= rect.bottom + SNAP) {
        for (const b of rowBoundaries(table, grid, colCount)) {
          if (b.y - SIZE / 2 < barBottom) continue; // never under the command bar
          consider(Math.abs(py - b.y), () => ({
            op: b.op,
            id: b.id,
            kind: 'row',
            title: b.op === 'addRowAfter' ? 'Insert row below' : 'Insert row here',
            btnLeft: rect.left - SIZE - 4,
            btnTop: b.y - SIZE / 2,
            guideRect: { left: rect.left, top: b.y - 1, width: rect.width, height: 2 },
          }));
        }
      }

      // Column band: pointer near the TOP outer edge or within the first row.
      if (py >= rect.top - EDGE_REACH && py <= firstRowBottom &&
          px >= rect.left - SNAP && px <= rect.right + SNAP) {
        const clip = clipXFor(table);
        const btnTop = rect.top - SIZE - 2;
        if (btnTop >= barBottom) {
          for (const b of columnBoundaries(table, colCount)) {
            if (b.x < clip.left || b.x > clip.right) continue; // scrolled out of the clip
            consider(Math.abs(px - b.x), () => ({
              op: b.op,
              id: b.id,
              kind: 'entry',
              disabled: !!b.disabled,
              reason: b.reason,
              title: b.disabled ? b.reason : 'Insert column here',
              btnLeft: b.x - SIZE / 2,
              btnTop: btnTop,
              guideRect: { left: b.x - 1, top: rect.top, width: 2, height: rect.height },
            }));
          }
        }
      }

      return best ? { dist: best.dist, spec: best.make() } : null;
    }

    function show(spec) {
      active = spec;
      btn.title = spec.title;
      btn.setAttribute('aria-disabled', spec.disabled ? 'true' : 'false');
      btn.style.background = spec.disabled ? '#f3f3f3' : '#f7fafb';
      btn.style.color = spec.disabled ? '#b3bcc2' : '#2c3a44';
      btn.style.cursor = spec.disabled ? 'not-allowed' : 'pointer';
      btn.style.left = Math.round(spec.btnLeft) + 'px';
      btn.style.top = Math.round(spec.btnTop) + 'px';
      btn.style.display = 'inline-flex';
      guide.style.display = 'none'; // guide appears while the button is hovered
    }

    function onPointerMove(e) {
      if (e.target === btn) return; // hovering the button keeps it visible
      const px = e.clientX;
      const py = e.clientY;
      if (raf) return;
      const rafFn = windowObj.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
      raf = rafFn(() => {
        raf = 0;
        if (document.body.classList.contains('dc-table-column-resizing')) {
          hide();
          return;
        }
        // All rendered CALS tables (struct-stamped), NOT just resizable ones —
        // data-table-resizable requires >=2 columns, which would leave 1-column
        // tables with no insert affordance at all.
        const tables = Array.prototype.slice.call(
          document.querySelectorAll('main table[data-struct-id][data-struct-kind="table"]'),
        );
        let best = null;
        for (const table of tables) {
          const c = candidateFor(table, px, py);
          if (c && (!best || c.dist < best.dist)) best = c;
        }
        if (best) show(best.spec);
        else hide();
      });
    }

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!active) return;
      const spec = active;
      if (spec.disabled) {
        announceNav(spec.reason || 'Not available here.'); // visible refusal, no write
        return;
      }
      hide();
      postStructural(spec.op, spec.id, withStructuralSuccess(spec.op, spec.kind));
    });
    btn.addEventListener('mouseenter', () => {
      if (!active) return;
      if (active.disabled) return; // no hover invite, no guide for a refused insert
      btn.style.background = '#e3edf7';
      const g = active.guideRect;
      guide.style.left = Math.round(g.left) + 'px';
      guide.style.top = Math.round(g.top) + 'px';
      guide.style.width = Math.round(g.width) + 'px';
      guide.style.height = Math.round(g.height) + 'px';
      guide.style.display = 'block';
    });
    btn.addEventListener('mouseleave', () => {
      if (active && active.disabled) return;
      btn.style.background = '#f7fafb';
      guide.style.display = 'none';
    });

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerleave', hide);
    windowObj.addEventListener('scroll', hide, true);
    windowObj.addEventListener('resize', hide);

    // After a rerender/zoom change any cached geometry is stale; the next
    // pointermove recomputes from live rects, so hiding is all that's needed.
    function refresh() {
      hide();
    }

    return { refresh: refresh };
  }

  window.DitaEditorTableInsertPlus = { installTableInsertPlus: installTableInsertPlus };
})();
