// Hover preview popup for the Styles view: a floating window that renders the
// hovered style on a small sample document together with the FULL managed
// stylesheet, so the preview shows real text composed with the current other
// styles — not just a restyled row name.
//
// Same split as canvas-command-bar-overflow.js: pure builders
// (buildStylePreviewHtml, computePreviewPlacement) plus a DOM manager
// (installPreviewPopup) with injected document/window. The manager takes no
// vscode handle at all, so the preview affordance structurally cannot post
// apply/clear/save messages.
//
// Isolation: the sample mounts inside a Shadow DOM when available so the
// managed CSS cannot restyle the view chrome (and view CSS cannot leak in).
// The fake-DOM test harness has no attachShadow; the manager falls back to
// plain innerHTML there — isolation itself is verified live in the dev host.
(() => {
  'use strict';

  const OPEN_DELAY_MS = 250;
  const CLOSE_GRACE_MS = 150;

  // Renderer-contract sample markup per style kind, mirroring the canvas
  // bridge's PROBE_MARKUP contract (media/canvas-style-bridge.js — the view
  // cannot import the bridge). Classes mirror src/render/to-html.ts exactly;
  // EVERY title renders as h1.title.topictitle1, sections included. Samples
  // sit inside a `.body` wrapper because managed selectors are emitted as
  // `.body p.p.p`, `table.table.table`, … The `cls` argument is '' or
  // ' <presetClassName>' appended to the target element's class attribute.
  const IMAGE_DATA_URI = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="40">'
    + '<rect width="72" height="40" fill="#e5e7eb"/></svg>');
  // Four body rows make row/cell presets readable against unstyled neighbours
  // and let zebra striping show on rows 2 and 4.
  const TABLE_SAMPLE = (opts) => {
    const t = opts.table || '';
    const r = opts.row || '';
    const c = opts.cell || '';
    const h = opts.head || '';
    const b = opts.body || '';
    return '<table class="table' + t + '">' + (opts.prefix || '')
      + '<thead class="thead"><tr class="row"><th class="entry' + h + '">Part</th>'
      + '<th class="entry' + h + '">Torque</th></tr></thead>'
      + '<tbody class="tbody">'
      + '<tr class="row"><td class="entry' + c + b + '">Intake flange</td><td class="entry' + b + '">24 Nm</td></tr>'
      + '<tr class="row' + r + '"><td class="entry' + b + '">Outlet flange</td><td class="entry' + b + '">22 Nm</td></tr>'
      + '<tr class="row"><td class="entry' + c + b + '">Drain plug</td><td class="entry' + b + '">18 Nm</td></tr>'
      + '<tr class="row"><td class="entry' + b + '">Housing bolts</td><td class="entry' + b + '">30 Nm</td></tr>'
      + '</tbody></table>';
  };
  const PREVIEW_SAMPLES = {
    all: (cls) => '<p class="p' + cls + '">High-pressure fittings must be torqued to spec.</p>',
    title: (cls) => '<h1 class="title topictitle1' + cls + '">Installing the pump</h1>',
    heading: (cls) => '<section class="section"><h1 class="title topictitle1' + cls + '">Before you begin</h1></section>',
    body: (cls) => '<p class="p' + cls + '">High-pressure fittings must be torqued to spec.</p>',
    shortdesc: (cls) => '<p class="shortdesc' + cls + '">A quick overview of the pump installation.</p>',
    section: (cls) => '<section class="section' + cls + '"><p class="p">Sections group related steps.</p></section>',
    list: (cls) => '<ul class="ul' + cls + '"><li class="li">Close the intake valve</li><li class="li">Drain the housing</li></ul>',
    listItem: (cls) => '<ul class="ul"><li class="li' + cls + '">Close the intake valve</li><li class="li">Drain the housing</li></ul>',
    table: (cls) => TABLE_SAMPLE({ table: cls }),
    tableRow: (cls) => TABLE_SAMPLE({ row: cls }),
    tableCell: (cls) => TABLE_SAMPLE({ cell: cls }),
    tableHeadCell: (cls) => TABLE_SAMPLE({ head: cls }),
    tableBodyCell: (cls) => TABLE_SAMPLE({ body: cls }),
    figure: (cls) => '<figure class="fig' + cls + '"><p class="p">Bracket alignment, front view.</p></figure>',
    image: (cls) => '<figure class="fig"><img class="image' + cls + '" alt="Sample image" src="' + IMAGE_DATA_URI + '"></figure>',
    note: (cls) => '<div class="note' + cls + '">Wear eye protection when venting the line.</div>',
    code: (cls) => '<p class="p">Run <code class="ph codeph' + cls + '">pumpctl --check</code> before starting.</p>',
    lines: (cls) => '<pre class="lines' + cls + '">Model: XR-90\nSerial: 04-1188</pre>',
    // Page previews show the plain sample document because their selectors target
    // the live canvas shell, which a detached fragment cannot reproduce.
    page: () => '',
  };

  // Fixed light "paper" backdrop: authored colors target the always-light
  // canvas, so the sample must never sit on a dark theme background.
  const PAPER_CSS =
    ':host{all:initial;display:block;}'
    + '.dc-style-preview-paper{background:#ffffff;color:#1f2937;padding:12px 14px;border-radius:4px;'
    + 'font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;'
    + 'overflow:hidden;}'
    + '.dc-style-preview-paper .body{margin:0;}';

  function buildStylePreviewHtml(kind, presetClassName, cssText) {
    const safeClass = typeof presetClassName === 'string' && /^[A-Za-z0-9_-]+$/.test(presetClassName)
      ? presetClassName
      : '';
    const cls = safeClass ? ' ' + safeClass : '';
    const sample = PREVIEW_SAMPLES[kind] || PREVIEW_SAMPLES.all;
    // Context frames the target with the document's current other styles: a
    // title-kind preview leads the sample, everything else follows the
    // default title + default paragraph.
    const parts = [];
    if (kind === 'title' || kind === 'heading') {
      parts.push(sample(cls), PREVIEW_SAMPLES.body(''));
    } else {
      parts.push(PREVIEW_SAMPLES.title(''), PREVIEW_SAMPLES.body(''), sample(cls));
    }
    // The managed CSS is our own serializer's output, but never allow a
    // stray sequence to terminate the style element early.
    const safeCss = String(cssText || '').replace(/<\/style/gi, '<\\/style');
    return '<style>' + PAPER_CSS + '\n' + safeCss + '</style>'
      + '<div class="dc-style-preview-paper"><div class="body">'
      + parts.join('')
      + '</div></div>';
  }

  // Pure vertical placement: below the anchor, flip above when it would
  // overflow, clamp as a last resort. Degrades to "below" when the viewport
  // height is unknown (the fake DOM has no innerHeight). Horizontal placement
  // is CSS-only (fixed left/right insets in styles-view.css).
  function computePreviewPlacement(input) {
    const margin = typeof input.margin === 'number' ? input.margin : 8;
    const below = input.anchorBottom + 4;
    if (!(input.viewportHeight > 0)) return { top: below, placement: 'below' };
    if (below + input.popupHeight + margin <= input.viewportHeight) {
      return { top: below, placement: 'below' };
    }
    const above = input.anchorTop - 4 - input.popupHeight;
    if (above >= margin) return { top: above, placement: 'above' };
    return {
      top: Math.max(margin, input.viewportHeight - input.popupHeight - margin),
      placement: 'clamped',
    };
  }

  function installPreviewPopup(options) {
    const document = options.document;
    const windowObj = options.window;
    const getCssText = options.getCssText || (() => '');
    const timers = windowObj && typeof windowObj.setTimeout === 'function' ? windowObj : null;
    let host = null;
    let openTimer = null;
    let closeTimer = null;
    let open = false;

    function clearTimer(id) {
      if (id != null && timers) timers.clearTimeout(id);
    }

    function ensureHost() {
      if (host) return host;
      host = document.createElement('div');
      host.className = 'style-preview-popup';
      if (host.classList && typeof host.classList.add === 'function') {
        host.classList.add('style-preview-popup');
      }
      host.setAttribute('role', 'tooltip');
      host.setAttribute('aria-hidden', 'true');
      host.style.display = 'none';
      // Body-mounted: the panel wipes its own innerHTML on every rebuild.
      document.body.appendChild(host);
      // Moving the pointer from the eye onto the popup keeps it open.
      host.addEventListener('mouseenter', () => {
        clearTimer(closeTimer);
        closeTimer = null;
      });
      host.addEventListener('mouseleave', () => scheduleClose());
      return host;
    }

    function openNow(anchor, kind, presetClassName, styleName) {
      const el = ensureHost();
      const html = buildStylePreviewHtml(kind, presetClassName, getCssText());
      let mount = el;
      if (typeof el.attachShadow === 'function') {
        mount = el.shadowRoot || el.attachShadow({ mode: 'open' });
      }
      mount.innerHTML = html;
      el.setAttribute('aria-label', 'Preview of ' + styleName);
      el.setAttribute('aria-hidden', 'false');
      el.style.display = 'block';
      open = true;
      const rect = anchor && typeof anchor.getBoundingClientRect === 'function'
        ? anchor.getBoundingClientRect()
        : { top: 0, bottom: 0 };
      const placed = computePreviewPlacement({
        anchorTop: rect.top || 0,
        anchorBottom: rect.bottom || 0,
        viewportHeight: (windowObj && windowObj.innerHeight) || 0,
        popupHeight: el.offsetHeight || 0,
      });
      el.style.top = placed.top + 'px';
    }

    function scheduleOpen(anchor, kind, presetClassName, styleName) {
      clearTimer(closeTimer);
      closeTimer = null;
      clearTimer(openTimer);
      openTimer = null;
      // Already open: retarget instantly so running the pointer down the eye
      // column flips previews without re-paying the hover delay.
      if (!timers || open) {
        openNow(anchor, kind, presetClassName, styleName);
        return;
      }
      openTimer = timers.setTimeout(() => {
        openTimer = null;
        openNow(anchor, kind, presetClassName, styleName);
      }, OPEN_DELAY_MS);
    }

    function scheduleClose() {
      clearTimer(openTimer);
      openTimer = null;
      if (!open) return;
      if (!timers) {
        closeNow();
        return;
      }
      clearTimer(closeTimer);
      closeTimer = timers.setTimeout(() => {
        closeTimer = null;
        closeNow();
      }, CLOSE_GRACE_MS);
    }

    function closeNow() {
      clearTimer(openTimer);
      openTimer = null;
      clearTimer(closeTimer);
      closeTimer = null;
      if (!host || !open) return;
      open = false;
      host.setAttribute('aria-hidden', 'true');
      host.style.display = 'none';
    }

    document.addEventListener('keydown', (event) => {
      if (event && event.key === 'Escape' && open) closeNow();
    });

    return {
      scheduleOpen,
      scheduleClose,
      closeNow,
      isOpen: () => open,
    };
  }

  window.DitaEditorStylesPreviewPopup = {
    buildStylePreviewHtml,
    computePreviewPlacement,
    installPreviewPopup,
  };
})();
