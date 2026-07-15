// Persistent menu primitive for the DITA Editor canvas.
//
// Loaded before canvas.js. It deliberately does not call acquireVsCodeApi()
// or own any document state; canvas.js passes small hooks for announcements
// and visible refusal messages.
(function () {
  const MENU_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  const CHEVRON_RIGHT =
    '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 5 13 10 8 15"/></svg>';
  const EDGE_GAP = 6;

  function noop() {}

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function px(value) {
    return Math.round(value) + 'px';
  }

  function viewportWidth() {
    const root = document.documentElement;
    return num(window.innerWidth, root ? num(root.clientWidth, 1024) : 1024);
  }

  function viewportHeight() {
    const root = document.documentElement;
    return num(window.innerHeight, root ? num(root.clientHeight, 768) : 768);
  }

  function rectHeight(rect) {
    if (!rect) return 0;
    return num(rect.height, Math.max(0, num(rect.bottom, 0) - num(rect.top, 0)));
  }

  function bottomChromeInset() {
    const crumb = document.querySelector('[data-ditaeditor-breadcrumb="bar"]');
    if (!crumb) return 0;
    const inlineDisplay = crumb.style && crumb.style.display;
    if (inlineDisplay === 'none') return 0;
    if (typeof window.getComputedStyle === 'function') {
      const computed = window.getComputedStyle(crumb);
      if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return 0;
    }
    const rect = typeof crumb.getBoundingClientRect === 'function' ? crumb.getBoundingClientRect() : null;
    return Math.ceil(Math.max(rectHeight(rect), num(crumb.offsetHeight, 0)));
  }

  function viewportBounds() {
    const bottom = Math.max(EDGE_GAP, viewportHeight() - EDGE_GAP - bottomChromeInset());
    return {
      left: EDGE_GAP,
      top: EDGE_GAP,
      right: Math.max(EDGE_GAP, viewportWidth() - EDGE_GAP),
      bottom: bottom,
    };
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(value, max));
  }

  function availableHeight(bounds) {
    return Math.max(1, bounds.bottom - bounds.top);
  }

  function elementWidth(el, fallback) {
    return Math.max(1, num(el.offsetWidth, fallback));
  }

  function elementHeight(el, fallback, maxHeight) {
    return Math.max(1, Math.min(num(el.offsetHeight, fallback), maxHeight));
  }

  function createMenu(ariaLabel, onToggle, hooks) {
    hooks = hooks || {};
    const announceNav = hooks.announceNav || noop;
    const showError = hooks.showError || noop;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', ariaLabel);
    // Frame D of the design: a rounded 12px card with a soft layered shadow.
    menu.style.cssText =
      'position:fixed;display:none;flex-direction:column;z-index:55;min-width:220px;max-height:calc(100vh - 12px);' +
      'overflow:auto;background:#fff;border:1px solid #e6e6e6;border-radius:10px;padding:4px 0 6px;' +
      'box-shadow:0 10px 34px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.05);font-family:' + MENU_FONT + ';';
    document.body.appendChild(menu);
    let open = false;
    let items = [];
    let closeCb = null;
    let submenuPanels = [];
    let submenuCloseTimer = null;

    function visibleItems() {
      return items.filter((it) => !it._parentSubmenuItem || it._parentSubmenuItem.getAttribute('aria-expanded') === 'true');
    }

    function roving(i) {
      const current = visibleItems();
      if (!current.length) return null;
      const idx = Math.max(0, Math.min(i, current.length - 1));
      for (const it of items) it.tabIndex = -1;
      current[idx].tabIndex = 0;
      current[idx].focus();
      return current[idx];
    }

    function activate(b) {
      if (b.getAttribute('aria-disabled') === 'true') {
        // Visible reason: clicking a grayed action surfaces why, rather than
        // doing nothing and leaving sighted users to infer the refusal.
        showError(b.title || "That action isn't available here.");
        announceNav('Unavailable: ' + (b.getAttribute('aria-label') || 'not available') + '.');
        return; // byte-noop
      }
      if (typeof b._openSubmenu === 'function') {
        b._openSubmenu(true);
        const first = b._firstSubmenuItem;
        if (first) {
          for (const it of items) it.tabIndex = -1;
          first.tabIndex = 0;
          first.focus();
        }
        return;
      }
      const act = b._act;
      closeMenu(false); // close first; the ensuing host rerender, if any, lands focus
      if (typeof act === 'function') act();
    }

    function createSeparator(def) {
      const s = document.createElement('div');
      s.setAttribute('role', 'separator');
      s.style.cssText = def && def.inset
        ? 'height:1px;background:#f0f0f0;margin:5px 10px;'
        : 'height:1px;background:#efefef;margin:6px 0;';
      return s;
    }

    function createItemButton(def, nested) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      const classes = ['tb-menuitem'];
      if (def.del) classes.push('tb-menuitem-del');
      if (def.submenu) classes.push('tb-menuitem-submenu');
      b.className = classes.join(' ');
      b.title = def.enabled ? def.label : def.reason || def.label;
      b.tabIndex = -1;
      // Frame E/F row: optional leading icon, label, optional shortcut/qualifier,
      // and an optional chevron for fly-out submenus. Built with DOM nodes so a
      // label cannot inject markup.
      b.style.cssText =
        'display:flex;align-items:center;gap:' + (nested ? '8px' : '9px') + ';width:calc(100% - ' + (nested ? '8px' : '10px') + ');box-sizing:border-box;text-align:left;' +
        'padding:' + (nested ? '5px 10px' : '6px 10px') + ';margin:0 ' + (nested ? '4px' : '5px') + ';' +
        'border:0;border-radius:' + (nested ? '6px' : '7px') + ';background:transparent;color:#3a3a3a;' +
        'font:' + (nested ? '12px' : '12.5px') + '/1.35 ' + MENU_FONT + ';cursor:pointer;white-space:nowrap;';
      if (def.icon) {
        const ic = document.createElement('span');
        ic.setAttribute('aria-hidden', 'true');
        ic.style.cssText = 'display:inline-flex;width:17px;flex:none;color:#6a6a6a;';
        ic.innerHTML = def.icon; // static author-authored SVG markup, not user content
        b.appendChild(ic);
      }
      const lab = document.createElement('span');
      lab.textContent = def.label;
      b.appendChild(lab);
      if (def.qualifier) {
        const q = document.createElement('span');
        q.textContent = def.qualifier;
        q.style.cssText = 'color:#9b9b9b;';
        b.appendChild(q);
      }
      if (def.shortcut) {
        const q = document.createElement('span');
        q.textContent = def.shortcut;
        q.style.cssText = 'margin-left:auto;font-size:11px;color:#b4b4b4;font-family:' + MONO_FONT + ';';
        b.appendChild(q);
      }
      if (def.submenu) {
        const ch = document.createElement('span');
        ch.setAttribute('aria-hidden', 'true');
        ch.style.cssText = 'margin-left:auto;display:inline-flex;color:#bdbdbd;';
        ch.innerHTML = CHEVRON_RIGHT;
        b.appendChild(ch);
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
      }
      if (def.enabled) {
        b.setAttribute('aria-label', def.label);
        b._act = def.onActivate;
      } else {
        b.setAttribute('aria-disabled', 'true');
        b.setAttribute('aria-label', def.label + ', unavailable: ' + (def.reason || 'not available'));
        b.style.color = '#c2c2c2';
        b.style.cursor = 'not-allowed';
        const icon = b.children && b.children[0];
        if (icon && icon.style) icon.style.color = '#cfcfcf';
        if (def.shortcut && b.children && b.children.length) {
          const maybeShortcut = b.children[b.children.length - 1];
          if (maybeShortcut && maybeShortcut.style && !def.submenu) maybeShortcut.style.color = '#d2d2d2';
        }
      }
      b.addEventListener('mouseenter', () => {
        const k = visibleItems().indexOf(b);
        if (k >= 0) roving(k);
      });
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        activate(b);
      });
      return b;
    }

    function buildSubmenu(def, parentButton) {
      const panel = document.createElement('div');
      panel.setAttribute('role', 'menu');
      panel.setAttribute('aria-label', def.label);
      panel.className = 'tb-submenu-panel';
      panel.style.cssText =
        'position:fixed;left:0;top:0;display:none;flex-direction:column;width:' +
        (def.submenuWidth || 210) + 'px;max-height:calc(100vh - 12px);overflow:auto;background:#fff;' +
        'border:1px solid #e6e6e6;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.15);' +
        'padding:4px 0;z-index:56;';
      let first = null;
      for (const childDef of def.submenu || []) {
        if (childDef.separator === true) {
          panel.appendChild(createSeparator({ inset: true }));
          continue;
        }
        const child = createItemButton(childDef, true);
        child._parentSubmenuItem = parentButton;
        if (!first && child.getAttribute('aria-disabled') !== 'true') first = child;
        if (!first) first = child;
        panel.appendChild(child);
        items.push(child);
      }
      function setOpen(isOpen) {
        if (isOpen) {
          clearTimeout(submenuCloseTimer);
          for (const other of submenuPanels) {
            if (other === panel) continue;
            other.style.display = 'none';
            if (other._parentButton) other._parentButton.setAttribute('aria-expanded', 'false');
          }
          panel.style.display = 'flex';
          positionSubmenu(panel, parentButton, def.submenuWidth || 210);
        } else {
          panel.style.display = 'none';
        }
        parentButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
      parentButton._openSubmenu = setOpen;
      parentButton._firstSubmenuItem = first;
      panel._parentButton = parentButton;
      panel.addEventListener('keydown', handleMenuKeydown);
      panel.addEventListener('mouseenter', () => clearTimeout(submenuCloseTimer));
      panel.addEventListener('mouseleave', () => {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = setTimeout(() => setOpen(false), 120);
      });
      document.body.appendChild(panel);
      submenuPanels.push(panel);
      return panel;
    }

    function positionSubmenu(panel, parentButton, widthFallback) {
      const bounds = viewportBounds();
      const maxHeight = availableHeight(bounds);
      panel.style.maxHeight = px(maxHeight);
      const wrap = parentButton.parentElement && parentButton.parentElement.className === 'tb-submenu-wrap'
        ? parentButton.parentElement
        : parentButton;
      const wrapRect = typeof wrap.getBoundingClientRect === 'function' ? wrap.getBoundingClientRect() : null;
      const buttonRect = typeof parentButton.getBoundingClientRect === 'function' ? parentButton.getBoundingClientRect() : wrapRect;
      const parentLeft = wrapRect ? num(wrapRect.left, bounds.left) : bounds.left;
      const parentTop = buttonRect ? num(buttonRect.top, bounds.top) : bounds.top;
      const parentRight = wrapRect
        ? num(wrapRect.right, parentLeft + elementWidth(wrap, 0))
        : parentLeft + elementWidth(wrap, 0);
      const panelWidth = elementWidth(panel, widthFallback);
      const panelHeight = elementHeight(panel, maxHeight, maxHeight);
      const rightLeft = parentRight - EDGE_GAP;
      const leftLeft = parentLeft - panelWidth + EDGE_GAP;
      let left = rightLeft;
      if (rightLeft + panelWidth > bounds.right && leftLeft >= bounds.left) left = leftLeft;
      else left = clamp(left, bounds.left, bounds.right - panelWidth);
      const top = clamp(parentTop - EDGE_GAP, bounds.top, bounds.bottom - panelHeight);
      panel.style.left = px(left);
      panel.style.top = px(top);
    }

    function build(defs) {
      for (const panel of submenuPanels) panel.remove();
      submenuPanels = [];
      menu.innerHTML = '';
      items = [];
      // defs interleave non-interactive chrome (separators / section headers) with command buttons.
      // Only buttons go in `items`, so keydown/roving correctly skip the chrome; visual order stays as authored.
      for (const def of defs) {
        if (def.separator === true) {
          menu.appendChild(createSeparator(def));
          continue;
        }
        if (def.spacer) {
          const sp = document.createElement('div');
          sp.setAttribute('role', 'presentation');
          sp.style.cssText = 'padding-top:' + def.spacer + 'px;';
          menu.appendChild(sp);
          continue;
        }
        if (def.header) {
          const h = document.createElement('div');
          h.setAttribute('role', 'presentation');
          h.textContent = def.header;
          h.style.cssText =
            'padding:0 16px;margin:13px 0 5px;font-weight:600;font-size:10px;line-height:1.3;' +
            'letter-spacing:.09em;text-transform:uppercase;color:#a3a3a3;';
          menu.appendChild(h);
          continue;
        }
        if (def.submenu) {
          const wrap = document.createElement('div');
          wrap.setAttribute('role', 'none');
          wrap.className = 'tb-submenu-wrap';
          wrap.style.cssText = 'position:relative;';
          const b = createItemButton(def, false);
          items.push(b);
          const panel = buildSubmenu(def, b);
          wrap.appendChild(b);
          wrap.addEventListener('mouseenter', () => {
            clearTimeout(submenuCloseTimer);
            if (b._openSubmenu) b._openSubmenu(true);
          });
          wrap.addEventListener('mouseleave', () => {
            clearTimeout(submenuCloseTimer);
            submenuCloseTimer = setTimeout(() => b._openSubmenu && b._openSubmenu(false), 120);
          });
          menu.appendChild(wrap);
          continue;
        }
        const b = createItemButton(def, false);
        menu.appendChild(b);
        items.push(b);
      }
    }

    function openAt(defs, x, y, opts) {
      opts = opts || {};
      if (opts.ariaLabel) menu.setAttribute('aria-label', opts.ariaLabel); // per-open name (cell vs block)
      build(defs);
      if (!items.length) return;
      closeCb = opts.onClose || null;
      menu.style.width = opts.width ? opts.width + 'px' : '';
      menu.style.minWidth = opts.width ? opts.width + 'px' : '220px';
      menu.style.overflow = 'auto';
      const bounds = viewportBounds();
      const maxHeight = availableHeight(bounds);
      menu.style.maxHeight = px(maxHeight);
      menu.style.display = 'flex';
      open = true;
      if (onToggle) onToggle(true);
      // Anchor at the click point; clamp into the viewport.
      const mw = elementWidth(menu, opts.width || 220);
      const mh = elementHeight(menu, maxHeight, maxHeight);
      const left = clamp(x, bounds.left, bounds.right - mw);
      const top = clamp(y, bounds.top, bounds.bottom - mh);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      let first = visibleItems().findIndex((it) => it.getAttribute('aria-disabled') !== 'true');
      if (first < 0) first = 0;
      roving(first);
      if (opts.announce) announceNav(opts.announce);
    }

    function closeMenu(restore) {
      if (!open && menu.style.display === 'none') return;
      menu.style.display = 'none';
      clearTimeout(submenuCloseTimer);
      for (const panel of submenuPanels) panel.remove();
      submenuPanels = [];
      menu.innerHTML = '';
      items = [];
      open = false;
      if (onToggle) onToggle(false);
      const cb = closeCb;
      closeCb = null;
      if (cb) cb(!!restore); // cleanup + optional focus restore on every close
    }

    function handleMenuKeydown(e) {
      if (!open) return;
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const current = visibleItems();
        const cur = current.indexOf(document.activeElement);
        let next;
        if (e.key === 'ArrowDown') next = Math.min((cur < 0 ? -1 : cur) + 1, current.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max((cur < 0 ? current.length : cur) - 1, 0);
        else if (e.key === 'Home') next = 0;
        else next = current.length - 1;
        const it = roving(next);
        if (it) announceNav((it.getAttribute('aria-label') || it.textContent) + '.');
        return;
      }
      if (e.key === 'ArrowRight') {
        const b = document.activeElement;
        if (b && typeof b._openSubmenu === 'function') {
          e.preventDefault();
          e.stopPropagation();
          b._openSubmenu(true);
          if (b._firstSubmenuItem) {
            for (const it of items) it.tabIndex = -1;
            b._firstSubmenuItem.tabIndex = 0;
            b._firstSubmenuItem.focus();
          }
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        const b = document.activeElement;
        if (b && b._parentSubmenuItem) {
          e.preventDefault();
          e.stopPropagation();
          if (b._parentSubmenuItem._openSubmenu) b._parentSubmenuItem._openSubmenu(false);
          b._parentSubmenuItem.focus();
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        const b = document.activeElement;
        if (b && visibleItems().indexOf(b) >= 0) activate(b);
      }
    }
    menu.addEventListener('keydown', handleMenuKeydown);

    // Left-click outside the menu dismisses it (an item click stopPropagation's above).
    document.addEventListener('click', (e) => {
      if (open && !menu.contains(e.target) && !submenuPanels.some((panel) => panel.contains(e.target))) closeMenu(false);
    });

    return { openAt: openAt, close: closeMenu, isOpen: () => open, contains: (n) => menu.contains(n) || submenuPanels.some((panel) => panel.contains(n)) };
  }

  window.DitaEditorCanvasMenu = { createMenu: createMenu };
})();
