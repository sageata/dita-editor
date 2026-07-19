// Canvas-side bridge for the native Styles view.
//
// Loaded before canvas.js. The Styles panel engine itself runs inside the
// Styles webview view (media/styles-panel.js); this module keeps the
// canvas-resident responsibilities: painting the live managed author CSS into
// the canvas, and publishing selection/computed-style snapshots that the host
// relays to the view.
(function () {
  // Inspector rows: [style field key, computed CSS property, label]. Field keys
  // match the author style model so the view can resolve provenance.
  const INSPECT_FIELDS = [
    ['fontSize', 'font-size', 'Size'],
    ['fontWeight', 'font-weight', 'Weight'],
    ['color', 'color', 'Text'],
    ['backgroundColor', 'background-color', 'Fill'],
    ['borderColor', 'border-left-color', 'Accent'],
    ['borderWidth', 'border-left-width', 'Accent width'],
    ['textTransform', 'text-transform', 'Case'],
    ['letterSpacing', 'letter-spacing', 'Tracking'],
    ['lineHeight', 'line-height', 'Line'],
    ['spacingBefore', 'margin-top', 'Before'],
    ['spacingAfter', 'margin-bottom', 'After'],
  ];
  // First rendered element of each kind — sampled so the empty choice in the
  // style editor can show the actual inherited value instead of a bare "Default".
  const SAMPLE_SELECTORS = {
    all: 'p.p',
    page: 'body',
    title: 'h1.title',
    heading: 'section.section .title, h2.title, h3.title',
    body: 'p.p',
    shortdesc: 'p.shortdesc, .shortdesc',
    section: 'section.section',
    list: 'ul.ul, ol.ol, ol.steps',
    listItem: 'li.li, li.step',
    table: 'table.table',
    tableRow: 'tr.row',
    tableCell: 'td.entry, th.entry',
    tableHeadCell: 'thead.thead th.entry',
    tableBodyCell: 'tbody.tbody td.entry',
    figure: 'figure.fig',
    image: 'img.image',
    note: 'div.note, .note',
    code: 'pre.pre, code.codeph, .codeblock',
    lines: 'pre.lines',
  };
  // Renderer-contract markup ([html, probe target selector]) used to read theme
  // values when the open topic has no element of a kind (e.g. section headings —
  // the corpus has almost none). Classes mirror src/render/to-html.ts exactly;
  // note that EVERY title renders as h1.title.topictitle1, sections included.
  const TABLE_PROBE = '<table class="table"><tbody><tr class="row"><td class="entry">x</td></tr></tbody></table>';
  const HEAD_PROBE = '<table class="table"><thead class="thead"><tr class="row"><th class="entry">x</th></tr></thead></table>';
  const BODY_PROBE = '<table class="table"><tbody class="tbody"><tr class="row"><td class="entry">x</td></tr></tbody></table>';
  const PROBE_MARKUP = {
    all: ['<p class="p">x</p>', 'p'],
    title: ['<h1 class="title topictitle1">x</h1>', 'h1'],
    heading: ['<section class="section"><h1 class="title topictitle1">x</h1></section>', 'h1'],
    body: ['<p class="p">x</p>', 'p'],
    shortdesc: ['<p class="shortdesc">x</p>', 'p'],
    section: ['<section class="section">x</section>', 'section'],
    list: ['<ul class="ul"><li class="li">x</li></ul>', 'ul'],
    listItem: ['<ul class="ul"><li class="li">x</li></ul>', 'li'],
    table: [TABLE_PROBE, 'table'],
    tableRow: [TABLE_PROBE, 'tr'],
    tableCell: [TABLE_PROBE, 'td'],
    tableHeadCell: [HEAD_PROBE, 'th'],
    tableBodyCell: [BODY_PROBE, 'td'],
    figure: ['<figure class="fig">x</figure>', 'figure'],
    image: ['<figure class="fig"><img class="image" alt=""></figure>', 'img'],
    note: ['<div class="note">x</div>', 'div'],
    code: ['<code class="ph codeph">x</code>', 'code'],
    lines: ['<pre class="lines">x</pre>', 'pre'],
  };
  const EMIT_DEBOUNCE_MS = 80;

  function installStyleBridge(options) {
    const document = options.document;
    const windowObj = options.window;
    const vscode = options.vscode;
    const getStyleState = options.getStyleState;
    const getCurrentTarget = options.getCurrentTarget;
    const getStructVersion = options.getStructVersion || function () { return 0; };

    const liveStyle = document.getElementById('ditaeditor-author-styles-live');
    if (!liveStyle) {
      throw new Error('DITA Editor managed stylesheet slot is missing');
    }
    let authorLink = typeof document.querySelector === 'function'
      ? document.querySelector('link[data-ditaeditor-style-origin="author"]')
      : null;
    const managedStyleData = document.getElementById('ditaeditor-managed-style-data');
    if (!managedStyleData) {
      throw new Error('DITA Editor managed stylesheet data is missing');
    }
    const embeddedManagedStyle = JSON.parse(managedStyleData.textContent || '{}');
    if (embeddedManagedStyle.consumer !== 'canvas' || typeof embeddedManagedStyle.cssText !== 'string') {
      throw new Error('DITA Editor managed stylesheet data does not target the canvas');
    }
    // The inert JSON is the first paint. Subsequent repaints always use the
    // host-owned state, including a deliberately empty stylesheet.
    liveStyle.textContent = embeddedManagedStyle.cssText;

    // Inherited "(default)" values are expensive (one probe per kind), so the
    // map is computed lazily on the first emission after an invalidation.
    let inheritedCache = null;
    let emitTimer = null;

    function state() {
      return getStyleState() || { styles: [], cssText: '', writable: false };
    }

    function inspectCssProperty(fieldKey, fallbackCssProp, target) {
      if (fieldKey !== 'borderColor' && fieldKey !== 'borderWidth') return fallbackCssProp;
      if (!target || target.kind !== 'table') return fallbackCssProp;
      const classTokens = String(target.outputclass || '').split(/\s+/).filter(Boolean);
      const styles = Array.isArray(state().styles) ? state().styles : [];
      const applied = styles.find(function (style) {
        return style && style.target === 'table' && style.isDefault !== true &&
          classTokens.indexOf(style.className) >= 0;
      });
      const base = styles.find(function (style) {
        return style && style.target === 'table' && style.isDefault === true && !style.structuralVariant;
      });
      const tableStyle = applied || base || null;
      const edge = tableStyle && ['top', 'bottom', 'left', 'right'].indexOf(tableStyle.borderEdge) >= 0
        ? tableStyle.borderEdge
        : 'top';
      return 'border-' + edge + (fieldKey === 'borderColor' ? '-color' : '-width');
    }

    // Finds a representative element of a kind so the style editor can show the
    // actual inherited value on the empty choice.
    function sampleElement(targetKey) {
      if (typeof document.querySelector !== 'function') return null;
      try {
        return document.querySelector(SAMPLE_SELECTORS[targetKey] || SAMPLE_SELECTORS.all);
      } catch (err) {
        return null;
      }
    }

    // Resolves a struct id to its canvas element for the effective-styles readout.
    function resolveElement(id) {
      if (!id || typeof document.querySelector !== 'function') return null;
      const esc = windowObj && windowObj.CSS && typeof windowObj.CSS.escape === 'function'
        ? windowObj.CSS.escape(id)
        : String(id).replace(/["\\]/g, '\\$&');
      try {
        return document.querySelector('[data-struct-id="' + esc + '"], [data-cell-id="' + esc + '"]');
      } catch (err) {
        return null;
      }
    }

    // Mounts a hidden, out-of-flow element built from the renderer's markup
    // contract inside the real cascade (.body), so theme values are readable
    // even when the topic contains no element of the kind. Removed synchronously.
    function mountProbe(targetKey) {
      const spec = PROBE_MARKUP[targetKey];
      if (!spec || typeof document.createElement !== 'function' || typeof document.querySelector !== 'function') return null;
      const host = document.querySelector('.body') || document.querySelector('main') || document.body;
      if (!host || typeof host.appendChild !== 'function') return null;
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText = 'position:absolute;left:-9999px;top:0;width:640px;visibility:hidden;pointer-events:none;';
      wrap.innerHTML = spec[0];
      const dispose = function () {
        try {
          if (typeof host.removeChild === 'function') host.removeChild(wrap);
        } catch (err) {
          // Already detached (e.g. a rerender swapped the body mid-read); nothing to clean.
        }
      };
      host.appendChild(wrap);
      const element = typeof wrap.querySelector === 'function' ? wrap.querySelector(spec[1]) : null;
      if (!element) {
        dispose();
        return null;
      }
      return { element: element, dispose: dispose };
    }

    // Reads the actual effective value of every style field from a sample element
    // of the kind. Empty map when nothing can be computed — the view then falls
    // back to plain "Default" labels.
    function inheritedFieldValues(targetKey) {
      const out = {};
      if (!windowObj || typeof windowObj.getComputedStyle !== 'function') return out;
      let element = sampleElement(targetKey);
      let dispose = null;
      if (!element) {
        const probe = mountProbe(targetKey);
        if (probe) {
          element = probe.element;
          dispose = probe.dispose;
        }
      }
      if (!element) return out;
      try {
        const computed = windowObj.getComputedStyle(element);
        if (computed && typeof computed.getPropertyValue === 'function') {
          for (const [fieldKey, fallbackCssProp] of INSPECT_FIELDS) {
            const cssProp = inspectCssProperty(fieldKey, fallbackCssProp, { kind: targetKey });
            const value = formatCssValue(String(computed.getPropertyValue(cssProp) || '').trim());
            if (value) out[fieldKey] = value;
          }
        }
      } catch (err) {
        // Fall through to dispose; the view falls back to plain "Default" labels.
      }
      if (dispose) dispose();
      return out;
    }

    // "(default)" values for every style-target kind, keyed by target kind.
    function buildInheritedMap() {
      const out = {};
      for (const targetKey of Object.keys(SAMPLE_SELECTORS)) {
        out[targetKey] = inheritedFieldValues(targetKey);
      }
      return out;
    }

    // Effective computed styles of the single selected element, or null when
    // the selection is not exactly one resolvable element or computed styles
    // are unavailable — the same degradation the in-canvas inspector had.
    function computedEntries(target) {
      if (!target || !Array.isArray(target.ids) || target.ids.length !== 1) return null;
      if (!windowObj || typeof windowObj.getComputedStyle !== 'function') return null;
      const element = resolveElement(target.ids[0]);
      if (!element) return null;
      let computed = null;
      try {
        computed = windowObj.getComputedStyle(element);
      } catch (err) {
        return null;
      }
      if (!computed || typeof computed.getPropertyValue !== 'function') return null;
      const out = [];
      for (const [key, fallbackCssProp, label] of INSPECT_FIELDS) {
        const cssProp = inspectCssProperty(key, fallbackCssProp, target);
        out.push({
          key: key,
          cssProp: cssProp,
          label: label,
          value: String(computed.getPropertyValue(cssProp) || '').trim(),
        });
      }
      return out;
    }

    function hasConfiguredStylesheet() {
      if (!document || typeof document.querySelectorAll !== 'function') return false;
      // Configured links are marked explicitly when the host wires the final
      // cascade. Basenames are not origin metadata and may legitimately collide.
      return document.querySelectorAll(
        'link[rel="stylesheet"][data-ditaeditor-style-origin="configured"], link[rel="stylesheet"][data-ditaeditor-style-origin="author"]',
      ).length > 0;
    }

    // Builds and posts the snapshot the host relays to the Styles view.
    function emitTargetState() {
      const target = getCurrentTarget ? getCurrentTarget() : null;
      if (inheritedCache == null) inheritedCache = buildInheritedMap();
      vscode.postMessage({
        type: 'styleTargetState',
        structVersion: getStructVersion(),
        target: target || null,
        computed: computedEntries(target),
        inherited: inheritedCache,
        hasConfiguredStylesheet: hasConfiguredStylesheet(),
      });
    }

    // Refreshes the complete repository stylesheet as a real link so relative
    // imports and URLs resolve from that file. Generated declarations bridge the
    // short load window, then clear so the linked file remains authoritative.
    function applyStyleState() {
      const next = state();
      const href = typeof next.stylesheetHref === 'string' ? next.stylesheetHref : '';
      const currentHref = authorLink && typeof authorLink.getAttribute === 'function'
        ? String(authorLink.getAttribute('href') || '')
        : '';

      if (!href) {
        liveStyle.textContent = '';
        if (authorLink && authorLink.parentNode && typeof authorLink.parentNode.removeChild === 'function') {
          authorLink.parentNode.removeChild(authorLink);
        }
        authorLink = null;
        inheritedCache = null;
        return;
      }
      if (authorLink && currentHref === href) {
        liveStyle.textContent = '';
        inheritedCache = null;
        return;
      }

      liveStyle.textContent = next.cssText || '';
      if (!authorLink) {
        authorLink = document.createElement('link');
        authorLink.setAttribute('rel', 'stylesheet');
        authorLink.setAttribute('data-ditaeditor-style-origin', 'author');
        if (!liveStyle.parentNode || typeof liveStyle.parentNode.insertBefore !== 'function') {
          throw new Error('DITA Editor author stylesheet link slot is unavailable');
        }
        liveStyle.parentNode.insertBefore(authorLink, liveStyle);
      }
      const expectedHref = href;
      authorLink.addEventListener('load', function () {
        if (authorLink && authorLink.getAttribute('href') === expectedHref) {
          liveStyle.textContent = '';
          inheritedCache = null;
          emitTargetState();
        }
      }, { once: true });
      authorLink.addEventListener('error', function () {
        if (authorLink && authorLink.getAttribute('href') === expectedHref) {
          vscode.postMessage({
            type: 'authorStylesheetLoadError',
            href: expectedHref,
          });
        }
      }, { once: true });
      authorLink.setAttribute('href', href);
      inheritedCache = null;
    }

    // A rerender changed ids/classes under the sample selectors: recompute the
    // inherited map and publish a fresh snapshot immediately.
    function noteRerender() {
      inheritedCache = null;
      emitTargetState();
    }

    // Trailing debounce so bursts of selection/keyboard activity publish one
    // snapshot. Falls back to immediate emission when the embedder (or a test
    // harness) provides no timers.
    function scheduleEmit() {
      if (!windowObj || typeof windowObj.setTimeout !== 'function') {
        emitTargetState();
        return;
      }
      if (emitTimer != null && typeof windowObj.clearTimeout === 'function') {
        windowObj.clearTimeout(emitTimer);
      }
      emitTimer = windowObj.setTimeout(function () {
        emitTimer = null;
        emitTargetState();
      }, EMIT_DEBOUNCE_MS);
    }

    document.addEventListener('selectionchange', scheduleEmit);
    document.addEventListener('keyup', scheduleEmit);
    document.addEventListener('click', scheduleEmit);

    return {
      emitTargetState: emitTargetState,
      applyStyleState: applyStyleState,
      noteRerender: noteRerender,
    };
  }

  // Computed colors come back as rgb()/rgba(); show them as compact hex, and a
  // fully transparent fill as the word it means. Non-color values pass through.
  function formatCssValue(value) {
    if (!value) return '';
    const rgba = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)$/.exec(value);
    if (!rgba) return value;
    if (rgba[4] != null && Number(rgba[4]) === 0) return 'transparent';
    const hex = function (part) {
      const h = Number(part).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return '#' + hex(rgba[1]) + hex(rgba[2]) + hex(rgba[3]);
  }

  window.DitaEditorCanvasStyleBridge = { installStyleBridge: installStyleBridge };
})();
