// Keyboard structural editing for the visual canvas editing adapter.
(function () {
  function installKeyHandling(opts) {
    const doc = opts.document || document;
    const win = opts.window || window;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const commit = opts.commit;
    const postStructural = opts.postStructural;
    const postTransform = opts.postTransform;
    const postLineBreak = opts.postLineBreak;
    const withStructuralSuccess = opts.withStructuralSuccess;
    const caretOffset = opts.caretOffset;
    const textMetrics = window.DitaEditorCanvasTextMetrics;
    const sourceTextLength =
      opts.sourceTextLength ||
      (textMetrics && textMetrics.sourceLength) ||
      function (el) { return el.textContent.length; };
    const selectContents = opts.selectContents;
    const insertTextAtSelection = opts.insertTextAtSelection;
    const splitPayload = opts.splitPayload;
    const inlineHtmlForJoin = opts.inlineHtmlForJoin;
    const getSelectionState = opts.getSelectionState;
    const DEL_OP = opts.DEL_OP;
    const BACKSPACE_JOIN_KINDS = ['p', 'li', 'title', 'shortdesc', 'note', 'cmd', 'lines', 'codeblock'];

    function cellEditTarget(cell) {
      if (cell.hasAttribute('data-edit-id') && cell.hasAttribute('contenteditable')) return cell;
      return cell.querySelector('[data-edit-id][contenteditable]');
    }

    function adjacentCellTarget(cell, dir) {
      const table = cell.closest('table');
      if (!table) return null;
      const cells = Array.prototype.slice.call(table.querySelectorAll('td, th'));
      for (let i = cells.indexOf(cell) + dir; i >= 0 && i < cells.length; i += dir) {
        const target = cellEditTarget(cells[i]);
        if (target) return target;
      }
      return null;
    }

    function joinPayload(prev, next) {
      const prevText = prev.textContent || '';
      const nextText = next.textContent || '';
      const payload = {
        prevId: prev.getAttribute('data-struct-id'),
        boundary: sourceTextLength(prev),
      };
      if (prev.getAttribute('data-inline-html') === 'true' || next.getAttribute('data-inline-html') === 'true') {
        payload.mergedHtml = inlineHtmlForJoin(prev) + inlineHtmlForJoin(next);
      } else {
        payload.merged = prevText + nextText;
      }
      return payload;
    }

    doc.addEventListener('keydown', (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      const directStruct = el.closest('[data-struct-id]');
      const directKind = directStruct && directStruct.getAttribute('data-struct-kind');
      const struct = structTarget(el);
      const kind = struct && struct.getAttribute('data-struct-kind');
      const structId = struct && struct.getAttribute('data-struct-id');
      const isRun = el.hasAttribute('data-edit-run');
      const selection = getSelectionState();

      if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return;

      if (e.key === 'Tab') {
        // List items keep list semantics even inside table cells — this runs
        // BEFORE cell navigation so Tab indents instead of changing cells.
        // closest() also catches the corpus <entry><ul><li><lines> shape,
        // where structTarget resolves to the lines leaf rather than the li.
        const li = el.closest('li[data-struct-id][data-struct-kind="li"]');
        if (li) {
          e.preventDefault();
          commit(el);
          const op = e.shiftKey ? 'outdentItem' : 'indentItem';
          postStructural(op, li.getAttribute('data-struct-id'),
            withStructuralSuccess(op, 'li', { caret: caretOffset(el) }));
          return;
        }
        const cell = el.closest('td, th');
        if (cell) {
          const target = adjacentCellTarget(cell, e.shiftKey ? -1 : 1);
          if (target) {
            e.preventDefault();
            commit(el);
            target.focus();
            selectContents(target);
            return;
          }
          // Let canvas-keyboard-nav handle true table edges so Tab can leave the
          // table through document-order navigation instead of mutating rows.
          return;
        }
        return;
      }

      if (e.key === 'Enter') {
        if (directKind === 'lines' || directKind === 'codeblock') {
          // A lines/codeblock leaf that IS a list item's content (corpus shape:
          // <entry><ul><li><lines>): plain Enter at the end of the text
          // continues the LIST with a new item; mid-text (and Shift+Enter)
          // keeps the block's literal line-break semantics.
          const liParent = directStruct.parentElement && directStruct.parentElement.closest
            ? directStruct.parentElement.closest('li[data-struct-id][data-struct-kind="li"]')
            : null;
          if (liParent && !e.shiftKey) {
            const txt = el.textContent || '';
            const tail = txt.endsWith('\n') ? 1 : 0;
            if (caretOffset(el) >= sourceTextLength(el) - tail) {
              e.preventDefault();
              commit(el);
              postStructural('addItemAfter', liParent.getAttribute('data-struct-id'),
                withStructuralSuccess('addItemAfter', 'li'));
              return;
            }
          }
          e.preventDefault();
          const insertion = insertTextAtSelection(el, '\n');
          if (insertion) postLineBreak(el, insertion.caretOffset);
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          const insertion = insertTextAtSelection(el, '\n');
          if (insertion) {
            postLineBreak(el, insertion.caretOffset);
          }
          return;
        }
        e.preventDefault();
        // List items keep list semantics even inside table cells — these run
        // BEFORE the whole-cell line-break fallback, or Enter in a cell list
        // would insert a newline instead of a new item.
        if (isRun && kind === 'li') {
          commit(el);
          postStructural('addItemAfter', structId, withStructuralSuccess('addItemAfter', kind));
          return;
        }
        if (!isRun && kind === 'li' && (el.textContent || '') === '' && caretOffset(el) === 0) {
          commit(el);
          postTransform('itemToParagraph', structId);
          return;
        }
        if (kind === 'li') {
          postStructural('split', structId, withStructuralSuccess('split', kind, splitPayload(el)));
          return;
        }
        const cell = el.closest('td, th');
        if (cell) {
          const insertion = insertTextAtSelection(el, '\n');
          if (insertion) {
            postLineBreak(el, insertion.caretOffset);
          }
          return;
        }
        if (kind === 'row') {
          commit(el);
          postStructural('addRowAfter', structId, withStructuralSuccess('addRowAfter', kind));
          return;
        }
        if (kind === 'p') {
          postStructural('split', structId, withStructuralSuccess('split', kind, splitPayload(el)));
          return;
        }
        commit(el);
        return;
      }

      if (e.key === 'Backspace' && !selection && !isRun && BACKSPACE_JOIN_KINDS.indexOf(kind) >= 0) {
        const sel = win.getSelection();
        if (!sel || !sel.isCollapsed || caretOffset(el) !== 0) return;
        let prev = struct.previousElementSibling;
        if (!prev && kind === 'li') {
          const list = struct.parentElement;
          if (list && (list.tagName === 'UL' || list.tagName === 'OL') && list.children.length === 1) {
            prev = list.previousElementSibling;
          }
        }
        if (prev && prev.hasAttribute('data-edit-id')) {
          e.preventDefault();
          // Flush the current DOM bytes first. The host queues this edit ahead
          // of the structural join, so its authoritative CST merge cannot lose
          // a change that is still inside the input debounce window.
          commit(el);
          postStructural('join', structId, withStructuralSuccess('join', kind, joinPayload(prev, el)));
          return;
        }
        if (el.textContent === '' && DEL_OP[kind]) {
          e.preventDefault();
          postStructural(DEL_OP[kind], structId, withStructuralSuccess(DEL_OP[kind], kind));
        }
      }

      if (e.key === 'Delete' && !selection && !isRun && (kind === 'li' || kind === 'p')) {
        const sel = win.getSelection();
        if (!sel || !sel.isCollapsed || caretOffset(el) !== sourceTextLength(el)) return;
        const next = struct.nextElementSibling;
        if (next && next.getAttribute('data-struct-kind') === kind && next.hasAttribute('data-edit-id')) {
          e.preventDefault();
          postStructural('join', next.getAttribute('data-struct-id'), withStructuralSuccess('join', kind, joinPayload(el, next)));
        }
      }
    });

    return {
      cellEditTarget: cellEditTarget,
      adjacentCellTarget: adjacentCellTarget,
      joinPayload: joinPayload,
    };
  }

  window.DitaEditorCanvasEditingKeys = {
    installKeyHandling: installKeyHandling,
  };
})();
