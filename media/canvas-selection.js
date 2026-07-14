// Shared selection helpers for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns DOM-to-selection calculations only:
// no VS Code API access, no host messages, and no document writes.
(function () {
  function createSelectionHelpers(options) {
    options = options || {};
    const editableTarget = options.editableTarget || function () { return null; };

    function unitOf(node) {
      if (node && node.nodeType === 3) node = node.parentElement;
      if (!node || !node.closest) return null;
      const image = node.closest('img[data-struct-id][data-struct-kind="image"]');
      if (image) return { type: 'image', el: image };
      const cell = node.closest('td[data-cell-id], th[data-cell-id]');
      if (cell) return { type: 'cell', el: cell };

      const struct = node.closest('[data-struct-id][data-struct-kind]');
      if (struct) {
        const kind = struct.getAttribute('data-struct-kind');
        if (kind === 'image') return { type: 'image', el: struct };
        if (kind === 'fig' && !editableTarget(node)) {
          const figImg = struct.querySelector('img[data-struct-id][data-struct-kind="image"]');
          if (figImg) return { type: 'image', el: figImg };
        }
        return { type: 'block', el: struct };
      }
      return null;
    }

    function unitElType(el) {
      if (!el || !el.matches) return null;
      if (el.matches('td[data-cell-id], th[data-cell-id]')) return 'cell';
      if (el.matches('img[data-struct-id][data-struct-kind="image"]')) return 'image';
      if (el.matches('[data-struct-id][data-struct-kind]')) return 'block';
      return null;
    }

    function computeDomGrid(table) {
      const grid = [];
      let collision = false;
      for (const section of ['thead', 'tbody']) {
        const sec = table.querySelector('.' + section);
        if (!sec) continue;
        const rows = Array.prototype.slice.call(sec.querySelectorAll(':scope > tr'));
        const occ = new Set();
        rows.forEach((tr, r) => {
          let col = 1;
          for (const cell of tr.children) {
            while (occ.has(r + ',' + col)) col++;
            const cs = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
            const rs = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1;
            const colStart = col;
            const colEnd = col + cs - 1;
            grid.push({ el: cell, cellId: cell.getAttribute('data-cell-id'), section, row: r, colStart, colEnd, rowSpan: rs });
            for (let rr = r; rr < r + rs; rr++) {
              for (let cc = colStart; cc <= colEnd; cc++) {
                const key = rr + ',' + cc;
                if (occ.has(key)) collision = true;
                occ.add(key);
              }
            }
            col = colEnd + 1;
          }
        });
      }
      grid.collision = collision;
      return grid;
    }

    function fingerprintOf(el, unit) {
      return unit === 'image' ? (el.getAttribute('src') || '') : el.textContent;
    }

    function singleSel(el) {
      const t = unitElType(el);
      if (t === 'cell') return { mode: 'single', unit: 'cell', id: el.getAttribute('data-cell-id'), kind: null, text: el.textContent };
      if (t === 'block') return { mode: 'single', unit: 'block', id: el.getAttribute('data-struct-id'), kind: el.getAttribute('data-struct-kind'), text: el.textContent };
      if (t === 'image') return { mode: 'single', unit: 'image', id: el.getAttribute('data-struct-id'), kind: 'image', text: fingerprintOf(el, 'image') };
      return null;
    }

    function buildBlockRange(anchorEl, focusEl) {
      const kind = anchorEl.getAttribute('data-struct-kind');
      if (focusEl.getAttribute('data-struct-kind') !== kind) return null;
      const parent = anchorEl.parentElement;
      if (!parent || focusEl.parentElement !== parent) return null;
      const all = Array.prototype.slice.call(parent.children);
      const ai = all.indexOf(anchorEl);
      const fi = all.indexOf(focusEl);
      if (ai < 0 || fi < 0) return null;
      const members = all
        .slice(Math.min(ai, fi), Math.max(ai, fi) + 1)
        .filter((el) => el.getAttribute && el.getAttribute('data-struct-kind') === kind && el.hasAttribute('data-struct-id'))
        .map((el) => ({ id: el.getAttribute('data-struct-id'), text: el.textContent }));
      if (members.length === 0) return null;
      return {
        mode: 'blockRange',
        kind: kind,
        anchorId: anchorEl.getAttribute('data-struct-id'),
        focusId: focusEl.getAttribute('data-struct-id'),
        members: members,
      };
    }

    function buildCellRect(anchorEl, focusEl) {
      const table = anchorEl.closest('table');
      if (!table || focusEl.closest('table') !== table) return null;
      const grid = computeDomGrid(table);
      if (grid.collision) return null;
      const a = grid.find((g) => g.el === anchorEl);
      const f = grid.find((g) => g.el === focusEl);
      if (!a || !f) return null;
      const section = a.section;
      let r0 = a.row;
      let r1 = a.row + a.rowSpan - 1;
      let c0 = Math.min(a.colStart, f.colStart);
      let c1 = Math.max(a.colEnd, f.colEnd);
      if (f.section === section) {
        r0 = Math.min(r0, f.row);
        r1 = Math.max(r1, f.row + f.rowSpan - 1);
      }
      const inSec = grid.filter((g) => g.section === section);
      const intersects = (g) => g.row <= r1 && g.row + g.rowSpan - 1 >= r0 && g.colStart <= c1 && g.colEnd >= c0;
      let changed = true;
      while (changed) {
        changed = false;
        for (const g of inSec) {
          if (!intersects(g)) continue;
          if (g.row < r0) { r0 = g.row; changed = true; }
          if (g.row + g.rowSpan - 1 > r1) { r1 = g.row + g.rowSpan - 1; changed = true; }
          if (g.colStart < c0) { c0 = g.colStart; changed = true; }
          if (g.colEnd > c1) { c1 = g.colEnd; changed = true; }
        }
      }
      const members = inSec.filter(intersects).map((g) => ({ id: g.cellId, text: g.el.textContent }));
      if (members.length === 0) return null;
      return {
        mode: 'cellRect',
        anchorCellId: anchorEl.getAttribute('data-cell-id'),
        focusCellId: focusEl.getAttribute('data-cell-id'),
        rect: { section: section, r0: r0, r1: r1, c0: c0, c1: c1 },
        members: members,
      };
    }

    function shouldIncludeInDocumentRange(el, anchorEl, focusEl) {
      const kind = el.getAttribute && el.getAttribute('data-struct-kind');
      if (el === anchorEl || el === focusEl) return true;
      return kind !== 'ul' && kind !== 'ol' && kind !== 'table' && kind !== 'fig';
    }

    function isDocumentRangeMember(el) {
      const kind = el.getAttribute && el.getAttribute('data-struct-kind');
      return kind !== 'ul' && kind !== 'ol' && kind !== 'table' && kind !== 'fig';
    }

    function verticalDragCandidate(el) {
      if (!el || !el.getAttribute || !el.closest) return false;
      if (el.closest('table')) return false;
      const kind = el.getAttribute('data-struct-kind');
      return !!kind && kind !== 'row';
    }

    function unitFromPoint(root, clientY) {
      if (!root || !root.querySelectorAll || typeof clientY !== 'number') return null;
      let best = null;
      for (const el of root.querySelectorAll('[data-struct-id][data-struct-kind]')) {
        if (!verticalDragCandidate(el) || typeof el.getBoundingClientRect !== 'function') continue;
        const rect = el.getBoundingClientRect();
        if (!rect || clientY < rect.top || clientY > rect.bottom) continue;
        if (!best) {
          best = { el: el, rect: rect };
          continue;
        }
        const height = Math.max(0, rect.bottom - rect.top);
        const bestHeight = Math.max(0, best.rect.bottom - best.rect.top);
        if (height < bestHeight || (height === bestHeight && best.el.contains && best.el.contains(el))) {
          best = { el: el, rect: rect };
        }
      }
      return best ? unitOf(best.el) : null;
    }

    function rangeBoundaryFor(el, side) {
      if (isDocumentRangeMember(el)) return el;
      if (side === 'start' && el.parentElement && el.parentElement.closest) {
        const ownerItem = el.parentElement.closest('li[data-struct-id][data-struct-kind]');
        if (ownerItem && isDocumentRangeMember(ownerItem)) return ownerItem;
      }
      const descendants = Array.prototype.slice
        .call(el.querySelectorAll('[data-struct-id][data-struct-kind]'))
        .filter(isDocumentRangeMember);
      if (!descendants.length) return el;
      return side === 'start' ? descendants[0] : descendants[descendants.length - 1];
    }

    function buildDocumentRange(anchorEl, focusEl) {
      const main = anchorEl.closest && anchorEl.closest('main');
      if (!main || (focusEl.closest && focusEl.closest('main') !== main)) return null;
      const raw = Array.prototype.slice.call(main.querySelectorAll('[data-struct-id][data-struct-kind]'));
      const anchorRaw = raw.indexOf(anchorEl);
      const focusRaw = raw.indexOf(focusEl);
      if (anchorRaw < 0 || focusRaw < 0) return null;
      const forward = anchorRaw <= focusRaw;
      const anchorBoundary = rangeBoundaryFor(anchorEl, forward ? 'start' : 'end');
      const focusBoundary = rangeBoundaryFor(focusEl, forward ? 'end' : 'start');
      const all = raw.filter((el) => shouldIncludeInDocumentRange(el, anchorBoundary, focusBoundary));
      const bi = all.indexOf(anchorBoundary);
      const ei = all.indexOf(focusBoundary);
      if (bi < 0 || ei < 0) return null;
      const els = all.slice(Math.min(bi, ei), Math.max(bi, ei) + 1);
      const units = els.map((el) => unitDesc(el)).filter(Boolean);
      if (units.length === 0) return null;
      if (units.length === 1) return singleSel(els[0]);
      // Document drags may cross structural wrapper elements (for example a
      // <section>) that are useful selection boundaries but are not themselves
      // formatting targets. Preserve the origin so feature-specific target
      // resolvers can ignore only those range artifacts without weakening
      // explicit Cmd-click multi-selection validation.
      return { mode: 'multiSet', origin: 'documentRange', units: units };
    }

    function buildSelection(anchorEl, focusEl) {
      if (!anchorEl) return null;
      if (!focusEl || anchorEl === focusEl) return singleSel(anchorEl);
      const at = unitElType(anchorEl);
      const ft = unitElType(focusEl);
      if (at === 'cell' && ft === 'cell') {
        const r = buildCellRect(anchorEl, focusEl);
        if (r) return r;
      }
      if ((at === 'block' || at === 'image') && (ft === 'block' || ft === 'image')) {
        const docRange = buildDocumentRange(anchorEl, focusEl);
        if (at === 'block' && ft === 'block') {
          const blockRange = buildBlockRange(anchorEl, focusEl);
          if (blockRange) {
            const blockIds = blockRange.members.map((m) => m.id);
            const docUnits = docRange && docRange.mode === 'multiSet' ? docRange.units : [];
            const docBlockIds = docUnits
              .filter((u) => u.unit === 'block' || u.unit === 'image')
              .map((u) => u.id);
            const sameRange = docBlockIds.length === blockIds.length &&
              docBlockIds.every((id, i) => id === blockIds[i]);
            return sameRange ? blockRange : (docRange || blockRange);
          }
        }
        if (docRange) return docRange;
      }
      return singleSel(anchorEl);
    }

    function resolveMember(main, unit, id) {
      if (id == null) return null;
      const attr = unit === 'cell' ? 'data-cell-id' : 'data-struct-id';
      return main.querySelector('[' + attr + '="' + CSS.escape(id) + '"]');
    }

    function selectionMemberEls(selection, main) {
      if (!selection) return [];
      const out = [];
      if (selection.mode === 'single') {
        const el = resolveMember(main, selection.unit, selection.id);
        if (el) out.push(el);
        return out;
      }
      if (selection.mode === 'multiSet') {
        for (const u of selection.units) {
          const el = resolveMember(main, u.unit, u.id);
          if (el) out.push(el);
        }
        return out;
      }
      const unit = selection.mode === 'cellRect' ? 'cell' : 'block';
      for (const m of selection.members) {
        const el = resolveMember(main, unit, m.id);
        if (el) out.push(el);
      }
      return out;
    }

    function selectionAnchorEl(selection, main) {
      if (!selection) return null;
      if (selection.mode === 'single') return resolveMember(main, selection.unit, selection.id);
      if (selection.mode === 'blockRange') return resolveMember(main, 'block', selection.anchorId);
      if (selection.mode === 'cellRect') return resolveMember(main, 'cell', selection.anchorCellId);
      if (selection.mode === 'multiSet') {
        const last = selection.units[selection.units.length - 1];
        return last ? resolveMember(main, last.unit, last.id) : null;
      }
      return null;
    }

    function unitDesc(el) {
      const t = unitElType(el);
      if (t === 'cell') return { unit: 'cell', id: el.getAttribute('data-cell-id'), kind: null, text: el.textContent };
      if (t === 'block') return { unit: 'block', id: el.getAttribute('data-struct-id'), kind: el.getAttribute('data-struct-kind'), text: el.textContent };
      if (t === 'image') return { unit: 'image', id: el.getAttribute('data-struct-id'), kind: 'image', text: fingerprintOf(el, 'image') };
      return null;
    }

    function selectionUnits(selection) {
      if (!selection) return [];
      if (selection.mode === 'single') return [{ unit: selection.unit, id: selection.id, kind: selection.kind, text: selection.text }];
      if (selection.mode === 'multiSet') return selection.units.slice();
      const unit = selection.mode === 'cellRect' ? 'cell' : 'block';
      const kind = selection.mode === 'blockRange' ? selection.kind : null;
      return selection.members.map((m) => ({ unit: unit, id: m.id, kind: kind, text: m.text }));
    }

    function sortUnitsByDocOrder(units, main) {
      const order = new Map();
      let i = 0;
      for (const el of main.querySelectorAll('[data-struct-id],[data-cell-id]')) {
        const id = el.getAttribute('data-cell-id') || el.getAttribute('data-struct-id');
        if (!order.has(id)) order.set(id, i++);
      }
      return units.slice().sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }

    return {
      unitOf: unitOf,
      unitElType: unitElType,
      computeDomGrid: computeDomGrid,
      fingerprintOf: fingerprintOf,
      singleSel: singleSel,
      buildBlockRange: buildBlockRange,
      buildCellRect: buildCellRect,
      buildSelection: buildSelection,
      resolveMember: resolveMember,
      selectionMemberEls: selectionMemberEls,
      selectionAnchorEl: selectionAnchorEl,
      unitDesc: unitDesc,
      selectionUnits: selectionUnits,
      sortUnitsByDocOrder: sortUnitsByDocOrder,
      unitFromPoint: unitFromPoint,
    };
  }

  window.DitaEditorCanvasSelection = { createSelectionHelpers: createSelectionHelpers };
})();
