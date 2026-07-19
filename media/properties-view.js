// Bootstrap for the native Properties view (Secondary Side Bar). Keeps a local
// snapshot cache fed by propertiesViewState messages and renders either the
// empty state or the ported properties panel engine. Ops post the same message
// shapes the in-canvas panel used; the host routes them to the active document.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('inspector-root');
  const status = document.getElementById('inspector-status');

  const cache = {
    active: false,
    docLabel: '',
    docProps: null,
    taxonomy: null,
    structVersion: 0,
  };

  let panel = null;

  function announce(text) {
    if (status) status.textContent = text || '';
  }

  function renderEmptyState() {
    root.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'inspector-empty';
    empty.textContent = 'Open a DITA topic in the visual editor to edit its properties.';
    root.appendChild(empty);
    panel = null;
  }

  function mountPanel() {
    const engineNs = window.DitaEditorPropertiesPanel;
    if (!engineNs) {
      renderEmptyState();
      return;
    }
    root.textContent = '';
    panel = engineNs.installPropertiesPanel({
      document: document,
      window: window,
      vscode: vscode,
      container: root,
      fontFamily: 'var(--vscode-font-family, sans-serif)',
      getDocProps: () => cache.docProps,
      taxonomy: cache.taxonomy,
      getStructVersion: () => cache.structVersion,
    });
  }

  function render() {
    if (!cache.active) {
      renderEmptyState();
      return;
    }
    if (!panel) mountPanel();
    if (panel) {
      panel.setTaxonomy(cache.taxonomy);
      panel.refresh();
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'propertiesViewState') {
      const wasActive = cache.active;
      cache.active = msg.active === true;
      cache.docLabel = typeof msg.docLabel === 'string' ? msg.docLabel : '';
      cache.docProps = msg.docProps || null;
      cache.taxonomy = msg.taxonomy || null;
      cache.structVersion = typeof msg.structVersion === 'number' ? msg.structVersion : 0;
      if (wasActive !== cache.active) panel = null;
      render();
      return;
    }
    if (msg.type === 'error') {
      announce(typeof msg.message === 'string' ? msg.message : 'The request was refused.');
      return;
    }
    if (msg.type === 'focusView') {
      const focusable = root.querySelector('input, select, button, [tabindex]');
      if (focusable && typeof focusable.focus === 'function') focusable.focus();
    }
  });

  renderEmptyState();
  vscode.postMessage({ type: 'propertiesReady' });
})();
