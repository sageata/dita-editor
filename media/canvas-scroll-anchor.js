// Reports the addressable DITA element nearest the top of the viewport and restores
// a host-provided element without changing focus or selection.
(function (root) {
  'use strict';

  function elementId(element) {
    return element.getAttribute('data-cell-id') || element.getAttribute('data-struct-id');
  }

  function create(options) {
    const windowObj = options.window;
    const documentObj = options.document;
    const postMessage = options.postMessage;
    let frame = 0;
    let started = false;

    function elements() {
      const main = documentObj.querySelector('main');
      return main ? Array.prototype.slice.call(main.querySelectorAll('[data-cell-id],[data-struct-id]')) : [];
    }

    function nearestElement() {
      let nearest = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      const candidates = elements();
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (!elementId(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom <= 0) continue;
        const distance = Math.abs(rect.top);
        if (
          distance < nearestDistance ||
          (distance === nearestDistance && nearest && nearest.contains(candidate))
        ) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }
      return nearest;
    }

    function reportNow() {
      frame = 0;
      const nearest = nearestElement();
      const id = nearest && elementId(nearest);
      if (id) postMessage({ type: 'scrollAnchor', id: id });
    }

    function scheduleReport() {
      if (frame) return;
      frame = windowObj.requestAnimationFrame(reportNow);
    }

    function start() {
      if (!started) {
        started = true;
        windowObj.addEventListener('scroll', scheduleReport, { passive: true });
      }
      scheduleReport();
    }

    function restore(id, block) {
      const candidates = elements();
      for (let index = 0; index < candidates.length; index++) {
        if (elementId(candidates[index]) !== id) continue;
        // 'start' preserves viewport-top semantics for the editor toggle;
        // 'center' keeps search landings clear of the fixed command bar.
        candidates[index].scrollIntoView({ block: block === 'center' ? 'center' : 'start' });
        return true;
      }
      return false;
    }

    return {
      start: start,
      didRerender: scheduleReport,
      restore: restore,
    };
  }

  root.DitaEditorCanvasScrollAnchor = { create: create };
})(window);
