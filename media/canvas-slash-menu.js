// Slash quick-insert menu for the DITA Editor canvas (IX-5).
//
// Loaded before canvas.js. Typing "/" in an EMPTY paragraph, list item or
// table cell opens a filterable popup of the same gated insert entries the
// ⊕ menu offers (shared resolveInsertEntries / insertAvailFor — the host
// still validates every insert). The "/" itself is never typed; Escape
// returns the caret untouched. Zero document bytes until an entry runs.
(function () {
  function installSlashMenu(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const vscode = opts.vscode;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const sourceTextLength = opts.sourceTextLength;
    const setCaret = opts.setCaret;
    const resolveInsertEntries = opts.resolveInsertEntries;
    const insertAvailFor = opts.insertAvailFor;
    const idOfPayload = opts.idOfPayload;
    const recordMru = opts.recordMru || function () {};
    const announceNav = opts.announceNav || function () {};

    const SYSTEM_SANS = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const popup = document.createElement('div');
    popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-label', 'Quick insert');
    popup.style.cssText =
      'position:fixed;display:none;flex-direction:column;z-index:120;min-width:260px;max-width:340px;' +
      'max-height:46vh;background:#fff;border:1px solid #bbb;border-radius:6px;padding:4px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,0.22);font-family:' + SYSTEM_SANS + ';';
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'Insert…';
    filter.setAttribute('aria-label', 'Filter insert options');
    filter.style.cssText =
      'margin:2px 2px 4px;padding:5px 8px;border:1px solid #d6dde1;border-radius:4px;' +
      'font:13px/1.4 ' + SYSTEM_SANS + ';color:#222;outline-offset:1px;';
    const list = document.createElement('div');
    list.style.cssText = 'overflow:auto;display:flex;flex-direction:column;';
    popup.append(filter, list);
    document.body.appendChild(popup);

    let open = false;
    let items = [];
    let activeIdx = -1;
    let originLeaf = null;

    function close(restoreCaret) {
      if (!open) return;
      open = false;
      popup.style.display = 'none';
      list.textContent = '';
      items = [];
      activeIdx = -1;
      const leaf = originLeaf;
      originLeaf = null;
      if (restoreCaret && leaf && leaf.isConnected) setCaret(leaf, 0);
    }

    function visibleItems() {
      return items.filter((b) => b.style.display !== 'none');
    }

    function setActive(idx) {
      const vis = visibleItems();
      if (!vis.length) return;
      const clamped = Math.max(0, Math.min(idx, vis.length - 1));
      for (const b of items) b.style.background = 'transparent';
      const b = vis[clamped];
      b.style.background = '#e9eef2';
      activeIdx = items.indexOf(b);
      if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
      announceNav((b.getAttribute('aria-label') || b.textContent) + '.');
    }

    function activate(b) {
      if (!b) return;
      if (b.getAttribute('aria-disabled') === 'true') {
        announceNav('Unavailable: ' + (b.getAttribute('aria-label') || 'not available') + '.');
        return;
      }
      const entry = b._insert;
      if (!entry) return;
      vscode.postMessage({ type: 'insert', op: entry.op, payload: entry.payload });
      recordMru(entry.op);
      announceNav(entry.label + '…');
      close(false);
    }

    function applyFilter() {
      const q = (filter.value || '').trim().toLowerCase();
      let shown = 0;
      for (const b of items) {
        const hit = !q || b._searchText.indexOf(q) >= 0;
        b.style.display = hit ? 'block' : 'none';
        if (hit) shown += 1;
      }
      setActive(0);
      return shown;
    }

    function buildItems(entries) {
      list.textContent = '';
      items = entries.map((entry) => {
        const a = insertAvailFor(idOfPayload(entry.payload), entry.payload.mode, entry.op);
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.textContent = entry.label;
        b._searchText = entry.label.toLowerCase();
        b.style.cssText =
          'display:block;width:100%;text-align:left;padding:5px 10px;border:0;border-radius:4px;' +
          'background:transparent;color:#222;font:13px/1.4 ' + SYSTEM_SANS + ';cursor:pointer;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;';
        if (a.enabled) {
          b.setAttribute('aria-label', entry.label);
          b._insert = entry;
        } else {
          b.setAttribute('aria-disabled', 'true');
          b.setAttribute('aria-label', entry.label + ', unavailable: ' + (a.reason || 'not available'));
          b.style.opacity = '0.5';
          b.style.cursor = 'not-allowed';
        }
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          activate(b);
        });
        b.addEventListener('mouseenter', () => setActive(visibleItems().indexOf(b)));
        list.appendChild(b);
        return b;
      });
    }

    function ctxFromLeaf(leaf) {
      const struct = structTarget(leaf);
      const cell = leaf.closest('td[data-cell-id],th[data-cell-id]');
      if (!struct && !cell) return null;
      return {
        kind: struct ? struct.getAttribute('data-struct-kind') : 'entry',
        id: struct ? struct.getAttribute('data-struct-id') : null,
        structEl: struct || cell,
        cellEl: cell || null,
        cellEntryId: cell ? cell.getAttribute('data-cell-id') : null,
      };
    }

    function openFor(leaf) {
      const ctx = ctxFromLeaf(leaf);
      if (!ctx) return false;
      const entries = resolveInsertEntries(ctx);
      if (!entries.length) return false;
      buildItems(entries);
      originLeaf = leaf;
      filter.value = '';
      popup.style.display = 'flex';
      open = true;
      const geom = window.DitaEditorCanvasGeom;
      const r = geom ? geom.visualRect(leaf) : leaf.getBoundingClientRect();
      let left = r.left;
      let top = r.bottom + 4;
      const mw = popup.offsetWidth;
      const mh = popup.offsetHeight;
      if (left + mw > windowObj.innerWidth - 6) left = Math.max(6, windowObj.innerWidth - 6 - mw);
      if (top + mh > windowObj.innerHeight - 6) top = Math.max(6, r.top - 4 - mh);
      popup.style.left = Math.round(left) + 'px';
      popup.style.top = Math.round(top) + 'px';
      filter.focus();
      applyFilter();
      announceNav('Quick insert. ' + entries.length + ' option' + (entries.length === 1 ? '' : 's') +
        '. Type to filter, Up and Down to choose, Enter to insert, Escape to close.');
      return true;
    }

    document.addEventListener('keydown', (e) => {
      if (open) return;
      if (e.defaultPrevented) return;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const leaf = editableTarget(e.target);
      if (!leaf) return;
      if (sourceTextLength(leaf) !== 0) return; // only in an EMPTY block
      if (openFor(leaf)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    popup.addEventListener('keydown', (e) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const vis = visibleItems();
        const cur = vis.indexOf(items[activeIdx]);
        setActive(e.key === 'ArrowDown' ? cur + 1 : Math.max(cur - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const vis = visibleItems();
        const b = items[activeIdx] && items[activeIdx].style.display !== 'none' ? items[activeIdx] : vis[0];
        activate(b);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    });

    filter.addEventListener('input', () => {
      if (applyFilter() === 0) announceNav('No matching insert options.');
    });

    document.addEventListener('click', (e) => {
      if (!open) return;
      if (popup.contains(e.target)) return;
      close(false);
    });

    return {
      close: close,
      isOpen: () => open,
    };
  }

  window.DitaEditorCanvasSlashMenu = { installSlashMenu: installSlashMenu };
})();
