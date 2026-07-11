// Arrow/Home/End/Tab keyboard navigation for the DITA Editor canvas.
//
// Loaded before canvas.js. The module owns render-only keyboard movement over
// the host-computed navMap. It posts nothing to the host and changes no
// document bytes.
(function () {
  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
  const CELL_SELECTOR = 'td[data-cell-id], th[data-cell-id]';

  function installKeyboardNavigation(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const getNavMap = opts.getNavMap;
    const editableTarget = opts.editableTarget;
    const cellEditTarget = opts.cellEditTarget;
    const selectContents = opts.selectContents;
    const caretOffset = opts.caretOffset;
    const setCaret = opts.setCaret;
    const textMetrics = window.DitaEditorCanvasTextMetrics;
    const sourceTextLength =
      opts.sourceTextLength ||
      (textMetrics && textMetrics.sourceLength) ||
      function (el) { return el.textContent.length; };
    const focusNonEditableTarget = opts.focusNonEditableTarget;
    const announceNav = opts.announceNav;

    function cssEscape(value) {
      const text = String(value);
      const escaper =
        (windowObj.CSS && typeof windowObj.CSS.escape === 'function' && windowObj.CSS) ||
        (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function' && CSS);
      if (escaper) return escaper.escape(text);
      return text.replace(/["\\]/g, '\\$&');
    }

    function caretClientRect() {
      const sel = windowObj.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const rects = sel.getRangeAt(0).cloneRange().getClientRects();
      return rects && rects.length ? rects[rects.length - 1] : null;
    }

    function contentBox(el) {
      const b = el.getBoundingClientRect();
      const cs = windowObj.getComputedStyle(el);
      return {
        top: b.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0),
        bottom: b.bottom - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0),
      };
    }

    function navBoundaryOk(leaf, key, inCell) {
      const sel = windowObj.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const renderedLen = leaf.textContent.length;
      const sourceLen = sourceTextLength(leaf);
      if (!sel.isCollapsed) {
        if (sel.toString().length !== renderedLen) return false;
        if (inCell) return true;
        const rects = sel.getRangeAt(0).getClientRects();
        if (!rects || rects.length !== 1) return false;
        return key === 'ArrowUp' || key === 'ArrowDown';
      }
      if (key === 'ArrowLeft' || key === 'Home') return caretOffset(leaf) === 0;
      if (key === 'ArrowRight' || key === 'End') return caretOffset(leaf) === sourceLen;
      const r = caretClientRect();
      if (!r) {
        const off = caretOffset(leaf);
        return key === 'ArrowUp' ? off === 0 : off === sourceLen;
      }
      const box = contentBox(leaf);
      const tol = (r.height || 0) * 0.5 + 1;
      return key === 'ArrowUp' ? r.top - box.top <= tol : box.bottom - r.bottom <= tol;
    }

    function editableLeavesInCell(cellEl) {
      const leaves = [];
      if (cellEl.hasAttribute('data-edit-id') && cellEl.hasAttribute('contenteditable')) leaves.push(cellEl);
      return leaves.concat(Array.prototype.slice.call(cellEl.querySelectorAll('[data-edit-id][contenteditable]')));
    }

    function cellLeafBoundaryOk(cellEl, leaf, key) {
      if (leaf === cellEl) return true;
      const leaves = editableLeavesInCell(cellEl);
      const index = leaves.indexOf(leaf);
      if (index < 0) return false;
      if (leaves.length <= 1) return true;
      if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home') return index === 0;
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'End') return index === leaves.length - 1;
      return true;
    }

    function resolveTarget(main, id) {
      return main.querySelector(
        '[data-cell-id="' + cssEscape(id) + '"],' +
          '[data-edit-id="' + cssEscape(id) + '"],' +
          '[data-struct-id="' + cssEscape(id) + '"]',
      );
    }

    function focusResolvedTarget(target) {
      if (target.matches && target.matches('[data-cell-id]')) {
        const cellTarget = cellEditTarget(target);
        if (!cellTarget) {
          announceNav('The target table cell is not editable');
          return false;
        }
        cellTarget.focus();
        selectContents(cellTarget);
        return true;
      }
      if (target.hasAttribute && target.hasAttribute('contenteditable')) {
        target.focus();
        selectContents(target);
        return true;
      }
      focusNonEditableTarget(target);
      return true;
    }

    function moveByTab(cellEl, backwards, e) {
      const table = cellEl && cellEl.closest ? cellEl.closest('table') : null;
      if (!table) return false;
      const cells = Array.prototype.slice.call(table.querySelectorAll(CELL_SELECTOR));
      const index = cells.indexOf(cellEl);
      if (index < 0) return false;

      const next = cells[index + (backwards ? -1 : 1)];
      if (!next) {
        const cellId = cellEl.getAttribute('data-cell-id');
        const nav = cellId && getNavMap() && getNavMap()[cellId] && getNavMap()[cellId][backwards ? 'ArrowUp' : 'ArrowDown'];
        if (nav && nav.ok) {
          const main = document.querySelector('main');
          const target = main && resolveTarget(main, nav.targetId);
          if (target) {
            e.preventDefault();
            focusResolvedTarget(target);
            return true;
          }
        }
        e.preventDefault();
        announceNav((nav && nav.message) || (backwards ? 'Already at the first cell in the table' : 'Already at the last cell in the table'));
        return true;
      }

      const cellTarget = cellEditTarget(next);
      if (!cellTarget) {
        e.preventDefault();
        announceNav('The next table cell is not editable');
        return true;
      }

      e.preventDefault();
      cellTarget.focus();
      selectContents(cellTarget);
      return true;
    }

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.prevented) return;
      if (!NAV_KEYS.has(e.key) && e.key !== 'Tab') return;
      if (e.metaKey || e.ctrlKey || e.altKey || (e.shiftKey && e.key !== 'Tab')) return;

      const cellEl = e.target.closest ? e.target.closest('[data-cell-id]') : null;
      if (e.key === 'Tab') {
        if (cellEl) moveByTab(cellEl, !!e.shiftKey, e);
        return;
      }
      const leaf = editableTarget(e.target);
      const structEl = !cellEl && !leaf && e.target.closest ? e.target.closest('[data-struct-id]') : null;
      const focusId =
        (cellEl && cellEl.getAttribute('data-cell-id')) ||
        (leaf && leaf.getAttribute('data-edit-id')) ||
        (structEl && structEl.getAttribute('data-struct-id'));
      if (!focusId) return;

      const navMap = getNavMap() || {};
      const res = navMap[focusId] && navMap[focusId][e.key];
      if (!res) return;

      if (cellEl && leaf && (e.key === 'Home' || e.key === 'End')) {
        const s = windowObj.getSelection();
        const len = sourceTextLength(leaf);
        const atEdge =
          !!s && s.isCollapsed && (e.key === 'Home' ? caretOffset(leaf) === 0 : caretOffset(leaf) === len);
        if (!atEdge) {
          e.preventDefault();
          const r = document.createRange();
          r.selectNodeContents(leaf);
          r.collapse(e.key === 'Home');
          if (s) {
            s.removeAllRanges();
            s.addRange(r);
          }
          return;
        }
      }

      if (leaf) {
        if (cellEl && !cellLeafBoundaryOk(cellEl, leaf, e.key)) return;
        if (!navBoundaryOk(leaf, e.key, !!cellEl)) return;
      } else if (!structEl) {
        return;
      }

      const main = document.querySelector('main');
      if (!main) return;
      if (res.ok) {
        const t = main.querySelector(
          '[data-cell-id="' + cssEscape(res.targetId) + '"],' +
            '[data-edit-id="' + cssEscape(res.targetId) + '"],' +
            '[data-struct-id="' + cssEscape(res.targetId) + '"]',
        );
        if (!t) return;
        if (t.matches && t.matches('[data-cell-id]')) {
          const cellTarget = cellEditTarget(t);
          if (!cellTarget) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          cellTarget.focus();
          selectContents(cellTarget);
        } else if (t.hasAttribute('data-edit-id') && t.hasAttribute('contenteditable')) {
          e.preventDefault();
          setCaret(t, 0);
        } else {
          e.preventDefault();
          focusNonEditableTarget(t);
        }
      } else {
        e.preventDefault();
        announceNav(res.message);
      }
    });
  }

  window.DitaEditorCanvasKeyboardNav = {
    installKeyboardNavigation: installKeyboardNavigation,
  };
})();
