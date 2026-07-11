// Spellcheck toggle for the DITA Editor canvas.
//
// Loaded before canvas.js. The renderer ships every editable leaf with
// spellcheck="false" (deliberate default); this render-only module lets the
// author opt in per machine. It flips the DOM attribute only — zero document
// bytes — and re-asserts the preference after every host rerender.
(function () {
  const STORAGE_KEY = 'ditaeditor.visual.spellcheck';

  function installSpellcheckToggle(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const announceNav = opts.announceNav || function () {};

    function storedEnabled() {
      try {
        return !!(windowObj.localStorage && windowObj.localStorage.getItem(STORAGE_KEY) === 'true');
      } catch {
        return false;
      }
    }

    function storeEnabled(on) {
      try {
        if (!windowObj.localStorage) return;
        if (on) windowObj.localStorage.setItem(STORAGE_KEY, 'true');
        else windowObj.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage is best-effort in VS Code webviews.
      }
    }

    let enabled = storedEnabled();

    function apply(root) {
      const scope = root || document.querySelector('main');
      if (!scope || !scope.querySelectorAll) return;
      const value = enabled ? 'true' : 'false';
      for (const el of scope.querySelectorAll('[contenteditable]')) {
        el.setAttribute('spellcheck', value);
      }
    }

    function toggle() {
      enabled = !enabled;
      storeEnabled(enabled);
      apply();
      announceNav('Spellcheck ' + (enabled ? 'on' : 'off') + '.');
      return enabled;
    }

    apply();

    return {
      toggle: toggle,
      enabled: () => enabled,
      apply: apply,
    };
  }

  window.DitaEditorCanvasSpellcheck = { installSpellcheckToggle: installSpellcheckToggle };
})();
