// Keyboard-shortcut cheat sheet for the DITA Editor canvas.
//
// Loaded before canvas.js. Render-only overlay (role="dialog") listing every
// canvas shortcut, with a text filter. Summoned by Cmd/Ctrl+/ or the command
// bar's Help button. Zero document bytes; no acquireVsCodeApi().
(function () {
  const SYSTEM_SANS = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const SECTIONS = [
    {
      title: 'Navigate',
      rows: [
        ['Arrow keys', 'Move between elements and lines'],
        ['Home / End', 'Start / end of line, then element boundary'],
        ['Tab / Shift+Tab', 'Indent / outdent list item (even in a table cell); otherwise next / previous table cell'],
        ['Escape', 'Clear selection; close menus and this list'],
      ],
    },
    {
      title: 'Edit',
      rows: [
        ['Enter', 'Split paragraph / list item; add a row from a cell'],
        ['Backspace at start', 'Join with the previous element'],
        ['Alt+↑ / Alt+↓', 'Move the current block up / down'],
        ['/ in an empty block', 'Quick-insert menu'],
        ['- or 1. then Space', 'Start a bulleted / numbered list'],
        ['Cmd/Ctrl+Z', 'Undo'],
        ['Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y', 'Redo'],
        ['Cmd/Ctrl+F', 'Find in document'],
        ['Cmd/Ctrl+Alt+F', 'Find and replace'],
      ],
    },
    {
      title: 'Format',
      rows: [
        ['Cmd/Ctrl+B / I / U', 'Bold / Italic / Underline'],
        ['Cmd/Ctrl+`', 'Inline code'],
        ['Cmd/Ctrl+=', 'Subscript'],
        ['Cmd/Ctrl+Shift+=', 'Superscript'],
      ],
    },
    {
      title: 'Structure & menus',
      rows: [
        ['Alt+F10 or Shift+F10', 'Open editing controls for the current element'],
        ['Right-click / ContextMenu key', 'Element, image or table-cell menu'],
        ['Cmd/Ctrl+A (repeated)', 'Grow the selection: text → element → container → document'],
        ['Shift+Arrow keys', 'Extend an element selection'],
        ['Cmd/Ctrl+Click', 'Add an element to the selection'],
        ['Shift+Click', 'Extend the selection'],
        ['Double-click a column handle', 'Fit the column to its content'],
      ],
    },
    {
      title: 'View',
      rows: [
        ['Cmd/Ctrl+Alt+= / −', 'Zoom in / out'],
        ['Cmd/Ctrl+Alt+0', 'Reset zoom'],
        ['Cmd/Ctrl+/', 'Show or hide this shortcut list'],
      ],
    },
  ];

  function installShortcutHelp(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const announceNav = opts.announceNav || function () {};

    const backdrop = document.createElement('div');
    backdrop.style.cssText =
      'position:fixed;inset:0;display:none;z-index:110;background:rgba(21,32,38,.38);';
    document.body.appendChild(backdrop);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Keyboard shortcuts');
    dialog.setAttribute('data-ditaeditor-shortcut-help', 'dialog');
    dialog.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:none;z-index:111;' +
      'flex-direction:column;width:min(560px,92vw);max-height:min(620px,86vh);background:#fff;color:#26343b;' +
      'border:1px solid #d8e0e4;border-radius:10px;box-shadow:0 18px 48px rgba(21,32,38,.28);' +
      'font:13px/1.5 ' + SYSTEM_SANS + ';overflow:hidden;';
    document.body.appendChild(dialog);

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #ebebeb;background:#fafafa;';
    const title = document.createElement('span');
    title.textContent = 'Keyboard shortcuts';
    title.style.cssText = 'font-weight:700;font-size:14px;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close keyboard shortcuts');
    closeBtn.style.cssText =
      'margin-left:auto;border:0;background:transparent;color:#52646f;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;';
    header.append(title, closeBtn);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter shortcuts…';
    search.setAttribute('aria-label', 'Filter shortcuts');
    search.style.cssText =
      'margin:10px 14px 0;padding:6px 10px;border:1px solid #d6dde1;border-radius:6px;' +
      'font:13px/1.4 ' + SYSTEM_SANS + ';color:#26343b;background:#fff;outline-offset:2px;';

    const list = document.createElement('div');
    list.style.cssText = 'padding:6px 14px 14px;overflow:auto;';

    const sectionEls = [];
    for (const section of SECTIONS) {
      const sec = document.createElement('div');
      const h = document.createElement('div');
      h.textContent = section.title;
      h.style.cssText =
        'margin:12px 0 4px;font:700 10px/1 ' + SYSTEM_SANS + ';letter-spacing:.09em;text-transform:uppercase;color:#a3a3a3;';
      sec.appendChild(h);
      const rowEls = [];
      for (const row of section.rows) {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:baseline;gap:12px;padding:4px 0;';
        const kbd = document.createElement('span');
        kbd.textContent = row[0];
        kbd.style.cssText =
          'flex:none;min-width:200px;padding:1px 6px;border:1px solid #d6dde1;border-radius:5px;background:#f7fafb;' +
          'font:600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;color:#314652;';
        const desc = document.createElement('span');
        desc.textContent = row[1];
        desc.style.cssText = 'min-width:0;color:#26343b;';
        r.append(kbd, desc);
        r._searchText = (row[0] + ' ' + row[1]).toLowerCase();
        sec.appendChild(r);
        rowEls.push(r);
      }
      list.appendChild(sec);
      sectionEls.push({ root: sec, rows: rowEls });
    }

    dialog.append(header, search, list);

    let open = false;
    let restoreFocusEl = null;

    function applyFilter() {
      const q = (search.value || '').trim().toLowerCase();
      for (const sec of sectionEls) {
        let visible = 0;
        for (const r of sec.rows) {
          const show = !q || r._searchText.indexOf(q) >= 0;
          r.style.display = show ? 'flex' : 'none';
          if (show) visible += 1;
        }
        sec.root.style.display = visible ? 'block' : 'none';
      }
    }

    function show() {
      if (open) return;
      open = true;
      restoreFocusEl = document.activeElement;
      search.value = '';
      applyFilter();
      backdrop.style.display = 'block';
      dialog.style.display = 'flex';
      search.focus();
      announceNav('Keyboard shortcuts. Type to filter, Escape to close.');
    }

    function hide(restoreFocus) {
      if (!open) return;
      open = false;
      backdrop.style.display = 'none';
      dialog.style.display = 'none';
      announceNav('Keyboard shortcuts closed.');
      if (restoreFocus !== false && restoreFocusEl && typeof restoreFocusEl.focus === 'function') {
        restoreFocusEl.focus();
      }
      restoreFocusEl = null;
    }

    function toggle() {
      if (open) hide(true);
      else show();
    }

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    });
    backdrop.addEventListener('click', () => hide(true));
    search.addEventListener('input', applyFilter);
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide(true);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '/') {
        e.preventDefault();
        toggle();
      }
    });

    return {
      toggle: toggle,
      show: show,
      hide: hide,
      isOpen: () => open,
    };
  }

  window.DitaEditorCanvasShortcutHelp = { installShortcutHelp: installShortcutHelp };
})();
