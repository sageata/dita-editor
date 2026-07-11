(function () {
  const MIN_COL_PX = 44;
  const HANDLE_WIDTH = 16;

  function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function rectWidth(rect) {
    return num(rect.width, num(rect.right, 0) - num(rect.left, 0));
  }

  function rectHeight(rect) {
    return num(rect.height, num(rect.bottom, 0) - num(rect.top, 0));
  }

  function elementRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    // Page-visual coordinates in both zoom-coordinate engines (legacy webview
    // included) — handles are fixed body-level overlays. See canvas-geom.js.
    const geom = window.DitaEditorCanvasGeom;
    return geom ? geom.visualRect(el) : el.getBoundingClientRect();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function columnsFor(table) {
    return Array.from(table.querySelectorAll('col'));
  }

  function cellsFor(row) {
    return Array.from(row.children || []).filter((child) => {
      const tag = (child.tagName || '').toLowerCase();
      return tag === 'td' || tag === 'th';
    });
  }

  function measuredWidthsFromCells(table, colCount) {
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = cellsFor(row);
      if (cells.length !== colCount) continue;
      if (cells.some((cell) => Number(cell.getAttribute('colspan') || '1') !== 1)) continue;
      const widths = cells.map((cell) => {
        const rect = elementRect(cell);
        return rect ? rectWidth(rect) : 0;
      });
      if (widths.every((width) => width > 0)) return widths;
    }
    return null;
  }

  function styleWidthPx(col, tableWidth) {
    const width = String((col.style && col.style.width) || '').trim();
    if (!width) return null;
    if (width.endsWith('%')) {
      const pct = Number(width.slice(0, -1));
      return Number.isFinite(pct) && pct > 0 ? (pct / 100) * tableWidth : null;
    }
    if (width.endsWith('px')) {
      const px = Number(width.slice(0, -2));
      return Number.isFinite(px) && px > 0 ? px : null;
    }
    const raw = Number(width);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  function measuredWidths(table) {
    const cols = columnsFor(table);
    const tableRect = elementRect(table);
    const tableWidth = tableRect ? rectWidth(tableRect) : 0;
    if (cols.length < 2 || tableWidth <= 0) return null;

    const cellWidths = measuredWidthsFromCells(table, cols.length);
    if (cellWidths) return cellWidths;

    const styled = cols.map((col) => styleWidthPx(col, tableWidth));
    const styledTotal = styled.reduce((sum, width) => sum + (width || 0), 0);
    if (styledTotal > 0 && styled.every((width) => width != null)) {
      return styled.map((width) => (width / styledTotal) * tableWidth);
    }

    return cols.map(() => tableWidth / cols.length);
  }

  function applyWidths(table, widths) {
    const cols = columnsFor(table);
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total <= 0 || cols.length !== widths.length) return;
    cols.forEach((col, index) => {
      col.style.width = ((widths[index] / total) * 100).toFixed(4).replace(/\.?0+$/, '') + '%';
    });
  }

  function ratiosForSource(widths) {
    const total = widths.reduce((sum, width) => sum + width, 0);
    const scale = total > 0 ? widths.length / total : 1;
    return widths.map((width) => Number(Math.max(0.05, width * scale).toFixed(3)));
  }

  function changedEnough(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    return a.some((value, index) => Math.abs(value - b[index]) >= 0.5);
  }

  // Handles are always mounted and draggable, but their stripes are painted
  // only on hover: on span-heavy tables no span-free row exists to measure, so
  // the always-on lines drew at arithmetic fallback positions through cell
  // text (user: invisible, not useless). Debug re-enable of the painted
  // guides: set localStorage 'ditaeditor.visual.tableGuides' = 'true' + reload.
  const GUIDES_KEY = 'ditaeditor.visual.tableGuides';

  function installTableColumnResize(opts) {
    const doc = opts.document;
    const win = opts.window;
    function guidesDebug() {
      return !!(win.localStorage && win.localStorage.getItem(GUIDES_KEY) === 'true');
    }
    const vscode = opts.vscode;
    const getStructVersion = opts.getStructVersion || (() => 0);
    const announceNav = opts.announceNav || (() => undefined);
    const layer = doc.createElement('div');
    layer.className = 'dc-table-resize-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.position = 'fixed';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.width = '100vw';
    layer.style.height = '100vh';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '48';
    if (guidesDebug()) layer.classList.add('dc-table-guides-debug');
    doc.body.appendChild(layer);

    let handles = [];
    let active = null;
    let layoutRaf = 0;
    let applyRaf = 0;

    function removeHandle(handle) {
      if (handle.parentNode && typeof handle.parentNode.removeChild === 'function') {
        handle.parentNode.removeChild(handle);
      } else if (typeof handle.remove === 'function') {
        handle.remove();
      }
    }

    function clearHandles() {
      handles.forEach(removeHandle);
      handles = [];
    }

    // Paint the stripe only near the pointer: the handle spans the whole table
    // so the boundary is grabbable anywhere along it, but a full-height line
    // pops in like a rendering glitch. The visible cue stays local to the
    // cursor; the debug layer class keeps the always-on full stripe (CSS).
    const STRIPE = 'linear-gradient(to right, transparent 0 6px, rgba(22, 49, 60, 0.52) 6px 10px, transparent 10px)';
    function paintLocalStripe(handle, event) {
      if (layer.classList && layer.classList.contains('dc-table-guides-debug')) return;
      const y = num(event.clientY, 0) - (parseFloat(handle.style.top) || 0);
      const mask = 'linear-gradient(to bottom, transparent ' + (y - 90) + 'px, #000 ' + (y - 60) + 'px, #000 ' + (y + 60) + 'px, transparent ' + (y + 90) + 'px)';
      handle.style.background = STRIPE;
      handle.style.webkitMaskImage = mask;
      handle.style.maskImage = mask;
    }
    function clearLocalStripe(handle) {
      handle.style.background = '';
      handle.style.webkitMaskImage = '';
      handle.style.maskImage = '';
    }

    function createHandle(table, boundaryIndex, left, top, height) {
      const handle = doc.createElement('div');
      handle.className = 'dc-table-col-resize-handle';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', 'Resize table column');
      handle.setAttribute('data-table-id', table.getAttribute('data-table-id') || '');
      handle.setAttribute('data-boundary-index', String(boundaryIndex));
      handle.style.position = 'fixed';
      handle.style.left = `${left - HANDLE_WIDTH / 2}px`;
      handle.style.top = `${top}px`;
      handle.style.width = `${HANDLE_WIDTH}px`;
      handle.style.height = `${Math.max(12, height)}px`;
      handle.style.pointerEvents = 'auto';
      handle.addEventListener('pointerenter', (event) => paintLocalStripe(handle, event));
      handle.addEventListener('pointermove', (event) => paintLocalStripe(handle, event));
      handle.addEventListener('pointerleave', () => clearLocalStripe(handle));
      handle.addEventListener('pointerdown', (event) => startDrag(event, table, boundaryIndex));
      // IX-10: double-click a boundary handle to fit the column to its content
      // (same byte-minimal setTableColumnWidths op the drag path posts).
      handle.title = 'Drag to resize · double-click to fit column to content';
      handle.addEventListener('dblclick', (event) => {
        event.preventDefault && event.preventDefault();
        event.stopPropagation && event.stopPropagation();
        autofitColumn(table, boundaryIndex);
      });
      layer.appendChild(handle);
      handles.push(handle);
    }

    // Natural (max-content) width of the widest cell in a column, measured in a
    // hidden probe that mirrors each cell's font and horizontal padding. Only
    // span-free rows participate — the same rows measuredWidthsFromCells trusts.
    function autofitColumn(table, colIndex) {
      const tableId = table.getAttribute('data-table-id');
      const cols = columnsFor(table);
      const widths = measuredWidths(table);
      if (!tableId || !widths || widths[colIndex] == null) return;
      const probe = doc.createElement('div');
      probe.style.cssText =
        'position:fixed;left:-10000px;top:0;visibility:hidden;width:max-content;max-width:none;';
      doc.body.appendChild(probe);
      let target = 0;
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        const cells = cellsFor(row);
        if (cells.length !== cols.length) continue;
        if (cells.some((cell) => Number(cell.getAttribute('colspan') || '1') !== 1)) continue;
        const cell = cells[colIndex];
        const cs = win.getComputedStyle ? win.getComputedStyle(cell) : null;
        if (cs) {
          probe.style.font = cs.font || '';
          probe.style.letterSpacing = cs.letterSpacing || '';
        }
        probe.textContent = '';
        for (const child of Array.from(cell.childNodes || [])) {
          probe.appendChild(child.cloneNode(true));
        }
        const pad = cs
          ? (num(parseFloat(cs.paddingLeft), 0) + num(parseFloat(cs.paddingRight), 0) +
             num(parseFloat(cs.borderLeftWidth), 0) + num(parseFloat(cs.borderRightWidth), 0))
          : 28;
        target = Math.max(target, probe.offsetWidth + pad + 2);
      }
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      if (!target) return;
      const tableWidth = widths.reduce((sum, width) => sum + width, 0);
      const cap = Math.max(MIN_COL_PX, tableWidth - (widths.length - 1) * MIN_COL_PX);
      target = clamp(target, MIN_COL_PX, cap);
      if (Math.abs(target - widths[colIndex]) < 0.5) {
        announceNav('Column already fits its content.');
        return;
      }
      const next = widths.slice();
      next[colIndex] = target;
      vscode.postMessage({
        type: 'setTableColumnWidths',
        id: tableId,
        widths: ratiosForSource(next),
        baseStructVersion: getStructVersion(),
      });
      announceNav('Column width fitted to content.');
    }

    // Exact x for each column boundary, read from a span-free row's cell rects
    // (the midpoint of the gutter when border-spacing separates the cells).
    // tableRect.left + cumulative cell widths drifts by the table's own border/
    // padding (and scales with zoom); the painted cell edges do not.
    function boundaryEdges(table, colCount) {
      const rows = Array.from(table.querySelectorAll('tr'));
      for (const row of rows) {
        const cells = cellsFor(row);
        if (cells.length !== colCount) continue;
        if (cells.some((cell) => Number(cell.getAttribute('colspan') || '1') !== 1)) continue;
        const rects = cells.map(elementRect);
        if (rects.some((rect) => !rect || !(rectWidth(rect) > 0))) continue;
        const edges = [];
        for (let i = 0; i < colCount - 1; i++) {
          edges.push((num(rects[i].right, 0) + num(rects[i + 1].left, 0)) / 2);
        }
        return edges;
      }
      return null;
    }

    // Visible region of an element: the viewport intersected with every
    // overflow-clipping ancestor. A wide (or zoomed) table is clipped by
    // .body{overflow-x:auto}; handles for boundaries outside that clip would
    // float over unrelated content.
    function clipRangeFor(el) {
      const root = doc.documentElement;
      const range = {
        left: 0,
        top: 0,
        right: root ? num(root.clientWidth, 1e9) : 1e9,
        bottom: root ? num(root.clientHeight, 1e9) : 1e9,
      };
      let node = el.parentElement;
      while (node && node !== doc.body) {
        const cs = win.getComputedStyle ? win.getComputedStyle(node) : null;
        const rect = cs ? elementRect(node) : null;
        if (rect) {
          if (cs.overflowX && cs.overflowX !== 'visible') {
            range.left = Math.max(range.left, num(rect.left, range.left));
            range.right = Math.min(range.right, num(rect.right, range.right));
          }
          if (cs.overflowY && cs.overflowY !== 'visible') {
            range.top = Math.max(range.top, num(rect.top, range.top));
            range.bottom = Math.min(range.bottom, num(rect.bottom, range.bottom));
          }
        }
        node = node.parentElement;
      }
      return range;
    }

    function refresh() {
      if (active) return;
      clearHandles();
      // Handles must never paint over (or under) the fixed command bar — the
      // viewport clip alone starts at y=0, which is behind the bar.
      const bar = doc.querySelector('.cmd-bar');
      const barRect = bar && typeof bar.getBoundingClientRect === 'function' ? bar.getBoundingClientRect() : null;
      const barBottom = barRect && Number.isFinite(barRect.bottom) ? barRect.bottom : 0;
      const tables = Array.from(doc.querySelectorAll('table[data-table-resizable="true"]'));
      for (const table of tables) {
        const widths = measuredWidths(table);
        const tableRect = elementRect(table);
        if (!widths || !tableRect || widths.length < 2) continue;
        const left = num(tableRect.left, 0);
        const top = num(tableRect.top, 0);
        const height = rectHeight(tableRect);
        const clip = clipRangeFor(table);
        const handleTop = Math.max(top, clip.top, barBottom);
        const handleHeight = Math.min(top + height, clip.bottom) - handleTop;
        if (handleHeight < 12) continue;
        const edges = boundaryEdges(table, widths.length);
        let cursor = left;
        for (let i = 0; i < widths.length - 1; i++) {
          cursor += widths[i];
          const x = edges ? edges[i] : cursor;
          if (x < clip.left + 2 || x > clip.right - 2) continue;
          createHandle(table, i, x, handleTop, handleHeight);
        }
      }
    }

    function scheduleRefresh() {
      if (active) return;
      if (layoutRaf) return;
      const raf = win.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
      layoutRaf = raf(() => {
        layoutRaf = 0;
        refresh();
      });
    }

    function cleanupDragListeners() {
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerup', onPointerUp);
      win.removeEventListener('blur', onWindowBlur);
    }

    function finishDrag(commit) {
      if (!active) return;
      const state = active;
      active = null;
      cleanupDragListeners();
      state.table.classList.remove('dc-table-resizing');
      doc.body.classList.remove('dc-table-column-resizing');
      const changed = commit && changedEnough(state.startWidths, state.currentWidths);
      if (!changed && !state.hadFixedLayout && state.table.style) {
        state.table.style.tableLayout = state.previousTableLayout;
      }
      if (changed) {
        vscode.postMessage({
          type: 'setTableColumnWidths',
          id: state.tableId,
          widths: ratiosForSource(state.currentWidths),
          baseStructVersion: getStructVersion(),
        });
      } else {
        applyWidths(state.table, state.startWidths);
        if (!commit) announceNav('Column resize cancelled.');
      }
      scheduleRefresh();
    }

    function applyActiveWidths() {
      applyRaf = 0;
      if (!active) return;
      applyWidths(active.table, active.currentWidths);
    }

    function scheduleApply() {
      if (applyRaf) return;
      const raf = win.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
      applyRaf = raf(applyActiveWidths);
    }

    function startDrag(event, table, boundaryIndex) {
      if (event.button != null && event.button !== 0) return;
      const tableId = table.getAttribute('data-table-id');
      if (!tableId) return;
      const widths = measuredWidths(table);
      if (!widths || !widths[boundaryIndex] || !widths[boundaryIndex + 1]) return;

      event.preventDefault && event.preventDefault();
      event.stopPropagation && event.stopPropagation();
      // Capture keeps every drag event targeted at the (unzoomed) handle, so
      // clientX stays in one coordinate space for the whole drag — without it,
      // legacy-zoom engines report moves over the zoomed content in a
      // different space than the pointerdown on the handle.
      if (event.pointerId != null && event.target && typeof event.target.setPointerCapture === 'function') {
        try { event.target.setPointerCapture(event.pointerId); } catch { /* synthetic events have no active pointer */ }
      }
      // Handles stay in the DOM so the capture target survives; the
      // dc-table-column-resizing body class hides them for the drag, and
      // finishDrag's refresh rebuilds them at their new positions.

      active = {
        table,
        tableId,
        boundaryIndex,
        startX: num(event.clientX, 0),
        startWidths: widths.slice(),
        currentWidths: widths.slice(),
        previousTableLayout: table.style ? table.style.tableLayout || '' : '',
        hadFixedLayout: table.style ? table.style.tableLayout === 'fixed' : false,
      };
      if (table.style) table.style.tableLayout = 'fixed';
      applyWidths(table, widths);
      table.classList.add('dc-table-resizing');
      doc.body.classList.add('dc-table-column-resizing');
      win.addEventListener('pointermove', onPointerMove);
      win.addEventListener('pointerup', onPointerUp);
      win.addEventListener('blur', onWindowBlur);
    }

    function onPointerMove(event) {
      if (!active) return;
      event.preventDefault && event.preventDefault();
      const dx = num(event.clientX, active.startX) - active.startX;
      const leftStart = active.startWidths[active.boundaryIndex];
      const rightStart = active.startWidths[active.boundaryIndex + 1];
      const pair = leftStart + rightStart;
      const min = Math.min(MIN_COL_PX, Math.max(12, pair / 2 - 1));
      const nextLeft = clamp(leftStart + dx, min, pair - min);
      const next = active.startWidths.slice();
      next[active.boundaryIndex] = nextLeft;
      next[active.boundaryIndex + 1] = pair - nextLeft;
      active.currentWidths = next;
      scheduleApply();
    }

    function onPointerUp(event) {
      event.preventDefault && event.preventDefault();
      finishDrag(true);
    }

    function onWindowBlur() {
      finishDrag(false);
    }

    win.addEventListener('resize', scheduleRefresh);
    // Capture: a configured workspace stylesheet may make `.body` the inner scroll
    // containers whose scroll events never bubble to a window-level listener.
    win.addEventListener('scroll', scheduleRefresh, true);
    refresh();

    return {
      refresh,
      destroy() {
        finishDrag(false);
        clearHandles();
        if (layer.parentNode && typeof layer.parentNode.removeChild === 'function') layer.parentNode.removeChild(layer);
      },
    };
  }

  window.DitaEditorCanvasTableResize = { installTableColumnResize };
})(window);
