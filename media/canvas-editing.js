// Core text-editing and structural-key adapter for the visual canvas.
(function () {
  function installCanvasEditing(opts) {
    const doc = opts.document || document;
    const win = opts.window || window;
    const vscode = opts.vscode;
    const editingUtils = window.DitaEditorCanvasEditingUtils;
    if (!editingUtils) throw new Error('DitaEditorCanvasEditingUtils must load before canvas-editing.js');
    const textMetrics = window.DitaEditorCanvasTextMetrics;
    if (!textMetrics) throw new Error('DitaEditorCanvasTextMetrics must load before canvas-editing.js');
    const editingPaste = window.DitaEditorCanvasEditingPaste;
    if (!editingPaste) throw new Error('DitaEditorCanvasEditingPaste must load before canvas-editing.js');
    const editingKeys = window.DitaEditorCanvasEditingKeys;
    if (!editingKeys) throw new Error('DitaEditorCanvasEditingKeys must load before canvas-editing.js');
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 250;
    const getStructVersion = opts.getStructVersion || (() => 0);
    const getRerendering = opts.getRerendering || (() => false);
    let timer = null;
    let runJustFocused = null;
    let composingEl = null;

    const ADD_OP = { row: 'addRowAfter', li: 'addItemAfter', p: 'addParaAfter' };
    const DEL_OP = {
      row: 'deleteRow',
      li: 'deleteItem',
      p: 'deletePara',
      codeblock: 'deleteElement',
      lines: 'deleteElement',
      note: 'deleteElement',
      section: 'deleteElement',
      shortdesc: 'deleteElement',
      table: 'deleteTable',
      fig: 'deleteFig',
      image: 'deleteImage',
      title: 'deleteTitle',
    };
    const structuralSuccessMessage = editingUtils.structuralSuccessMessage;
    const withStructuralSuccess = editingUtils.withStructuralSuccess;
    const looksLikeRichHtml = editingUtils.looksLikeRichHtml;
    const htmlPasteBlocks = editingUtils.htmlPasteBlocks;
    const textPasteBlocks = editingUtils.textPasteBlocks;
    const inlineHtmlForJoin = editingUtils.inlineHtmlForJoin;
    const selectionPayloads = editingUtils.createSelectionPayloads({
      document: doc,
      window: win,
      caretOffset: caretOffset,
    });
    const insertTextAtSelection = selectionPayloads.insertTextAtSelection;
    const inlineHtmlSelectionParts = selectionPayloads.inlineHtmlSelectionParts;
    const selectionTextBounds = selectionPayloads.selectionTextBounds;
    const splitPayload = selectionPayloads.splitPayload;

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function editableTarget(node) {
      const el = node && node.closest ? node.closest('[data-edit-id]') : null;
      return el && el.hasAttribute('contenteditable') ? el : null;
    }

    const STRUCT_SKIP_KINDS = new Set(['image', 'table', 'fig', 'ul', 'ol']);
    function structTarget(node) {
      if (!node || !node.closest) return null;
      let el = node.closest('[data-struct-id]');
      while (el && STRUCT_SKIP_KINDS.has(el.getAttribute('data-struct-kind'))) {
        const parent = el.parentElement;
        el = parent && parent.closest ? parent.closest('[data-struct-id]') : null;
      }
      return el;
    }

    function commit(el) {
      clearTimer();
      const msg = { type: 'edit', id: el.getAttribute('data-edit-id'), text: el.textContent };
      if (el.getAttribute('data-inline-html') === 'true') msg.html = el.innerHTML;
      vscode.postMessage(msg);
    }

    function scheduleCommit(el) {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        commit(el);
      }, debounceMs);
    }

    function postStructural(op, id, extra) {
      clearTimer();
      vscode.postMessage(Object.assign({ type: 'structural', op: op, id: id, baseStructVersion: getStructVersion() }, extra || {}));
    }

    function postTransform(transform, id) {
      clearTimer();
      vscode.postMessage({ type: 'transform', transform: transform, id: id });
    }

    function postLineBreak(el, lineBreakCaretOffset) {
      clearTimer();
      vscode.postMessage({
        type: 'lineBreak',
        id: el.getAttribute('data-edit-id'),
        text: el.textContent,
        caretOffset: typeof lineBreakCaretOffset === 'number' ? lineBreakCaretOffset : caretOffset(el),
      });
    }

    function caretOffset(el) {
      const sel = win.getSelection();
      if (!sel || sel.rangeCount === 0) return 0;
      const range = sel.getRangeAt(0);
      if (!('endContainer' in range) && typeof range.cloneRange === 'function') {
        const clone = range.cloneRange();
        return typeof clone.endOffset === 'number' ? clone.endOffset : 0;
      }
      return textMetrics.offsetWithin(el, range.endContainer, range.endOffset);
    }

    function setCaret(el, offset) {
      el.focus();
      const sel = win.getSelection();
      if (!sel) return;
      const range = doc.createRange();
      const targetOffset = Math.max(0, offset);
      let remaining = targetOffset;
      let fallback = null;
      function walk(node) {
        if (!node) return null;
        if (node.nodeType === 3) {
          if (textMetrics.zeroLengthAtomAncestor(node)) return null;
          const len = node.length || (node.nodeValue ? node.nodeValue.length : 0);
          if (remaining <= len) return { node: node, offset: remaining };
          remaining -= len;
          fallback = { node: node, offset: len };
          return null;
        }
        if (textMetrics.isZeroLengthAtom(node)) return null;
        const kids = node.childNodes || [];
        for (const child of kids) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      }
      const pos = walk(el) || fallback;
      if (pos) {
        range.setStart(pos.node, pos.offset);
      } else {
        range.selectNodeContents(el);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function sourceTextLength(el) {
      return textMetrics.sourceLength(el);
    }

    function runTarget(node) {
      return node && node.closest ? node.closest('[data-edit-run]') : null;
    }

    function selectContents(el) {
      const sel = win.getSelection();
      if (!sel) return;
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const pasteHandling = editingPaste.installPasteHandling({
      document: doc,
      window: win,
      editableTarget: editableTarget,
      structTarget: structTarget,
      postStructural: postStructural,
      withStructuralSuccess: withStructuralSuccess,
      looksLikeRichHtml: looksLikeRichHtml,
      htmlPasteBlocks: htmlPasteBlocks,
      textPasteBlocks: textPasteBlocks,
      escapeHtmlSnippet: editingUtils.escapeHtmlSnippet,
      inlineHtmlSelectionParts: inlineHtmlSelectionParts,
      selectionTextBounds: selectionTextBounds,
    });

    doc.addEventListener('compositionstart', (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      clearTimer();
      composingEl = el;
    });

    doc.addEventListener('compositionend', (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      composingEl = null;
      scheduleCommit(el);
    });

    doc.addEventListener('beforeinput', (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      if (e.isComposing || e.inputType === 'insertCompositionText') {
        clearTimer();
        composingEl = el;
      }
    });

    doc.addEventListener('input', (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      if (e.isComposing || composingEl === el) return;
      scheduleCommit(el);
    });

    doc.addEventListener(
      'blur',
      (e) => {
        if (getRerendering()) return;
        const el = editableTarget(e.target);
        if (el) commit(el);
      },
      true,
    );

    doc.addEventListener('focusin', (e) => {
      const run = runTarget(e.target);
      runJustFocused = run;
      if (run) selectContents(run);
    });

    doc.addEventListener('mouseup', (e) => {
      const run = runTarget(e.target);
      if (!run || run !== runJustFocused) return;
      runJustFocused = null;
      const sel = win.getSelection();
      if (sel && sel.isCollapsed) selectContents(run);
    });

    const keyHandling = editingKeys.installKeyHandling({
      document: doc,
      window: win,
      editableTarget: editableTarget,
      structTarget: structTarget,
      commit: commit,
      postStructural: postStructural,
      postTransform: postTransform,
      postLineBreak: postLineBreak,
      withStructuralSuccess: withStructuralSuccess,
      caretOffset: caretOffset,
      sourceTextLength: sourceTextLength,
      selectContents: selectContents,
      insertTextAtSelection: insertTextAtSelection,
      splitPayload: splitPayload,
      inlineHtmlForJoin: inlineHtmlForJoin,
      getSelectionState: opts.getSelection || (() => null),
      DEL_OP: DEL_OP,
    });

    return {
      ADD_OP: ADD_OP,
      DEL_OP: DEL_OP,
      clearTimer: clearTimer,
      editableTarget: editableTarget,
      structTarget: structTarget,
      postStructural: postStructural,
      postTransform: postTransform,
      structuralSuccessMessage: structuralSuccessMessage,
      withStructuralSuccess: withStructuralSuccess,
      caretOffset: caretOffset,
      setCaret: setCaret,
      sourceTextLength: sourceTextLength,
      selectContents: selectContents,
      cellEditTarget: keyHandling.cellEditTarget,
      selectedBlockPasteBlocksFromClipboard: pasteHandling.selectedBlockPasteBlocksFromClipboard,
    };
  }

  window.DitaEditorCanvasEditing = {
    installCanvasEditing: installCanvasEditing,
  };
})();
