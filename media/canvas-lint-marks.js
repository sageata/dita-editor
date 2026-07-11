// Inline lint marks for the DITA Editor canvas (UX-7).
//
// Loaded before canvas.js. Paints the host-pushed dita-quality findings
// ({type:'lint', items:[{id, code, message}]}) as in-place markers on the
// elements they belong to. Render-only: a dotted underline + hover message;
// zero document bytes; no acquireVsCodeApi().
(function () {
  function installLintMarks(opts) {
    const document = opts.document;

    let marked = [];

    function clear() {
      for (const el of marked) {
        el.classList.remove('dc-lint');
        if (el.getAttribute('data-dc-lint') != null) {
          if (el.getAttribute('title') === el.getAttribute('data-dc-lint')) el.removeAttribute('title');
          el.removeAttribute('data-dc-lint');
        }
      }
      marked = [];
    }

    function idSelector(id) {
      const value = String(id);
      const esc = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape(value)
        : value.replace(/"/g, '\\"');
      return '[data-struct-id="' + esc + '"],[data-cell-id="' + esc + '"]';
    }

    function apply(items) {
      clear();
      if (!Array.isArray(items) || !items.length) return;
      const main = document.querySelector('main');
      if (!main) return;
      const byId = new Map();
      for (const item of items) {
        if (!item || item.id == null || !item.message) continue;
        const list = byId.get(item.id) || [];
        list.push(item.message);
        byId.set(item.id, list);
      }
      for (const [id, messages] of byId) {
        const el = main.querySelector(idSelector(id));
        if (!el) continue;
        const message = messages.join(' · ');
        el.classList.add('dc-lint');
        el.setAttribute('data-dc-lint', message);
        if (!el.getAttribute('title')) el.setAttribute('title', message);
        marked.push(el);
      }
    }

    return {
      apply: apply,
      clear: clear,
      count: () => marked.length,
    };
  }

  window.DitaEditorCanvasLintMarks = { installLintMarks: installLintMarks };
})();
