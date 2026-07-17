// Shared control primitives for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns generic browser-side button,
// separator, roving-index, and availability presentation behavior. It does not
// call the VS Code webview API and does not know about DITA state or host messages.
(function () {
  function nextRovingIndex(visibleCount, currentIdx, key) {
    if (visibleCount <= 0) return -1;
    const last = visibleCount - 1;
    const cur = Math.max(0, Math.min(currentIdx, last));
    if (key === 'ArrowRight') return cur >= last ? 0 : cur + 1;
    if (key === 'ArrowLeft') return cur <= 0 ? last : cur - 1;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return cur;
  }

  function makeBtn(label, title) {
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.action = title;
    b.tabIndex = -1;
    b.style.cssText =
      'min-width:20px;height:20px;line-height:18px;padding:0 3px;border:1px solid #999;' +
      'border-radius:4px;background:#fff;color:#222;font-size:13px;';
    return b;
  }

  function isUnavailable(btn) {
    return !!btn && btn.getAttribute('aria-disabled') === 'true';
  }

  function setBtnEnabled(btn, ok, title) {
    const action = btn.dataset.action || title;
    if (ok) {
      btn.removeAttribute('aria-disabled');
      btn.style.opacity = '';
      btn.style.cursor = '';
    } else {
      btn.setAttribute('aria-disabled', 'true');
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
    }
    btn.title = ok || title === action ? title : action + '. Unavailable: ' + title;
    btn.setAttribute('aria-label', btn.title);
  }

  function makeSep() {
    const s = document.createElement('span');
    s.style.cssText = 'align-self:stretch;width:1px;background:#ccc;margin:1px;';
    return s;
  }

  window.DitaEditorCanvasControls = {
    nextRovingIndex: nextRovingIndex,
    makeBtn: makeBtn,
    isUnavailable: isUnavailable,
    setBtnEnabled: setBtnEnabled,
    makeSep: makeSep,
  };
})();
