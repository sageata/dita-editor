// Scroll persistence + banner actions for the Review Changes (redline) panel.
//
// The ONLY script this webview loads. Auto-refresh reassigns webview.html,
// which reloads the page and would drop the reading position mid-review; the
// scroll offset is stashed in the webview state on every scroll (rAF-throttled)
// and restored on load. The single message this surface posts is the banner's
// data-redline-action click (e.g. "openSourceDiff" -> the host opens the
// native side-by-side git diff). Never touches document bytes.
(function () {
  const vscode = acquireVsCodeApi();

  const s = vscode.getState();
  if (s && typeof s.y === 'number') window.scrollTo(0, s.y);

  const style = document.getElementById('ditaeditor-author-styles-live');
  if (!style) throw new Error('DITA Editor managed stylesheet slot is missing');
  const managedStyleData = document.getElementById('ditaeditor-managed-style-data');
  if (!managedStyleData) throw new Error('DITA Editor managed stylesheet data is missing');
  const embeddedManagedStyle = JSON.parse(managedStyleData.textContent || '{}');
  if (embeddedManagedStyle.consumer !== 'redline' || typeof embeddedManagedStyle.cssText !== 'string') {
    throw new Error('DITA Editor managed stylesheet data does not target redline');
  }
  style.textContent = embeddedManagedStyle.cssText;

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || message.type !== 'managedStyles') return;
    // Complete marked/refused CSS is host-owned text, never HTML interpolation.
    style.textContent = typeof message.cssText === 'string' ? message.cssText : '';
  });
  vscode.postMessage({ type: 'redlineReady' });

  let pending = false;
  window.addEventListener(
    'scroll',
    function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        vscode.setState({ y: window.scrollY });
      });
    },
    { passive: true },
  );

  // Banner buttons (delegated: the banner is re-created on every refresh).
  document.addEventListener('click', function (ev) {
    const el = ev.target instanceof Element ? ev.target.closest('[data-redline-action]') : null;
    if (!el) return;
    vscode.postMessage({ type: el.getAttribute('data-redline-action') });
  });
})();
