// Selection state controller for the DITA Editor canvas.
//
// Loaded before canvas.js. The controller owns render-only element selection,
// range availability queries, delete-key handling, and rerender restoration.
// It receives vscode through install options only.
(function () {
  function noop() {}

  function installSelectionController(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const vscode = opts.vscode;
    const selectionModel = opts.selectionModel;
    const selectionAria = opts.selectionAria;
    const selectionDebug = opts.selectionDebug;
    const announceNav = opts.announceNav || noop;
    const showError = opts.showError || noop;
    const elementPath = opts.elementPath || function () { return ''; };
    const postStructural = opts.postStructural || noop;
    const withStructuralSuccess = opts.withStructuralSuccess || function (_op, _kind, extra) { return extra || {}; };
    const refreshCommandBar = opts.refreshCommandBar || noop;
    const configureRangeButton = opts.configureRangeButton || noop;
    const isContextToolbarShown = opts.isContextToolbarShown || function () { return false; };
    const selectedBlockPasteBlocksFromClipboard = opts.selectedBlockPasteBlocksFromClipboard || null;
    const onSelectionChange = opts.onSelectionChange || noop;
    const dependencyResolver = windowObj.DitaEditorCanvasSelectionDependencies || window.DitaEditorCanvasSelectionDependencies;
    if (!dependencyResolver || typeof dependencyResolver.resolveSelectionDependencies !== 'function') {
      throw new Error('DitaEditorCanvasSelectionDependencies is required before canvas-selection-controller.js');
    }
    const deps = dependencyResolver.resolveSelectionDependencies(opts, windowObj, window);
    const selectionAnnouncement = deps.selectionAnnouncement;
    const selectionSummary = deps.selectionSummary;
    const selectionRestore = deps.selectionRestore;
    const selectionClipboard = deps.selectionClipboard;
    const selectionRange = deps.selectionRange;

    const unitOf = selectionModel.unitOf;
    const unitElType = selectionModel.unitElType;
    const fingerprintOf = selectionModel.fingerprintOf;
    const singleSel = selectionModel.singleSel;
    const buildSelection = selectionModel.buildSelection;
    const buildCellRect = selectionModel.buildCellRect;
    const resolveMember = selectionModel.resolveMember;
    const unitDesc = selectionModel.unitDesc;
    const sortUnitsByDocOrder = selectionModel.sortUnitsByDocOrder;
    const unitFromPoint = typeof selectionModel.unitFromPoint === 'function' ? selectionModel.unitFromPoint : null;

    let selection = null;
    let drag = null;
    let selAnchorEl = null;
    let navFocusEl = null;
    let rangeAvail = null;
    let rangeQueryTimer = null;
    let suppressClick = false;

    const selCount = document.createElement('div');
    selCount.setAttribute('aria-hidden', 'true');
    selCount.style.cssText =
      'position:fixed;top:6px;right:6px;display:none;z-index:70;padding:3px 10px;' +
      'background:#1b2932;color:#e8eff2;border:1px solid #2e4755;border-radius:12px;' +
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.02em;' +
      'pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,0.25);';
    document.body.appendChild(selCount);

    function getImageBar() {
      return opts.getImageBar ? opts.getImageBar() : null;
    }

    function updateImageBar() {
      const imageBar = getImageBar();
      if (imageBar && typeof imageBar.update === 'function') imageBar.update();
    }

    function selectionMemberEls(main) {
      return selectionModel.selectionMemberEls(selection, main);
    }

    function selectionAnchorEl(main) {
      return selectionModel.selectionAnchorEl(selection, main);
    }

    function selectionUnits() {
      return selectionModel.selectionUnits(selection);
    }

    function clearSelectionStyles() {
      const main = document.querySelector('main');
      if (!main) {
        selectionAria.clear();
        return;
      }
      selectionAria.clear();
      for (const el of main.querySelectorAll('.is-selected')) el.classList.remove('is-selected');
    }

    function applySelectionStyles() {
      clearSelectionStyles();
      if (!selection) return;
      const main = document.querySelector('main');
      if (!main) return;
      const members = selectionMemberEls(main);
      for (const el of members) el.classList.add('is-selected');
      selectionAria.apply(main, members);
    }

    function reflectSelectionState() {
      const mode = selection ? selection.mode : 'none';
      const ids = currentSelectionIds();
      if (selectionDebug && typeof selectionDebug.reflect === 'function') selectionDebug.reflect(mode, ids, !!selection);
    }

    function updateSelCount() {
      reflectSelectionState();
      updateImageBar();
      updateRangeQuery();
      onSelectionChange();
      if (!selection) {
        selCount.style.display = 'none';
        selCount.textContent = '';
        return;
      }
      selCount.textContent = selectionSummary.selectionCountText(selection);
      selCount.style.display = selectionCount() > 0 ? 'block' : 'none';
    }

    function setSelection(sel) {
      selection = sel && sel.mode ? sel : null;
      applySelectionStyles();
      updateSelCount();
      refreshCommandBar();
    }

    function clearNavFocus() {
      if (navFocusEl) {
        navFocusEl.classList.remove('is-nav-focus');
        navFocusEl = null;
      }
    }

    function clearSelection() {
      selection = null;
      clearSelectionStyles();
      clearNavFocus();
      updateSelCount();
      refreshCommandBar();
    }

    function setNavFocus(el) {
      clearNavFocus();
      el.classList.add('is-nav-focus');
      navFocusEl = el;
    }

    function focusNonEditableTarget(el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus();
      const t = unitElType(el);
      if (t === 'block' || t === 'image') {
        clearNavFocus();
        setSelection(singleSel(el));
      } else {
        clearSelection();
        setNavFocus(el);
      }
      const path = elementPath(el);
      announceNav(path ? 'Selected ' + path : 'Selected element.');
    }

    function announceSelection() {
      announceNav(selectionAnnouncement.describeSelection(selectionStateForAnnouncement(), function (id) {
        return kindOfSelectedId(id);
      }));
    }

    function selectionCount() {
      return selectionSummary.selectionCount(selection);
    }

    function isMultiSelection() {
      return selectionSummary.isMultiSelection(selection);
    }

    function currentSelectionIds() {
      return selectionSummary.currentSelectionIds(selection);
    }

    function selectedElements() {
      const main = document.querySelector('main');
      return main ? selectionMemberEls(main) : [];
    }

    function copySelectionToClipboard(e, announce) {
      if (!selection) return false;
      const data = e.clipboardData || windowObj.clipboardData;
      if (!data || typeof data.setData !== 'function') return false;
      const els = selectedElements();
      if (els.length === 0) return false;
      data.setData('text/plain', selectionClipboard.selectionPlainText(selection, els));
      data.setData('text/html', selectionClipboard.selectionHtml(selection, els));
      e.preventDefault();
      e.stopPropagation();
      if (announce) announceNav((els.length === 1 ? 'Selection' : els.length + ' items') + ' copied.');
      return true;
    }

    function rangeActionForSelection() {
      return selectionSummary.rangeActionForSelection(selection);
    }

    function rangeAvailFor(action) {
      return selectionRange.rangeAvailFor(rangeAvail, currentSelectionIds(), action);
    }

    function selectionIsAllCells() {
      return selectionSummary.selectionIsAllCells(selection);
    }

    function executeCellClearForSelection() {
      const ids = currentSelectionIds();
      if (ids.length === 0) return false;
      announceNav('Clearing ' + (ids.length === 1 ? 'cell' : ids.length + ' cells') + '…');
      vscode.postMessage({ type: 'rangeExecute', action: 'cellClear', ids });
      return true;
    }

    function executeCellPaste(e) {
      if (!selectionIsAllCells()) return false;
      const ids = currentSelectionIds();
      if (ids.length === 0) return false;
      const text = selectionClipboard.clipboardText(e, windowObj);
      const htmlMatrix = selectionClipboard.htmlTablePasteMatrix(selectionClipboard.clipboardHtml(e, windowObj), windowObj);
      if (text === '' && !htmlMatrix) return false;
      e.preventDefault();
      e.stopPropagation();
      const textMatrix = htmlMatrix ? null : selectionClipboard.tabularPasteMatrix(text, selection && selection.mode === 'cellRect');
      const matrix = htmlMatrix || textMatrix;
      const tabularTarget = selectionClipboard.singleCellTabularPasteTarget(selection, matrix, ids, selectedElements());
      const targetIds = tabularTarget ? tabularTarget.ids : ids;
      let values;
      if (tabularTarget) {
        values = tabularTarget.values;
      } else if (htmlMatrix) {
        values = selectionClipboard.cellRectPasteValuesFromMatrix(selection, htmlMatrix) ||
          selectionClipboard.flattenPasteMatrix(htmlMatrix, ids.length);
      } else if (textMatrix) {
        values = selectionClipboard.cellRectPasteValuesFromMatrix(selection, textMatrix) ||
          selectionClipboard.cellPasteValues(text, ids.length);
      } else {
        values = selectionClipboard.cellPasteValues(text, ids.length);
      }
      vscode.postMessage({ type: 'rangeExecute', action: 'cellTextReplace', ids: targetIds, values });
      announceNav('Pasting into ' + (targetIds.length === 1 ? 'cell' : targetIds.length + ' cells') + '…');
      return true;
    }

    function executeSelectedBlockPaste(e) {
      if (!selection || selection.mode !== 'single' || selection.unit !== 'block') return false;
      if (selection.kind !== 'p' && selection.kind !== 'li') return false;
      if (typeof selectedBlockPasteBlocksFromClipboard !== 'function') return false;
      const blocks = selectedBlockPasteBlocksFromClipboard(e);
      if (!Array.isArray(blocks) || blocks.length === 0) return false;
      e.preventDefault();
      e.stopPropagation();
      postStructural('pasteBlocks', selection.id, withStructuralSuccess('pasteBlocks', selection.kind, {
        prefix: '',
        suffix: '',
        blocks: blocks,
      }));
      announceNav('Pasting content…');
      return true;
    }

    function eventTargetOwnsTextInput(e) {
      const target = e.target;
      return !!(
        target &&
        typeof target.closest === 'function' &&
        target.closest('[contenteditable],input,textarea,select,button,[role="toolbar"]')
      );
    }

    function executePrintableCellReplace(e) {
      if (!selection || selection.mode !== 'single' || selection.unit !== 'cell') return false;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
      if (typeof e.key !== 'string' || e.key.length !== 1) return false;
      if (eventTargetOwnsTextInput(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'rangeExecute', action: 'cellTextReplace', ids: [selection.id], values: [e.key] });
      announceNav('Replacing cell text…');
      return true;
    }

    function singleTargetMultiReason() {
      const editability = selectionAnnouncement.selectionEditability(selectionStateForAnnouncement());
      return editability.reason || 'Structural edits are not available for this selection';
    }

    function selectionStateForAnnouncement() {
      return selectionSummary.selectionStateForAnnouncement(selection);
    }

    function kindOfSelectedId(id) {
      return selectionSummary.kindOfSelectedId(selection, id);
    }

    function dragUnitForEvent(e) {
      const direct = unitOf(e.target);
      if (direct || !unitFromPoint) return direct;
      const main = document.querySelector('main');
      if (!main) return null;
      if (e.target && main.contains && !main.contains(e.target)) return null;
      return unitFromPoint(main, e.clientY);
    }

    function postRangeQuery() {
      if (!selection || !isMultiSelection()) return;
      vscode.postMessage({
        type: 'rangeQuery',
        selection: selectionRange.rangeQuerySelection(selection, currentSelectionIds()),
      });
    }

    function scheduleRangeQuery() {
      if (rangeQueryTimer) clearTimeout(rangeQueryTimer);
      rangeQueryTimer = setTimeout(() => {
        rangeQueryTimer = null;
        postRangeQuery();
      }, 120);
    }

    function updateRangeQuery() {
      if (isMultiSelection()) {
        if (!rangeAvail || !selectionRange.sameIds(rangeAvail.forIds, currentSelectionIds())) rangeAvail = null;
        scheduleRangeQuery();
      } else {
        rangeAvail = null;
        if (rangeQueryTimer) {
          clearTimeout(rangeQueryTimer);
          rangeQueryTimer = null;
        }
      }
    }

    function applyRangeAvailability(msg) {
      rangeAvail = selectionRange.normalizeAvailability(msg);
      onSelectionChange();
      if (selectionRange.sameIds(rangeAvail.forIds, currentSelectionIds()) && isContextToolbarShown()) configureRangeButton();
    }

    function toggleInSelection(el) {
      const d = unitDesc(el);
      if (!d) return;
      const main = document.querySelector('main');
      let units = selectionUnits();
      const idx = units.findIndex((x) => x.unit === d.unit && x.id === d.id);
      if (idx >= 0) units.splice(idx, 1);
      else units.push(d);
      if (units.length === 0) { clearSelection(); return; }
      if (main) units = sortUnitsByDocOrder(units, main);
      setSelection({ mode: 'multiSet', units });
    }

    function executeSelectionDelete() {
      if (!selection) return false;
      if (selection.mode === 'single') {
        if (selection.unit === 'block' || selection.unit === 'image') {
          announceNav('Deleting ' + (selection.kind || 'element') + '…');
          postStructural('deleteElement', selection.id, withStructuralSuccess('deleteElement', selection.kind));
          return true;
        }
        if (selection.unit === 'cell') {
          return executeCellClearForSelection();
        } else {
          announceNav("This element can't be deleted.");
        }
        return true;
      }
      if (isMultiSelection()) {
        if (selectionIsAllCells()) return executeCellClearForSelection();
        if (rangeActionForSelection() !== 'rangeDelete') return false;
        const avail = rangeAvailFor('rangeDelete');
        if (avail && avail.enabled) {
          vscode.postMessage({ type: 'rangeExecute', action: 'rangeDelete', ids: currentSelectionIds() });
        } else if (avail) {
          const reason = avail.reason || 'This selection cannot be deleted.';
          showError(reason);
          announceNav(reason);
        } else {
          announceNav('Checking whether this selection can be deleted…');
        }
        return true;
      }
      return false;
    }

    document.addEventListener('mousedown', (e) => {
      suppressClick = false;
      const u = unitOf(e.target);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (u) e.preventDefault();
        return;
      }
      drag = u ? { anchor: u, mode: 'pending', lastFocusEl: u.el } : null;
      if (u) selAnchorEl = u.el;
    });

    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const u = dragUnitForEvent(e);
      if (drag.mode === 'pending') {
        if (!u || u.el === drag.anchor.el) return;
        drag.mode = 'element';
        const ws = windowObj.getSelection();
        if (ws) ws.removeAllRanges();
        document.body.classList.add('selecting');
      }
      if (drag.mode === 'element') {
        e.preventDefault();
        const focusEl = u ? u.el : null;
        if (focusEl === drag.lastFocusEl) return;
        drag.lastFocusEl = focusEl;
        setSelection(buildSelection(drag.anchor.el, focusEl || drag.anchor.el));
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (drag && drag.mode === 'element') {
        e.preventDefault();
        suppressClick = true;
        document.body.classList.remove('selecting');
        selAnchorEl = drag.anchor.el;
        drag = null;
        announceSelection();
        return;
      }
      drag = null;
    });

    document.addEventListener('click', (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const u = unitOf(e.target);
      const main = document.querySelector('main');
      if (e.shiftKey) {
        if (!u) return;
        e.preventDefault();
        const anchorEl = selAnchorEl && main && main.contains(selAnchorEl) ? selAnchorEl : u.el;
        setSelection(buildSelection(anchorEl, u.el));
        selAnchorEl = anchorEl;
        announceSelection();
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (!u) return;
        e.preventDefault();
        toggleInSelection(u.el);
        selAnchorEl = u.el;
        announceSelection();
        return;
      }
      if (u && u.type === 'image') {
        e.preventDefault();
        e.stopPropagation();
        setSelection(singleSel(u.el));
        selAnchorEl = u.el;
        announceSelection();
        return;
      }
      if (selection && main && main.contains(e.target)) {
        clearSelection();
        announceSelection();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !selection) return;
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      announceSelection();
    });

    document.addEventListener('keydown', (e) => {
      executePrintableCellReplace(e);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (!selection) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (executeSelectionDelete()) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    document.addEventListener('copy', (e) => {
      copySelectionToClipboard(e, true);
    });

    document.addEventListener('cut', (e) => {
      if (!copySelectionToClipboard(e, false)) return;
      if (executeSelectionDelete()) {
        announceNav('Selection cut.');
      } else {
        announceNav('Selection copied. This selection cannot be cut.');
      }
    });

    document.addEventListener('paste', (e) => {
      if (executeCellPaste(e)) return;
      executeSelectedBlockPaste(e);
    }, true);

    document.addEventListener('focusin', (e) => {
      const main = document.querySelector('main');
      if (!main) return;
      for (const el of main.querySelectorAll('[aria-current]')) el.removeAttribute('aria-current');
      const cur = e.target && e.target.closest ? e.target.closest('[data-selectable]') : null;
      if (cur && main.contains(cur)) cur.setAttribute('aria-current', 'true');
    });

    function restoreSelectionAfterRerender(main) {
      if (!selection) return;
      const restored = selectionRestore.restoreSelectionAfterRerender(selection, main, {
        resolveMember: resolveMember,
        fingerprintOf: fingerprintOf,
        buildCellRect: buildCellRect,
      });
      if (restored) {
        selection = restored;
        applySelectionStyles();
        updateSelCount();
        selAnchorEl = selectionAnchorEl(main);
      } else {
        clearSelection();
      }
    }

    return {
      getSelection: function () { return selection; },
      setSelection: setSelection,
      clearSelection: clearSelection,
      setAnchorEl: function (el) { selAnchorEl = el; },
      getSelectionCountText: function () { return selCount.textContent || ''; },
      selectionCount: selectionCount,
      isMultiSelection: isMultiSelection,
      singleTargetMultiReason: singleTargetMultiReason,
      rangeActionForSelection: rangeActionForSelection,
      rangeAvailFor: rangeAvailFor,
      currentSelectionIds: currentSelectionIds,
      cellPasteValues: selectionClipboard.cellPasteValues,
      clearNavFocus: clearNavFocus,
      focusNonEditableTarget: focusNonEditableTarget,
      applyRangeAvailability: applyRangeAvailability,
      restoreSelectionAfterRerender: restoreSelectionAfterRerender,
      resetNavFocusForRerender: function () { navFocusEl = null; },
    };
  }

  window.DitaEditorCanvasSelectionController = {
    installSelectionController: installSelectionController,
  };
})();
