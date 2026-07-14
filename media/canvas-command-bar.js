// Persistent top command bar for the DITA Editor canvas.
//
// Loaded before canvas.js. The module owns the body-level command-bar DOM,
// roving focus, and per-button refresh logic. It posts only the existing host
// message shapes through injected callbacks or vscode.postMessage.
(function () {
  function installCommandBar(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const vscode = opts.vscode;
    const fontFamily = opts.fontFamily;
    const controls = opts.controls;
    const menuIcons = opts.menuIcons;
    const barIcons = opts.barIcons;
    const getSelection = opts.getSelection;
    const getStructVersion = opts.getStructVersion;
    const structTarget = opts.structTarget;
    const caretOffset = opts.caretOffset || function () { return null; };
    const columnAnchorId = opts.columnAnchorId;
    const availFor = opts.availFor;
    const applyAvail = opts.applyAvail;
    const insertAvailFor = opts.insertAvailFor;
    const transformAvailFor = opts.transformAvailFor;
    const postStructural = opts.postStructural;
    const withStructuralSuccess = opts.withStructuralSuccess || function (_op, _kind, extra) { return extra || {}; };
    const postTransform = opts.postTransform;
    const announceNav = opts.announceNav;
    // Optional render-only view tools ({ zoom, spellcheck, help } controllers).
    // Absent in headless installs: the View group hides and roving skips it.
    const viewTools = opts.viewTools || null;

    const isUnavailable = controls.isUnavailable;
    const setBtnEnabled = controls.setBtnEnabled;
    const nextRovingIndex = controls.nextRovingIndex;
    const commandBarUi = window.DitaEditorCanvasCommandBarUi;
    if (!commandBarUi) throw new Error('DITA Editor command bar UI script did not load before canvas-command-bar.js');
    const ui = commandBarUi.createCommandBarUi({
      document: document,
      fontFamily: fontFamily,
      controls: controls,
      menuIcons: menuIcons,
      barIcons: barIcons,
    });
    const cmdBar = ui.cmdBar;
    const hUndo = ui.hUndo;
    const hRedo = ui.hRedo;
    const hFind = ui.hFind;
    hUndo._barRun = function () { vscode.postMessage({ type: 'history', op: 'undo' }); };
    hRedo._barRun = function () { vscode.postMessage({ type: 'history', op: 'redo' }); };
    hFind._barRun = function () { vscode.postMessage({ type: 'history', op: 'find' }); };
    ui.tPrev._barRun = function () { vscode.postMessage({ type: 'navTopic', delta: -1 }); };
    ui.tNext._barRun = function () { vscode.postMessage({ type: 'navTopic', delta: 1 }); };

    const fmtBold = ui.fmtBold;
    const fmtItalic = ui.fmtItalic;
    const fmtUnderline = ui.fmtUnderline;
    const fmtStrike = ui.fmtStrike;
    const fmtCode = ui.fmtCode;
    const fmtSub = ui.fmtSub;
    const fmtSup = ui.fmtSup;
    const fmtClear = ui.fmtClear;
    const fmtBtns = ui.fmtBtns;
    const fmtActionBtns = ui.fmtActionBtns;
    const fmtOp = ui.fmtOp;
    const fmtBtnByOp = ui.fmtBtnByOp;
    const fmtSelector = ui.fmtSelector;
    const commandFormat = window.DitaEditorCanvasCommandFormat;
    if (!commandFormat) throw new Error('DITA Editor command format script did not load before canvas-command-bar.js');
    const commandShortcuts = window.DitaEditorCanvasCommandShortcuts;
    if (!commandShortcuts) throw new Error('DITA Editor command shortcuts script did not load before canvas-command-bar.js');
    const commandInsert = window.DitaEditorCanvasCommandInsert;
    if (!commandInsert) throw new Error('DITA Editor command insert script did not load before canvas-command-bar.js');
    const commandStructure = window.DitaEditorCanvasCommandStructure;
    if (!commandStructure) throw new Error('DITA Editor command structure script did not load before canvas-command-bar.js');
    const formatHelpers = commandFormat.createCommandFormatHelpers({
      document: document,
      window: windowObj,
      getCanvasSelection: getSelection,
      fmtSelector: fmtSelector,
    });

    const biParagraph = ui.biParagraph;
    const biSection = ui.biSection;
    const biList = ui.biList;
    const aiList = ui.aiList;
    const niList = ui.niList;
    const biLines = ui.biLines;
    const biNote = ui.biNote;
    const biCode = ui.biCode;
    const biIndent = ui.biIndent;
    const biOutdent = ui.biOutdent;
    const biTable = ui.biTable;
    const biImage = ui.biImage;
    const biXref = ui.biXref;
    const biConref = ui.biConref;
    const inlineInsertBtns = ui.inlineInsertBtns;
    const inlineInsertOp = ui.inlineInsertOp;
    const tableGroup = ui.tableGroup;
    const cRowAdd = ui.cRowAdd;
    const cRowDel = ui.cRowDel;
    const cColAdd = ui.cColAdd;
    const cColDel = ui.cColDel;
    const tableDivider = ui.tableDivider;
    const cmdBtns = ui.cmdBtns;

    const vZoomOut = ui.vZoomOut;
    const vZoomPct = ui.vZoomPct;
    const vZoomIn = ui.vZoomIn;
    const vSpell = ui.vSpell;
    const vHelp = ui.vHelp;
    const viewBtns = [vZoomOut, vZoomPct, vZoomIn, vSpell, vHelp];
    function refreshViewGroup() {
      if (!viewTools) return;
      if (viewTools.zoom) vZoomPct.textContent = viewTools.zoom.label();
      if (viewTools.spellcheck) setPressed(vSpell, viewTools.spellcheck.enabled());
    }
    if (viewTools) {
      if (viewTools.zoom) {
        vZoomOut._barRun = function () { viewTools.zoom.decrease(); refreshViewGroup(); };
        vZoomPct._barRun = function () { viewTools.zoom.reset(); refreshViewGroup(); };
        vZoomIn._barRun = function () { viewTools.zoom.increase(); refreshViewGroup(); };
      }
      if (viewTools.spellcheck) {
        vSpell._barRun = function () { viewTools.spellcheck.toggle(); refreshViewGroup(); };
      }
      if (viewTools.help) {
        vHelp._barRun = function () { viewTools.help.toggle(); };
      }
      if (viewTools.findReplace) {
        ui.hReplace._barRun = function () { viewTools.findReplace.toggle(); };
      } else {
        ui.hReplace.style.display = 'none';
      }
    } else {
      ui.viewGroup.wrap.style.display = 'none';
      ui.viewDivider.style.display = 'none';
      for (const b of viewBtns) b.style.display = 'none';
      ui.hReplace.style.display = 'none';
    }

    let barCurrent = null;
    function structIdSelector(id) {
      const value = String(id);
      if (windowObj.CSS && typeof windowObj.CSS.escape === 'function') {
        return '[data-struct-id="' + windowObj.CSS.escape(value) + '"]';
      }
      return '[data-struct-id="' + value.replace(/"/g, '\\"') + '"]';
    }
    function contextFromNode(node) {
      const struct = node && node.closest ? structTarget(node) : null;
      if (!struct) return null;
      const editEl = node && node.closest ? node.closest('[data-edit-id][contenteditable]') : null;
      const sel = windowObj.getSelection();
      const isCollapsed = !!(sel && sel.isCollapsed);
      const cell = node && node.closest ? node.closest('td[data-cell-id], th[data-cell-id]') : null;
      const rowStruct = cell && cell.closest ? cell.closest('[data-struct-id][data-struct-kind="row"]') : null;
      // Resolved directly: structTarget skips ul/ol and returns the lines leaf
      // for the corpus <li><lines> shape, so the li never surfaces as `kind`.
      const liEl = node && node.closest ? node.closest('li[data-struct-id][data-struct-kind="li"]') : null;
      const noteEl = node && node.closest ? node.closest('[data-struct-id][data-struct-kind="note"]') : null;
      const cellEntryId = cell ? cell.getAttribute('data-cell-id') : null;
      const editId = editEl ? editEl.getAttribute('data-edit-id') : null;
      const directEntryEdit = !!(cellEntryId && editId === cellEntryId);
      const id = directEntryEdit ? cellEntryId : struct.getAttribute('data-struct-id');
      const kind = directEntryEdit ? 'entry' : struct.getAttribute('data-struct-kind');
      return {
        id: id,
        kind: kind,
        editId: editId,
        caretOffset: editEl ? caretOffset(editEl) : null,
        textLength: editEl ? commandStructure.sourceTextLength(editEl) : null,
        isCollapsed: isCollapsed,
        rowId: rowStruct ? rowStruct.getAttribute('data-struct-id') : null,
        listItemId: liEl ? liEl.getAttribute('data-struct-id') : null,
        insideNote: !!(noteEl && noteEl !== struct),
        cellId: cell ? columnAnchorId(cell) : null,
        cellEntryId: cellEntryId,
        structEl: directEntryEdit ? cell : struct,
        cellEl: cell || null,
      };
    }
    function selectedBlockNode() {
      const selection = getSelection ? getSelection() : null;
      if (!selection || selection.mode !== 'single' || selection.unit !== 'block' || selection.id == null) return null;
      return document.querySelector(structIdSelector(selection.id));
    }
    function resolveBarContext() {
      const sel = windowObj.getSelection();
      let node = sel && sel.anchorNode ? sel.anchorNode : null;
      if (node && node.nodeType === 3) node = node.parentElement;
      if ((!node || !node.closest || !node.closest('main')) && document.activeElement) {
        const ae = document.activeElement;
        if (ae.closest && ae.closest('main')) node = ae;
      }
      return contextFromNode(node) || contextFromNode(selectedBlockNode());
    }
    function refreshBarCurrent() {
      barCurrent = resolveBarContext();
      return barCurrent;
    }

    let cmdRovingIdx = 0;
    function visibleCmdBtns() {
      return cmdBtns.filter((b) => b.style.display !== 'none');
    }
    function setCmdRoving(i) {
      const vis = visibleCmdBtns();
      if (!vis.length) return null;
      const idx = Math.max(0, Math.min(i, vis.length - 1));
      cmdRovingIdx = idx;
      for (const b of cmdBtns) b.tabIndex = -1;
      vis[idx].tabIndex = 0;
      return vis[idx];
    }

    function announceBtn(btn) {
      const action = btn.dataset.action || btn.getAttribute('aria-label') || 'control';
      if (isUnavailable(btn)) announceNav(action + ', unavailable: ' + (btn.getAttribute('aria-label') || 'not available') + '.');
      else announceNav(action + '.');
    }

    function activateCmdBtn(b) {
      if (isUnavailable(b)) {
        announceNav('Unavailable: ' + (b.getAttribute('aria-label') || 'not available') + '.');
        return;
      }
      if (typeof b._barRun === 'function') b._barRun();
    }

    function barInsert(op) {
      const current = refreshBarCurrent();
      const placement = commandInsert.blockInsertPlacement(current);
      if (!placement) {
        announceNav('Place the caret in a paragraph, list item, table, figure, or table cell to insert here.');
        return;
      }
      vscode.postMessage({ type: 'insert', op: op, payload: commandInsert.payloadForPlacement(placement) });
      announceNav('Insert ' + op + ' ' + placement.label + '…');
    }

    function runStructureAction(op) {
      const listItemTransform = listItemSelectionTransformFor(op);
      if (listItemTransform) {
        postSelectedListKindTransform(listItemTransform, commandStructure.structureTransformLabel(op, listItemTransform));
        return;
      }
      const selectionTransform = paragraphSelectionTransformFor(op);
      if (selectionTransform) {
        postSelectedTransform(selectionTransform, commandStructure.structureTransformLabel(op, selectionTransform));
        return;
      }
      const lineSelectionTransform = lineSelectionTransformFor(op);
      if (lineSelectionTransform) {
        postSelectedTransform(lineSelectionTransform, commandStructure.structureTransformLabel(op, lineSelectionTransform));
        return;
      }
      const current = refreshBarCurrent();
      const transform = commandStructure.structureTransformFor(op, current);
      if (transform) {
        if (postSelectedTransform(transform, commandStructure.structureTransformLabel(op, transform))) return;
        postTransform(transform, current.editId || current.id);
        return;
      }
      if (commandStructure.isSameStructureInNote(op, current)) {
        announceNav('Already in that form.');
        return;
      }
      if (commandStructure.isEditingBeforeEnd(current)) {
        announceNav('Move the caret to the end to insert here.');
        return;
      }
      barInsert(op);
    }

    biParagraph._barRun = function () { runStructureAction('paragraph'); };
    biSection._barRun = function () { runStructureAction('section'); };
    biList._barRun = function () { runStructureAction('unorderedList'); };
    aiList._barRun = function () { runStructureAction('alphabeticList'); };
    niList._barRun = function () { runStructureAction('orderedList'); };
    biLines._barRun = function () { runStructureAction('lines'); };
    biNote._barRun = function () { runStructureAction('note'); };
    biCode._barRun = function () { runStructureAction('codeblock'); };
    biIndent._barRun = function () { if (barCurrent && barCurrent.listItemId) postStructural('indentItem', barCurrent.listItemId, withStructuralSuccess('indentItem', 'li')); };
    biOutdent._barRun = function () { if (barCurrent && barCurrent.listItemId) postStructural('outdentItem', barCurrent.listItemId, withStructuralSuccess('outdentItem', 'li')); };
    biTable._barRun = function () { barInsert('table'); };
    cRowAdd._barRun = function () { if (barCurrent && barCurrent.rowId) postStructural('addRowAfter', barCurrent.rowId, withStructuralSuccess('addRowAfter', 'row')); };
    cRowDel._barRun = function () { if (barCurrent && barCurrent.rowId) postStructural('deleteRow', barCurrent.rowId, withStructuralSuccess('deleteRow', 'row')); };
    cColAdd._barRun = function () { if (barCurrent && barCurrent.cellEntryId) postStructural('addColumnAfter', barCurrent.cellEntryId, withStructuralSuccess('addColumnAfter', 'entry')); };
    cColDel._barRun = function () { if (barCurrent && barCurrent.cellEntryId) postStructural('deleteColumn', barCurrent.cellEntryId, withStructuralSuccess('deleteColumn', 'entry')); };

    const currentFormatTarget = formatHelpers.currentFormatTarget;
    const currentFormatState = formatHelpers.currentFormatState;
    const formattableSelectionIds = formatHelpers.formattableSelectionIds;
    const currentInlineInsertTarget = formatHelpers.currentInlineInsertTarget;
    function setPressed(btn, pressed) {
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      btn.style.background = pressed ? '#e9eef2' : 'transparent';
      btn.style.color = pressed ? '#1f2f3a' : '#5f5f5f';
      btn.style.boxShadow = pressed ? 'inset 0 0 0 1px #b7c7d1' : '';
    }
    function barFormat(op) {
      const t = currentFormatTarget();
      if (t && t.mid !== '' && t.editId != null) {
        vscode.postMessage({
          type: 'inline', op: op, id: t.editId,
          before: t.before, mid: t.mid, after: t.after,
          caretOffset: t.caretOffset,
          baseStructVersion: getStructVersion(),
        });
        announceNav(op + ' applied to selection…');
        return;
      }
      const ids = formattableSelectionIds();
      if (ids.length) {
        vscode.postMessage({ type: 'inlineMulti', op: op, ids: ids, baseStructVersion: getStructVersion() });
        announceNav(op + ' applied to ' + ids.length + ' element' + (ids.length === 1 ? '' : 's') + '…');
      }
    }
    function barRemoveStyles() {
      const t = currentFormatTarget();
      if (t && t.mid !== '' && t.editId != null) {
        vscode.postMessage({
          type: 'removeStyles', id: t.editId,
          before: t.before, mid: t.mid, after: t.after,
          caretOffset: t.caretOffset,
          baseStructVersion: getStructVersion(),
        });
        announceNav('Styles removed from selection…');
        return;
      }
      const ids = formattableSelectionIds();
      if (ids.length) {
        vscode.postMessage({ type: 'removeStyles', ids: ids, baseStructVersion: getStructVersion() });
        announceNav('Styles removed from ' + ids.length + ' element' + (ids.length === 1 ? '' : 's') + '…');
      }
    }
    function selectedListItemIds() {
      return commandStructure.selectedListItemIds(getSelection());
    }
    function hasMultiListItemSelection() {
      return commandStructure.hasMultiListItemSelection(getSelection());
    }
    function listItemSelectionTransformFor(op) {
      if (!hasMultiListItemSelection()) return null;
      if (op === 'alphabeticList') return 'toAlphabeticList';
      if (op === 'orderedList') return 'toOrderedList';
      if (op === 'unorderedList') return 'toUnorderedList';
      return null;
    }
    function selectedBlockIds(kind) {
      const selection = getSelection ? getSelection() : null;
      if (!selection || selection.mode === 'single') return [];
      if (selection.mode === 'blockRange') {
        if (selection.kind !== kind) return [];
        return (selection.members || []).map((member) => member.id).filter((id) => id != null);
      }
      if (selection.mode === 'multiSet') {
        const units = selection.units || [];
        if (!units.length) return [];
        const ids = [];
        for (const unit of units) {
          if (!unit || unit.unit !== 'block' || unit.kind !== kind || unit.id == null) return [];
          ids.push(unit.id);
        }
        return ids;
      }
      return [];
    }
    function hasCanvasMultiSelection() {
      const selection = getSelection ? getSelection() : null;
      if (!selection || selection.mode === 'single') return false;
      if (selection.mode === 'multiSet') return (selection.units || []).length > 0;
      if (selection.members) return selection.members.length > 0;
      return false;
    }
    function selectedIdsForTransform(transform) {
      switch (transform) {
        case 'paragraphToOrderedList':
        case 'paragraphToUnorderedList':
        case 'paragraphToAlphabeticList':
        case 'paragraphToSection':
        case 'paragraphToNote':
        case 'paragraphToCodeblock':
          return selectedBlockIds('p');
        case 'linesToParagraph':
        case 'linesToUnorderedList':
        case 'linesToOrderedList':
        case 'linesToAlphabeticList':
        case 'linesToSection':
        case 'linesToNote':
        case 'linesToCodeblock':
          return selectedBlockIds('lines');
        default:
          return [];
      }
    }
    function postSelectedTransform(transform, label) {
      const ids = selectedIdsForTransform(transform);
      if (!ids.length) {
        if (hasCanvasMultiSelection()) {
          announceNav('That transform is not available for this selection.');
          return true;
        }
        return false;
      }
      vscode.postMessage({ type: 'multiTransform', transform: transform, ids: ids, baseStructVersion: getStructVersion() });
      announceNav(label + ' applied to ' + ids.length + ' selected item' + (ids.length === 1 ? '' : 's') + '…');
      return true;
    }
    function postSelectedListKindTransform(transform, label) {
      const ids = selectedListItemIds();
      if (!ids.length) return false;
      vscode.postMessage({ type: 'multiTransform', transform: transform, ids: ids, baseStructVersion: getStructVersion() });
      announceNav(label + ' applied to ' + ids.length + ' selected item' + (ids.length === 1 ? '' : 's') + '…');
      return true;
    }
    function paragraphSelectionTransformFor(op) {
      if (!selectedBlockIds('p').length) return null;
      if (op === 'unorderedList') return 'paragraphToUnorderedList';
      if (op === 'alphabeticList') return 'paragraphToAlphabeticList';
      if (op === 'orderedList') return 'paragraphToOrderedList';
      if (op === 'section') return 'paragraphToSection';
      if (op === 'note') return 'paragraphToNote';
      if (op === 'codeblock') return 'paragraphToCodeblock';
      return null;
    }
    function lineSelectionTransformFor(op) {
      if (!selectedBlockIds('lines').length) return null;
      if (op === 'paragraph') return 'linesToParagraph';
      if (op === 'unorderedList') return 'linesToUnorderedList';
      if (op === 'alphabeticList') return 'linesToAlphabeticList';
      if (op === 'orderedList') return 'linesToOrderedList';
      if (op === 'section') return 'linesToSection';
      if (op === 'note') return 'linesToNote';
      if (op === 'codeblock') return 'linesToCodeblock';
      return null;
    }
    function selectedListTags(ids) {
      return commandStructure.selectedListTags(document, windowObj, ids);
    }
    function selectedListStyles(ids) {
      return commandStructure.selectedListStyles(document, windowObj, ids);
    }
    function applyBarMultiListTransform(btn, ids, transform, label, alreadyReason) {
      const targetStyle = transform === 'toAlphabeticList'
        ? 'alpha'
        : transform === 'toOrderedList'
          ? 'ordered'
          : 'unordered';
      const styles = selectedListStyles(ids);
      const allAlready = styles.length > 0 && styles.length === ids.length && styles.every((style) => style === targetStyle);
      setBtnEnabled(btn, !allAlready, allAlready ? alreadyReason : label);
    }
    const shortcutHistoryOp = commandShortcuts.historyShortcutOp;
    const shortcutFormatOp = commandShortcuts.formatShortcutOp;
    for (const b of fmtBtns) {
      b._barRun = (function (btn) { return function () { barFormat(fmtOp[btn.dataset.action]); }; })(b);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); });
    }
    fmtClear._barRun = barRemoveStyles;
    fmtClear.addEventListener('mousedown', (e) => { e.preventDefault(); });

    function barInsertInline(op) {
      const t = currentInlineInsertTarget();
      if (!t || t.editId == null) return;
      vscode.postMessage({
        type: 'insertInline', op: op, id: t.editId,
        before: t.before, after: t.after, baseStructVersion: getStructVersion(),
      });
      announceNav('Insert ' + op + '…');
    }
    for (const b of inlineInsertBtns) {
      b._barRun = (function (btn) { return function () { barInsertInline(inlineInsertOp[btn.dataset.action]); }; })(b);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); });
    }

    for (const b of cmdBtns) {
      b.addEventListener('mousedown', (e) => { e.preventDefault(); });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateCmdBtn(b);
      });
    }

    function applyBarTransform(btn, id, transform, label, forceReason) {
      const a = transformAvailFor(id, transform);
      const enabled = !forceReason && a.status === 'ok';
      const reason = forceReason || a.reason || (a.status === 'noop' ? 'Already in that form' : 'Not available here');
      setBtnEnabled(btn, enabled, enabled ? label : reason);
    }
    function refresh() {
      barCurrent = resolveBarContext();
      const c = barCurrent;
      const hasBlock = !!(c && c.id != null);
      const inCell = !!(c && c.cellEntryId);
      const multiListIds = selectedListItemIds();
      const multiListTransform = hasMultiListItemSelection();
      const hasMultiSelection = hasCanvasMultiSelection();

      const fmtTarget = currentFormatTarget();
      const canFormat = !!((fmtTarget && fmtTarget.mid !== '') || formattableSelectionIds().length);
      for (const b of fmtActionBtns) {
        setBtnEnabled(b, canFormat, canFormat ? b.dataset.action : 'Select text, or select elements, to format');
      }
      for (const op of Object.keys(fmtBtnByOp)) {
        setPressed(fmtBtnByOp[op], canFormat && currentFormatState(op));
      }

      const canInline = !!currentInlineInsertTarget();
      for (const b of inlineInsertBtns) {
        setBtnEnabled(b, canInline, canInline ? b.dataset.action : 'Place the caret in text to insert here');
      }

      const afterSpec = [
        { b: biParagraph, op: 'paragraph', label: 'Insert paragraph after' },
        { b: biSection, op: 'section', label: 'Insert section after' },
        { b: biList, op: 'unorderedList', label: 'Insert bulleted list after' },
        { b: aiList, op: 'alphabeticList', label: 'Insert alphabetic list after' },
        { b: niList, op: 'orderedList', label: 'Insert numbered list after' },
        { b: biLines, op: 'lines', label: 'Insert lines after' },
        { b: biNote, op: 'note', label: 'Insert note after' },
        { b: biCode, op: 'codeblock', label: 'Insert code block after' },
        { b: biTable, op: 'table', label: 'Insert table after' },
      ];
      for (const s of afterSpec) {
        const listItemTransform = listItemSelectionTransformFor(s.op);
        if (listItemTransform) {
          applyBarMultiListTransform(
            s.b,
            multiListIds,
            listItemTransform,
            listItemTransform === 'toOrderedList'
              ? 'Convert selected lists to numbered lists'
              : listItemTransform === 'toAlphabeticList'
                ? 'Convert selected lists to alphabetic lists'
                : 'Convert selected lists to bulleted lists',
            listItemTransform === 'toOrderedList'
              ? 'Selected lists are already numbered'
              : listItemTransform === 'toAlphabeticList'
                ? 'Selected lists are already alphabetic'
                : 'Selected lists are already bulleted',
          );
          continue;
        }
        const selectionTransform = paragraphSelectionTransformFor(s.op);
        if (selectionTransform) {
          setBtnEnabled(s.b, true, commandStructure.structureTransformLabel(s.op, selectionTransform));
          continue;
        }
        if (hasMultiSelection) {
          setBtnEnabled(s.b, false, 'That transform is not available for this selection');
          continue;
        }
        const transform = commandStructure.structureTransformFor(s.op, c);
        if (transform) {
          applyBarTransform(s.b, c.id, transform, commandStructure.structureTransformLabel(s.op, transform), null);
          continue;
        }
        if (commandStructure.isSameStructureInNote(s.op, c)) {
          setBtnEnabled(s.b, false, s.op === 'paragraph' ? 'Already a paragraph' : 'Already in that form');
          continue;
        }
        if (commandStructure.isEditingBeforeEnd(c)) {
          setBtnEnabled(s.b, false, 'Move the caret to the end to insert here');
          continue;
        }
        const placement = hasBlock ? commandInsert.blockInsertPlacement(c) : null;
        if (!placement) {
          setBtnEnabled(s.b, false, 'Place the caret in an element to insert here');
        } else {
          const label = placement.label === 'after' ? s.label : s.label.replace(' after', ' ' + placement.label);
          const a = insertAvailFor(placement.id, placement.mode, s.op);
          setBtnEnabled(s.b, a.enabled, a.enabled ? label : a.reason || label);
        }
      }

      if (hasMultiSelection) {
        setBtnEnabled(biIndent, false, 'Select a single list item to indent');
        setBtnEnabled(biOutdent, false, 'Select a single list item to outdent');
      } else if (c && c.listItemId) {
        applyAvail(biIndent, c.listItemId, 'indentItem', 'Increase indent');
        applyAvail(biOutdent, c.listItemId, 'outdentItem', 'Decrease indent');
      } else {
        setBtnEnabled(biIndent, false, 'Place the caret in a list item');
        setBtnEnabled(biOutdent, false, 'Place the caret in a list item');
      }

      const tableVis = inCell ? 'inline-flex' : 'none';
      tableGroup.wrap.style.display = inCell ? 'flex' : 'none';
      tableDivider.style.display = inCell ? 'block' : 'none';
      cRowAdd.style.display = tableVis;
      cRowDel.style.display = tableVis;
      cColAdd.style.display = tableVis;
      cColDel.style.display = tableVis;
      if (inCell) {
        applyAvail(cRowAdd, c.rowId, 'addRowAfter', 'Add row below');
        applyAvail(cRowDel, c.rowId, 'deleteRow', 'Delete this row');
        const anchorOk = !!c.cellEntryId;
        const addA = availFor(c.cellEntryId, 'addColumnAfter');
        const delA = availFor(c.cellEntryId, 'deleteColumn');
        setBtnEnabled(cColAdd, anchorOk && addA.enabled,
          !anchorOk ? 'No editable cell in this column' : addA.enabled ? 'Add column to the right' : addA.reason || 'Add column to the right');
        setBtnEnabled(cColDel, anchorOk && delA.enabled,
          !anchorOk ? 'No editable cell in this column' : delA.enabled ? 'Delete this column' : delA.reason || 'Delete this column');
      }

      refreshViewGroup();
      setCmdRoving(cmdRovingIdx);
    }

    cmdBar.addEventListener('keydown', (e) => {
      const vis = visibleCmdBtns();
      if (!vis.length) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const curIdx = vis.indexOf(document.activeElement);
        const btn = setCmdRoving(nextRovingIndex(vis.length, curIdx, e.key));
        if (btn) {
          btn.focus();
          announceBtn(btn);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        const btn = document.activeElement;
        if (!btn || cmdBtns.indexOf(btn) < 0) return;
        e.preventDefault();
        e.stopPropagation();
        activateCmdBtn(btn);
      }
    });

    document.addEventListener('selectionchange', refresh);
    document.addEventListener('keydown', (e) => {
      const historyOp = shortcutHistoryOp(e);
      if (historyOp) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'history', op: historyOp });
        announceNav(historyOp === 'undo' ? 'Undo…' : historyOp === 'redo' ? 'Redo…' : 'Find…');
        return;
      }
      const op = shortcutFormatOp(e);
      if (!op) return;
      e.preventDefault();
      e.stopPropagation();
      refresh();
      const btn = fmtBtnByOp[op];
      if (!btn || isUnavailable(btn)) {
        announceNav('Select text, or place the caret in a word, to format.');
        return;
      }
      barFormat(op);
    });
    refresh();

    return {
      refresh: refresh,
    };
  }

  window.DitaEditorCanvasCommandBar = {
    installCommandBar: installCommandBar,
  };
})();
