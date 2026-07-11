// Block move gestures for the DITA Editor canvas (IX-1 / IX-2).
//
// Loaded before canvas.js. Two entry points into the host's same-parent
// moveBefore/moveAfter structural op:
//
//   IX-2 Alt+ArrowUp / Alt+ArrowDown — move the current block (paragraph,
//   list item, row via its cell, table, figure, list…) past its previous /
//   next sibling.
//
//   IX-1 drag-and-drop — a grip appears in the page's left margin for the
//   OUTERMOST block under the pointer (a direct body-level child: paragraph,
//   table, list, figure, note…); dragging it shows an insertion line between
//   same-parent siblings and drops into a single moveBefore/moveAfter post.
//   Nested blocks (rows, list items, cell content) never get a grip — the
//   whole table/list moves instead.
//
// Zero document bytes until the host applies the move; Escape cancels a drag.
(function () {
  const MOVABLE = {
    p: 'paragraph', li: 'list item', row: 'row', table: 'table', fig: 'figure',
    ul: 'bulleted list', ol: 'numbered list', note: 'note',
    codeblock: 'code block', lines: 'lines block',
  };
  const GRIP_W = 14;
  const GRIP_H = 22;

  function installMoveBlock(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const caretOffset = opts.caretOffset;
    const postStructural = opts.postStructural;
    const getSelection = opts.getSelection;
    const resolveMember = opts.resolveMember;
    const announceNav = opts.announceNav || function () {};

    function movableFrom(node) {
      const struct = structTarget(node);
      if (!struct) return null;
      const kind = struct.getAttribute('data-struct-kind');
      if (!MOVABLE[kind]) return null;
      return struct;
    }

    // Grip targeting (IX-1 only): resolve the OUTERMOST struct ancestor —
    // NOT structTarget, whose walk-up skips table/fig/ul/ol and so lands on
    // rows/items. Hovering anywhere inside a table or list resolves to the
    // whole table/list; only a body-level block (nothing struct above it)
    // qualifies. IX-2 Alt+Arrow keeps the fine-grained movableFrom.
    function gripTargetFrom(node) {
      if (!node || !node.closest) return null;
      let el = node.closest('[data-struct-id]');
      let top = null;
      while (el) {
        top = el;
        const parent = el.parentElement;
        el = parent && parent.closest ? parent.closest('[data-struct-id]') : null;
      }
      if (!top || !MOVABLE[top.getAttribute('data-struct-kind')]) return null;
      return top;
    }

    function structSibling(el, dir) {
      let sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
      while (sib && !(sib.hasAttribute && sib.hasAttribute('data-struct-id') && sib.hasAttribute('data-struct-kind'))) {
        sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
      }
      return sib;
    }

    function postMove(el, op, refEl, caret) {
      const id = el.getAttribute('data-struct-id');
      const refId = refEl.getAttribute('data-struct-id');
      if (id == null || refId == null) return;
      const noun = MOVABLE[el.getAttribute('data-struct-kind')] || 'element';
      const extra = {
        refId: refId,
        announceOnSuccess: 'Moved the ' + noun + (op === 'moveBefore' ? ' up.' : ' down.'),
      };
      if (typeof caret === 'number') extra.caret = caret;
      postStructural(op, id, extra);
    }

    // ---------- IX-2 Alt+Arrow ----------

    function currentBlock() {
      const ae = document.activeElement;
      const leaf = ae && editableTarget(ae) ? ae : null;
      if (leaf) {
        const el = movableFrom(leaf);
        if (el) return { el: el, caret: caretOffset(leaf) };
      }
      const sel = getSelection();
      if (sel && sel.mode === 'single' && sel.unit === 'block') {
        const main = document.querySelector('main');
        const el = main ? resolveMember(main, 'block', sel.id) : null;
        if (el && MOVABLE[el.getAttribute('data-struct-kind')]) return { el: el, caret: null };
      }
      return null;
    }

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const cur = currentBlock();
      if (!cur) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const sib = structSibling(cur.el, dir);
      if (!sib) {
        const noun = MOVABLE[cur.el.getAttribute('data-struct-kind')] || 'element';
        announceNav('The ' + noun + ' is already ' + (dir < 0 ? 'first' : 'last') + ' in its container.');
        return;
      }
      postMove(cur.el, dir < 0 ? 'moveBefore' : 'moveAfter', sib, cur.caret);
    });

    // ---------- IX-1 drag grip ----------

    // The grip is a fixed hit area whose right edge touches the hovered block,
    // so the pointer can travel from the block onto it without crossing a dead
    // gap (crossing anything non-movable used to hide it instantly). The chip
    // is the visible part, at the hit area's left edge.
    const grip = document.createElement('div');
    grip.setAttribute('aria-hidden', 'true');
    grip.title = 'Drag to reorder';
    grip.style.cssText =
      'position:fixed;display:none;z-index:46;height:' + GRIP_H + 'px;' +
      'align-items:center;justify-content:flex-start;cursor:grab;user-select:none;';
    const gripChip = document.createElement('div');
    gripChip.textContent = '⋮⋮';
    gripChip.style.cssText =
      'display:flex;pointer-events:none;width:' + GRIP_W + 'px;height:' + GRIP_H + 'px;' +
      'align-items:center;justify-content:center;border:1px solid #d6dde1;border-radius:4px;' +
      'background:#f7fafb;color:#8a99a3;letter-spacing:-2px;' +
      'font:700 10px/1 ui-monospace,Menlo,monospace;box-shadow:0 1px 3px rgba(0,0,0,.12);';
    grip.appendChild(gripChip);
    document.body.appendChild(grip);

    const dropLine = document.createElement('div');
    dropLine.setAttribute('aria-hidden', 'true');
    dropLine.style.cssText =
      'position:fixed;display:none;z-index:47;height:2px;background:#b88746;border-radius:1px;' +
      'pointer-events:none;box-shadow:0 0 0 1px rgba(184,135,70,.35);';
    document.body.appendChild(dropLine);

    let gripTarget = null;
    let drag = null;
    let hideTimer = 0;

    function clearHideTimer() {
      if (hideTimer) {
        windowObj.clearTimeout(hideTimer);
        hideTimer = 0;
      }
    }

    function hideGrip() {
      if (drag) return;
      clearHideTimer();
      grip.style.display = 'none';
      gripTarget = null;
    }

    // Leaving the block towards the grip crosses non-movable territory; a
    // short grace period keeps the grip grabbable instead of hiding it the
    // instant the pointer exits the block.
    function scheduleHideGrip() {
      if (drag || hideTimer) return;
      hideTimer = windowObj.setTimeout(() => {
        hideTimer = 0;
        hideGrip();
      }, 250);
    }

    function vRect(el) {
      const geom = window.DitaEditorCanvasGeom;
      return geom ? geom.visualRect(el) : el.getBoundingClientRect();
    }

    // The page's left content edge: <main>'s first element (the article) spans
    // the full centered column, so its left edge is the page margin boundary —
    // stable regardless of the hovered block's own margins/indentation.
    function pageEdge() {
      const main = document.querySelector('main');
      const first = main && main.firstElementChild;
      return first ? vRect(first).left : null;
    }

    function showGripFor(el) {
      gripTarget = el;
      const r = vRect(el);
      const edge = pageEdge();
      const anchor = edge != null ? edge : r.left;
      const left = Math.max(2, Math.round(anchor - GRIP_W - 6));
      const top = Math.round(r.top + Math.min(6, Math.max(0, (r.height - GRIP_H) / 2)));
      const width = Math.max(GRIP_W, Math.round(anchor) - left);
      grip.style.display = 'flex';
      grip.style.left = left + 'px';
      grip.style.width = width + 'px';
      grip.style.top = top + 'px';
    }

    document.addEventListener('mouseover', (e) => {
      if (drag) return;
      const t = e.target;
      if (t && grip.contains && grip.contains(t)) {
        clearHideTimer();
        return;
      }
      const el = t && t.closest ? gripTargetFrom(t) : null;
      if (!el) {
        scheduleHideGrip();
        return;
      }
      clearHideTimer();
      if (el !== gripTarget) showGripFor(el);
    });

    // Margin reach: hovering the empty margin up to ~100px LEFT of a movable
    // block also reveals its grip — the grip lives in that margin, so authors
    // aim there before ever touching the block. Probes rightward at the
    // pointer's y; overlay hits (chips, the grip itself) fall through to a
    // deeper offset.
    const MARGIN_REACH = 104;
    let marginRaf = 0;
    function probeMargin(x, y) {
      if (!document.elementFromPoint) return null;
      const wasShown = grip.style.display;
      grip.style.display = 'none';
      try {
        for (const dx of [16, 48, 80, MARGIN_REACH]) {
          const el = gripTargetFrom(document.elementFromPoint(x + dx, y));
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (x < r.left && r.left - x <= MARGIN_REACH && y >= r.top && y <= r.bottom) return el;
          return null; // a block, but the pointer is not in its left margin
        }
        return null;
      } finally {
        grip.style.display = wasShown;
      }
    }
    document.addEventListener('mousemove', (e) => {
      if (drag || marginRaf) return;
      const t = e.target;
      if (t && (grip.contains(t) || (t.closest && t.closest('[data-struct-id]')))) return;
      const raf = windowObj.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
      const x = e.clientX;
      const y = e.clientY;
      marginRaf = raf(() => {
        marginRaf = 0;
        if (drag) return;
        const el = probeMargin(x, y);
        if (!el) {
          // Out of reach: mouseover never fires while moving inside one large
          // margin element, so the hide must be scheduled from here too.
          scheduleHideGrip();
          return;
        }
        clearHideTimer();
        if (el !== gripTarget) showGripFor(el);
      });
    });

    function siblingsOf(el) {
      const parent = el.parentElement;
      if (!parent) return [];
      return Array.prototype.slice.call(parent.children).filter((c) =>
        c.hasAttribute && c.hasAttribute('data-struct-id') && c.hasAttribute('data-struct-kind'));
    }

    function dropIndexFor(sibs, y) {
      for (let i = 0; i < sibs.length; i += 1) {
        const r = sibs[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return sibs.length;
    }

    function paintDropLine(sibs, idx) {
      let x;
      let y;
      let w;
      if (!sibs.length) return;
      if (idx < sibs.length) {
        const r = vRect(sibs[idx]);
        x = r.left; y = r.top - 1; w = r.width;
      } else {
        const r = vRect(sibs[sibs.length - 1]);
        x = r.left; y = r.bottom + 1; w = r.width;
      }
      dropLine.style.display = 'block';
      dropLine.style.left = Math.round(x) + 'px';
      dropLine.style.top = Math.round(y) + 'px';
      dropLine.style.width = Math.round(w) + 'px';
    }

    function endDrag(commit) {
      if (!drag) return;
      const state = drag;
      drag = null;
      dropLine.style.display = 'none';
      grip.style.cursor = 'grab';
      document.body.style.userSelect = '';
      windowObj.removeEventListener('pointermove', onDragMove);
      windowObj.removeEventListener('pointerup', onDragUp);
      if (!commit) {
        if (state.moved) announceNav('Move cancelled.');
        hideGrip();
        return;
      }
      const sibs = state.sibs;
      const i = sibs.indexOf(state.el);
      const idx = state.dropIndex;
      hideGrip();
      if (idx == null || i < 0 || idx === i || idx === i + 1) return; // dropped in place
      if (idx < i) postMove(state.el, 'moveBefore', sibs[idx], null);
      else postMove(state.el, 'moveAfter', sibs[idx - 1], null);
    }

    function onDragMove(e) {
      if (!drag) return;
      e.preventDefault && e.preventDefault();
      drag.moved = true;
      drag.dropIndex = dropIndexFor(drag.sibs, e.clientY);
      paintDropLine(drag.sibs, drag.dropIndex);
    }

    function onDragUp(e) {
      e.preventDefault && e.preventDefault();
      endDrag(true);
    }

    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!gripTarget || !gripTarget.isConnected) return;
      e.preventDefault();
      e.stopPropagation();
      const sibs = siblingsOf(gripTarget);
      if (sibs.length < 2) {
        announceNav('Nothing to reorder here.');
        return;
      }
      drag = { el: gripTarget, sibs: sibs, dropIndex: null, moved: false };
      grip.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      windowObj.addEventListener('pointermove', onDragMove);
      windowObj.addEventListener('pointerup', onDragUp);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drag) {
        e.preventDefault();
        e.stopPropagation();
        endDrag(false);
      }
    }, true);

    windowObj.addEventListener('blur', () => endDrag(false));
    windowObj.addEventListener('scroll', () => { if (!drag) hideGrip(); }, true);

    return {
      hideGrip: hideGrip,
    };
  }

  window.DitaEditorCanvasMoveBlock = { installMoveBlock: installMoveBlock };
})();
