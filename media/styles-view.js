// Bootstrap for the native Styles view (Secondary Side Bar). Keeps a local
// snapshot cache fed by stylesViewState/styleTargetState data and renders
// either the empty state or the ported styles panel engine. The engine's save
// controller persists through THIS webview's getState, so in-flight saves
// survive view hide/show. Ops post the same message shapes the in-canvas
// panel used; the host routes them to the active document.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('inspector-root');
  const status = document.getElementById('inspector-status');

  const cache = {
    active: false,
    docLabel: '',
    styleState: null,
    targetState: null,
  };

  let panel = null;

  // Hover preview popup (styles-preview-popup.js loads before this script).
  // Built once — the singleton popup host lives on document.body, outside the
  // panel the engine rebuilds. Guarded so the view still works without it.
  const popupNs = window.DitaEditorStylesPreviewPopup;
  const previewPopup = popupNs && typeof popupNs.installPreviewPopup === 'function'
    ? popupNs.installPreviewPopup({
      document: document,
      window: window,
      getCssText: () => (cache.styleState && cache.styleState.cssText) || '',
    })
    : null;

  function createSaveRequestSessionId() {
    const globalCrypto = typeof crypto !== 'undefined' ? crypto : null;
    if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID();
    let out = '';
    for (let i = 0; i < 8; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return 'session-' + out + '-' + String(Date.now());
  }
  const saveRequestSessionId = createSaveRequestSessionId();

  function announce(text) {
    if (status) status.textContent = text || '';
  }

  function renderEmptyState() {
    root.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'inspector-empty';
    empty.textContent = 'Open a DITA topic in the visual editor to edit styles.';
    root.appendChild(empty);
    panel = null;
  }

  function mountPanel() {
    const engineNs = window.DitaEditorStylesPanel;
    if (!engineNs) {
      renderEmptyState();
      return;
    }
    root.textContent = '';
    panel = engineNs.installStylesPanel({
      document: document,
      window: window,
      vscode: vscode,
      container: root,
      fontFamily: 'var(--vscode-font-family, sans-serif)',
      saveRequestSessionId: saveRequestSessionId,
      getStyleState: () => cache.styleState,
      getCurrentTarget: () => (cache.targetState ? cache.targetState.target : null),
      getStructVersion: () => (cache.targetState ? cache.targetState.structVersion : 0),
      getInspectorState: () => cache.targetState,
      announceNav: announce,
      previewPopup: previewPopup,
    });
  }

  function render(force) {
    if (!cache.active) {
      renderEmptyState();
      return;
    }
    if (!panel) mountPanel();
    if (panel) panel.refresh(force === true);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'stylesViewState') {
      const wasLabel = cache.docLabel;
      cache.active = msg.active === true;
      cache.docLabel = typeof msg.docLabel === 'string' ? msg.docLabel : '';
      cache.styleState = msg.styleState || null;
      cache.targetState = msg.targetState || null;
      // A document switch is authoritative: force so a focused panel rebuilds.
      render(cache.docLabel !== wasLabel);
      return;
    }
    if (msg.type === 'styleSaveResult') {
      if (panel) panel.acceptSaveResult(msg);
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
  vscode.postMessage({ type: 'stylesReady' });
})();
