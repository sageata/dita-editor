// Contextual structural toolbar for the DITA Editor visual canvas.
(function () {
  function installContextToolbar(opts) {
    const rootWindow = window;
    const doc = opts.document || document;
    const win = opts.window || window;
    const vscode = opts.vscode;
    const controls = opts.controls;
    const nextRovingIndex = controls.nextRovingIndex;
    const makeBtn = controls.makeBtn;
    const isUnavailable = controls.isUnavailable;
    const setBtnEnabled = controls.setBtnEnabled;
    const makeSep = controls.makeSep;
    const withStructuralSuccess = opts.withStructuralSuccess || function (_op, _kind, extra) { return extra || {}; };
    const toolbarState = win.DitaEditorCanvasContextToolbarState || rootWindow.DitaEditorCanvasContextToolbarState;
    if (!toolbarState) throw new Error('DitaEditorCanvasContextToolbarState must load before canvas-context-toolbar.js');
    const columnAnchorId = toolbarState.columnAnchorId;
    const isSummonKey = toolbarState.isSummonKey;
    const floatingEnabled = opts.floatingEnabled !== false;

    let current = null;
    let hideTimer = null;
    let toolbarFocused = false;
    let toolbarOrigin = null;
    let activeCell = null;

    const toolbar = doc.createElement('div');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Block and table editing controls');
    toolbar.style.cssText =
      'position:absolute;display:none;align-items:center;gap:3px;z-index:50;font-family:sans-serif;' +
      'background:#fff;border:1px solid #bbb;border-radius:6px;padding:2px 4px;box-shadow:0 1px 4px rgba(0,0,0,0.18);';
    toolbar.style.display = 'none';
    const addBtn = makeBtn('+', 'Add row/item below');
    const delBtn = makeBtn('−', 'Delete this row/item');
    const colAddBtn = makeBtn('+|', 'Add column to the right');
    const colDelBtn = makeBtn('−|', 'Delete this column');
    const mergeRBtn = makeBtn('→|', 'Merge with the cell on the right');
    const mergeDBtn = makeBtn('↓|', 'Merge with the cell below');
    const splitBtn = makeBtn('⊟', 'Split this merged cell');
    const rangeBtn = makeBtn('⌦', 'Range action');
    const insertBtn = makeBtn('⊕', 'Insert element');
    insertBtn.setAttribute('aria-haspopup', 'menu');
    insertBtn.setAttribute('aria-expanded', 'false');

    const sep1 = makeSep();
    const sep2 = makeSep();
    const sep3 = makeSep();
    const sep4 = makeSep();
    toolbar.append(addBtn, delBtn, sep1, colAddBtn, colDelBtn, sep2, mergeRBtn, mergeDBtn, splitBtn, sep3, rangeBtn, sep4, insertBtn);
    doc.body.appendChild(toolbar);

    const TB_BTNS = [addBtn, delBtn, colAddBtn, colDelBtn, mergeRBtn, mergeDBtn, splitBtn];
    const ALL_BTNS = TB_BTNS.concat([rangeBtn, insertBtn]);

    function getCurrent() {
      return current;
    }

    function clearHideTimer() {
      clearTimeout(hideTimer);
    }

    function clearCellHighlight() {
      if (!activeCell) return;
      activeCell.style.outline = '';
      activeCell.style.outlineOffset = '';
      activeCell = null;
    }

    function highlightCell(cellEl) {
      if (cellEl === activeCell) return;
      clearCellHighlight();
      if (cellEl) {
        cellEl.style.outline = '2px solid #4a90d9';
        cellEl.style.outlineOffset = '-2px';
        activeCell = cellEl;
      }
    }

    function visibleBtns() {
      return ALL_BTNS.filter((b) => b.style.display !== 'none');
    }

    function setRoving(i) {
      const vis = visibleBtns();
      if (!vis.length || i < 0) return null;
      const idx = Math.max(0, Math.min(i, vis.length - 1));
      for (const b of ALL_BTNS) b.tabIndex = -1;
      vis[idx].tabIndex = 0;
      vis[idx].focus();
      return vis[idx];
    }

    function configureRangeBtn() {
      const act = opts.isMultiSelection() ? opts.rangeActionForSelection() : null;
      if (!act) {
        rangeBtn.style.display = 'none';
        sep3.style.display = 'none';
        return;
      }
      rangeBtn.style.display = 'inline-block';
      sep3.style.display = 'block';
      rangeBtn.dataset.rangeAction = act;
      const n = opts.selectionCount();
      const avail = opts.rangeAvailFor(act);
      const state = toolbarState.rangeButtonState(act, n, avail);
      rangeBtn.textContent = state.text;
      setBtnEnabled(rangeBtn, state.enabled, state.title);
    }

    function showFor(structEl, cellEl) {
      if (!floatingEnabled) return;
      const geom = window.DitaEditorCanvasGeom;
      const rect = geom ? geom.visualRect(structEl) : structEl.getBoundingClientRect();
      toolbar.style.display = 'flex';
      const rowStruct = cellEl && cellEl.closest ? cellEl.closest('[data-struct-id][data-struct-kind="row"]') : null;
      const cellEntryId = cellEl ? cellEl.getAttribute('data-cell-id') : null;
      const rowId = rowStruct ? rowStruct.getAttribute('data-struct-id') : null;
      const opKind = cellEntryId && rowId ? 'row' : structEl.getAttribute('data-struct-kind');
      const opId = cellEntryId && rowId ? rowId : structEl.getAttribute('data-struct-id');
      current = {
        id: opId,
        kind: opKind,
        rowId: rowId,
        cellId: cellEl ? columnAnchorId(cellEl) : null,
        cellEntryId: cellEntryId,
        structEl: structEl,
        cellEl: cellEl || null,
      };
      const inCell = !!current.cellEntryId;
      const addOp = opts.ADD_OP[current.kind];
      const delOp = opts.DEL_OP[current.kind];

      addBtn.style.display = addOp ? 'inline-block' : 'none';
      delBtn.style.display = delOp ? 'inline-block' : 'none';
      if (addOp) opts.applyAvail(addBtn, current.id, addOp, 'Add row/item below');
      if (delOp) opts.applyAvail(delBtn, current.id, delOp, 'Delete this element');

      const colVisible = inCell ? 'inline-block' : 'none';
      colAddBtn.style.display = colVisible;
      colDelBtn.style.display = colVisible;
      if (inCell) {
        const anchorOk = !!current.cellId;
        const addA = opts.availFor(current.cellEntryId, 'addColumnAfter');
        const delA = opts.availFor(current.cellEntryId, 'deleteColumn');
        setBtnEnabled(
          colAddBtn,
          anchorOk && addA.enabled,
          !anchorOk ? 'No editable cell in this column' : addA.enabled ? 'Add column to the right' : addA.reason || 'Add column to the right',
        );
        setBtnEnabled(
          colDelBtn,
          anchorOk && delA.enabled,
          !anchorOk ? 'No editable cell in this column' : delA.enabled ? 'Delete this column' : delA.reason || 'Delete this column',
        );
      }

      const cellMerged = cellEl && (cellEl.hasAttribute('colspan') || cellEl.hasAttribute('rowspan'));
      mergeRBtn.style.display = inCell ? 'inline-block' : 'none';
      mergeDBtn.style.display = inCell ? 'inline-block' : 'none';
      splitBtn.style.display = inCell && cellMerged ? 'inline-block' : 'none';
      if (inCell) {
        opts.applyAvail(mergeRBtn, current.cellEntryId, 'mergeRight', 'Merge with the cell on the right');
        opts.applyAvail(mergeDBtn, current.cellEntryId, 'mergeDown', 'Merge with the cell below');
        if (cellMerged) opts.applyAvail(splitBtn, current.cellEntryId, 'splitCell', 'Split this merged cell');
      }
      sep1.style.display = inCell ? 'block' : 'none';
      sep2.style.display = inCell ? 'block' : 'none';
      highlightCell(inCell ? cellEl : null);

      if (opts.isMultiSelection()) {
        const reason = opts.singleTargetMultiReason();
        for (const b of TB_BTNS) {
          if (b.style.display !== 'none') setBtnEnabled(b, false, reason);
        }
        configureRangeBtn();
        insertBtn.style.display = 'none';
        sep4.style.display = 'none';
        const insertMenu = opts.getInsertMenuController();
        if (insertMenu) insertMenu.close(false);
        toolbar.setAttribute('aria-label', 'Editing controls — ' + opts.selectionCount() + ' items selected');
      } else {
        rangeBtn.style.display = 'none';
        sep3.style.display = 'none';
        const insertMenu = opts.getInsertMenuController();
        if (insertMenu) insertMenu.configureButton();
        toolbar.setAttribute('aria-label', 'Block and table editing controls');
      }

      const GUTTER = 84;
      const MIN_GAP = 6;
      const sx = win.scrollX;
      const sy = win.scrollY;
      const minLeft = sx + MIN_GAP;
      let left = rect.left + sx - GUTTER;
      let top = rect.top + sy;
      if (left < minLeft) {
        const above = rect.top + sy - toolbar.offsetHeight - MIN_GAP;
        if (above >= sy + MIN_GAP) {
          top = above;
          left = Math.max(minLeft, rect.left + sx);
        } else {
          left = minLeft;
        }
      }
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    }

    function scheduleHide() {
      const insertMenu = opts.getInsertMenuController();
      if (toolbarFocused || (insertMenu && insertMenu.isOpen())) return;
      clearHideTimer();
      hideTimer = setTimeout(() => {
        hide();
        clearCellHighlight();
      }, 400);
    }

    function resultMessage(btn) {
      if (btn === rangeBtn) return toolbarState.resultMessage(rangeBtn.dataset.rangeAction);
      return 'Done.';
    }

    function runPending(btn, run) {
      if (isUnavailable(btn)) return;
      opts.announceNav(resultMessage(btn));
      run();
    }

    function postConfirmed(btn, op, id, kind) {
      if (isUnavailable(btn)) return;
      opts.postStructural(op, id, withStructuralSuccess(op, kind));
    }

    function announceBtn(btn) {
      const action = btn.dataset.action || btn.getAttribute('aria-label') || 'control';
      if (isUnavailable(btn)) opts.announceNav(action + ', unavailable: ' + (btn.getAttribute('aria-label') || 'not available') + '.');
      else opts.announceNav(action + '.');
    }

    function close(restoreOrigin) {
      toolbarFocused = false;
      hide();
      clearCellHighlight();
      if (restoreOrigin && toolbarOrigin && toolbarOrigin.leaf && toolbarOrigin.leaf.isConnected) {
        opts.setCaret(toolbarOrigin.leaf, toolbarOrigin.offset);
      }
      toolbarOrigin = null;
      opts.announceNav('Editing controls closed.');
    }

    function hide() {
      toolbar.style.display = 'none';
    }

    if (floatingEnabled) {
      doc.addEventListener('mouseover', (e) => {
        const s = opts.structTarget(e.target);
        if (s) {
          clearHideTimer();
          const cell = e.target.closest ? e.target.closest('td[data-cell-id], th[data-cell-id]') : null;
          showFor(s, cell);
        }
      });
      doc.addEventListener('mouseout', scheduleHide);
      toolbar.addEventListener('mouseover', clearHideTimer);
      toolbar.addEventListener('mouseout', scheduleHide);
    }

    toolbar.addEventListener(
      'click',
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button') : null;
        if (btn && isUnavailable(btn)) {
          e.preventDefault();
          e.stopPropagation();
          opts.announceNav('Unavailable: ' + (btn.getAttribute('aria-label') || 'not available') + '.');
        }
      },
      true,
    );
    addBtn.addEventListener('click', () => {
      if (current && opts.ADD_OP[current.kind]) postConfirmed(addBtn, opts.ADD_OP[current.kind], current.id, current.kind);
    });
    delBtn.addEventListener('click', () => {
      if (current && opts.DEL_OP[current.kind]) postConfirmed(delBtn, opts.DEL_OP[current.kind], current.id, current.kind);
    });
    colAddBtn.addEventListener('click', () => {
      if (current && current.cellEntryId) postConfirmed(colAddBtn, 'addColumnAfter', current.cellEntryId, current.kind);
    });
    colDelBtn.addEventListener('click', () => {
      if (current && current.cellEntryId) postConfirmed(colDelBtn, 'deleteColumn', current.cellEntryId, current.kind);
    });
    mergeRBtn.addEventListener('click', () => {
      if (current && current.cellEntryId) postConfirmed(mergeRBtn, 'mergeRight', current.cellEntryId, current.kind);
    });
    mergeDBtn.addEventListener('click', () => {
      if (current && current.cellEntryId) postConfirmed(mergeDBtn, 'mergeDown', current.cellEntryId, current.kind);
    });
    splitBtn.addEventListener('click', () => {
      if (current && current.cellEntryId) postConfirmed(splitBtn, 'splitCell', current.cellEntryId, current.kind);
    });
    rangeBtn.addEventListener('click', () => {
      if (isUnavailable(rangeBtn)) return;
      const action = rangeBtn.dataset.rangeAction;
      const ids = opts.currentSelectionIds();
      if ((action === 'rangeDelete' || action === 'cellRectMerge') && ids.length) {
        runPending(rangeBtn, () => vscode.postMessage({ type: 'rangeExecute', action: action, ids: ids }));
      }
    });

    if (floatingEnabled) {
      doc.addEventListener('keydown', (e) => {
        if (!isSummonKey(e) || toolbarFocused) return;
        const imageBar = opts.getImageBar();
        const selection = opts.getSelection();
        if (selection && selection.mode === 'single' && selection.unit === 'image' && imageBar && imageBar.isShown()) {
          e.preventDefault();
          imageBar.focusChangeButton();
          opts.announceNav('Image editing controls. Change image. Press Enter to choose a new image, Escape to deselect.');
          return;
        }
        const struct = opts.structTarget(e.target);
        if (!struct) return;
        const leaf = opts.editableTarget(e.target);
        const cell = e.target.closest ? e.target.closest('td[data-cell-id], th[data-cell-id]') : null;
        e.preventDefault();
        toolbarOrigin = leaf ? { leaf: leaf, offset: opts.caretOffset(leaf) } : null;
        const r = struct.getBoundingClientRect();
        if (r.bottom < 0 || r.top > win.innerHeight) struct.scrollIntoView({ block: 'nearest' });
        showFor(struct, cell);
        toolbarFocused = true;
        clearHideTimer();
        const vis = visibleBtns();
        let firstIdx = vis.findIndex((b) => !isUnavailable(b));
        if (firstIdx < 0) firstIdx = 0;
        setRoving(firstIdx);
        let countPhrase;
        if (opts.isMultiSelection()) {
          const act = opts.rangeActionForSelection();
          const avail = act ? opts.rangeAvailFor(act) : null;
          countPhrase = toolbarState.multiSelectionSummary(opts.selectionCount(), act, avail);
        } else {
          countPhrase = toolbarState.availabilitySummary(vis, isUnavailable);
        }
        opts.announceNav('Editing controls for ' + toolbarState.toolbarKindNoun(current) + '. ' + countPhrase +
          '. Arrow to choose, Enter to apply, Escape to return.');
      });
    }

    toolbar.addEventListener('keydown', (e) => {
      if (!toolbarFocused) return;
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const vis = visibleBtns();
        const curIdx = vis.indexOf(doc.activeElement);
        const next = nextRovingIndex(vis.length, curIdx, e.key);
        const btn = setRoving(next);
        if (btn) announceBtn(btn);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        const btn = doc.activeElement;
        if (!btn || ALL_BTNS.indexOf(btn) < 0) return;
        if (isUnavailable(btn)) {
          opts.announceNav('Unavailable: ' + (btn.getAttribute('aria-label') || 'not available') + '.');
          return;
        }
        if (btn === insertBtn) {
          const insertMenu = opts.getInsertMenuController();
          if (insertMenu) insertMenu.open();
          return;
        }
        toolbarFocused = false;
        btn.click();
        return;
      }
      if (e.key === 'ArrowDown' && doc.activeElement === insertBtn) {
        e.preventDefault();
        e.stopPropagation();
        const insertMenu = opts.getInsertMenuController();
        if (insertMenu) insertMenu.open();
      }
    });

    function resetForRerender() {
      hide();
      toolbarFocused = false;
      toolbarOrigin = null;
      clearCellHighlight();
    }

    return {
      toolbar: toolbar,
      insertBtn: insertBtn,
      insertSeparator: sep4,
      getCurrent: getCurrent,
      visibleBtns: visibleBtns,
      setRoving: setRoving,
      showFor: showFor,
      hide: hide,
      isShown: () => toolbar.style.display !== 'none',
      resetForRerender: resetForRerender,
      configureRangeBtn: configureRangeBtn,
      clearHideTimer: clearHideTimer,
      clearCellHighlight: clearCellHighlight,
      highlightCell: highlightCell,
      columnAnchorId: columnAnchorId,
    };
  }

  window.DitaEditorCanvasContextToolbar = {
    installContextToolbar: installContextToolbar,
  };
})();
