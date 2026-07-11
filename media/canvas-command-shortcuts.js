// Command-bar keyboard shortcut mapping for the DITA Editor canvas.
//
// Loaded before canvas-command-bar.js. This raw webview helper owns the shortcut
// mapping without touching DOM or VS Code API.
(function () {
  function historyShortcutOp(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    const key = (e.key || '').toLowerCase();
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (!e.shiftKey && key === 'y') return 'redo';
    if (!e.shiftKey && key === 'f') return 'find';
    return null;
  }

  function formatShortcutOp(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    const key = (e.key || '').toLowerCase();
    if (!e.shiftKey && key === 'b') return 'b';
    if (!e.shiftKey && key === 'i') return 'i';
    if (!e.shiftKey && key === 'u') return 'u';
    if (!e.shiftKey && (key === '`' || key === 'dead')) return 'codeph';
    if (!e.shiftKey && key === '=') return 'sub';
    if (e.shiftKey && (key === '=' || key === '+')) return 'sup';
    return null;
  }

  window.DitaEditorCanvasCommandShortcuts = {
    historyShortcutOp: historyShortcutOp,
    formatShortcutOp: formatShortcutOp,
  };
})();
