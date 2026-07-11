// Cross-kind Insert menu for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns the body-level Insert popup and
// the shared insert availability/entry helpers used by toolbar and context
// menus. It posts only the existing { type:'insert', op, payload } messages.
(function () {
  const INSERT_KINDS = [
    { op: 'paragraph', noun: 'paragraph' },
    { op: 'unorderedList', noun: 'bulleted list' },
    { op: 'alphabeticList', noun: 'alphabetic list' },
    { op: 'orderedList', noun: 'numbered list' },
    { op: 'table', noun: 'table' },
    { op: 'lines', noun: 'line-respecting text' },
    { op: 'note', noun: 'note' },
    { op: 'codeblock', noun: 'code block' },
    { op: 'section', noun: 'section' },
  ];

  function makeInsertPayload(mode, idField, id) {
    const p = { mode: mode };
    p[idField] = id;
    return p;
  }

  function idOfPayload(p) {
    return p.mode === 'into' ? p.containerId : p.refId;
  }

  // UX-6 adaptive ordering: most-recently-used insert kinds float to the top of
  // the ⊕ menu. Pure reordering — availability gating and labels are unchanged.
  const MRU_KEY = 'ditaeditor.visual.insertMru';
  const MRU_CAP = 6;

  function storedMru(windowObj) {
    try {
      const raw = windowObj.localStorage && windowObj.localStorage.getItem(MRU_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  function storeMru(windowObj, mru) {
    try {
      if (!windowObj.localStorage) return;
      windowObj.localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, MRU_CAP)));
    } catch {
      // Storage is best-effort in VS Code webviews.
    }
  }

  function installInsertMenu(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const vscode = opts.vscode;
    const insertBtn = opts.insertBtn;
    const separator = opts.separator;
    const getCurrent = opts.getCurrent;
    const getInsertMap = opts.getInsertMap;
    const visibleToolbarButtons = opts.visibleToolbarButtons;
    const setToolbarRoving = opts.setToolbarRoving;
    const announceNav = opts.announceNav;

    let mru = storedMru(windowObj);
    function recordMru(op) {
      mru = [op].concat(mru.filter((o) => o !== op)).slice(0, MRU_CAP);
      storeMru(windowObj, mru);
    }
    // Stable sort by MRU rank: recently-used kinds first, unused kinds keep
    // their original order (so before/after pairs stay adjacent per kind).
    function mruOrdered(entries) {
      if (!mru.length) return entries;
      const rank = (op) => {
        const i = mru.indexOf(op);
        return i < 0 ? mru.length + 1 : i;
      };
      return entries
        .map((en, i) => ({ en: en, i: i }))
        .sort((a, b) => rank(a.en.op) - rank(b.en.op) || a.i - b.i)
        .map((x) => x.en);
    }

    function insertAvailFor(id, mode, op) {
      const insertMap = getInsertMap() || {};
      const slot = id != null && insertMap[id] && insertMap[id][mode];
      if (!slot || !slot.find) return { enabled: true };
      return slot.find((x) => x.kind === op) || { enabled: true };
    }

    function resolveEntries(ctx) {
      ctx = ctx || getCurrent();
      if (!ctx) return [];
      const entries = [];
      const add = (label, op, mode, idField, id) => {
        if (id != null) entries.push({ label: label, op: op, payload: makeInsertPayload(mode, idField, id) });
      };
      const blockNoun = ctx.kind === 'li' ? 'list item' : ctx.kind === 'p' ? 'paragraph' : null;
      if (blockNoun && ctx.id) {
        for (const k of INSERT_KINDS) {
          add('Insert ' + k.noun + ' before this ' + blockNoun, k.op, 'before', 'refId', ctx.id);
          add('Insert ' + k.noun + ' after this ' + blockNoun, k.op, 'after', 'refId', ctx.id);
        }
        if (ctx.kind === 'li') {
          for (const k of INSERT_KINDS) {
            add('Insert ' + k.noun + ' inside this list item', k.op, 'into', 'containerId', ctx.id);
          }
        }
      }
      const base = ctx.cellEl || ctx.structEl || null;
      const tableEl = base ? base.closest('[data-struct-kind="table"]') : null;
      if (tableEl) {
        const tid = tableEl.getAttribute('data-struct-id');
        for (const k of INSERT_KINDS) add('Insert ' + k.noun + ' after this table', k.op, 'after', 'refId', tid);
      }
      const figEl = ctx.structEl ? ctx.structEl.closest('[data-struct-kind="fig"]') : null;
      if (figEl) {
        const fid = figEl.getAttribute('data-struct-id');
        for (const k of INSERT_KINDS) add('Insert ' + k.noun + ' after this figure', k.op, 'after', 'refId', fid);
      }
      if (ctx.cellEntryId) {
        for (const k of INSERT_KINDS) {
          add('Insert ' + k.noun + ' inside this cell', k.op, 'into', 'containerId', ctx.cellEntryId);
        }
      }
      return entries;
    }

    const insertMenu = document.createElement('div');
    insertMenu.setAttribute('role', 'menu');
    insertMenu.setAttribute('aria-label', 'Insert element');
    insertMenu.style.cssText =
      'position:fixed;display:none;flex-direction:column;z-index:55;min-width:220px;max-height:60vh;' +
      'overflow:auto;background:#fff;border:1px solid #bbb;border-radius:6px;padding:3px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.22);font-family:sans-serif;';
    document.body.appendChild(insertMenu);

    let menuOpen = false;
    let menuItems = [];

    function makeMenuItem(entry) {
      const a = insertAvailFor(idOfPayload(entry.payload), entry.payload.mode, entry.op);
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = 'tb-menuitem';
      b.textContent = entry.label;
      b.title = a.enabled ? entry.label : a.reason || entry.label;
      b.tabIndex = -1;
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:5px 10px;border:0;border-radius:4px;' +
        'background:transparent;color:#222;font:13px/1.4 sans-serif;cursor:pointer;white-space:nowrap;';
      if (a.enabled) {
        b.setAttribute('aria-label', entry.label);
        b._insert = entry;
      } else {
        b.setAttribute('aria-disabled', 'true');
        b.setAttribute('aria-label', entry.label + ', unavailable: ' + (a.reason || 'not available'));
        b.style.opacity = '0.5';
        b.style.cursor = 'not-allowed';
      }
      b.addEventListener('mouseenter', () => {
        const i = menuItems.indexOf(b);
        if (i >= 0) setMenuRoving(i);
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateMenuItem(b);
      });
      return b;
    }

    function setMenuRoving(i) {
      if (!menuItems.length) return null;
      const idx = Math.max(0, Math.min(i, menuItems.length - 1));
      for (const it of menuItems) it.tabIndex = -1;
      menuItems[idx].tabIndex = 0;
      menuItems[idx].focus();
      return menuItems[idx];
    }

    function activateMenuItem(b) {
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

    function open() {
      const entries = mruOrdered(resolveEntries());
      if (!entries.length) return;
      insertMenu.innerHTML = '';
      menuItems = entries.map((en) => {
        const it = makeMenuItem(en);
        insertMenu.appendChild(it);
        return it;
      });
      insertMenu.style.display = 'flex';
      insertBtn.setAttribute('aria-expanded', 'true');
      menuOpen = true;
      const r = insertBtn.getBoundingClientRect();
      let top = r.bottom + 2;
      let left = r.left;
      const mw = insertMenu.offsetWidth;
      const mh = insertMenu.offsetHeight;
      if (left + mw > windowObj.innerWidth - 6) left = Math.max(6, windowObj.innerWidth - 6 - mw);
      if (top + mh > windowObj.innerHeight - 6) top = Math.max(6, r.top - 2 - mh);
      insertMenu.style.left = left + 'px';
      insertMenu.style.top = top + 'px';
      let first = menuItems.findIndex((it) => it.getAttribute('aria-disabled') !== 'true');
      if (first < 0) first = 0;
      setMenuRoving(first);
      announceNav('Insert menu. ' + entries.length + ' option' + (entries.length === 1 ? '' : 's') +
        '. Up and Down to choose, Enter to insert, Escape to close.');
    }

    function focusInsertBtn() {
      if (insertBtn.style.display === 'none') return;
      const vis = visibleToolbarButtons();
      const i = vis.indexOf(insertBtn);
      if (i >= 0) setToolbarRoving(i);
      else insertBtn.focus();
    }

    function close(restoreFocus) {
      if (menuOpen || insertMenu.style.display !== 'none') {
        insertMenu.style.display = 'none';
        insertMenu.innerHTML = '';
        menuItems = [];
        menuOpen = false;
        insertBtn.setAttribute('aria-expanded', 'false');
      }
      if (restoreFocus) focusInsertBtn();
    }

    function configureButton() {
      const has = resolveEntries().length > 0;
      insertBtn.style.display = has ? 'inline-block' : 'none';
      separator.style.display = has ? 'block' : 'none';
      if (!has) close(false);
    }

    insertBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menuOpen) close(true);
      else open();
    });

    insertMenu.addEventListener('keydown', (e) => {
      if (!menuOpen) return;
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const cur = menuItems.indexOf(document.activeElement);
        let next;
        if (e.key === 'ArrowDown') next = Math.min((cur < 0 ? -1 : cur) + 1, menuItems.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max((cur < 0 ? menuItems.length : cur) - 1, 0);
        else if (e.key === 'Home') next = 0;
        else next = menuItems.length - 1;
        const it = setMenuRoving(next);
        if (it) announceNav((it.getAttribute('aria-label') || it.textContent) + '.');
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        const b = document.activeElement;
        if (b && menuItems.indexOf(b) >= 0) activateMenuItem(b);
      }
    });

    document.addEventListener('click', (e) => {
      if (!menuOpen) return;
      const t = e.target;
      if (insertMenu.contains(t) || t === insertBtn) return;
      close(false);
    });

    return {
      configureButton: configureButton,
      open: open,
      close: close,
      isOpen: () => menuOpen,
      resolveEntries: resolveEntries,
      insertAvailFor: insertAvailFor,
      idOfPayload: idOfPayload,
      recordMru: recordMru,
    };
  }

  window.DitaEditorCanvasInsertMenu = {
    installInsertMenu: installInsertMenu,
    INSERT_KINDS: INSERT_KINDS,
    idOfPayload: idOfPayload,
  };
})();
