// Keyboard selection for the DITA Editor canvas (IX-7 / IX-8).
//
// Loaded before canvas.js. Two render-only gestures over the existing
// selection model — zero document bytes, no acquireVsCodeApi():
//
//   IX-7 progressive expansion — repeated Cmd/Ctrl+A grows the selection:
//   leaf text (native) → element → container (list / table / figure) →
//   entire document.
//
//   IX-8 Shift+Arrow — extends an existing element selection from the
//   keyboard: cells extend through the DOM grid (span-aware), blocks extend
//   through the host navMap, mirroring what Shift+Click builds with the mouse.
(function () {
  const ARROWS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };

  function installKeyboardSelect(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const selectionModel = opts.selectionModel;
    const getSelection = opts.getSelection;
    const setSelection = opts.setSelection;
    const setSelectionAnchor = opts.setSelectionAnchor;
    const getNavMap = opts.getNavMap;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const nounForKind = opts.nounForKind || function (k) { return k || 'element'; };
    const announceNav = opts.announceNav || function () {};

    const singleSel = selectionModel.singleSel;
    const buildSelection = selectionModel.buildSelection;
    const buildBlockRange = selectionModel.buildBlockRange;
    const buildDocumentRange = selectionModel.buildDocumentRange || null;
    const computeDomGrid = selectionModel.computeDomGrid;
    const resolveMember = selectionModel.resolveMember;

    function mainEl() {
      return document.querySelector('main');
    }

    function countOf(sel) {
      if (!sel) return 0;
      if (sel.mode === 'single') return 1;
      if (sel.mode === 'multiSet') return (sel.units || []).length;
      return (sel.members || []).length;
    }

    function describe(sel) {
      const n = countOf(sel);
      const noun = sel && sel.mode === 'cellRect' ? 'cell' : 'element';
      return n + ' ' + noun + (n === 1 ? '' : 's') + ' selected.';
    }

    function focusEl(el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus();
    }

    function selectEl(el, label) {
      setSelection(singleSel(el));
      setSelectionAnchor(el);
      focusEl(el);
      announceNav('Selected ' + label + '.');
    }

    // ---------- IX-7 Cmd/Ctrl+A progressive expansion ----------

    function leafTextFullySelected(leaf) {
      const text = (leaf.textContent || '').trim();
      if (!text) return true; // nothing to select — escalate immediately
      const s = windowObj.getSelection();
      if (!s || s.isCollapsed || !s.anchorNode || !s.focusNode) return false;
      if (!leaf.contains(s.anchorNode) || !leaf.contains(s.focusNode)) return false;
      return s.toString().trim().length >= text.length;
    }

    function selectDocument(main) {
      const all = main.querySelectorAll('[data-struct-id][data-struct-kind]');
      if (!all.length) return;
      const sel = buildDocumentRange
        ? buildDocumentRange(all[0], all[all.length - 1])
        : buildSelection(all[0], all[all.length - 1]);
      if (!sel) return;
      setSelection(sel);
      setSelectionAnchor(all[0]);
      announceNav('Entire document selected: ' + describe(sel));
    }

    function expandFromElement(main, el, unit) {
      if (unit === 'cell') {
        const table = el.closest('table[data-struct-id][data-struct-kind="table"]');
        if (table) {
          selectEl(table, 'the whole table');
          return;
        }
      }
      if (unit === 'image') {
        const fig = el.closest('[data-struct-id][data-struct-kind="fig"]');
        if (fig) {
          selectEl(fig, 'the figure');
          return;
        }
      }
      const kind = el.getAttribute && el.getAttribute('data-struct-kind');
      if (kind === 'li') {
        const list = el.closest('ul,ol');
        const items = list ? list.querySelectorAll(':scope > li[data-struct-id]') : null;
        if (items && items.length > 1) {
          const range = buildBlockRange(items[0], items[items.length - 1]);
          if (range) {
            setSelection(range);
            setSelectionAnchor(items[0]);
            announceNav('Whole list selected: ' + describe(range));
            return;
          }
        }
      }
      selectDocument(main);
    }

    function onSelectAll(e) {
      const main = mainEl();
      if (!main) return;
      const ae = document.activeElement;
      const leaf = ae && editableTarget(ae) ? ae : null;

      // Stage 1: let the browser select the leaf's own text first.
      if (leaf && !leafTextFullySelected(leaf)) return;

      const sel = getSelection();

      if (leaf) {
        e.preventDefault();
        const cell = leaf.closest('td[data-cell-id],th[data-cell-id]');
        const el = cell || structTarget(leaf);
        if (!el) return;
        if (sel && sel.mode === 'single' &&
            sel.id === (cell ? cell.getAttribute('data-cell-id') : el.getAttribute('data-struct-id'))) {
          // Element already selected — keep climbing.
          expandFromElement(main, el, cell ? 'cell' : 'block');
          return;
        }
        const kind = cell ? 'entry' : el.getAttribute('data-struct-kind');
        selectEl(el, 'this ' + (cell ? 'cell' : nounForKind(kind)));
        return;
      }

      if (sel && sel.mode === 'single') {
        e.preventDefault();
        const el = resolveMember(main, sel.unit, sel.id);
        if (el) expandFromElement(main, el, sel.unit);
        else selectDocument(main);
        return;
      }
      if (sel && sel.mode === 'cellRect') {
        e.preventDefault();
        const el = resolveMember(main, 'cell', sel.anchorCellId);
        const table = el ? el.closest('table[data-struct-id][data-struct-kind="table"]') : null;
        if (table) selectEl(table, 'the whole table');
        else selectDocument(main);
        return;
      }
      if (sel) {
        e.preventDefault();
        selectDocument(main);
        return;
      }
      // No canvas focus and no selection — leave Cmd/Ctrl+A alone.
    }

    // ---------- IX-8 Shift+Arrow range extension ----------

    function nextCellFrom(focusCell, key) {
      const table = focusCell.closest('table');
      if (!table) return null;
      const grid = computeDomGrid(table);
      const g = grid.find((x) => x.el === focusCell);
      if (!g) return null;
      let row = g.row;
      let col = g.colStart;
      if (key === 'ArrowUp') row = g.row - 1;
      else if (key === 'ArrowDown') row = g.row + g.rowSpan;
      else if (key === 'ArrowLeft') col = g.colStart - 1;
      else col = g.colEnd + 1;
      if (row < 0 || col < 1) return null;
      const hit = grid.find((x) =>
        x.section === g.section &&
        x.row <= row && x.row + x.rowSpan - 1 >= row &&
        x.colStart <= col && x.colEnd >= col);
      return hit ? hit.el : null;
    }

    function selectionEnds(main, sel) {
      if (sel.mode === 'single') {
        const el = resolveMember(main, sel.unit, sel.id);
        return el ? { anchor: el, focus: el, unit: sel.unit } : null;
      }
      if (sel.mode === 'blockRange') {
        const anchor = resolveMember(main, 'block', sel.anchorId);
        const focus = resolveMember(main, 'block', sel.focusId);
        return anchor && focus ? { anchor: anchor, focus: focus, unit: 'block' } : null;
      }
      if (sel.mode === 'cellRect') {
        const anchor = resolveMember(main, 'cell', sel.anchorCellId);
        const focus = resolveMember(main, 'cell', sel.focusCellId);
        return anchor && focus ? { anchor: anchor, focus: focus, unit: 'cell' } : null;
      }
      return null;
    }

    function caretInsideEditable() {
      const ae = document.activeElement;
      if (!ae || !editableTarget(ae)) return false;
      const s = windowObj.getSelection();
      return !!(s && s.anchorNode && ae.contains(s.anchorNode));
    }

    function onShiftArrow(e) {
      const sel = getSelection();
      if (!sel) return;
      if (sel.mode === 'multiSet') return; // additive Cmd-click sets are not directional
      // A caret in text keeps native Shift+Arrow character selection.
      if (sel.mode === 'single' && caretInsideEditable()) return;
      const main = mainEl();
      if (!main) return;
      const ends = selectionEnds(main, sel);
      if (!ends) return;

      let next = null;
      if (ends.unit === 'cell') {
        next = nextCellFrom(ends.focus, e.key);
      } else if (ends.unit === 'block' || ends.unit === 'image') {
        const navMap = getNavMap() || {};
        const focusId = ends.focus.getAttribute('data-struct-id');
        const nav = focusId != null && navMap[focusId] && navMap[focusId][e.key];
        if (nav && nav.ok && nav.targetId != null) {
          next = resolveMember(main, 'block', nav.targetId) || resolveMember(main, 'cell', nav.targetId);
        }
      }
      e.preventDefault();
      e.stopPropagation();
      if (!next) {
        announceNav('Selection edge reached.');
        return;
      }
      const grown = buildSelection(ends.anchor, next);
      if (!grown) {
        announceNav('Cannot extend the selection there.');
        return;
      }
      setSelection(grown);
      announceNav(describe(grown));
    }

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key || '').toLowerCase() === 'a') {
        onSelectAll(e);
        return;
      }
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && ARROWS[e.key]) {
        onShiftArrow(e);
      }
    });

    return {};
  }

  window.DitaEditorCanvasKeyboardSelect = { installKeyboardSelect: installKeyboardSelect };
})();
