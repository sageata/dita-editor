// Review Changes layout, navigation, export, and guarded revert actions.
//
// Auto-refresh reassigns webview.html, which reloads the page and would drop the
// reading position mid-review; the scroll offset, selected layout, and pending
// post-revert focus target are stored in webview state. Expanded unchanged groups
// deliberately reset when content refreshes because group boundaries may have
// changed. Both rendered columns use the document's single scrollbar.
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
    if (!message) return;
    if (message.type === 'managedStyles') {
      // Complete marked/refused CSS is host-owned text, never HTML interpolation.
      style.textContent = typeof message.cssText === 'string' ? message.cssText : '';
      return;
    }
    if (message.type === 'revertResult') {
      const status = document.querySelector('[data-redline-status]');
      if (status) status.textContent = typeof message.message === 'string' ? message.message : '';
      if (!message.ok) saveState({ resumeChangeIndex: undefined });
    }
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
    // NEVER stamp the mode on <body>: the delegated click handler matches
    // closest('[data-redline-mode]'), and body is an ancestor of every click —
    // a body stamp swallows all nav/expand/action clicks. Nothing styles on it.
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
  function activeReviewView() {
    return all('[data-redline-view]').find(function (view) { return !view.hidden; }) || document;
  }
  function visibleChanges() {
    const view = activeReviewView();
    const query = function (selector) {
      return typeof view.querySelectorAll === 'function'
        ? Array.from(view.querySelectorAll(selector))
        : all(selector);
    };
    let changes = query('[data-redline-change]');
    if (changes.length === 0) {
      changes = query('.redline-block-ins,.redline-block-del,.redline-block-mod,.redline-block-fmt,.redline-block-moved');
    }
    return changes.filter(function (row) {
      if (row.classList && row.classList.contains('redline-block-moved-from')) return false;
      const visible = typeof row.closest !== 'function' || row.closest('[hidden]') === null;
      if (visible && typeof row.setAttribute === 'function' && !row.hasAttribute('tabindex')) {
        row.setAttribute('tabindex', '-1');
      }
      return visible;
    });
  }

  function updateNavigationState(changes, index) {
    const selected = index >= 0 && index < changes.length ? index + 1 : 0;
    all('[data-redline-position]').forEach(function (status) {
      status.textContent = 'Change ' + selected + ' of ' + changes.length;
    });
    all('[data-redline-nav]').forEach(function (button) {
      const disabled = changes.length === 0;
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
    });
  }

  function resetNavigation() {
    activeChange = -1;
    all('[data-redline-active]').forEach(function (row) {
      row.removeAttribute('data-redline-active');
      row.removeAttribute('aria-current');
    });
    updateNavigationState(visibleChanges(), activeChange);
  }

  function viewportStartIndex(changes, direction) {
    if (typeof window.innerHeight !== 'number') return direction === 'previous' ? changes.length - 1 : 0;
    const anchor = window.innerHeight / 2;
    if (direction === 'previous') {
      for (let index = changes.length - 1; index >= 0; index -= 1) {
        if (typeof changes[index].getBoundingClientRect !== 'function'
          || changes[index].getBoundingClientRect().top < anchor) return index;
      }
      return changes.length - 1;
    }
    for (let index = 0; index < changes.length; index += 1) {
      if (typeof changes[index].getBoundingClientRect !== 'function'
        || changes[index].getBoundingClientRect().top > anchor) return index;
    }
    return 0;
  }

  function markActiveChange(changes, index) {
    changes.forEach(function (row, rowIndex) {
      row.setAttribute('data-redline-active', String(rowIndex === index));
      if (rowIndex === index) row.setAttribute('aria-current', 'true');
      else if (typeof row.removeAttribute === 'function') row.removeAttribute('aria-current');
    });
    updateNavigationState(changes, index);
  }

  function navigate(direction) {
    const changes = visibleChanges();
    if (changes.length === 0) return;
    if (activeChange < 0 || activeChange >= changes.length) {
      activeChange = viewportStartIndex(changes, direction);
    } else if (direction === 'previous') {
      activeChange = activeChange <= 0 ? changes.length - 1 : activeChange - 1;
    } else {
      activeChange = activeChange >= changes.length - 1 ? 0 : activeChange + 1;
    }
    const target = changes[activeChange];
    markActiveChange(changes, activeChange);
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: 'auto' });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  resetNavigation();
  if (typeof state.resumeChangeIndex === 'number') {
    const resumeIndex = state.resumeChangeIndex;
    saveState({ resumeChangeIndex: undefined });
    const changes = visibleChanges();
    if (changes.length > 0) {
      activeChange = Math.min(Math.max(resumeIndex, 0), changes.length - 1) - 1;
      navigate('next');
    }
  }

  // Delegated controls survive every host-driven html refresh.
  document.addEventListener('click', function (ev) {
    if (!(ev.target instanceof Element)) return;
    const mode = ev.target.closest('[data-redline-mode]');
    if (mode) {
      activeChange = -1;
      applyMode(mode.getAttribute('data-redline-mode'));
      resetNavigation();
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
    if (!action) return;
    const type = action.getAttribute('data-redline-action');
    if (type === 'revertChange') {
      const token = action.getAttribute('data-redline-revert-token');
      if (!token) return;
      const row = action.closest('[data-redline-change]');
      const changes = visibleChanges();
      const rowIndex = row ? changes.indexOf(row) : -1;
      saveState({ resumeChangeIndex: rowIndex >= 0 ? rowIndex : 0 });
      vscode.postMessage({ type: type, token: token });
      return;
    }
    vscode.postMessage({ type: type });
  });
})();
