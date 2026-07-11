// Geometry bridge for the DITA Editor canvas overlays.
//
// Loaded FIRST. CSS `zoom` coordinate semantics differ by engine: standardized
// zoom (current desktop Chromium) reports getBoundingClientRect of elements
// inside the zoomed <main> in page-visual px, while legacy engines (VS Code's
// Electron webview, which runs without the StandardizedBrowserZoom feature)
// report them in zoomed-local px, where visual = reported × zoom. Within each
// engine, events, elementFromPoint and gBCR stay mutually coherent, so overlay
// LOGIC can keep comparing raw values — but body-level fixed overlays paint in
// page-visual px, so every style write derived from an in-main rect must
// convert through visualRect()/visualPointIn(). Detection is empirical (main's
// gBCR width vs its layout offsetWidth), never engine-sniffed.
(function () {
  function zoomOf(main) {
    const z = parseFloat((main.style && main.style.zoom) || '1');
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  // 1 when gBCR already returns page-visual px (standardized zoom, or zoom=1);
  // the zoom level when the engine returns zoomed-local px (legacy).
  function gbcrScale(doc) {
    const main = doc.querySelector('main');
    if (!main) return 1;
    const zoom = zoomOf(main);
    if (zoom === 1) return 1;
    if (!main.offsetWidth || typeof main.getBoundingClientRect !== 'function') return 1;
    const rect = main.getBoundingClientRect();
    if (!rect || !rect.width) return 1;
    const ratio = rect.width / main.offsetWidth;
    return Math.abs(ratio - zoom) <= Math.abs(ratio - 1) ? 1 : zoom;
  }

  // Rect of an element in page-visual (fixed-overlay) coordinates under both
  // engines. Elements outside the zoomed <main> pass through unchanged.
  function visualRect(el, doc) {
    const d = doc || el.ownerDocument;
    const r = el.getBoundingClientRect();
    const main = d ? d.querySelector('main') : null;
    if (!main || !main.contains(el)) return r;
    const s = gbcrScale(d);
    if (s === 1) return r;
    return {
      left: r.left * s,
      top: r.top * s,
      right: r.right * s,
      bottom: r.bottom * s,
      width: r.width * s,
      height: r.height * s,
    };
  }

  // Map a point that is coherent with el's RAW rect (pointer-event coords on
  // el) into page-visual space by preserving its fractional position inside
  // el. Space-free: correct whichever space the event engine reports in, as
  // long as events and raw rects agree with each other (they do — proven per
  // engine via elementFromPoint).
  function visualPointIn(el, x, y, doc) {
    const raw = el.getBoundingClientRect();
    const vis = visualRect(el, doc);
    if (vis === raw) return { x: x, y: y };
    return {
      x: raw.width ? vis.left + ((x - raw.left) / raw.width) * vis.width : vis.left + (x - raw.left),
      y: raw.height ? vis.top + ((y - raw.top) / raw.height) * vis.height : vis.top + (y - raw.top),
    };
  }

  window.DitaEditorCanvasGeom = { gbcrScale: gbcrScale, visualRect: visualRect, visualPointIn: visualPointIn };
})();
