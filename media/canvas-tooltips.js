// Fast custom tooltips for the command bar.
//
// Native title bubbles wait ~1s and cannot be tuned, so command-bar buttons
// carry dataset.tooltipOnly and an aria-label instead of a title; this module
// renders one shared tooltip that appears ~120ms after hover or roving focus,
// and instantly when moving between adjacent buttons (grace window). Timers
// and clock are injectable for the headless harness. The tooltip duplicates
// the aria-label, so it stays aria-hidden to avoid double SR announcements.
(function () {
  function createTooltipController(opts) {
    const documentObj = opts.document;
    const windowObj = opts.windowObj;
    const setTimeoutFn = opts.setTimeoutFn || windowObj.setTimeout.bind(windowObj);
    const clearTimeoutFn = opts.clearTimeoutFn || windowObj.clearTimeout.bind(windowObj);
    const now = opts.now || (() => Date.now());
    const showDelayMs = typeof opts.showDelayMs === 'number' ? opts.showDelayMs : 120;
    const graceMs = typeof opts.graceMs === 'number' ? opts.graceMs : 300;

    let tip = null;
    let pendingTimer = null;
    let currentBtn = null;
    let visible = false;
    let hiddenAt = -Infinity;

    function ensureTip() {
      if (tip) return tip;
      tip = documentObj.createElement('div');
      tip.className = 'cmd-tooltip';
      tip.setAttribute('aria-hidden', 'true');
      tip.style.cssText =
        'position:fixed;z-index:85;display:none;pointer-events:none;background:#2b2b2b;color:#fff;' +
        'font:600 11px/1.4 system-ui, -apple-system, sans-serif;padding:4px 8px;border-radius:5px;' +
        'max-width:260px;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
      documentObj.body.appendChild(tip);
      return tip;
    }

    function buttonFrom(node, container) {
      let el = node;
      while (el && el !== container) {
        if (
          String(el.tagName).toLowerCase() === 'button'
          && el.dataset && el.dataset.action
          && el.dataset.tooltipOnly === '1'
        ) return el;
        el = el.parentElement;
      }
      return null;
    }

    function cancelPending() {
      if (pendingTimer != null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
    }

    function hide() {
      cancelPending();
      if (visible) {
        visible = false;
        hiddenAt = now();
        if (tip) tip.style.display = 'none';
      }
      currentBtn = null;
    }

    function showNow() {
      pendingTimer = null;
      if (!currentBtn) return;
      const text = currentBtn.getAttribute('aria-label') || currentBtn.dataset.action || '';
      if (!text) {
        hide();
        return;
      }
      const el = ensureTip();
      el.textContent = text;
      el.style.display = 'block';
      visible = true;
      const rect = typeof currentBtn.getBoundingClientRect === 'function'
        ? currentBtn.getBoundingClientRect()
        : null;
      if (!rect) return;
      const tipRect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const tipWidth = (tipRect && tipRect.width) || 0;
      const viewport = windowObj.innerWidth || 0;
      let left = (rect.left || 0) + ((rect.width || 0) - tipWidth) / 2;
      if (viewport > 0) left = Math.min(left, viewport - tipWidth - 8);
      left = Math.max(8, left);
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round((rect.bottom || 0) + 6) + 'px';
    }

    function maybeShow(btn) {
      if (!btn) return;
      if (btn === currentBtn && (visible || pendingTimer != null)) return;
      cancelPending();
      const wasVisible = visible;
      if (visible && tip) {
        visible = false;
        hiddenAt = now();
        tip.style.display = 'none';
      }
      currentBtn = btn;
      if (wasVisible || now() - hiddenAt <= graceMs) showNow();
      else pendingTimer = setTimeoutFn(showNow, showDelayMs);
    }

    function attach(container) {
      container.addEventListener('pointerover', (event) => {
        maybeShow(buttonFrom(event.target, container));
      });
      container.addEventListener('pointerout', (event) => {
        const from = buttonFrom(event.target, container);
        if (!from || from !== currentBtn) return;
        if (buttonFrom(event.relatedTarget, container) === from) return;
        hide();
      });
      container.addEventListener('focusin', (event) => {
        maybeShow(buttonFrom(event.target, container));
      });
      container.addEventListener('focusout', (event) => {
        const from = buttonFrom(event.target, container);
        if (from && from === currentBtn) hide();
      });
      container.addEventListener('pointerdown', () => hide());
    }

    // No stopPropagation: Escape must still close menus and the overflow popover.
    documentObj.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hide();
    });

    return { attach: attach, hide: hide };
  }

  window.DitaEditorCanvasTooltips = {
    createTooltipController: createTooltipController,
  };
})();
