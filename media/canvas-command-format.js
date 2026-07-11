// Formatting target helpers for the persistent DITA Editor command bar.
//
// Loaded before canvas-command-bar.js. This module reads DOM selection state and
// never calls acquireVsCodeApi or posts host messages.
(function () {
  function createCommandFormatHelpers(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const getCanvasSelection = opts.getCanvasSelection || function () { return null; };
    const fmtSelector = opts.fmtSelector || {};
    const textMetrics = window.DitaEditorCanvasTextMetrics;
    if (!textMetrics) throw new Error('DitaEditorCanvasTextMetrics must load before canvas-command-format.js');

    function attrSelector(id) {
      if (windowObj.CSS && typeof windowObj.CSS.escape === 'function') return '[data-struct-id="' + windowObj.CSS.escape(id) + '"]';
      return '[data-struct-id="' + String(id).replace(/"/g, '\\"') + '"]';
    }

    function hasMark(node, op) {
      let el = node && node.nodeType === 3 ? textMetrics.parentElementOf(node) : node;
      const selector = fmtSelector[op];
      while (el && el !== document.body) {
        if (el.matches && el.matches(selector)) return true;
        el = el.parentElement;
      }
      return false;
    }

    function selectedRunFullyMarked(root, start, end, op) {
      let pos = 0;
      let any = false;
      for (const node of textMetrics.textNodesIn(root)) {
        const text = node.nodeValue || '';
        const nodeStart = pos;
        const nodeEnd = pos + text.length;
        const a = Math.max(start, nodeStart);
        const b = Math.min(end, nodeEnd);
        if (a < b && text.slice(a - nodeStart, b - nodeStart).trim() !== '') {
          any = true;
          if (!hasMark(node, op)) return false;
        }
        pos = nodeEnd;
      }
      return any;
    }

    function elementFullyMarked(el, op) {
      const text = el ? textMetrics.sourceText(el) : '';
      return text.trim() !== '' && selectedRunFullyMarked(el, 0, text.length, op);
    }

    function isWordChar(ch) {
      return !!ch && /[\p{L}\p{N}_]/u.test(ch);
    }

    function expandWordRange(text, offset) {
      const pos = Math.max(0, Math.min(offset, text.length));
      let seed = pos;
      if (!isWordChar(text.charAt(seed)) && isWordChar(text.charAt(seed - 1))) seed = pos - 1;
      if (!isWordChar(text.charAt(seed))) return { start: pos, end: pos };
      let start = seed;
      while (start > 0 && isWordChar(text.charAt(start - 1))) start--;
      let end = seed + 1;
      while (end < text.length && isWordChar(text.charAt(end))) end++;
      return { start: start, end: end };
    }

    function currentFormatTarget() {
      const sel = windowObj.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      let a = sel.anchorNode;
      if (a && a.nodeType === 3) a = a.parentElement;
      let f = sel.focusNode;
      if (f && f.nodeType === 3) f = f.parentElement;
      const runA = a && a.closest ? a.closest('[data-edit-id]') : null;
      const runF = f && f.closest ? f.closest('[data-edit-id]') : null;
      if (!runA || runA !== runF) return null;
      const range = sel.getRangeAt(0);
      const o1 = textMetrics.offsetWithin(runA, range.startContainer, range.startOffset);
      const o2 = textMetrics.offsetWithin(runA, range.endContainer, range.endOffset);
      const full = textMetrics.sourceText(runA);
      let start = Math.min(o1, o2);
      let end = Math.max(o1, o2);
      let restoreOffset = end;
      if (start === end) {
        restoreOffset = start;
        const word = expandWordRange(full, start);
        start = word.start;
        end = word.end;
      }
      if (start === end) return null;
      return {
        editId: runA.getAttribute('data-edit-id'),
        before: full.slice(0, start),
        mid: full.slice(start, end),
        after: full.slice(end),
        caretOffset: restoreOffset,
      };
    }

    function formattableSelectionIds() {
      const selection = getCanvasSelection();
      if (!selection) return [];
      if (selection.mode === 'single') {
        return selection.unit === 'block' && selection.id != null ? [selection.id] : [];
      }
      if (selection.mode === 'blockRange' && selection.members) {
        return selection.members.map((m) => m.id).filter((x) => x != null);
      }
      if (selection.mode === 'multiSet' && selection.units) {
        return selection.units.filter((u) => u.unit === 'block').map((u) => u.id).filter((x) => x != null);
      }
      return [];
    }

    function currentFormatState(op) {
      const t = currentFormatTarget();
      if (t && t.mid !== '') {
        const sel = windowObj.getSelection();
        let node = sel && sel.anchorNode ? sel.anchorNode : null;
        if (node && node.nodeType === 3) node = node.parentElement;
        const run = node && node.closest ? node.closest('[data-edit-id]') : null;
        if (!run) return false;
        return selectedRunFullyMarked(run, t.before.length, t.before.length + t.mid.length, op);
      }
      const ids = formattableSelectionIds();
      if (!ids.length) return false;
      for (const id of ids) {
        const el = document.querySelector(attrSelector(id));
        if (!elementFullyMarked(el, op)) return false;
      }
      return true;
    }

    function currentInlineInsertTarget() {
      const sel = windowObj.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      let n = sel.anchorNode;
      if (n && n.nodeType === 3) n = n.parentElement;
      const run = n && n.closest ? n.closest('[data-edit-id]') : null;
      if (!run) return null;
      const range = sel.getRangeAt(0);
      if (!run.contains(range.startContainer)) return null;
      const at = textMetrics.offsetWithin(run, range.startContainer, range.startOffset);
      const full = textMetrics.sourceText(run);
      return { editId: run.getAttribute('data-edit-id'), before: full.slice(0, at), after: full.slice(at) };
    }

    return {
      currentFormatTarget: currentFormatTarget,
      currentFormatState: currentFormatState,
      formattableSelectionIds: formattableSelectionIds,
      currentInlineInsertTarget: currentInlineInsertTarget,
    };
  }

  window.DitaEditorCanvasCommandFormat = {
    createCommandFormatHelpers: createCommandFormatHelpers,
  };
})();
