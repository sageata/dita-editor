// Editing client for the DITA Editor canvas.
//
// TEXT: editable leaves (contenteditable + data-edit-id) commit live as you type
// (debounced) and on blur/Enter, so the .dita document tracks the canvas.
//
// STRUCTURE: rows, list items and paragraphs carry data-struct-id/data-struct-kind.
//   - Enter in a cell -> add a row. Enter in a paragraph / list item -> SPLIT at
//     the caret (text before stays, text after moves to a new sibling); splitting
//     at the end just adds an empty one.
//   - Backspace at the START of a paragraph / list item -> JOIN it into the
//     previous one (caret lands at the seam); on an empty first one, delete it.
//   - The fixed command bar and right-click context menu own structural commands.
// Structural edits re-render the <main> in place (no flicker, scroll preserved)
// via a 'rerender' message from the host, which then restores the caret.
(function () {
  const vscode = acquireVsCodeApi();
  const DEBOUNCE_MS = 250;
  if (!window.DitaEditorCanvasScrollAnchor) throw new Error('DITA Editor scroll anchor script did not load before canvas.js');
  const scrollAnchor = window.DitaEditorCanvasScrollAnchor.create({
    document: document,
    window: window,
    postMessage: (message) => vscode.postMessage(Object.assign({ baseStructVersion: structVersion }, message)),
  });
  // Host-computed keyboard navigation map: focusId -> { ArrowUp|...|End: NavResult }. Pushed by
  // the host on load (navready handshake) and on every rerender. The Arrow/Home/End handler does a
  // SYNCHRONOUS local lookup here; table Tab navigation uses rendered cell order locally. Neither
  // path posts to the host per keystroke.
  let navMap = {};
  // P0-2 command-availability map: elementId (data-struct-id / data-cell-id) -> op -> {enabled,
  // reason?}. Host-computed from the validity core and pushed with navMap (load handshake + every
  // rerender). showToolbarFor reads it to enable/disable controls — the SINGLE SOURCE OF TRUTH for
  // structural validity; the canvas no longer re-derives merge/column/delete rules from the DOM.
  let cmdMap = {};
  // #13 insert-availability map: refId (the inserted-relative anchor's data-struct-id, an e{N} id) ->
  // { before:[{kind,enabled,reason?}], after:[...], into:[...] }. Host-computed from the insert core
  // (canInsert) and pushed like cmdMap. The cross-kind Insert menu reads it to gate each item. Until
  // the host ships it (W6 #18 insertMap is the host side), it stays {} and insertAvailFor defaults to
  // ENABLED — exactly like availFor/cmdMap — so the host still validates+refuses+resyncs a bad insert.
  let insertMap = {};
  // #22 block-transform availability map: focusId (p/li data-struct-id or entry data-cell-id) -> transform -> {status:'ok'|
  // 'noop'|'invalid', reason?}. Host-computed from planTransform and pushed like navMap/cmdMap (handoff
  // docs/p1-3-transform-wiring-handoff.md §4). The right-click transform menu reads it: status 'ok' ->
  // enabled, 'noop'/'invalid' -> disabled-with-reason. Until the host ships it (W6 #22 owns the host
  // branch in extension.ts), it stays {} and transformAvailFor defaults to 'ok' (host still
  // plans+refuses+resyncs a bad transform), so the menu can drive the host once that branch lands.
  let transformMap = {};
  // FILE-LEVEL document properties for the left Properties sidebar: { id, kind, attrs:[{name,value}] }
  // of the outermost topic root (host buildDocProps), pushed like the other maps. The panel edits the
  // WHOLE document's metadata on the root element, NOT the selected element. null until the host ships it.
  let docProps = null;
  function readEmbeddedTaxonomy() {
    const node = document.getElementById('ditaeditor-taxonomy-data');
    if (!node) return null;
    try {
      const parsed = JSON.parse(node.textContent || 'null');
      return parsed && parsed.version === 1 && Array.isArray(parsed.fields) ? parsed : null;
    } catch (error) {
      console.error('DITA Editor: embedded taxonomy JSON could not be parsed.', error);
      return null;
    }
  }
  let taxonomy = readEmbeddedTaxonomy();
  // CSS-backed author styles for the right Styles panel. The host reads/writes the real workspace CSS
  // file and pushes definitions + generated CSS; the canvas only renders controls and posts intents.
  let styleState = { styles: [], cssText: '', writable: false, sourceHash: '', targetToken: '' };

  // Optimistic-concurrency token for STRUCTURAL ops. data-struct-id is a positional index
  // (src/cst/element-ids.ts) that is only valid within one render cycle; a structural edit
  // reassigns every id. The host stamps each rerender with a structVersion and rejects any
  // structural op whose baseStructVersion is stale — so rapid Enter/Backspace in a list can
  // no longer post a SECOND op carrying ids from a superseded render (which previously hit the
  // wrong element and duplicated text into the file). Text edits do NOT bump it (they preserve
  // element identity), so the common "type then Enter" stays a single live cycle.
  let structVersion = 0;

  // True only while a host rerender is swapping <main>'s innerHTML. Detaching the focused
  // element fires `blur`, and that blur handler would otherwise commit(el) using the element's
  // STALE pre-rerender id — which after a structural edit resolves to a DIFFERENT element (or
  // none), throwing on the host and forcing a focusId-less resync that wipes the just-restored
  // caret (the "can't type after Tab-indent" bug). The swap-driven blur is not a real edit, so
  // skip it; genuine user blurs (clicking away) still commit because the flag is false then.
  let rerendering = false;
  let selectionController = null;
  function getCanvasSelection() {
    return selectionController ? selectionController.getSelection() : null;
  }
  function setSelection(sel) {
    if (selectionController) selectionController.setSelection(sel);
  }
  function clearSelection() {
    if (selectionController) selectionController.clearSelection();
  }
  function setSelectionAnchor(el) {
    if (selectionController) selectionController.setAnchorEl(el);
  }
  function getSelectionCountText() {
    return selectionController ? selectionController.getSelectionCountText() : '';
  }
  function clearNavFocus() {
    if (selectionController) selectionController.clearNavFocus();
  }
  function focusNonEditableTarget(el) {
    if (selectionController) selectionController.focusNonEditableTarget(el);
  }
  function selectionCount() {
    return selectionController ? selectionController.selectionCount() : 0;
  }
  function isMultiSelection() {
    return selectionController ? selectionController.isMultiSelection() : false;
  }
  function singleTargetMultiReason() {
    return selectionController ? selectionController.singleTargetMultiReason() : 'Single-item action';
  }
  function rangeActionForSelection() {
    return selectionController ? selectionController.rangeActionForSelection() : null;
  }
  function rangeAvailFor(action) {
    return selectionController ? selectionController.rangeAvailFor(action) : null;
  }
  function currentSelectionIds() {
    return selectionController ? selectionController.currentSelectionIds() : [];
  }
  function applyRangeAvailability(msg) {
    if (selectionController) selectionController.applyRangeAvailability(msg);
  }
  function resetSelectionForRerender() {
    if (selectionController) selectionController.resetNavFocusForRerender();
  }
  function restoreSelectionAfterRerender(main) {
    if (selectionController) selectionController.restoreSelectionAfterRerender(main);
  }

  const canvasEditing = window.DitaEditorCanvasEditing;
  if (!canvasEditing) throw new Error('DITA Editor editing script did not load before canvas.js');
  const editing = canvasEditing.installCanvasEditing({
    document: document,
    window: window,
    vscode: vscode,
    debounceMs: DEBOUNCE_MS,
    getStructVersion: () => structVersion,
    getRerendering: () => rerendering,
    getSelection: getCanvasSelection,
  });
  const ADD_OP = editing.ADD_OP;
  const DEL_OP = editing.DEL_OP;
  const clearTimer = editing.clearTimer;
  const editableTarget = editing.editableTarget;
  const structTarget = editing.structTarget;
  const postStructural = editing.postStructural;
  const withStructuralSuccess = editing.withStructuralSuccess;
  const caretOffset = editing.caretOffset;
  const setCaret = editing.setCaret;
  const sourceTextLength = editing.sourceTextLength;
  const selectContents = editing.selectContents;
  const cellEditTarget = editing.cellEditTarget;

  const canvasChrome = window.DitaEditorCanvasChrome;
  if (!canvasChrome) throw new Error('DITA Editor chrome script did not load before canvas.js');
  const chrome = canvasChrome.installCanvasChrome({
    document: document,
    window: window,
    editableTarget: editableTarget,
    clearNavFocus: clearNavFocus,
  });
  const announceNav = chrome.announceNav;
  const showError = chrome.showError;
  const hideError = chrome.hideError;
  const elementPath = chrome.elementPath;

  // ==================== View tools (zoom / spellcheck / shortcut help; zero document bytes) ====================
  const canvasZoom = window.DitaEditorCanvasZoom;
  if (!canvasZoom) throw new Error('DITA Editor zoom script did not load before canvas.js');
  const zoomCtl = canvasZoom.installCanvasZoom({
    document: document,
    window: window,
    announceNav: announceNav,
    // Body-level overlays (table resize handles, image bar) measure zoomed
    // geometry — reposition them whenever the zoom level changes.
    onChange: () => window.dispatchEvent(new Event('ditaeditor:zoomchange')),
  });
  const canvasSpellcheck = window.DitaEditorCanvasSpellcheck;
  if (!canvasSpellcheck) throw new Error('DITA Editor spellcheck script did not load before canvas.js');
  const spellCtl = canvasSpellcheck.installSpellcheckToggle({
    document: document,
    window: window,
    announceNav: announceNav,
  });
  const canvasShortcutHelp = window.DitaEditorCanvasShortcutHelp;
  if (!canvasShortcutHelp) throw new Error('DITA Editor shortcut help script did not load before canvas.js');
  const helpCtl = canvasShortcutHelp.installShortcutHelp({
    document: document,
    window: window,
    announceNav: announceNav,
  });

  // ==================== UX-7 inline lint marks (host-pushed dita-quality findings) ====================
  const canvasLintMarks = window.DitaEditorCanvasLintMarks;
  if (!canvasLintMarks) throw new Error('DITA Editor lint marks script did not load before canvas.js');
  const lintMarks = canvasLintMarks.installLintMarks({ document: document });

  // ==================== IX-4 find & replace (byte-minimal edits through the normal edit path) ====================
  const canvasFindReplace = window.DitaEditorCanvasFindReplace;
  if (!canvasFindReplace) throw new Error('DITA Editor find/replace script did not load before canvas.js');
  const findReplace = canvasFindReplace.installFindReplace({
    document: document,
    window: window,
    vscode: vscode,
    clearTimer: clearTimer,
    announceNav: announceNav,
  });

  // --- keyboard navigation (Arrow / Home / End / table Tab) ---
  const canvasKeyboardNav = window.DitaEditorCanvasKeyboardNav;
  if (!canvasKeyboardNav) throw new Error('DITA Editor keyboard navigation script did not load before canvas.js');
  canvasKeyboardNav.installKeyboardNavigation({
    document: document,
    window: window,
    getNavMap: () => navMap,
    editableTarget: editableTarget,
    cellEditTarget: cellEditTarget,
    selectContents: selectContents,
    caretOffset: caretOffset,
    sourceTextLength: sourceTextLength,
    setCaret: setCaret,
    focusNonEditableTarget: focusNonEditableTarget,
    announceNav: announceNav,
  });

  const canvasControls = window.DitaEditorCanvasControls;
  if (!canvasControls) throw new Error('DITA Editor controls script did not load before canvas.js');
  const isUnavailable = canvasControls.isUnavailable;
  const setBtnEnabled = canvasControls.setBtnEnabled;

  let insertMenuController = null;
  let nativeContextMenu = null;
  let imageBar = null;

  const canvasContextToolbar = window.DitaEditorCanvasContextToolbar;
  if (!canvasContextToolbar) throw new Error('DITA Editor context toolbar script did not load before canvas.js');
  const contextToolbar = canvasContextToolbar.installContextToolbar({
    document: document,
    window: window,
    vscode: vscode,
    controls: canvasControls,
    floatingEnabled: false,
    ADD_OP: ADD_OP,
    DEL_OP: DEL_OP,
    editableTarget: editableTarget,
    structTarget: structTarget,
    caretOffset: caretOffset,
    setCaret: setCaret,
    availFor: availFor,
    applyAvail: applyAvail,
    postStructural: postStructural,
    withStructuralSuccess: withStructuralSuccess,
    getSelection: getCanvasSelection,
    isMultiSelection: isMultiSelection,
    selectionCount: selectionCount,
    singleTargetMultiReason: singleTargetMultiReason,
    rangeActionForSelection: rangeActionForSelection,
    rangeAvailFor: rangeAvailFor,
    currentSelectionIds: currentSelectionIds,
    getInsertMenuController: () => insertMenuController,
    getImageBar: () => imageBar,
    announceNav: announceNav,
  });
  const toolbar = contextToolbar.toolbar;
  const insertBtn = contextToolbar.insertBtn;
  const sep4 = contextToolbar.insertSeparator;
  const visibleBtns = contextToolbar.visibleBtns;
  const setRoving = contextToolbar.setRoving;
  const showToolbarFor = contextToolbar.showFor;
  const configureRangeBtn = contextToolbar.configureRangeBtn;
  const clearCellHighlight = contextToolbar.clearCellHighlight;
  const highlightCell = contextToolbar.highlightCell;
  const columnAnchorId = contextToolbar.columnAnchorId;

  const canvasImages = window.DitaEditorCanvasImages;
  if (!canvasImages) throw new Error('DITA Editor images script did not load before canvas.js');
  const scanBrokenImages = canvasImages.installBrokenImageFallback(document, HTMLImageElement);
  const canvasIcons = window.DitaEditorCanvasIcons;
  if (!canvasIcons) throw new Error('DITA Editor icons script did not load before canvas.js');
  const MENU_ICN = canvasIcons.menu;

  // P0-2: an op's availability for an element id from the host-computed cmdMap (validity core SoT).
  // Defaults to ENABLED when the map lacks an entry (pre-handshake / parse error) — never wrongly
  // blocks; the host still refuses a genuinely-invalid op and resyncs. Once cmdMap arrives it wins.
  function availFor(id, op) {
    const e = id != null && cmdMap[id] && cmdMap[id][op];
    return e || { enabled: true };
  }
  // Apply an op's availability to a button: enabled -> the action title; disabled -> the validity
  // reason (falling back to the action title). setBtnEnabled handles aria-disabled + dim + labels.
  function applyAvail(btn, id, op, actionTitle) {
    const a = availFor(id, op);
    setBtnEnabled(btn, a.enabled, a.enabled ? actionTitle : a.reason || actionTitle);
  }

  // ==================== #13 cross-kind Insert menu (keyboard-operable; zero document bytes until activated) ====================
  const canvasInsertMenu = window.DitaEditorCanvasInsertMenu;
  if (!canvasInsertMenu) throw new Error('DITA Editor insert menu script did not load before canvas.js');
  insertMenuController = canvasInsertMenu.installInsertMenu({
    document: document,
    window: window,
    vscode: vscode,
    insertBtn: insertBtn,
    separator: sep4,
    getCurrent: contextToolbar.getCurrent,
    getInsertMap: () => insertMap,
    visibleToolbarButtons: visibleBtns,
    setToolbarRoving: setRoving,
    announceNav: announceNav,
  });
  const insertAvailFor = insertMenuController.insertAvailFor;
  const idOfPayload = insertMenuController.idOfPayload;
  const resolveInsertEntries = insertMenuController.resolveEntries;

  // ==================== IX-5 slash quick-insert menu (same gated entries as the ⊕ menu) ====================
  const canvasSlashMenu = window.DitaEditorCanvasSlashMenu;
  if (!canvasSlashMenu) throw new Error('DITA Editor slash menu script did not load before canvas.js');
  const slashMenu = canvasSlashMenu.installSlashMenu({
    document: document,
    window: window,
    vscode: vscode,
    editableTarget: editableTarget,
    structTarget: structTarget,
    sourceTextLength: sourceTextLength,
    setCaret: setCaret,
    resolveInsertEntries: resolveInsertEntries,
    insertAvailFor: insertAvailFor,
    idOfPayload: idOfPayload,
    recordMru: insertMenuController.recordMru,
    announceNav: announceNav,
  });

  const canvasEndInsert = window.DitaEditorCanvasEndInsert;
  if (!canvasEndInsert) throw new Error('DITA Editor end-insert script did not load before canvas.js');
  const endInsert = canvasEndInsert.installEndInsert({
    document: document,
    vscode: vscode,
    insertAvailFor: insertAvailFor,
    announceNav: announceNav,
  });

  // #22: the host's per-element transform availability, defaulting to status 'ok' when absent — same
  // contract as availFor/cmdMap (handoff §4). `transform` is one of the host TransformTypes.
  function transformAvailFor(id, transform) {
    const e = id != null && transformMap[id] && transformMap[id][transform];
    return e || { status: 'ok' };
  }
  // The webview sends ONLY { type, transform, id } — the host plans + maps + applies (handoff §3b). id
  // is the focused p/li data-struct-id or entry data-cell-id; for list-kind transforms the host walks
  // li -> parent ul/ol (§6).
  function postTransform(transform, id) {
    // #22 canvas guard (belt-and-suspenders with the host fix): a block with no data-struct-id has no
    // anchor the host can resolve, so posting { id:null } would be a silent no-op / resync. Refuse it
    // here, announce why, and skip the post entirely rather than send an unaddressable transform.
    if (id == null || id === '') {
      announceNav('Cannot transform: no anchor on this element.');
      return;
    }
    clearTimer(); // a pending text-edit debounce would clobber the transform result (like postStructural)
    vscode.postMessage({ type: 'transform', transform: transform, id: id });
  }

  // A human-readable noun for a struct kind — used in the menu header and the "Delete this …" label.
  function nounForKind(kind) {
    switch (kind) {
      case 'p': return 'paragraph';
      case 'li': return 'list item';
      case 'title': return 'title';
      case 'shortdesc': return 'short description';
      case 'section': return 'section';
      case 'image': return 'image';
      case 'fig': return 'figure';
      case 'table': return 'table';
      case 'ul': return 'bulleted list';
      case 'ol': return 'numbered list';
      case 'lines': return 'lines block';
      case 'codeblock': return 'code block';
      case 'note': return 'note';
      case 'row': return 'row';
      default: return kind || 'element';
    }
  }

  // VS Code-native right-click context menus. This helper only decorates targets
  // and executes commands forwarded back by the extension host.
  const canvasNativeContextMenu = window.DitaEditorCanvasNativeContextMenu;
  if (!canvasNativeContextMenu) throw new Error('DITA Editor native context menu script did not load before canvas.js');
  nativeContextMenu = canvasNativeContextMenu.installNativeContextMenu({
    document: document,
    vscode: vscode,
    getStyleState: () => styleState,
    clearTimer: clearTimer,
    columnAnchorId: columnAnchorId,
    availFor: availFor,
    withStructuralSuccess: withStructuralSuccess,
    transformAvailFor: transformAvailFor,
    insertAvailFor: insertAvailFor,
    getStructVersion: () => structVersion,
    getSessionId: () => {
      try { return JSON.parse(document.body.dataset.vscodeContext || '{}').ditaNativeSession || ''; }
      catch (error) { console.error('DITA Editor: invalid native context session', error); return ''; }
    },
    currentSelectionIds: currentSelectionIds,
    rangeActionForSelection: rangeActionForSelection,
    rangeAvailFor: rangeAvailFor,
  });

  // ==================== IX-6 markdown-style autoformat (marker + Space → list transform) ====================
  const canvasAutoformat = window.DitaEditorCanvasAutoformat;
  if (!canvasAutoformat) throw new Error('DITA Editor autoformat script did not load before canvas.js');
  canvasAutoformat.installAutoformat({
    document: document,
    vscode: vscode,
    editableTarget: editableTarget,
    structTarget: structTarget,
    caretOffset: caretOffset,
    sourceTextLength: sourceTextLength,
    clearTimer: clearTimer,
    transformAvailFor: transformAvailFor,
    postTransform: postTransform,
    announceNav: announceNav,
  });

  const SYSTEM_SANS = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  // ==================== Persistent top command bar (.cmd-bar; zero document bytes) ====================
  const canvasCommandBar = window.DitaEditorCanvasCommandBar;
  if (!canvasCommandBar) throw new Error('DITA Editor command bar script did not load before canvas.js');
  const commandBar = canvasCommandBar.installCommandBar({
    document: document,
    window: window,
    vscode: vscode,
    fontFamily: SYSTEM_SANS,
    controls: canvasControls,
    menuIcons: MENU_ICN,
    barIcons: canvasIcons.bar,
    menu: window.DitaEditorCanvasMenu,
    getSelection: getCanvasSelection,
    getStructVersion: () => structVersion,
    structTarget: structTarget,
    caretOffset: caretOffset,
    columnAnchorId: columnAnchorId,
    availFor: availFor,
    applyAvail: applyAvail,
    insertAvailFor: insertAvailFor,
    transformAvailFor: transformAvailFor,
    postStructural: postStructural,
    withStructuralSuccess: withStructuralSuccess,
    postTransform: postTransform,
    announceNav: announceNav,
    onToolbarHeightChange: zoomCtl.setToolbarHeight,
    viewTools: { zoom: zoomCtl, spellcheck: spellCtl, help: helpCtl, findReplace: findReplace },
  });
  const refreshCmdBar = commandBar.refresh;
  // Re-apply the persisted zoom after command-bar measurement so its clearance
  // remains visually constant when zoom is not 100%.
  zoomCtl.apply();

  // ==================== Properties sidebar (Frame A left bar; FILE-LEVEL attribute editor) ====================
  const canvasProperties = window.DitaEditorCanvasProperties;
  if (!canvasProperties) throw new Error('DITA Editor properties script did not load before canvas.js');
  const propertiesPanel = canvasProperties.installPropertiesPanel({
    document: document,
    window: window,
    vscode: vscode,
    fontFamily: SYSTEM_SANS,
    getDocProps: () => docProps,
    nounForKind: nounForKind,
    taxonomy: taxonomy,
    getStructVersion: () => structVersion,
  });
  function refreshProperties() {
    propertiesPanel.refresh();
  }

  // ==================== Selection model (render-only) ====================
  // A document-level, element-granular selection. It NEVER posts to the host and never
  // serializes: it only paints `.is-selected` + a live count chip, and survives host rerenders
  // by re-resolving stable ids (data-struct-id / data-cell-id) against the fresh <main>.

  const canvasSelection = window.DitaEditorCanvasSelection;
  if (!canvasSelection) throw new Error('DITA Editor selection script did not load before canvas.js');
  const selectionModel = canvasSelection.createSelectionHelpers({ editableTarget: editableTarget });
  const canvasSelectionAria = window.DitaEditorCanvasSelectionAria;
  if (!canvasSelectionAria) throw new Error('DITA Editor selection ARIA script did not load before canvas.js');
  const selectionAria = canvasSelectionAria.installSelectionAria({ document: document });
  const computeDomGrid = selectionModel.computeDomGrid;
  const buildBlockRange = selectionModel.buildBlockRange;
  const buildCellRect = selectionModel.buildCellRect;
  const resolveMember = selectionModel.resolveMember;
  const unitDesc = selectionModel.unitDesc;

  const canvasImageBar = window.DitaEditorCanvasImageBar;
  if (!canvasImageBar) throw new Error('DITA Editor image bar script did not load before canvas.js');
  imageBar = canvasImageBar.installImageBar({
    document: document,
    window: window,
    vscode: vscode,
    makeBtn: canvasControls.makeBtn,
    getSelection: getCanvasSelection,
    resolveMember: resolveMember,
    getStructVersion: () => structVersion,
  });
  const hideImageBar = imageBar.hide;

  const canvasSelectionController = window.DitaEditorCanvasSelectionController;
  if (!canvasSelectionController) throw new Error('DITA Editor selection controller script did not load before canvas.js');
  selectionController = canvasSelectionController.installSelectionController({
    document: document,
    window: window,
    vscode: vscode,
    selectionModel: selectionModel,
    selectionAria: selectionAria,
    selectionDebug: null,
    announceNav: announceNav,
    showError: showError,
    elementPath: elementPath,
    postStructural: postStructural,
    withStructuralSuccess: withStructuralSuccess,
    refreshCommandBar: refreshCmdBar,
    configureRangeButton: configureRangeBtn,
    isContextToolbarShown: () => toolbar.style.display !== 'none',
    getImageBar: () => imageBar,
    selectedBlockPasteBlocksFromClipboard: editing.selectedBlockPasteBlocksFromClipboard,
    onSelectionChange: () => nativeContextMenu.refresh(),
  });

  // ==================== IX-1/IX-2 block move gestures (Alt+Arrow + drag grip → host moveBefore/moveAfter) ====================
  const canvasMoveBlock = window.DitaEditorCanvasMoveBlock;
  if (!canvasMoveBlock) throw new Error('DITA Editor move block script did not load before canvas.js');
  const moveBlock = canvasMoveBlock.installMoveBlock({
    document: document,
    window: window,
    editableTarget: editableTarget,
    structTarget: structTarget,
    caretOffset: caretOffset,
    postStructural: postStructural,
    getSelection: getCanvasSelection,
    resolveMember: resolveMember,
    announceNav: announceNav,
  });

  // ==================== IX-7/IX-8 keyboard selection (Cmd+A expansion + Shift+Arrow ranges) ====================
  const canvasKeyboardSelect = window.DitaEditorCanvasKeyboardSelect;
  if (!canvasKeyboardSelect) throw new Error('DITA Editor keyboard select script did not load before canvas.js');
  canvasKeyboardSelect.installKeyboardSelect({
    document: document,
    window: window,
    selectionModel: selectionModel,
    getSelection: getCanvasSelection,
    setSelection: setSelection,
    setSelectionAnchor: setSelectionAnchor,
    getNavMap: () => navMap,
    editableTarget: editableTarget,
    structTarget: structTarget,
    nounForKind: nounForKind,
    announceNav: announceNav,
  });

  // ==================== Styles sidebar (right bar; CSS-backed outputclass editor) ====================
  const canvasStyles = window.DitaEditorCanvasStyles;
  if (!canvasStyles) throw new Error('DITA Editor styles script did not load before canvas.js');
  function createSaveRequestSessionId() {
    const crypto = window.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // RFC 4122 version/variant bits make the fallback the same UUID shape as
      // randomUUID while retaining 122 bits of per-frame randomness.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.prototype.map.call(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
        + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    throw new Error('Secure randomness is unavailable for style save request IDs.');
  }
  const saveRequestSessionId = createSaveRequestSessionId();
  function idSelector(attrName, id) {
    const value = String(id);
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return '[' + attrName + '="' + window.CSS.escape(value) + '"]';
    }
    return '[' + attrName + '="' + value.replace(/"/g, '\\"') + '"]';
  }
  // Every class token on the element's ancestor chain up to <main>. Lets the Styles
  // panel show a preset as "applied" when it lives on an ANCESTOR (e.g. a table-level
  // preset while a cell is selected), not just on the selected element itself.
  function ancestorClassTokens(el) {
    const tokens = [];
    const seen = Object.create(null);
    for (let cur = el; cur && cur.classList; cur = cur.parentElement) {
      for (let i = 0; i < cur.classList.length; i++) {
        const t = cur.classList[i];
        if (!seen[t]) { seen[t] = 1; tokens.push(t); }
      }
      if (cur.tagName === 'MAIN' || (cur.getAttribute && cur.getAttribute('role') === 'main')) break;
    }
    return tokens;
  }
  function styleTargetForId(id) {
    if (id == null) return null;
    const el = document.querySelector(idSelector('data-struct-id', id) + ',' + idSelector('data-cell-id', id));
    if (!el) return null;
    const kind = el.getAttribute('data-struct-kind') || (el.hasAttribute('data-cell-id') ? 'entry' : '');
    return {
      ids: [String(id)],
      kind: kind,
      label: nounForKind(kind),
      outputclass: el.getAttribute('data-outputclass') || '',
      ancestorClasses: ancestorClassTokens(el),
    };
  }
  let lastStyleTarget = null;
  function rememberedStyleTarget() {
    // Rebuild the last selected element's target from the live DOM so its
    // @outputclass / Applied state stays current; drop it if the element is gone.
    if (!lastStyleTarget || !lastStyleTarget.ids || !lastStyleTarget.ids.length) return null;
    if (lastStyleTarget.ids.length === 1) return styleTargetForId(lastStyleTarget.ids[0]);
    const alive = lastStyleTarget.ids.filter((id) =>
      document.querySelector(idSelector('data-struct-id', id) + ',' + idSelector('data-cell-id', id)));
    if (alive.length !== lastStyleTarget.ids.length) return null;
    return { ids: alive.slice(), kind: lastStyleTarget.kind, label: lastStyleTarget.label, outputclass: '' };
  }
  function resolveCurrentStyleTarget() {
    const live = resolveCurrentStyleTargetLive();
    if (live) {
      lastStyleTarget = live;
      return live;
    }
    // Caret/selection left the canvas (clicked the Styles panel or outside VS Code).
    // Keep showing and targeting the last selected element instead of graying the
    // panel out — as long as that element still exists in the document.
    const remembered = rememberedStyleTarget();
    lastStyleTarget = remembered;
    return remembered;
  }
  function resolveCurrentStyleTargetLive() {
    const ids = currentSelectionIds();
    if (ids.length > 1) {
      return { ids: ids, kind: 'selection', label: ids.length + ' selected elements', outputclass: '' };
    }
    if (ids.length === 1) return styleTargetForId(ids[0]);

    const sel = window.getSelection();
    let node = sel && sel.anchorNode ? sel.anchorNode : null;
    if (node && node.nodeType === 3) node = node.parentElement;
    if ((!node || !node.closest || !node.closest('main')) && document.activeElement) {
      const ae = document.activeElement;
      if (ae.closest && ae.closest('main')) node = ae;
    }
    if (!node || !node.closest) return null;
    const struct = structTarget(node);
    const cell = node.closest('td[data-cell-id],th[data-cell-id]');
    if (struct && (!cell || cell.contains(struct))) {
      const id = struct.getAttribute('data-struct-id');
      const kind = struct.getAttribute('data-struct-kind');
      return id ? {
        ids: [id],
        kind: kind,
        label: nounForKind(kind),
        outputclass: struct.getAttribute('data-outputclass') || '',
        ancestorClasses: ancestorClassTokens(struct),
      } : null;
    }
    if (cell) {
      const id = cell.getAttribute('data-cell-id');
      return id ? {
        ids: [id],
        kind: 'entry',
        label: nounForKind('entry'),
        outputclass: cell.getAttribute('data-outputclass') || '',
        ancestorClasses: ancestorClassTokens(cell),
      } : null;
    }
    return null;
  }
  const stylesPanel = canvasStyles.installStylesPanel({
    document: document,
    window: window,
    vscode: vscode,
    fontFamily: SYSTEM_SANS,
    saveRequestSessionId: saveRequestSessionId,
    getStyleState: () => styleState,
    getCurrentTarget: resolveCurrentStyleTarget,
    getStructVersion: () => structVersion,
    announceNav: announceNav,
  });
  function refreshStyles(force) {
    stylesPanel.refresh(!!force);
  }

  // ==================== Table column resize (render-only handles; DITA colwidth persistence) ====================
  const canvasTableResize = window.DitaEditorCanvasTableResize;
  if (!canvasTableResize) throw new Error('DITA Editor table resize script did not load before canvas.js');
  const tableResize = canvasTableResize.installTableColumnResize({
    document: document,
    window: window,
    vscode: vscode,
    getStructVersion: () => structVersion,
    announceNav: announceNav,
  });

  // ==================== UI-3 table hover cross-highlight (render-only) ====================
  const canvasTableHover = window.DitaEditorCanvasTableHover;
  if (!canvasTableHover) throw new Error('DITA Editor table hover script did not load before canvas.js');
  canvasTableHover.installTableHover({
    document: document,
    computeDomGrid: computeDomGrid,
  });

  // Intersection "+" row/column inserters at the table's outer edges.
  const canvasTableInsertPlus = window.DitaEditorTableInsertPlus;
  if (!canvasTableInsertPlus) throw new Error('DITA Editor table insert-plus script did not load before canvas.js');
  const tableInsertPlus = canvasTableInsertPlus.installTableInsertPlus({
    document: document,
    window: window,
    computeDomGrid: computeDomGrid,
    availFor: availFor,
    postStructural: postStructural,
    withStructuralSuccess: withStructuralSuccess,
    announceNav: announceNav,
  });

  // Zoom changes relayout the zoomed <main>: refresh the body-level overlays
  // that cached its geometry (resize handles, image bar, "+" inserters).
  function refreshGeometryOverlays() {
    tableResize.refresh();
    tableInsertPlus.refresh();
    if (imageBar && imageBar.update) imageBar.update();
  }
  window.addEventListener('ditaeditor:zoomchange', refreshGeometryOverlays);

  // Content reflow moves the geometry those overlays anchor to without firing
  // any scroll/resize/zoom event — images finish loading after a rerender's
  // innerHTML swap, edits rewrap text, a column drag reflows rows. <main>'s
  // height tracks all of these; observe it (rAF-throttled).
  if (typeof ResizeObserver === 'function') {
    const mainEl = document.querySelector('main');
    if (mainEl) {
      let reflowRaf = 0;
      new ResizeObserver(() => {
        if (reflowRaf) return;
        reflowRaf = requestAnimationFrame(() => {
          reflowRaf = 0;
          refreshGeometryOverlays();
        });
      }).observe(mainEl);
    }
  }

  // --- in-place re-render from the host (structural / external edits) ---
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'nativeContextCommand') {
      nativeContextMenu.execute(msg.command, msg.context);
      return;
    }
    if (msg.type === 'error') {
      showError(msg.message);
      return;
    }
    if (msg.type === 'scrollToAnchor') {
      if (!scrollAnchor.restore(msg.id)) {
        vscode.postMessage({ type: 'scrollRestoreFailed', id: msg.id });
      }
      return;
    }
    if (msg.type === 'navmap') {
      if (msg.navMap) navMap = msg.navMap; // load-handshake reply (no body changes)
      if (msg.cmdMap) cmdMap = msg.cmdMap; // P0-2: command availability for the current doc
      if (msg.insertMap) insertMap = msg.insertMap; // #13: cross-kind insert availability (W6 host side)
      if (msg.transformMap) transformMap = msg.transformMap; // #22: block-transform availability (W6 host side)
      if (msg.docProps !== undefined) docProps = msg.docProps; // file-level Properties source
      if (msg.styleState) styleState = msg.styleState; // CSS-backed author styles
      if (msg.taxonomy !== undefined) {
        taxonomy = msg.taxonomy && msg.taxonomy.version === 1 && Array.isArray(msg.taxonomy.fields)
          ? msg.taxonomy
          : null;
        propertiesPanel.setTaxonomy(taxonomy);
      }
      if (typeof msg.structVersion === 'number') structVersion = msg.structVersion; // adopt the load-cycle token
      nativeContextMenu.refresh();
      endInsert.refresh(); // refresh the trailing paragraph hit area against the host insert map
      refreshCmdBar(); // the command bar gates off these maps — repaint it on the load handshake
      refreshProperties(); // repaint the file-level Properties panel
      refreshStyles(); // repaint the CSS-backed author Styles panel
      tableResize.refresh(); // place column resize handles for the initial body
      tableInsertPlus.refresh(); // drop any stale intersection "+" for the initial body
      return;
    }
    if (msg.type === 'styleSaveResult') {
      stylesPanel.acceptSaveResult(msg);
      return;
    }
    if (msg.type === 'styleState') {
      if (msg.styleState) styleState = msg.styleState;
      nativeContextMenu.refresh();
      // NOT forced: this fires after every autosave round-trip while the user may still be
      // typing in the style editor. buildPanel() already repaints the live CSS preview
      // unconditionally; forcing the DOM rebuild here destroyed the focused input every time,
      // requiring a reclick per keystroke.
      refreshStyles();
      return;
    }
    if (msg.type === 'taxonomyState') {
      taxonomy = msg.taxonomy && msg.taxonomy.version === 1 && Array.isArray(msg.taxonomy.fields)
        ? msg.taxonomy
        : null;
      propertiesPanel.setTaxonomy(taxonomy);
      return;
    }
    if (msg.type === 'announce') {
      announceNav(msg.message || ''); // P1-4: host-driven a11y announcement (e.g. image picker result)
      return;
    }
    if (msg.type === 'rangeAvailability') {
      applyRangeAvailability(msg);
      nativeContextMenu.refresh();
      return;
    }
    if (msg.type === 'lint') {
      lintMarks.apply(msg.items); // UX-7: paint the host-pushed dita-quality findings in place
      return;
    }
    if (msg.type !== 'rerender') return;
    clearTimer(); // the new body IS the authoritative state
    if (msg.navMap) navMap = msg.navMap; // adopt the navMap for the freshly-rendered body
    if (msg.cmdMap) cmdMap = msg.cmdMap; // P0-2: refresh command availability for the new body
    if (msg.insertMap) insertMap = msg.insertMap; // #13: refresh insert availability for the new body
    if (msg.transformMap) transformMap = msg.transformMap; // #22: refresh block-transform availability
    if (msg.docProps !== undefined) docProps = msg.docProps; // file-level Properties source for the new body
    if (msg.styleState) styleState = msg.styleState; // CSS-backed author styles
    if (typeof msg.structVersion === 'number') structVersion = msg.structVersion; // adopt the new render cycle's token
    const main = document.querySelector('main');
    if (!main) return;
    rerendering = true; // suppress the blur(commit) fired by detaching the old focused node
    main.innerHTML = msg.body;
    endInsert.refresh(); // re-append the end-of-document paragraph affordance after the body swap
    contextToolbar.resetForRerender();
    insertMenuController.close(false); // #13: the menu was anchored to the now-replaced toolbar/element
    slashMenu.close(false); // IX-5: the popup was anchored to a now-replaced leaf
    moveBlock.hideGrip(); // IX-1: the grip's block was replaced by the body swap
    lintMarks.clear(); // UX-7: old marks point at detached elements; the host re-pushes lint after every rerender
    findReplace.refreshAfterRerender(); // IX-4: recompute matches against the fresh leaves
    hideImageBar(); // image bar (a body sibling) outlives the swap; restore re-shows it if still valid
    hideError(); // a successful rerender means we recovered
    resetSelectionForRerender(); // #NAV: the non-editable nav-focus node was in the replaced <main> (now detached)
    scanBrokenImages(main); // re-tag any already-failed images in the new body
    tableResize.refresh(); // old handles pointed at detached table geometry
    tableInsertPlus.refresh(); // the "+" anchored to a now-detached table boundary
    spellCtl.apply(main); // re-assert the author's spellcheck preference on the fresh editables
    restoreSelectionAfterRerender(main); // re-resolve/repaint or drop the element selection
    scrollAnchor.didRerender(); // ids may have shifted; report the current logical viewport again
    nativeContextMenu.refresh();
    if (msg.focusId != null) {
      const el = main.querySelector('[data-autofocus]');
      if (el) {
        if (typeof msg.caretOffset === 'number') {
          setCaret(el, msg.caretOffset);
        } else if (selectionModel.unitElType(el) === 'block' || selectionModel.unitElType(el) === 'image') {
          if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
          el.focus();
          setSelection(selectionModel.singleSel(el));
          setSelectionAnchor(el);
        } else {
          setCaret(el, sourceTextLength(el));
        }
      }
    }
    refreshCmdBar(); // new body + fresh maps: rebind the command bar to the restored caret/element
    refreshProperties(); // repaint the file-level Properties panel from the fresh docProps
    refreshStyles(true); // FORCE: a rerender is an authoritative document change (e.g. a preset apply/clear),
                         // so the applied-indicator must recompute from the fresh DOM even if focus sits in the
                         // panel. The unforced guard exists only to protect a focused CSS input on the styleState
                         // (typing) path — document rerenders never fire while that input is being typed into.
    rerendering = false; // swap done + caret restored: genuine user blurs commit again
  });

  // Initial pass for images that failed before the capture listener was attached.
  scanBrokenImages(document);
  scrollAnchor.start();

  // The initial canvas comes from webview.html (no rerender message), so ping the host once now
  // that the message listener is registered; it replies with a {type:'navmap'} message carrying the
  // navMap for this body. One-time load handshake — NOT a per-keystroke message.
  vscode.postMessage({ type: 'navready' });
})();
