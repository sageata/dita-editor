// Canvas zoom for the DITA Editor canvas.
//
// Loaded before canvas.js. Render-only view scaling: applies CSS `zoom` to the
// <main> content root and persists the level. It never touches document bytes
// and does not call acquireVsCodeApi(). `zoom` (not transform:scale) is used so
// layout and getBoundingClientRect stay consistent for the body-level overlays
// (table resize handles, image bar, menus).
(function () {
  const LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
  const STORAGE_KEY = 'ditaeditor.visual.zoomLevel';
  // The fixed command bar overlays the top of <main>; this is the CSS-px top
  // clearance the command bar UI assigns (canvas-command-bar-ui.js).
  const BASE_TOP_PAD = 72;

  function installCanvasZoom(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const announceNav = opts.announceNav || function () {};
    const onChange = opts.onChange || function () {};

    function storedLevel() {
      try {
        if (!windowObj.localStorage) return 1;
        const v = Number.parseFloat(windowObj.localStorage.getItem(STORAGE_KEY) || '');
        if (LEVELS.indexOf(v) >= 0) return v;
      } catch {
        // Storage is best-effort in VS Code webviews.
      }
      return 1;
    }

    function storeLevel(level) {
      try {
        if (!windowObj.localStorage) return;
        if (level === 1) windowObj.localStorage.removeItem(STORAGE_KEY);
        else windowObj.localStorage.setItem(STORAGE_KEY, String(level));
      } catch {
        // Storage is best-effort in VS Code webviews.
      }
    }

    let level = storedLevel();

    function label() {
      return Math.round(level * 100) + '%';
    }

    function apply() {
      const main = document.querySelector('main');
      if (!main) return;
      main.style.zoom = level === 1 ? '' : String(level);
      // The command-bar clearance is padding INSIDE the zoomed root, so
      // counter-scale it to stay visually constant under the fixed bar.
      const pad = Math.round(BASE_TOP_PAD / level);
      main.style.paddingTop = pad + 'px';
    }

    function setLevel(next) {
      if (LEVELS.indexOf(next) < 0 || next === level) return;
      level = next;
      storeLevel(level);
      apply();
      announceNav('Zoom ' + label() + '.');
      onChange(level);
    }

    function increase() {
      setLevel(LEVELS[Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1)]);
    }

    function decrease() {
      setLevel(LEVELS[Math.max(LEVELS.indexOf(level) - 1, 0)]);
    }

    function reset() {
      setLevel(1);
    }

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      const key = e.key;
      if (key === '=' || key === '+') {
        e.preventDefault();
        increase();
      } else if (key === '-' || key === '_') {
        e.preventDefault();
        decrease();
      } else if (key === '0') {
        e.preventDefault();
        reset();
      }
    });

    apply();

    return {
      increase: increase,
      decrease: decrease,
      reset: reset,
      label: label,
      level: () => level,
      apply: apply,
    };
  }

  window.DitaEditorCanvasZoom = { installCanvasZoom: installCanvasZoom };
})();
