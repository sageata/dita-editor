// Persisted layout + navigation for the read-only Review Changes panel.
//
// The ONLY script this webview loads. Auto-refresh reassigns webview.html,
// which reloads the page and would drop the reading position mid-review; the
// scroll offset and selected layout are stored in webview state. Expanded
// unchanged groups deliberately reset when content refreshes because group
// boundaries may have changed. Both rendered columns use the document's single scrollbar;
// this script never attempts to synchronize independent scroll containers.
// The only host message remains openSourceDiff. Never touches document bytes.
(function () {
  const vscode = acquireVsCodeApi();

  let state = vscode.getState() || {};
  if (Object.prototype.hasOwnProperty.call(state, 'expandedGroups')) {
    const cleaned = Object.assign({}, state);
    delete cleaned.expandedGroups;
    state = cleaned;
  }
  function saveState(patch) {
    state = Object.assign({}, state, patch);
    vscode.setState(state);
  }

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

  function all(selector) {
    return typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll(selector))
      : [];
  }

  function applyMode(requested) {
    const mode = requested === 'side-by-side' ? 'side-by-side' : 'inline';
    all('[data-redline-view]').forEach(function (view) {
      view.hidden = view.getAttribute('data-redline-view') !== mode;
    });
    all('[data-redline-mode]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-redline-mode') === mode));
    });
    all('[data-redline-side-only]').forEach(function (control) {
      control.hidden = mode !== 'side-by-side';
    });
    if (document.body && typeof document.body.setAttribute === 'function') {
      document.body.setAttribute('data-redline-mode', mode);
    }
    saveState({ mode: mode });
  }

  function setGroupExpanded(id, expanded) {
    all('[data-redline-unchanged-rows]').forEach(function (rows) {
      if (rows.getAttribute('data-redline-unchanged-rows') === id) rows.hidden = !expanded;
    });
    all('[data-redline-expand]').forEach(function (button) {
      if (button.getAttribute('data-redline-expand') === id) {
        button.setAttribute('aria-expanded', String(expanded));
      }
    });
  }

  applyMode(state.mode);
  if (typeof state.y === 'number') {
    requestAnimationFrame(function () { window.scrollTo(0, state.y); });
  }

  let pending = false;
  window.addEventListener(
    'scroll',
    function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        saveState({ y: window.scrollY });
      });
    },
    { passive: true },
  );

  let activeChange = -1;
  function visibleChanges() {
    return all('[data-redline-change]').filter(function (row) {
      return typeof row.closest !== 'function' || row.closest('[hidden]') === null;
    });
  }

  function navigate(direction) {
    const changes = visibleChanges();
    if (changes.length === 0) return;
    if (direction === 'previous') {
      activeChange = activeChange <= 0 ? changes.length - 1 : activeChange - 1;
    } else {
      activeChange = activeChange >= changes.length - 1 ? 0 : activeChange + 1;
    }
    const target = changes[activeChange];
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  // Delegated controls survive every host-driven html refresh.
  document.addEventListener('click', function (ev) {
    if (!(ev.target instanceof Element)) return;
    const mode = ev.target.closest('[data-redline-mode]');
    if (mode) {
      activeChange = -1;
      applyMode(mode.getAttribute('data-redline-mode'));
      return;
    }
    const expand = ev.target.closest('[data-redline-expand]');
    if (expand) {
      const id = expand.getAttribute('data-redline-expand');
      if (id) setGroupExpanded(id, expand.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const nav = ev.target.closest('[data-redline-nav]');
    if (nav) {
      navigate(nav.getAttribute('data-redline-nav'));
      return;
    }
    const action = ev.target.closest('[data-redline-action]');
    if (action) vscode.postMessage({ type: action.getAttribute('data-redline-action') });
  });
})();
