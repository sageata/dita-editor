// CSS-backed author Styles panel for the DITA Editor canvas.
//
// Loaded before canvas.js. The panel renders only host-provided style definitions
// and posts save/apply intents; the host owns CSS file writes and DITA outputclass edits.
(function () {
  const DEFAULT_PANEL_WIDTH = 324;
  const MIN_PANEL_WIDTH = 260;
  const MAX_PANEL_WIDTH = 600;
  const MIN_EDITOR_WIDTH = 360;
  const BASE_EDITOR_WIDTH = 1040;
  const TOP_CHROME_FALLBACK = 72;
  const PANEL_TOP_INSET = 18;
  const RESIZE_HIT_WIDTH = 8;
  const COLLAPSED_RAIL_WIDTH = 36;
  const PANEL_EDITOR_OVERLAP = 16;
  const SAVE_CONTROLLER_STATE_KEY = 'ditaeditorStyleSaveController';
  const SAVE_CONTROLLER_STATE_VERSION = 1;
  // One small gray scale for the whole panel — it had 8+ near-identical grays that
  // read as noise. Text/border/chip all map to one of these; the accent applied
  // state and error red remain distinct.
  const GRAY_STRONG = '#303030';
  const GRAY_LABEL = '#5f6b72';
  const GRAY_MUTED = '#4b5563';
  const GRAY_HAIRLINE = '#e6e8ea';

  // [key, label, DITA tag(s)] — the tag column keeps literal element names
  // (p, ul, li, …) visible so authors scanning for DITA names find every kind.
  const TARGET_OPTIONS = [
    ['all', 'All elements', ''],
    ['title', 'Topic title', 'title'],
    ['heading', 'Section heading', 'section title'],
    ['body', 'Paragraph', 'p'],
    ['shortdesc', 'Short description', 'shortdesc'],
    ['section', 'Section', 'section'],
    ['list', 'List', 'ul / ol'],
    ['listItem', 'List item', 'li'],
    ['table', 'Table', 'table'],
    ['tableRow', 'Table row', 'row'],
    ['tableCell', 'Table cell', 'entry'],
    ['tableHeadCell', 'Header cell', 'entry (thead)'],
    ['tableBodyCell', 'Body cell', 'entry (tbody)'],
    ['figure', 'Figure', 'fig'],
    ['image', 'Image', 'image'],
    ['note', 'Note', 'note'],
    ['code', 'Code', 'codeblock / codeph'],
    ['lines', 'Lines', 'lines'],
  ];
  const TARGET_LABEL = TARGET_OPTIONS.reduce((acc, entry) => {
    acc[entry[0]] = entry[1];
    return acc;
  }, {});
  const TARGET_TAG = TARGET_OPTIONS.reduce((acc, entry) => {
    acc[entry[0]] = entry[2];
    return acc;
  }, {});
  // The page target is deliberately absent from TARGET_OPTIONS: it is a
  // base-style-only group (never a preset target in the create form), rendered
  // ahead of the element kinds by pageStyleGroup.
  TARGET_LABEL.page = 'Page';
  TARGET_TAG.page = '';
  const DEFAULT_CLASS_PREFIX = 'dc-default-';
  // Structure-derived base variants per target — extra always-on base rows whose
  // host-generated selectors carry a :where()-wrapped DOM predicate ([colspan],
  // nth-child(even), [rowspan], :only-child, :empty). [variant key, label suffix].
  // These are caret-only (edit-in-place); they are never applied to a selection.
  const STRUCTURAL_VARIANTS = {
    table: [['singleCol', 'single column'], ['emptyCaption', 'empty caption']],
  };
  // Inspector rows: [style field key, computed CSS property, label]. Field keys
  // match VALUE_FIELDS so provenance can be resolved from the style model.
  const INSPECT_FIELDS = [
    ['fontSize', 'font-size', 'Size'],
    ['fontWeight', 'font-weight', 'Weight'],
    ['color', 'color', 'Text'],
    ['backgroundColor', 'background-color', 'Fill'],
    ['borderColor', 'border-left-color', 'Accent'],
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
  const SPACING_CHOICES = [
    ['', 'Default'],
    ['0', 'None'],
    ['4px', '4 px'],
    ['8px', '8 px'],
    ['10px', '10 px'],
    ['12px', '12 px'],
    ['14px', '14 px'],
    ['16px', '16 px'],
    ['18px', '18 px'],
    ['20px', '20 px'],
    ['22px', '22 px'],
    ['24px', '24 px'],
    ['28px', '28 px'],
  ];
  const COLOR_CHOICES = [
    ['', 'Default'],
    ['var(--dc-color-text, #1f2937)', 'Text'],
    ['var(--dc-color-text-muted, #4b5563)', 'Muted text'],
    ['var(--dc-color-accent, #2563eb)', 'Accent'],
    ['var(--dc-color-accent-strong, #1d4ed8)', 'Strong accent'],
    ['#111827', 'Near black'],
  ];
  const FILL_CHOICES = [
    ['', 'Default'],
    ['var(--dc-color-surface-muted, #f3f4f6)', 'Muted surface'],
    ['var(--dc-color-surface, #ffffff)', 'Surface'],
    ['#eff6ff', 'Accent tint'],
  ];
  const VALUE_FIELDS = [
    {
      key: 'fontSize',
      label: 'Size',
      choices: [
        ['', 'Default'],
        ['12px', '12 px'],
        ['13px', '13 px'],
        ['14px', '14 px'],
        ['16px', '16 px'],
        ['18px', '18 px'],
        ['20px', '20 px'],
        ['24px', '24 px'],
        ['28px', '28 px'],
        ['34px', '34 px'],
      ],
    },
    {
      key: 'fontWeight',
      label: 'Weight',
      choices: [
        ['', 'Default'],
        ['400', 'Regular'],
        ['500', 'Medium'],
        ['600', 'Semi bold'],
        ['700', 'Bold'],
      ],
    },
    { key: 'color', label: 'Text', color: true, choices: COLOR_CHOICES },
    { key: 'backgroundColor', label: 'Fill', color: true, choices: FILL_CHOICES },
    { key: 'borderColor', label: 'Accent', color: true, choices: COLOR_CHOICES },
    {
      key: 'textTransform',
      label: 'Case',
      choices: [
        ['', 'Default'],
        ['none', 'Normal'],
        ['uppercase', 'Uppercase'],
        ['lowercase', 'Lowercase'],
        ['capitalize', 'Capitalize'],
      ],
    },
    {
      key: 'letterSpacing',
      label: 'Tracking',
      choices: [
        ['', 'Default'],
        ['0', 'None'],
        ['.02em', 'Tight'],
        ['.04em', 'Normal'],
        ['.08em', 'Wide'],
        ['.09em', 'Extra wide'],
      ],
    },
    {
      key: 'lineHeight',
      label: 'Line height',
      choices: [
        ['', 'Default'],
        ['1.15', 'Tight (1.15)'],
        ['1.25', 'Snug (1.25)'],
        ['1.45', 'Cozy (1.45)'],
        ['1.55', 'Relaxed (1.55)'],
        ['1.7', 'Loose (1.7)'],
      ],
    },
    {
      key: 'padding',
      label: 'Padding',
      choices: [
        ['', 'Default'],
        ['6px 10px', 'Compact'],
        ['10px 14px', 'Cozy'],
        ['12px 14px', 'Comfortable'],
        ['16px 20px', 'Spacious'],
      ],
    },
    {
      key: 'textAlign',
      label: 'Align',
      choices: [
        ['', 'Default'],
        ['left', 'Left'],
        ['center', 'Center'],
        ['right', 'Right'],
      ],
    },
    {
      key: 'verticalAlign',
      label: 'V-align',
      choices: [
        ['', 'Default'],
        ['top', 'Top'],
        ['middle', 'Middle'],
        ['bottom', 'Bottom'],
      ],
    },
    { key: 'spacingBefore', label: 'Before', choices: SPACING_CHOICES },
    { key: 'spacingAfter', label: 'After', choices: SPACING_CHOICES },
  ];
  // Page base style: the document canvas exposes its theme-owned styling here
  // (fill, content column width, table shadow) instead of leaving it opaque.
  const PAGE_VALUE_FIELDS = [
    {
      key: 'backgroundColor',
      label: 'Page fill',
      color: true,
      choices: [
        ['', 'Default'],
        ['var(--dc-color-surface-muted, #f3f4f6)', 'Muted surface'],
        ['var(--dc-color-surface, #ffffff)', 'Surface'],
        ['#eff6ff', 'Accent tint'],
      ],
    },
    {
      key: 'contentWidth',
      label: 'Content width',
      choices: [
        ['', 'Default'],
        ['720px', '720 px'],
        ['840px', '840 px'],
        ['960px', '960 px'],
        ['1040px', '1040 px'],
        ['1200px', '1200 px'],
      ],
    },
    {
      key: 'tableShadow',
      label: 'Table shadow',
      choices: [
        ['', 'Default'],
        ['none', 'None'],
        ['var(--dc-shadow-md, 0 6px 24px rgb(15 23 42 / 12%))', 'Soft'],
      ],
    },
    // Site chrome (app-shell): masthead banner, TOC sidebar, links. These write
    // :root --dc-chrome-* custom properties the published/editor shell reads; an
    // empty value leaves the shell's own default (today's look) in place.
    { key: 'mastheadTitle', label: 'Masthead title', text: true },
    { key: 'mastheadBg', label: 'Masthead fill', color: true, choices: FILL_CHOICES },
    { key: 'mastheadText', label: 'Masthead text', color: true, choices: COLOR_CHOICES },
    { key: 'mastheadAccent', label: 'Masthead accent', color: true, choices: COLOR_CHOICES },
    {
      key: 'sidebarWidth',
      label: 'Sidebar width',
      choices: [
        ['', 'Default'],
        ['280px', '280 px'],
        ['324px', '324 px'],
        ['360px', '360 px'],
        ['400px', '400 px'],
      ],
    },
    { key: 'sidebarBg', label: 'Sidebar fill', color: true, choices: FILL_CHOICES },
    { key: 'sidebarLink', label: 'Sidebar text', color: true, choices: COLOR_CHOICES },
    { key: 'sidebarHover', label: 'Sidebar hover', color: true, choices: FILL_CHOICES },
    { key: 'sidebarActive', label: 'Sidebar active', color: true, choices: FILL_CHOICES },
    { key: 'sidebarAccent', label: 'Sidebar accent', color: true, choices: COLOR_CHOICES },
    { key: 'sidebarCaption', label: 'Sidebar caption', color: true, choices: COLOR_CHOICES },
    { key: 'linkColor', label: 'Link color', color: true, choices: COLOR_CHOICES },
    { key: 'linkHover', label: 'Link hover', color: true, choices: COLOR_CHOICES },
  ];
  const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

  function installStylesPanel(options) {
    const document = options.document;
    const win = options.window || window;
    const vscode = options.vscode;
    const fontFamily = options.fontFamily;
    const saveRequestSessionId = options.saveRequestSessionId;
    const getStyleState = options.getStyleState;
    const getCurrentTarget = options.getCurrentTarget;
    const getStructVersion = options.getStructVersion || function () { return 0; };
    const announceNav = options.announceNav || function () {};
    if (typeof saveRequestSessionId !== 'string' || !saveRequestSessionId) {
      throw new Error('A per-webview save request session ID is required.');
    }
    const main = document.querySelector('main');
    let topChromeHeight = TOP_CHROME_FALLBACK;
    let panelWidth = DEFAULT_PANEL_WIDTH;
    let dragStartX = 0;
    let dragStartWidth = DEFAULT_PANEL_WIDTH;
    let dragging = false;
    let collapsed = false;
    let editClassName = null;
    let expandedGroups = new Set();
    let draftTarget = null;
    let revealCreateForm = false;
    let nextSaveRequestSequence = 1;
    let nextFormMutationSequence = 1;
    // Save correlation belongs to the panel, not to a mounted form. buildPanel()
    // intentionally replaces forms during navigation and forced refreshes; an
    // outstanding acknowledgement must still release the latest queued draft.
    let inFlightSave = null;
    let pendingMutations = [];
    let saveBlockedReason = '';
    let queueErrorReason = '';
    let latestAcceptedSourceHash = '';
    let latestAcceptedTargetToken = '';
    let latestAcceptedStyles = null;
    let restoredRequestId = '';
    const acceptedSourceHashes = new Set();
    const logicalClassNames = new Map();
    // Managed classes applied anywhere on the current selection's ancestor chain, so a
    // preset shows "applied" even when it lives on an ancestor (e.g. a table preset
    // while a cell is selected). Rebuilt each render by buildPanel.
    let appliedManagedSet = new Set();

    // Finds a representative element of a kind so the style editor can show the
    // actual inherited value on the empty choice. Overridable for headless tests
    // (the fake DOM has no compound-selector support).
    const sampleElement = typeof options.sampleElement === 'function'
      ? options.sampleElement
      : function (targetKey) {
        if (typeof document.querySelector !== 'function') return null;
        try {
          return document.querySelector(SAMPLE_SELECTORS[targetKey] || SAMPLE_SELECTORS.all);
        } catch (err) {
          return null;
        }
      };

    // Resolves a struct id to its canvas element for the effective-styles readout.
    // Overridable via options so headless tests can stub it alongside getComputedStyle.
    const resolveElement = typeof options.resolveElement === 'function'
      ? options.resolveElement
      : function (id) {
        if (!id || typeof document.querySelector !== 'function') return null;
        const esc = win.CSS && typeof win.CSS.escape === 'function'
          ? win.CSS.escape(id)
          : String(id).replace(/["\\]/g, '\\$&');
        try {
          return document.querySelector('[data-struct-id="' + esc + '"], [data-cell-id="' + esc + '"]');
        } catch (err) {
          return null;
        }
      };

    const liveStyle = document.getElementById('ditaeditor-author-styles-live');
    if (!liveStyle) {
      throw new Error('DITA Editor managed stylesheet slot is missing');
    }
    const managedStyleData = document.getElementById('ditaeditor-managed-style-data');
    if (!managedStyleData) {
      throw new Error('DITA Editor managed stylesheet data is missing');
    }
    const embeddedManagedStyle = JSON.parse(managedStyleData.textContent || '{}');
    if (embeddedManagedStyle.consumer !== 'canvas' || typeof embeddedManagedStyle.cssText !== 'string') {
      throw new Error('DITA Editor managed stylesheet data does not target the canvas');
    }
    // The inert JSON is the first paint. Subsequent refreshes always use the
    // host-owned state, including a deliberately empty stylesheet.
    liveStyle.textContent = embeddedManagedStyle.cssText;
    let firstPanelBuild = true;

    const panel = document.createElement('aside');
    panel.id = 'ditaeditor-styles-panel';
    panel.setAttribute('aria-label', 'Styles');
    panel.className = 'style-panel';
    panel.style.cssText =
      'position:fixed;right:0;top:0;bottom:0;width:324px;box-sizing:border-box;z-index:74;overflow:auto;' +
      'background:#fbfbfa;border-left:1px solid #ececec;padding:90px 18px 22px 18px;font-family:' + fontFamily + ';';
    panel.style.paddingTop = TOP_CHROME_FALLBACK + PANEL_TOP_INSET + 'px';
    document.body.appendChild(panel);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'style-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'Resize styles panel');
    resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-valuemin', String(MIN_PANEL_WIDTH));
    resizeHandle.tabIndex = 0;
    resizeHandle.style.cssText =
      'position:fixed;top:var(--ditaeditor-toolbar-height,72px);bottom:0;right:320px;width:8px;z-index:76;box-sizing:border-box;' +
      'cursor:col-resize;background:linear-gradient(to right,transparent 0 3px,#e1e1e1 3px 4px,transparent 4px);';
    document.body.appendChild(resizeHandle);

    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'style-toggle-btn';
    hideButton.textContent = '›';
    hideButton.title = 'Hide styles';
    hideButton.setAttribute('aria-label', 'Hide styles');
    hideButton.setAttribute('aria-controls', 'ditaeditor-styles-panel');
    hideButton.setAttribute('aria-expanded', 'true');
    hideButton.style.cssText = iconButtonCss(fontFamily);

    const showButton = document.createElement('button');
    showButton.type = 'button';
    showButton.className = 'style-show-button';
    showButton.textContent = '‹';
    showButton.title = 'Show styles';
    showButton.setAttribute('aria-label', 'Show styles');
    showButton.setAttribute('aria-controls', 'ditaeditor-styles-panel');
    showButton.setAttribute('aria-expanded', 'false');
    showButton.style.cssText =
      'position:fixed;right:0;top:var(--ditaeditor-toolbar-height,72px);bottom:0;width:36px;box-sizing:border-box;z-index:74;display:none;' +
      'align-items:flex-start;justify-content:center;padding-top:12px;border:0;border-left:1px solid #ececec;' +
      'background:#fbfbfa;color:#737373;cursor:pointer;font:600 20px/1 ' + fontFamily + ';';
    document.body.appendChild(showButton);

    function state() {
      return getStyleState() || { styles: [], cssText: '', writable: false };
    }

    function showSaveError(reason) {
      for (const mountedForm of Array.prototype.slice.call(panel.querySelectorAll('form'))) {
        if (typeof mountedForm._ditaeditorShowSaveError === 'function') {
          mountedForm._ditaeditorShowSaveError(reason);
        }
      }
      announceNav(reason);
    }

    function isPlainStyle(value) {
      if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      if (typeof value.name !== 'string' || typeof value.className !== 'string' || typeof value.target !== 'string') return false;
      return Object.keys(value).every((key) => typeof value[key] === 'string' || typeof value[key] === 'boolean');
    }

    function isStyleArray(value) {
      return Array.isArray(value) && value.every(isPlainStyle);
    }

    function isPersistedMutation(value) {
      return value != null
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.logicalId === 'string'
        && value.logicalId.length > 0
        && (value.replaceClassName == null || typeof value.replaceClassName === 'string')
        && isPlainStyle(value.base)
        && isPlainStyle(value.next);
    }

    function isRequestForSession(requestId, sessionId) {
      if (typeof requestId !== 'string' || typeof sessionId !== 'string') return false;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return false;
      const prefix = sessionId + ':style-save-';
      return requestId.indexOf(prefix) === 0 && /^[1-9][0-9]{0,15}$/.test(requestId.slice(prefix.length));
    }

    function clearRejectedPersistedSaveController(root) {
      if (typeof vscode.setState !== 'function') return null;
      try {
        const nextState = root && typeof root === 'object' && !Array.isArray(root)
          ? Object.assign({}, root)
          : {};
        delete nextState[SAVE_CONTROLLER_STATE_KEY];
        vscode.setState(JSON.parse(JSON.stringify(nextState)));
      } catch (err) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('DITA Editor could not clear rejected persisted style-save state.', err);
        }
      }
      return null;
    }

    function readPersistedSaveController() {
      if (typeof vscode.getState !== 'function') return null;
      let root;
      try {
        root = vscode.getState();
      } catch (err) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('DITA Editor could not read persisted style-save state.', err);
        }
        return null;
      }
      const saved = root && typeof root === 'object' && !Array.isArray(root)
        ? root[SAVE_CONTROLLER_STATE_KEY]
        : null;
      if (saved == null) return null;
      if (typeof saved !== 'object' || Array.isArray(saved) || saved.schemaVersion !== SAVE_CONTROLLER_STATE_VERSION) {
        return clearRejectedPersistedSaveController(root);
      }
      const flight = saved.inFlight;
      if (flight == null || typeof flight !== 'object' || Array.isArray(flight)) {
        return clearRejectedPersistedSaveController(root);
      }
      if (!isRequestForSession(flight.requestId, flight.requestSessionId)) {
        return clearRejectedPersistedSaveController(root);
      }
      if (typeof flight.sourceHash !== 'string' || !flight.sourceHash) {
        return clearRejectedPersistedSaveController(root);
      }
      if (typeof flight.targetToken !== 'string' || !flight.targetToken) {
        return clearRejectedPersistedSaveController(root);
      }
      if (typeof flight.cssPath !== 'string' || !isStyleArray(flight.styles) || typeof flight.silent !== 'boolean') {
        return clearRejectedPersistedSaveController(root);
      }
      if (!Array.isArray(saved.pendingMutations) || !saved.pendingMutations.every(isPersistedMutation)) {
        return clearRejectedPersistedSaveController(root);
      }
      return {
        inFlight: {
          requestId: flight.requestId,
          requestSessionId: flight.requestSessionId,
          sourceHash: flight.sourceHash,
          targetToken: flight.targetToken,
          cssPath: flight.cssPath,
          styles: flight.styles,
          silent: flight.silent,
        },
        pendingMutations: saved.pendingMutations,
      };
    }

    function persistSaveController() {
      if (typeof vscode.getState !== 'function' || typeof vscode.setState !== 'function') return true;
      try {
        const previous = vscode.getState();
        const nextState = previous && typeof previous === 'object' && !Array.isArray(previous)
          ? Object.assign({}, previous)
          : {};
        if (inFlightSave == null) {
          delete nextState[SAVE_CONTROLLER_STATE_KEY];
        } else {
          nextState[SAVE_CONTROLLER_STATE_KEY] = {
            schemaVersion: SAVE_CONTROLLER_STATE_VERSION,
            inFlight: {
              requestId: inFlightSave.requestId,
              requestSessionId: inFlightSave.requestSessionId,
              sourceHash: inFlightSave.sourceHash,
              targetToken: inFlightSave.targetToken,
              cssPath: inFlightSave.cssPath,
              styles: inFlightSave.styles,
              silent: inFlightSave.silent,
            },
            pendingMutations: pendingMutations.map((mutation) => ({
              logicalId: mutation.logicalId,
              replaceClassName: mutation.replaceClassName,
              base: mutation.base,
              next: mutation.next,
            })),
          };
        }
        // VS Code serializes this object for the webview. Clone first so later
        // in-memory coalescing cannot mutate a test shim (or embedder) by alias.
        vscode.setState(JSON.parse(JSON.stringify(nextState)));
        return true;
      } catch (err) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('DITA Editor could not persist style-save state.', err);
        }
        return false;
      }
    }

    function restoreSaveController() {
      const saved = readPersistedSaveController();
      if (saved == null) return;
      inFlightSave = saved.inFlight;
      pendingMutations = saved.pendingMutations;
      restoredRequestId = inFlightSave.requestId;
      acceptedSourceHashes.add(inFlightSave.sourceHash);
      replaceLogicalClassNames(pendingMutations);
      vscode.postMessage({ type: 'resumeStyleSave', requestId: restoredRequestId });
    }

    function replaceLogicalClassNames(mutations) {
      logicalClassNames.clear();
      for (const mutation of mutations) {
        logicalClassNames.set(mutation.logicalId, mutation.next.className);
      }
    }

    function applyStylePatch(current, base, next) {
      const patched = Object.assign({}, current);
      const keys = new Set(Object.keys(base).concat(Object.keys(next)));
      for (const key of keys) {
        const baseHas = Object.prototype.hasOwnProperty.call(base, key);
        const nextHas = Object.prototype.hasOwnProperty.call(next, key);
        if (baseHas === nextHas && (!baseHas || base[key] === next[key])) continue;
        if (nextHas) patched[key] = next[key];
        else delete patched[key];
      }
      return patched;
    }

    function applyStyleMutation(styles, mutation) {
      const nextStyles = styles.slice();
      if (mutation.replaceClassName == null) {
        const created = applyStylePatch(mutation.base, mutation.base, mutation.next);
        if (nextStyles.some((item) => item.className === created.className)) return null;
        nextStyles.push(created);
        return nextStyles;
      }
      const index = nextStyles.findIndex((item) => item.className === mutation.replaceClassName);
      if (index < 0) return null;
      nextStyles[index] = applyStylePatch(nextStyles[index], mutation.base, mutation.next);
      return nextStyles;
    }

    function prepareSave(save, sourceHash, targetToken, cssPath) {
      const requestId = saveRequestSessionId + ':style-save-' + nextSaveRequestSequence++;
      const expectedSourceHash = targetToken === latestAcceptedTargetToken
        && acceptedSourceHashes.has(sourceHash)
        && latestAcceptedSourceHash
        ? latestAcceptedSourceHash
        : sourceHash;
      acceptedSourceHashes.add(expectedSourceHash);
      inFlightSave = {
        requestId: requestId,
        requestSessionId: saveRequestSessionId,
        sourceHash: expectedSourceHash,
        targetToken: targetToken,
        cssPath: cssPath,
        styles: save.styles,
        silent: save.silent,
      };
      return inFlightSave;
    }

    function postPreparedSave() {
      if (!persistSaveController()) {
        saveBlockedReason = 'DITA Editor could not safely retain this style save. Keep the editor open and try again.';
        showSaveError(saveBlockedReason);
        return false;
      }
      vscode.postMessage({
        type: 'saveStyles',
        requestId: inFlightSave.requestId,
        styles: inFlightSave.styles,
        silent: inFlightSave.silent,
        sourceHash: inFlightSave.sourceHash,
        targetToken: inFlightSave.targetToken,
      });
      return true;
    }

    function postSave(save, sourceHash, targetToken, cssPath) {
      const prepared = prepareSave(save, sourceHash, targetToken, cssPath);
      if (postPreparedSave()) return true;
      // Nothing was posted, so this request can never receive a result. Roll it
      // back instead of leaving all future drafts queued behind an unsent ID.
      if (inFlightSave === prepared) inFlightSave = null;
      return false;
    }

    function queueStyleMutation(binding, baseStyles, logicalId, formMutationId, baseStyle, previousClassName, next, silent) {
      queueErrorReason = '';
      if (typeof binding.targetToken !== 'string' || !binding.targetToken) {
        queueErrorReason = 'DITA Editor has not finished identifying the active managed stylesheet. Reload the Styles panel before saving.';
        return false;
      }
      if (restoredRequestId) {
        queueErrorReason = 'DITA Editor is finishing the style save that was active before this editor reloaded. Wait for that result before editing again.';
        showSaveError(queueErrorReason);
        return false;
      }
      if (inFlightSave == null) {
        const canRebaseStaleForm = binding.targetToken === latestAcceptedTargetToken
          && acceptedSourceHashes.has(binding.sourceHash)
          && isStyleArray(latestAcceptedStyles);
        const mutationBaseStyles = canRebaseStaleForm ? latestAcceptedStyles : baseStyles;
        const knownClassName = logicalClassNames.get(logicalId);
        const previousClassExists = mutationBaseStyles.some(
          (item) => item.className === previousClassName,
        );
        const knownRenamedClassExists = typeof knownClassName === 'string'
          && mutationBaseStyles.some((item) => item.className === knownClassName);
        if (canRebaseStaleForm
          && typeof knownClassName === 'string'
          && !knownRenamedClassExists) {
          queueErrorReason = 'The edited style changed identity after the stylesheet was saved. Reload the Styles panel before editing it again.';
          return false;
        }
        const replaceClassName = canRebaseStaleForm
          && knownRenamedClassExists
          ? knownClassName
          : previousClassExists
            ? previousClassName
            : null;
        if (canRebaseStaleForm
          && replaceClassName == null
          && baseStyles.some((item) => item.className === previousClassName)) {
          queueErrorReason = 'The edited style changed identity after the stylesheet was saved. Reload the Styles panel before editing it again.';
          return false;
        }
        const mutation = {
          logicalId: logicalId,
          replaceClassName: replaceClassName,
          base: baseStyle,
          next: next,
        };
        const nextStyles = applyStyleMutation(mutationBaseStyles, mutation);
        if (nextStyles == null) return false;
        logicalClassNames.set(logicalId, next.className);
        const posted = postSave(
          { styles: nextStyles, silent: silent },
          binding.sourceHash,
          binding.targetToken,
          binding.cssPath,
        );
        if (!posted) queueErrorReason = saveBlockedReason;
        return posted;
      }

      if (binding.targetToken !== inFlightSave.targetToken || !acceptedSourceHashes.has(binding.sourceHash)) {
        queueErrorReason = 'The active managed stylesheet changed while another style save was completing. Reload the Styles panel before editing this stylesheet.';
        return false;
      }

      let pending = pendingMutations.find((mutation) => mutation.logicalId === logicalId);
      if (pending) {
        if (pending.activeFormId === formMutationId) {
          pending.next = applyStylePatch(pending.beforeActiveForm, pending.activeFormBase, next);
        } else {
          pending.beforeActiveForm = pending.next;
          pending.activeFormBase = baseStyle;
          pending.activeFormId = formMutationId;
          pending.next = applyStylePatch(pending.beforeActiveForm, baseStyle, next);
        }
      } else {
        const currentClassName = logicalClassNames.has(logicalId)
          ? logicalClassNames.get(logicalId)
          : inFlightSave.styles.some((item) => item.className === previousClassName)
            ? previousClassName
            : null;
        const currentStyle = currentClassName == null
          ? baseStyle
          : inFlightSave.styles.find((item) => item.className === currentClassName);
        if (!currentStyle) return false;
        pending = {
          logicalId: logicalId,
          replaceClassName: currentClassName,
          base: currentStyle,
          next: applyStylePatch(currentStyle, baseStyle, next),
          activeFormId: formMutationId,
          activeFormBase: baseStyle,
          beforeActiveForm: currentStyle,
        };
        pendingMutations.push(pending);
      }
      logicalClassNames.set(logicalId, next.className);
      if (!persistSaveController()) {
        queueErrorReason = 'DITA Editor could not safely retain the latest queued style draft. Keep the editor open until the current save finishes.';
        showSaveError(queueErrorReason);
        return false;
      }
      return true;
    }

    function measureTopChromeHeight() {
      const cmdBar = document.querySelector('.cmd-bar');
      if (!cmdBar) return TOP_CHROME_FALLBACK;
      const rect = typeof cmdBar.getBoundingClientRect === 'function' ? cmdBar.getBoundingClientRect() : null;
      const rectHeight = rect && typeof rect.top === 'number' && typeof rect.bottom === 'number'
        ? rect.bottom - rect.top
        : 0;
      const offsetHeight = typeof cmdBar.offsetHeight === 'number' ? cmdBar.offsetHeight : 0;
      return Math.max(1, Math.ceil(rectHeight || offsetHeight || TOP_CHROME_FALLBACK));
    }

    function maxPanelWidth() {
      const viewportWidth = typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : 0;
      if (!viewportWidth) return MAX_PANEL_WIDTH;
      return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportWidth - MIN_EDITOR_WIDTH));
    }

    function clampPanelWidth(width) {
      return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth(), Math.round(width)));
    }

    function pixelValue(value) {
      const n = Number.parseFloat(String(value || ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    // The page style's Content width control publishes --dc-page-content-width;
    // the inline width math must honor it or the inline min/max-width written
    // here would clobber the user's choice. Guarded because headless fake DOMs
    // stub or omit getComputedStyle — they fall back to the 1040px base.
    function baseEditorWidth() {
      try {
        if (win && typeof win.getComputedStyle === 'function' && document.body) {
          const computed = win.getComputedStyle(document.body);
          if (computed && typeof computed.getPropertyValue === 'function') {
            const w = Number.parseFloat(String(computed.getPropertyValue('--dc-page-content-width') || ''));
            if (Number.isFinite(w) && w >= 480 && w <= 1600) return Math.round(w);
          }
        }
      } catch (err) {
        // Fall through to the fixed base width.
      }
      return BASE_EDITOR_WIDTH;
    }

    function reserveEditorInset(side, width) {
      if (!main) return;
      if (side === 'left') main.style.paddingLeft = width + 'px';
      else main.style.paddingRight = width + 'px';
      const left = pixelValue(main.style.paddingLeft);
      const right = pixelValue(main.style.paddingRight);
      const editorWidth = baseEditorWidth() + left + right;
      main.style.minWidth = editorWidth + 'px';
      main.style.maxWidth = editorWidth + 'px';
    }

    // Re-applies the inline width math when a page-style edit (or an external
    // CSS file change) moves --dc-page-content-width, so a Content width choice
    // takes effect immediately instead of on the next resize/collapse.
    let lastBaseEditorWidth = BASE_EDITOR_WIDTH;
    function syncBaseEditorWidth() {
      const next = baseEditorWidth();
      if (next === lastBaseEditorWidth) return;
      lastBaseEditorWidth = next;
      reserveEditorInset('right', collapsed ? COLLAPSED_RAIL_WIDTH : expandedEditorInset(panelWidth));
      notifyLayoutChange();
    }

    function notifyLayoutChange() {
      if (typeof win.dispatchEvent === 'function' && typeof win.Event === 'function') {
        win.dispatchEvent(new win.Event('ditaeditor:layoutchange'));
      } else if (typeof win.dispatch === 'function') {
        win.dispatch('ditaeditor:layoutchange', {});
      }
    }

    function expandedEditorInset(width) {
      return Math.max(COLLAPSED_RAIL_WIDTH, width - PANEL_EDITOR_OVERLAP);
    }

    function applyTopChromeHeight() {
      topChromeHeight = measureTopChromeHeight();
      panel.style.paddingTop = topChromeHeight + PANEL_TOP_INSET + 'px';
      resizeHandle.style.top = topChromeHeight + 'px';
      showButton.style.top = topChromeHeight + 'px';
    }

    function applyPanelWidth(width) {
      panelWidth = clampPanelWidth(width);
      panel.style.width = panelWidth + 'px';
      if (!collapsed) reserveEditorInset('right', expandedEditorInset(panelWidth));
      resizeHandle.style.right = panelWidth - RESIZE_HIT_WIDTH / 2 + 'px';
      resizeHandle.setAttribute('aria-valuemax', String(maxPanelWidth()));
      resizeHandle.setAttribute('aria-valuenow', String(panelWidth));
      notifyLayoutChange();
    }

    function setCollapsed(nextCollapsed) {
      collapsed = !!nextCollapsed;
      if (collapsed) {
        stopResize();
        panel.style.display = 'none';
        panel.setAttribute('aria-hidden', 'true');
        resizeHandle.style.display = 'none';
        showButton.style.display = 'inline-flex';
        showButton.setAttribute('aria-expanded', 'false');
        hideButton.setAttribute('aria-expanded', 'false');
        reserveEditorInset('right', COLLAPSED_RAIL_WIDTH);
        notifyLayoutChange();
        return;
      }

      panel.style.display = '';
      panel.setAttribute('aria-hidden', 'false');
      resizeHandle.style.display = 'block';
      showButton.style.display = 'none';
      showButton.setAttribute('aria-expanded', 'true');
      hideButton.setAttribute('aria-expanded', 'true');
      applyPanelWidth(panelWidth);
    }

    function stopResize() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('style-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      win.removeEventListener('pointermove', onResizeMove);
      win.removeEventListener('pointerup', stopResize);
      win.removeEventListener('blur', stopResize);
    }

    function onResizeMove(event) {
      if (!dragging || typeof event.clientX !== 'number') return;
      if (event.preventDefault) event.preventDefault();
      applyPanelWidth(dragStartWidth + dragStartX - event.clientX);
    }

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      if (typeof event.clientX !== 'number') return;
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      dragging = true;
      dragStartX = event.clientX;
      dragStartWidth = panelWidth;
      document.body.classList.add('style-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      win.addEventListener('pointermove', onResizeMove);
      win.addEventListener('pointerup', stopResize);
      win.addEventListener('blur', stopResize);
    });

    resizeHandle.addEventListener('keydown', (event) => {
      let next = null;
      const step = event.shiftKey ? 48 : 16;
      if (event.key === 'ArrowLeft') next = panelWidth + step;
      else if (event.key === 'ArrowRight') next = panelWidth - step;
      else if (event.key === 'Home') next = MIN_PANEL_WIDTH;
      else if (event.key === 'End') next = maxPanelWidth();
      if (next == null) return;
      if (event.preventDefault) event.preventDefault();
      applyPanelWidth(next);
    });

    hideButton.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      setCollapsed(true);
    });
    showButton.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      setCollapsed(false);
    });

    win.addEventListener('resize', () => {
      applyTopChromeHeight();
      applyPanelWidth(panelWidth);
    });

    function targetSummary(target) {
      if (!target || !target.ids || !target.ids.length) return 'No element selected';
      if (target.ids.length > 1) return target.ids.length + ' selected elements';
      return target.label || target.kind || 'Current element';
    }

    function buildPanel(force) {
      if (force && inFlightSave == null && saveBlockedReason) {
        // Internal close/reopen and group-navigation paths call buildPanel()
        // directly, so the clean-form boundary belongs here rather than only in
        // the public refresh wrapper.
        saveBlockedReason = '';
        latestAcceptedSourceHash = '';
        latestAcceptedTargetToken = '';
        latestAcceptedStyles = null;
        acceptedSourceHashes.clear();
        logicalClassNames.clear();
      }
      const styleState = state();
      if (firstPanelBuild) {
        firstPanelBuild = false;
      } else {
        liveStyle.textContent = typeof styleState.cssText === 'string' ? styleState.cssText : '';
      }
      syncBaseEditorWidth();
      if (!force && panel.contains(document.activeElement)) return;
      // innerHTML teardown resets a scrollable box to the top; the panel rebuilds
      // on every document click/keyup, so the previous scroll must be restored.
      const prevScrollTop = typeof panel.scrollTop === 'number' ? panel.scrollTop : 0;
      const styles = Array.isArray(styleState.styles) ? styleState.styles : [];
      const target = getCurrentTarget ? getCurrentTarget() : null;
      const currentClasses = target && target.outputclass ? target.outputclass.split(/\s+/).filter(Boolean) : [];
      const managed = styles.map((style) => style.className);
      const activeManaged = currentClasses.find((token) => managed.indexOf(token) >= 0) || '';
      const activeStyle = styles.find((style) => style.className === activeManaged) || null;
      // Applied state spans the whole ancestor chain (table/row/cell), not just the
      // selected element, so ancestor-level presets read as applied. Falls back to the
      // selected element's own classes when the host doesn't supply the chain.
      const managedLookup = new Set(managed);
      const chainClasses = target && Array.isArray(target.ancestorClasses) && target.ancestorClasses.length
        ? target.ancestorClasses
        : currentClasses;
      appliedManagedSet = new Set(chainClasses.filter((token) => managedLookup.has(token)));

      panel.innerHTML = '';
      if (Array.isArray(panel.childNodes)) panel.childNodes.length = 0;
      if (Array.isArray(panel.children)) panel.children.length = 0;
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:14px;';
      const title = document.createElement('span');
      title.textContent = 'Styles';
      title.style.cssText = 'font-weight:650;font-size:13px;color:' + GRAY_STRONG + ';flex:1;';
      const newBtn = smallButton(document, 'New', fontFamily);
      newBtn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        editClassName = '';
        draftTarget = null;
        revealCreateForm = true;
        buildPanel(true);
      });
      head.append(title, newBtn, hideButton);
      panel.appendChild(head);

      const current = document.createElement('div');
      current.className = 'style-current';
      if (current.classList && typeof current.classList.add === 'function') current.classList.add('style-current');
      current.style.cssText =
        (activeStyle && activeStyle.borderColor ? 'border-left:2px solid ' + activeStyle.borderColor + ';' : '') +
        'background:#fff;padding:7px 8px 7px ' + (activeStyle && activeStyle.borderColor ? '5px' : '0') + ';' +
        'margin-bottom:12px;border-top:1px solid ' + GRAY_HAIRLINE + ';border-bottom:1px solid ' + GRAY_HAIRLINE + ';';
      const currentEyebrow = document.createElement('div');
      currentEyebrow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';
      const currentEyebrowText = document.createElement('span');
      currentEyebrowText.textContent = 'Selected element';
      currentEyebrowText.style.cssText =
        'font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:' + GRAY_LABEL + ';';
      currentEyebrow.appendChild(currentEyebrowText);
      const currentLabel = document.createElement('div');
      currentLabel.style.cssText = 'font-size:12.5px;color:' + GRAY_STRONG + ';font-weight:700;margin-bottom:2px;text-transform:capitalize;';
      const currentName = document.createElement('span');
      currentName.textContent = targetSummary(target);
      currentLabel.appendChild(currentName);
      if (target && target.ids && target.ids.length === 1 && target.kind) {
        const currentTag = document.createElement('span');
        currentTag.textContent = '<' + target.kind + '>';
        currentTag.style.cssText =
          'margin-left:6px;font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:' + GRAY_LABEL + ';text-transform:none;';
        currentLabel.appendChild(currentTag);
      }
      const clearBtn = smallButton(document, 'Clear', fontFamily);
      clearBtn.style.marginTop = '9px';
      clearBtn.disabled = !target || !target.ids || !target.ids.length || !activeManaged;
      clearBtn.setAttribute('aria-disabled', clearBtn.disabled ? 'true' : 'false');
      clearBtn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        applyStyle('', target, styles, activeStyle ? activeStyle.target : '');
      });
      current.append(currentEyebrow, currentLabel);
      const inspector = buildInspector(target, activeStyle, styles);
      if (inspector) current.appendChild(inspector);
      current.appendChild(clearBtn);
      panel.appendChild(current);

      if (styleState.error) {
        const err = document.createElement('div');
        err.textContent = styleState.error;
        err.style.cssText = 'font-size:12px;color:#9c2f2f;line-height:1.4;margin:0 0 12px;';
        panel.appendChild(err);
      }
      if (!styleState.writable) {
        const locked = document.createElement('div');
        locked.textContent = styleState.error
          ? 'Styles are read-only until the issue above is resolved.'
          : 'Styles are read-only because this file is outside a workspace.';
        locked.style.cssText = 'font-size:12px;color:#8a6b2b;line-height:1.4;margin:0 0 12px;';
        panel.appendChild(locked);
      }

      panel.appendChild(sectionLabel(document, 'Available styles'));
      if (!styles.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No CSS-backed styles are defined yet.';
        empty.style.cssText = 'font-size:12.5px;color:' + GRAY_MUTED + ';line-height:1.45;margin:8px 0 18px;';
        panel.appendChild(empty);
      }
      appendStyleGroups(panel, styles, target, activeManaged, styleState.writable);

      if (typeof panel.scrollTop === 'number') panel.scrollTop = prevScrollTop;
      if (revealCreateForm) {
        revealCreateForm = false;
        const created = typeof panel.querySelector === 'function' ? panel.querySelector('#style-create-form') : null;
        if (created && typeof created.scrollIntoView === 'function') created.scrollIntoView({ block: 'nearest' });
      }
    }

    // A group renders collapsed (header only) until it is toggled open, an editor
    // is open inside it, or the create form is aimed at it — so opening any editor
    // never leaves its group visually shut.
    function groupExpanded(targetKey, styles, target) {
      if (expandedGroups.has(targetKey)) return true;
      if (editClassName === '') {
        const effKind = draftTarget != null ? draftTarget : targetForKind(target && target.kind);
        if (effKind === targetKey) return true; // create form targets this group
      }
      if (editClassName) {
        if (editClassName === DEFAULT_CLASS_PREFIX + targetKey) return true; // base editor open here
        const editing = styles.find((s) => s.className === editClassName);
        if (editing && (TARGET_LABEL[editing.target] ? editing.target : 'all') === targetKey) return true; // preset editor open here
      }
      return false;
    }

    function appendStyleGroups(parent, styles, target, activeManaged, writable) {
      const groups = new Map();
      for (const style of styles) {
        const key = TARGET_LABEL[style.target] ? style.target : 'all';
        const group = groups.get(key) || [];
        group.push(style);
        groups.set(key, group);
      }

      // The page canvas renders first so document-level styling (fill, content
      // width, table shadow) is never buried under the element kinds — then
      // every element kind renders, styled or not; nothing stays hidden in code.
      parent.appendChild(pageStyleGroup(styles, writable));
      for (const [targetKey, targetLabel] of TARGET_OPTIONS) {
        const groupStyles = groups.get(targetKey) || [];
        parent.appendChild(styleTargetGroup(targetKey, targetLabel, groupStyles, styles, target, activeManaged, writable));
      }
    }

    // The page group is base-style-only: one always-on document-level style,
    // no presets and no add button (a page preset could never be "applied").
    function pageStyleGroup(styles, writable) {
      const group = document.createElement('section');
      group.className = 'style-target-group style-page-group';
      if (group.classList && typeof group.classList.add === 'function') {
        group.classList.add('style-target-group');
        group.classList.add('style-page-group');
      }
      group.setAttribute('aria-label', 'Page styles');
      group.style.cssText = 'margin:0 0 12px;background:#fff;';

      const expanded = groupExpanded('page', styles, null);
      const bodyId = 'style-group-body-page';

      const header = document.createElement('div');
      header.className = 'style-target-heading';
      if (header.classList && typeof header.classList.add === 'function') header.classList.add('style-target-heading');
      header.style.cssText =
        'display:flex;align-items:center;gap:9px;padding:7px 10px;margin-bottom:6px;border-radius:8px;background:#f0f0f0;';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'style-group-toggle';
      if (toggle.classList && typeof toggle.classList.add === 'function') toggle.classList.add('style-group-toggle');
      toggle.style.cssText =
        'flex:1;min-width:0;display:flex;align-items:center;gap:9px;text-align:left;border:0;background:transparent;padding:0;' +
        'cursor:pointer;font-family:' + fontFamily + ';';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + 'Page styles');
      toggle.setAttribute('aria-controls', bodyId);
      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = expanded ? '▾' : '▸';
      chevron.style.cssText = 'flex:none;font-size:9px;color:' + GRAY_LABEL + ';';
      const headerText = document.createElement('span');
      headerText.textContent = 'Page';
      headerText.style.cssText =
        'min-width:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:' + GRAY_LABEL + ';';
      toggle.append(chevron, headerText);
      toggle.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (expandedGroups.has('page')) expandedGroups.delete('page');
        else expandedGroups.add('page');
        buildPanel(true);
      });
      header.append(toggle);
      group.appendChild(header);
      if (expanded) {
        const body = document.createElement('div');
        body.setAttribute('id', bodyId);
        body.appendChild(baseStyleRow('page', 'Page', styles, writable, null));
        group.appendChild(body);
      }
      return group;
    }

    function styleTargetGroup(targetKey, label, groupStyles, styles, target, activeManaged, writable) {
      const presets = groupStyles.filter((style) => !style.isDefault);
      const group = document.createElement('section');
      group.className = 'style-target-group';
      if (group.classList && typeof group.classList.add === 'function') group.classList.add('style-target-group');
      group.setAttribute('aria-label', label + ' styles');
      group.style.cssText = 'margin:0 0 12px;background:#fff;';

      const expanded = groupExpanded(targetKey, styles, target);
      const bodyId = 'style-group-body-' + targetKey;

      const header = document.createElement('div');
      header.className = 'style-target-heading';
      if (header.classList && typeof header.classList.add === 'function') header.classList.add('style-target-heading');
      header.style.cssText =
        'display:flex;align-items:center;gap:9px;padding:7px 10px;margin-bottom:6px;border-radius:8px;background:#f0f0f0;';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'style-group-toggle';
      if (toggle.classList && typeof toggle.classList.add === 'function') toggle.classList.add('style-group-toggle');
      toggle.style.cssText =
        'flex:1;min-width:0;display:flex;align-items:center;gap:9px;text-align:left;border:0;background:transparent;padding:0;' +
        'cursor:pointer;font-family:' + fontFamily + ';';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + label + ' styles');
      toggle.setAttribute('aria-controls', bodyId);
      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = expanded ? '▾' : '▸';
      chevron.style.cssText = 'flex:none;font-size:9px;color:' + GRAY_LABEL + ';';
      const headerText = document.createElement('span');
      headerText.textContent = label + ' (' + presets.length + ')';
      headerText.style.cssText =
        'min-width:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:' + GRAY_LABEL + ';';
      toggle.append(chevron, headerText);
      toggle.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (expandedGroups.has(targetKey)) expandedGroups.delete(targetKey);
        else expandedGroups.add(targetKey);
        buildPanel(true);
      });
      header.append(toggle);
      const addBtn = smallButton(document, '+', fontFamily);
      addBtn.title = 'Add ' + label + ' style';
      addBtn.setAttribute('aria-label', 'Add ' + label + ' style');
      addBtn.style.minWidth = '28px';
      addBtn.style.padding = '3px 0';
      addBtn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        editClassName = '';
        draftTarget = targetKey;
        revealCreateForm = true;
        buildPanel(true);
      });
      header.appendChild(addBtn);
      group.appendChild(header);

      if (!expanded) return group;

      const body = document.createElement('div');
      body.setAttribute('id', bodyId);

      const effectiveDraftKind = draftTarget != null ? draftTarget : (editClassName === '' ? targetForKind(target && target.kind) : null);
      if (editClassName === '' && effectiveDraftKind === targetKey) {
        const editing = emptyDraft(styles, target);
        const createForm = styleForm(editing, styles, writable);
        createForm.setAttribute('id', 'style-create-form');
        createForm.style.margin = '2px 0 8px';
        body.appendChild(createForm);
      }

      if (targetKey !== 'all') {
        body.appendChild(baseStyleRow(targetKey, label, styles, writable, target));
        const variants = STRUCTURAL_VARIANTS[targetKey];
        if (variants) {
          for (const entry of variants) {
            body.appendChild(baseStyleRow(targetKey, label, styles, writable, target, entry[0], entry[1]));
          }
        }
      }
      for (const style of presets) {
        body.appendChild(styleRow(style, styles, target, activeManaged, writable));
      }
      if (!presets.length) {
        const empty = document.createElement('div');
        empty.className = 'style-group-empty';
        if (empty.classList && typeof empty.classList.add === 'function') empty.classList.add('style-group-empty');
        empty.textContent = 'No styles yet.';
        empty.style.cssText = 'font-size:11.5px;color:' + GRAY_MUTED + ';padding:4px 0 7px 10px;';
        body.appendChild(empty);
      }
      group.appendChild(body);
      return group;
    }

    // The always-on look of every element of this kind. Clicking edits it in
    // place — it is never "applied" to a selection, so no applyStyle is posted.
    function baseStyleRow(targetKey, label, styles, writable, target, variant, variantLabel) {
      const className = DEFAULT_CLASS_PREFIX + targetKey + (variant ? '-' + variant : '');
      const base = styles.find((style) => style.isDefault && style.target === targetKey
        && (variant ? style.structuralVariant === variant : !style.structuralVariant)) || null;
      // Variant rows are caret-only, like the page row: they are structural defaults,
      // not something you apply to or clear from a selection.
      const caretOnly = targetKey === 'page' || !!variant;
      const rowLabel = variantLabel ? label + ' — ' + variantLabel : label;
      const wrap = document.createElement('div');
      wrap.className = 'style-base-wrap';
      if (wrap.classList && typeof wrap.classList.add === 'function') wrap.classList.add('style-base-wrap');
      wrap.style.cssText = 'border-bottom:1px solid ' + GRAY_HAIRLINE + ';padding:0;';
      const row = document.createElement('div');
      row.style.cssText =
        'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:5px 10px 5px 10px;background:#fff;';

      const meta = document.createElement('button');
      meta.type = 'button';
      meta.className = 'style-base-edit';
      if (meta.classList && typeof meta.classList.add === 'function') meta.classList.add('style-base-edit');
      if (caretOnly) {
        meta.title = 'Edit base style for ' + rowLabel;
        meta.setAttribute('aria-label', 'Edit base style for ' + rowLabel);
      } else {
        meta.title = 'Use base style for ' + rowLabel + ' — clears the applied style on the selected element';
        meta.setAttribute('aria-label', 'Apply base style for ' + rowLabel);
      }
      meta.style.cssText =
        'display:flex;align-items:center;gap:7px;text-align:left;border:0;background:transparent;padding:0;' +
        'min-width:0;cursor:pointer;color:' + GRAY_STRONG + ';font-family:' + fontFamily + ';';
      const chip = document.createElement('span');
      chip.textContent = 'Base';
      chip.style.cssText =
        'flex:none;border:1px solid ' + GRAY_HAIRLINE + ';background:#f4f6f7;color:' + GRAY_LABEL + ';border-radius:999px;' +
        'font:700 8.5px/1 ' + fontFamily + ';letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;';
      const summary = document.createElement('span');
      if (base) {
        summary.textContent = base.name;
        summary.style.cssText = previewCss(base);
      } else {
        summary.textContent = 'DITA Editor surface stylesheet';
        summary.style.cssText =
          'display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:' + GRAY_MUTED + ';';
      }
      // Leading accent rail when the base style defines a border colour, mirroring
      // styleRow so the "border colour ⟺ accent rail" cue holds for base rows too.
      if (base && base.borderColor) {
        const rail = document.createElement('span');
        rail.className = 'style-accent-rail';
        if (rail.classList && typeof rail.classList.add === 'function') rail.classList.add('style-accent-rail');
        rail.setAttribute('aria-hidden', 'true');
        rail.style.cssText = 'width:2px;align-self:stretch;border-radius:999px;background:' + base.borderColor + ';';
        meta.append(rail, chip, summary);
      } else {
        meta.append(chip, summary);
      }

      const expanded = editClassName === className;
      const editorId = 'style-editor-' + className;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = expanded ? '▴' : '▾';
      editBtn.style.cssText = iconButtonCss(fontFamily) + 'width:28px;';
      editBtn.title = expanded ? 'Collapse base style editor' : 'Expand base style editor';
      editBtn.setAttribute('aria-label', (expanded ? 'Collapse' : 'Expand') + ' base style editor for ' + rowLabel);
      editBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      editBtn.setAttribute('aria-controls', editorId);
      const toggle = (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        editClassName = expanded ? null : className;
        buildPanel(true);
      };
      editBtn.addEventListener('click', toggle);
      // The meta clears the applied style on the selection (revert to the always-on
      // base look), mirroring styleRow's apply pattern — only the caret edits the base.
      // Page and structural variants have no per-element apply, so they open via caret only.
      if (!caretOnly) {
        let basePointerApplied = false;
        meta.addEventListener('pointerdown', (event) => {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
          if (event.button != null && event.button !== 0) return;
          basePointerApplied = true;
          applyStyle('', target, styles, targetKey);
        });
        meta.addEventListener('mousedown', (event) => {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
        });
        meta.addEventListener('click', (event) => {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
          if (basePointerApplied) {
            basePointerApplied = false;
            return;
          }
          applyStyle('', target, styles, targetKey);
        });
      } else {
        // Caret-only rows (page + structural variants) have no apply/clear semantics,
        // so a body click opens the in-place editor — same as the caret — instead of
        // doing nothing.
        meta.addEventListener('click', toggle);
      }

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:5px;align-items:center;';
      actions.appendChild(editBtn);
      row.append(meta, actions);
      wrap.appendChild(row);
      if (expanded) {
        const draft = base || {
          name: 'Base ' + rowLabel.toLowerCase(),
          className: className,
          target: targetKey,
          isDefault: true,
          structuralVariant: variant || undefined,
        };
        const form = styleForm(draft, styles, writable);
        form.setAttribute('id', editorId);
        form.style.margin = '0 0 5px;';
        form.style.padding = '8px 8px 9px 4px;';
        form.style.boxSizing = 'border-box';
        wrap.appendChild(form);
      }
      return wrap;
    }

    function styleRow(style, styles, target, activeManaged, writable) {
      // Applied = this preset's class is on the selection or any of its ancestors.
      const isApplied = appliedManagedSet.has(style.className);
      const wrap = document.createElement('div');
      wrap.className = 'style-row-wrap';
      if (wrap.classList && typeof wrap.classList.add === 'function') {
        wrap.classList.add('style-row-wrap');
        if (isApplied) wrap.classList.add('style-row-applied');
      }
      // Applied styles get an accent ring (replaces the old "Applied" text badge).
      wrap.style.cssText = isApplied
        ? 'border:2px solid var(--dc-color-accent, #2563eb);border-radius:7px;padding:0;margin:3px 0;box-sizing:border-box;overflow:hidden;'
        : 'border-bottom:1px solid ' + GRAY_HAIRLINE + ';padding:0;';
      const row = document.createElement('div');
      row.className = 'style-row';
      row.style.cssText =
        'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:5px 10px 5px 10px;' +
        'background:' + (isApplied ? '#eff6ff' : '#fff') + ';';
      const meta = document.createElement('button');
      meta.type = 'button';
      meta.className = 'style-apply';
      meta.title = 'Apply ' + style.name;
      meta.setAttribute('aria-label', 'Apply ' + style.name);
      meta.style.cssText =
        'display:flex;align-items:center;gap:7px;text-align:left;border:0;background:transparent;padding:0;' +
        'min-width:0;cursor:pointer;color:' + GRAY_STRONG + ';font-family:' + fontFamily + ';';
      const copy = document.createElement('span');
      copy.style.cssText = 'display:block;min-width:0;';
      const topLine = document.createElement('span');
      topLine.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:2px;';
      const name = document.createElement('span');
      name.textContent = style.name;
      name.style.cssText = previewCss(style);
      if (style.backgroundColor && (style.target === 'tableCell' || style.target === 'tableRow')) {
        const swatch = document.createElement('span');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.cssText = 'flex:none;width:10px;height:10px;border-radius:3px;border:1px solid ' + GRAY_HAIRLINE + ';background:' + style.backgroundColor + ';';
        topLine.append(swatch);
      }
      topLine.append(name);
      copy.append(topLine);
      if (style.borderColor) {
        const rail = document.createElement('span');
        rail.className = 'style-accent-rail';
        if (rail.classList && typeof rail.classList.add === 'function') rail.classList.add('style-accent-rail');
        rail.setAttribute('aria-hidden', 'true');
        rail.style.cssText =
          'width:2px;align-self:stretch;border-radius:999px;background:' + style.borderColor + ';';
        meta.appendChild(rail);
      }
      meta.appendChild(copy);
      const canApply = !!(target && target.ids && target.ids.length);
      meta.setAttribute('aria-disabled', canApply ? 'false' : 'true');
      if (!canApply) meta.style.cursor = 'not-allowed';
      let pointerApplied = false;
      meta.addEventListener('pointerdown', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (event.button != null && event.button !== 0) return;
        pointerApplied = true;
        applyStyle(style.className, target, styles);
      });
      meta.addEventListener('mousedown', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
      });
      meta.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (pointerApplied) {
          pointerApplied = false;
          return;
        }
        applyStyle(style.className, target, styles);
      });
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:5px;align-items:center;';
      const expanded = editClassName === style.className;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = expanded ? '▴' : '▾';
      editBtn.style.cssText = iconButtonCss(fontFamily) + 'width:28px;';
      const editorId = 'style-editor-' + style.className;
      editBtn.title = expanded ? 'Collapse style editor' : 'Expand style editor';
      editBtn.setAttribute('aria-label', expanded ? 'Collapse editor for ' + style.name : 'Expand editor for ' + style.name);
      editBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      editBtn.setAttribute('aria-controls', editorId);
      editBtn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        editClassName = expanded ? null : style.className;
        buildPanel(true);
      });
      actions.append(editBtn);
      row.append(meta, actions);
      wrap.appendChild(row);
      if (expanded) {
        const form = styleForm(style, styles, writable);
        form.setAttribute('id', editorId);
        form.style.margin = '0 0 5px;';
        form.style.padding = '8px 8px 9px 4px;';
        form.style.boxSizing = 'border-box';
        wrap.appendChild(form);
      }
      return wrap;
    }

    function styleForm(style, styles, writable) {
      // Bind edits to the inspection that produced this form. A watcher refresh may
      // update global styleState while focus keeps the old form mounted; using the
      // newer hash with the older style array would defeat host stale-write refusal.
      const displayedSourceHash = String(state().sourceHash || '');
      const displayedTargetToken = String(state().targetToken || '');
      const displayedCssPath = String(state().cssPath || '');
      const isDefaultStyle = style.isDefault === true;
      const styleWasPresent = styles.some((item) => item.className === style.className);
      const formMutationId = saveRequestSessionId + ':style-form-' + nextFormMutationSequence++;
      // Existing rows from the same source generation share one pending lineage
      // across rebuilds; New forms are separate create intents even when both
      // start from the same generated class name.
      const logicalStyleIdentity = [
        displayedTargetToken,
        displayedSourceHash,
        styleWasPresent ? 'style' : 'new-style',
        style.className,
      ];
      if (!styleWasPresent) logicalStyleIdentity.push(formMutationId);
      const logicalStyleId = JSON.stringify(logicalStyleIdentity);
      let formCurrentClassName = style.className;
      let lastQueuedDraftSignature = '';
      const form = document.createElement('form');
      form.className = 'style-form';
      form.style.cssText = 'display:flex;flex-direction:column;gap:9px;margin:8px 0 4px;';
      const controls = [];
      const nameInput = field('Name', style.name || '');
      const classInput = field('Class', style.className || '');
      const targetSelect = document.createElement('select');
      targetSelect.setAttribute('aria-label', 'Target');
      targetSelect.className = 'style-field';
      targetSelect.style.cssText = fieldCss(fontFamily);
      for (const [target, label] of TARGET_OPTIONS) {
        const option = document.createElement('option');
        option.value = target;
        option.textContent = TARGET_TAG[target] ? label + ' — ' + TARGET_TAG[target] : label;
        if (style.target === target) option.selected = true;
        targetSelect.appendChild(option);
      }
      targetSelect.value = TARGET_LABEL[style.target] ? style.target : 'all';
      if (isDefaultStyle) {
        // Base styles: class name and target are fixed by the kind; only the
        // display name and CSS values are editable. The style is always on.
        controls.push(nameInput);
        const hint = document.createElement('div');
        hint.textContent = style.target === 'page'
          ? 'Page style — sets the document canvas (fill, content width, table shadow) for every topic.'
          : 'Base style — applies to every ' + (TARGET_LABEL[style.target] || style.target).toLowerCase() + ' without marking the document.';
        hint.style.cssText = 'font-size:11px;color:' + GRAY_MUTED + ';line-height:1.4;';
        form.append(labelWrap(document, 'Name', nameInput), hint);
      } else {
        controls.push(nameInput, classInput, targetSelect);
        form.append(labelWrap(document, 'Name', nameInput), labelWrap(document, 'Class', classInput), labelWrap(document, 'Target', targetSelect));
      }
      const inherited = inheritedFieldValues(TARGET_LABEL[style.target] ? style.target : 'all');
      const valueFields = style.target === 'page' ? PAGE_VALUE_FIELDS : VALUE_FIELDS;
      for (const config of valueFields) {
        const input = choiceField(config, style[config.key] || '', inherited[config.key]);
        controls.push(input);
        form.appendChild(labelWrap(document, config.label, input));
      }
      const error = document.createElement('div');
      error.style.cssText = 'display:none;font-size:12px;color:#9c2f2f;line-height:1.35;';
      form.append(error);
      form._ditaeditorShowSaveError = function (reason) {
        error.textContent = reason;
        error.style.display = reason ? 'block' : 'none';
      };
      if (saveBlockedReason) form._ditaeditorShowSaveError(saveBlockedReason);

      form.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          if (event.preventDefault) event.preventDefault();
          editClassName = null;
          buildPanel(true);
        }
      });
      form.addEventListener('submit', (event) => {
        if (event.preventDefault) event.preventDefault();
        saveDraft(true);
      });

      for (const control of controls) {
        if (typeof control._ditaeditorSubscribe === 'function') {
          control._ditaeditorSubscribe(scheduleAutoSave);
        } else {
          control.addEventListener('input', () => scheduleAutoSave());
          control.addEventListener('change', () => scheduleAutoSave());
        }
      }

      function scheduleAutoSave() {
        if (!writable) return;
        // Persist the controller state synchronously with the input event. A
        // deferred debounce created a loss window: replacing the form could
        // cancel another form's timer, and destroying the iframe discarded a
        // changed draft before it had any durable representation.
        saveDraft(true);
      }

      function saveDraft(silent) {
        if (!writable) {
          const reason = 'Styles are read-only because this file is outside a workspace.';
          error.textContent = reason;
          error.style.display = 'block';
          announceNav(reason);
          return false;
        }
        if (saveBlockedReason) {
          error.textContent = saveBlockedReason;
          error.style.display = 'block';
          announceNav(saveBlockedReason);
          return false;
        }
        const next = readDraft(form, nameInput, classInput, targetSelect);
        if (isDefaultStyle) {
          next.className = style.className;
          next.target = style.target;
          next.isDefault = true;
          // Preserve the structural variant so the reserved class name (and thus the
          // predicate selector) survives a base-row edit; dropping it would collapse
          // the class onto the plain base and destroy this variant.
          if (style.structuralVariant) next.structuralVariant = style.structuralVariant;
        }
        const reason = validationError(next, styles, style.className);
        if (reason) {
          error.textContent = reason;
          error.style.display = 'block';
          announceNav(reason);
          return false;
        }
        const draftSignature = JSON.stringify(next);
        if (draftSignature === lastQueuedDraftSignature) return true;
        error.textContent = '';
        error.style.display = 'none';
        const queued = queueStyleMutation(
          { sourceHash: displayedSourceHash, targetToken: displayedTargetToken, cssPath: displayedCssPath },
          styles,
          logicalStyleId,
          formMutationId,
          style,
          formCurrentClassName,
          next,
          !!silent,
        );
        if (!queued) {
          const rebaseError = queueErrorReason
            || 'The latest style draft could not be safely combined with the saved stylesheet. Reload the Styles panel before trying again.';
          error.textContent = rebaseError;
          error.style.display = 'block';
          announceNav(rebaseError);
          return false;
        }
        lastQueuedDraftSignature = draftSignature;
        formCurrentClassName = next.className;
        editClassName = next.className;
        return true;
      }

      return form;
    }

    function readDraft(form, nameInput, classInput, targetSelect) {
      const next = {
        name: String(nameInput.value || '').trim(),
        className: String(classInput.value || '').trim(),
        target: String(targetSelect.value || 'heading'),
      };
      const fields = Array.prototype.slice.call(form.querySelectorAll('[data-style-field]'));
      for (const input of fields) {
        const key = input.getAttribute('data-style-field');
        const value = String(input.value || '').trim();
        if (key && value) next[key] = value;
      }
      return next;
    }

    function validationError(style, styles, previousClassName) {
      if (!style.name) return 'Style name is required.';
      if (!CLASS_NAME_RE.test(style.className)) return 'Class must use CSS-safe letters, numbers, underscores, or hyphens.';
      if (!style.isDefault && style.className.indexOf(DEFAULT_CLASS_PREFIX) === 0) {
        return 'Class names starting with "' + DEFAULT_CLASS_PREFIX + '" are reserved for base styles.';
      }
      if (styles.some((item) => item.className === style.className && item.className !== previousClassName)) {
        return 'A style with that class already exists.';
      }
      const cssValueKeys = new Set(VALUE_FIELDS.concat(PAGE_VALUE_FIELDS).map((field) => field.key));
      for (const key of Object.keys(style)) {
        if (!cssValueKeys.has(key)) continue;
        if (typeof style[key] === 'string' && (/[{};<>]/.test(style[key]) || style[key].indexOf('*/') >= 0)) {
          return 'CSS values cannot contain braces, semicolons, angle brackets, or comment endings.';
        }
      }
      return null;
    }

    function applyStyle(className, target, styles, styleTargetOverride) {
      const liveTarget = getCurrentTarget ? getCurrentTarget() : null;
      const effectiveTarget = liveTarget && liveTarget.ids && liveTarget.ids.length ? liveTarget : target;
      if (!effectiveTarget || !effectiveTarget.ids || !effectiveTarget.ids.length) {
        announceNav('Select an element before applying a style.');
        return;
      }
      if (className) {
        // The host resolves the class against its current inspected stylesheet and
        // derives both the structural target and complete removable class set.
        vscode.postMessage({
          type: 'applyStyle', ids: effectiveTarget.ids, className: className,
          baseStructVersion: getStructVersion(),
        });
        return;
      }
      // A clear has no class from which to derive a target. The caller supplies
      // only the closed target key; the host validates it against fresh DITA and
      // derives the removable classes itself.
      const styleTarget = (styleTargetOverride != null && styleTargetOverride !== '')
        ? styleTargetOverride
        : styleTargetForClass(className, styles);
      vscode.postMessage({
        type: 'clearStyle', ids: effectiveTarget.ids, styleTarget: styleTarget,
        baseStructVersion: getStructVersion(),
      });
    }

    function refresh(force) {
      buildPanel(!!force);
    }

    function acceptSaveResult(result) {
      if (!result || result.type !== 'styleSaveResult' || typeof result.requestId !== 'string') return false;
      if (result.ok !== true && result.ok !== false) return false;
      if (inFlightSave == null || result.requestId !== inFlightSave.requestId) return false;
      const currentFrameRequest = isRequestForSession(result.requestId, saveRequestSessionId);
      if (!currentFrameRequest && result.requestId !== restoredRequestId) return false;
      const completed = inFlightSave;
      const queued = pendingMutations;
      const hasValidSuccessPayload = result.ok === true
        && typeof result.sourceHash === 'string'
        && !!result.sourceHash
        && isStyleArray(result.acceptedStyles);
      if (!hasValidSuccessPayload) {
        inFlightSave = null;
        pendingMutations = [];
        restoredRequestId = '';
        saveBlockedReason = typeof result.error === 'string' && result.error
          ? result.error
          : result.ok === true && (typeof result.sourceHash !== 'string' || !result.sourceHash)
            ? 'The style save confirmation did not include a new source hash. Close and reopen the style editor before saving again.'
            : result.ok === true
              ? 'The style save confirmation did not include the accepted stylesheet snapshot. Reload the Styles panel before saving again.'
            : 'The stylesheet could not be saved. Close and reopen the style editor before saving again.';
        acceptedSourceHashes.delete(completed.sourceHash);
        if (!persistSaveController()) {
          inFlightSave = completed;
          pendingMutations = queued;
          restoredRequestId = currentFrameRequest ? '' : completed.requestId;
          showSaveError('DITA Editor could not safely record the failed style save. Keep this editor open and try again.');
          return true;
        }
        vscode.postMessage({ type: 'styleSaveResultAck', requestId: completed.requestId });
        showSaveError(saveBlockedReason);
        return true;
      }
      const currentTargetToken = String(state().targetToken || '');
      if (queued.length && currentTargetToken && currentTargetToken !== completed.targetToken) {
        inFlightSave = null;
        pendingMutations = [];
        restoredRequestId = '';
        saveBlockedReason = 'The active managed stylesheet changed before the queued draft could be saved. Reload the Styles panel before editing the new stylesheet.';
        acceptedSourceHashes.clear();
        latestAcceptedSourceHash = '';
        latestAcceptedTargetToken = '';
        latestAcceptedStyles = null;
        logicalClassNames.clear();
        if (!persistSaveController()) {
          inFlightSave = completed;
          pendingMutations = queued;
          restoredRequestId = currentFrameRequest ? '' : completed.requestId;
          replaceLogicalClassNames(queued);
          showSaveError('DITA Editor could not safely retain the queued style draft after the stylesheet destination changed. Keep this editor open and try again.');
          return true;
        }
        vscode.postMessage({ type: 'styleSaveResultAck', requestId: completed.requestId });
        showSaveError(saveBlockedReason);
        return true;
      }
      acceptedSourceHashes.add(completed.sourceHash);
      acceptedSourceHashes.add(result.sourceHash);
      latestAcceptedSourceHash = result.sourceHash;
      latestAcceptedTargetToken = completed.targetToken;
      const acceptedStyles = result.acceptedStyles;
      latestAcceptedStyles = acceptedStyles;
      const completedCssPath = completed.cssPath;
      const completedTargetToken = completed.targetToken;
      inFlightSave = null;
      pendingMutations = [];
      restoredRequestId = '';
      saveBlockedReason = '';
      if (queued.length) {
        let rebasedStyles = acceptedStyles;
        for (const mutation of queued) {
          rebasedStyles = applyStyleMutation(rebasedStyles, mutation);
          if (rebasedStyles == null) break;
        }
        if (rebasedStyles == null) {
          saveBlockedReason = 'The latest style draft could not be safely combined with the saved stylesheet. Reload the Styles panel before trying again.';
          logicalClassNames.clear();
          if (!persistSaveController()) {
            inFlightSave = completed;
            pendingMutations = queued;
            restoredRequestId = currentFrameRequest ? '' : completed.requestId;
            replaceLogicalClassNames(queued);
            showSaveError('DITA Editor could not safely retain the queued style draft after reconciliation failed. Keep this editor open and try again.');
            return true;
          }
          vscode.postMessage({ type: 'styleSaveResultAck', requestId: completed.requestId });
          showSaveError(saveBlockedReason);
          return true;
        }
        replaceLogicalClassNames(queued);
        prepareSave({ styles: rebasedStyles, silent: true }, result.sourceHash, completedTargetToken, completedCssPath);
        if (!postPreparedSave()) {
          inFlightSave = completed;
          pendingMutations = queued;
          restoredRequestId = currentFrameRequest ? '' : completed.requestId;
          return true;
        }
      } else {
        logicalClassNames.clear();
        if (!persistSaveController()) {
          inFlightSave = completed;
          pendingMutations = queued;
          restoredRequestId = currentFrameRequest ? '' : completed.requestId;
          showSaveError('DITA Editor could not safely finish this style save. Keep this editor open and try again.');
          return true;
        }
      }
      vscode.postMessage({ type: 'styleSaveResultAck', requestId: completed.requestId });
      return true;
    }

    document.addEventListener('selectionchange', () => refresh(false));
    document.addEventListener('keyup', () => refresh(false));
    document.addEventListener('click', () => refresh(false));
    applyTopChromeHeight();
    setCollapsed(true);
    restoreSaveController();
    refresh(true);
    return {
      refresh: refresh,
      acceptSaveResult: acceptSaveResult,
      panel: panel,
      resizeHandle: resizeHandle,
      hideButton: hideButton,
      showButton: showButton,
      applyLiveCss: function () {
        liveStyle.textContent = state().cssText || '';
        syncBaseEditorWidth();
      },
    };

    function emptyDraft(styles, target) {
      const base = 'dc-new-style';
      let className = base;
      let index = 2;
      const used = new Set(styles.map((style) => style.className));
      while (used.has(className)) className = base + '-' + index++;
      const draftKind = TARGET_LABEL[draftTarget] ? draftTarget : targetForKind(target && target.kind);
      return { name: 'New style', className: className, target: draftKind };
    }

    // Reads the actual effective value of every style field from a sample element
    // of the kind, so the style editor's empty choices can say "16px (default)"
    // instead of a bare "Default". Empty map when nothing can be computed.
    function inheritedFieldValues(targetKey) {
      const out = {};
      if (!win || typeof win.getComputedStyle !== 'function') return out;
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
        const computed = win.getComputedStyle(element);
        if (computed && typeof computed.getPropertyValue === 'function') {
          for (const [fieldKey, cssProp] of INSPECT_FIELDS) {
            const value = formatCssValue(String(computed.getPropertyValue(cssProp) || '').trim());
            if (value) out[fieldKey] = value;
          }
        }
      } catch (err) {
        // Fall through to dispose; the caller falls back to plain "Default" labels.
      }
      if (dispose) dispose();
      return out;
    }

    // Mounts a hidden, out-of-flow element built from the renderer's markup
    // contract inside the real cascade (.body), so theme values are readable
    // even when the topic contains no element of the kind. Removed synchronously.
    function mountProbe(targetKey) {
      const spec = PROBE_MARKUP[targetKey];
      if (!spec || typeof document.createElement !== 'function' || typeof document.querySelector !== 'function') return null;
      const host = document.querySelector('.body') || main || document.body;
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

    function hasConfiguredWorkspaceStylesheet() {
      if (!document || typeof document.querySelectorAll !== 'function') return false;
      // Task 6 must mark configured links explicitly when it wires the final
      // cascade. Basenames are not origin metadata and may legitimately collide.
      return document.querySelectorAll(
        'link[rel="stylesheet"][data-ditaeditor-style-origin="configured"]',
      ).length > 0;
    }

    // Model-based provenance: only values owned by the author style model get a
    // field badge. Computed values may instead be inherited or user-agent defaults;
    // Task 6 must provide per-property source metadata before attribution expands.
    function provenanceForField(fieldKey, activeStyle, baseStyle) {
      if (activeStyle && activeStyle[fieldKey]) return 'managed author stylesheet';
      if (baseStyle && baseStyle[fieldKey]) return 'managed author stylesheet';
      return '';
    }

    function buildInspector(target, activeStyle, styles) {
      if (!target || !target.ids || target.ids.length !== 1) return null;
      if (!win || typeof win.getComputedStyle !== 'function') return null;
      const element = resolveElement(target.ids[0]);
      if (!element) return null;
      let computed = null;
      try {
        computed = win.getComputedStyle(element);
      } catch (err) {
        return null;
      }
      if (!computed || typeof computed.getPropertyValue !== 'function') return null;
      const styleTarget = targetForKind(target.kind);
      const baseStyle = styles.find((style) => style.isDefault && style.target === styleTarget) || null;

      const box = document.createElement('div');
      box.className = 'style-inspector';
      if (box.classList && typeof box.classList.add === 'function') box.classList.add('style-inspector');
      box.style.cssText = 'margin-top:9px;';
      const hasConfiguredStylesheet = hasConfiguredWorkspaceStylesheet();
      const sourceDescription = hasConfiguredStylesheet
        ? 'configured workspace stylesheet'
        : 'DITA Editor surface stylesheet';
      const sourceSummary = document.createElement('div');
      sourceSummary.className = 'style-source-summary';
      if (sourceSummary.classList && typeof sourceSummary.classList.add === 'function') {
        sourceSummary.classList.add('style-source-summary');
      }
      sourceSummary.textContent = sourceDescription;
      sourceSummary.title = sourceDescription;
      sourceSummary.style.cssText =
        'margin:0 0 6px;color:' + GRAY_MUTED + ';font:600 10px/1.4 ' + fontFamily + ';text-transform:uppercase;';
      box.appendChild(sourceSummary);
      for (const [fieldKey, cssProp, label] of INSPECT_FIELDS) {
        const value = String(computed.getPropertyValue(cssProp) || '').trim();
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'style-inspect-row';
        if (row.classList && typeof row.classList.add === 'function') row.classList.add('style-inspect-row');
        row.style.cssText = 'display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:6px;align-items:center;padding:2px 0;';
        const labEl = document.createElement('span');
        labEl.textContent = label;
        labEl.style.cssText = 'font-size:10.5px;color:' + GRAY_LABEL + ';';
        const valEl = document.createElement('span');
        valEl.textContent = value;
        valEl.style.cssText =
          'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
          'font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:' + GRAY_STRONG + ';';
        const provenance = provenanceForField(fieldKey, activeStyle, baseStyle);
        row.append(labEl, valEl);
        if (provenance) {
          const provEl = document.createElement('span');
          provEl.className = 'style-inspect-prov';
          if (provEl.classList && typeof provEl.classList.add === 'function') provEl.classList.add('style-inspect-prov');
          provEl.textContent = provenance;
          provEl.title = provenance;
          provEl.style.cssText =
            'flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:1px 6px;' +
            'font:600 8.5px/1.5 ' + fontFamily + ';letter-spacing:.04em;text-transform:uppercase;' +
            'border:1px solid #cbd9df;background:#f0f7fa;color:#31586a;';
          row.appendChild(provEl);
        }
        box.appendChild(row);
      }
      return box.childNodes && box.childNodes.length ? box : null;
    }

    function styleTargetForClass(className, styles) {
      if (!className) return '';
      const style = styles.find(function (item) { return item.className === className; });
      return style && style.target ? style.target : '';
    }

    function targetForKind(kind) {
      if (kind === 'title') return 'title';
      if (kind === 'p') return 'body';
      if (kind === 'shortdesc') return 'shortdesc';
      if (kind === 'section') return 'section';
      if (kind === 'ul' || kind === 'ol' || kind === 'steps') return 'list';
      if (kind === 'li' || kind === 'step') return 'listItem';
      if (kind === 'table') return 'table';
      if (kind === 'row') return 'tableRow';
      if (kind === 'entry') return 'tableCell';
      if (kind === 'fig') return 'figure';
      if (kind === 'image') return 'image';
      if (kind === 'note') return 'note';
      if (kind === 'codeblock' || kind === 'codeph') return 'code';
      if (kind === 'lines') return 'lines';
      return 'all';
    }

    function field(label, value, placeholder) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.setAttribute('aria-label', label);
      input.className = 'style-field';
      input.style.cssText = fieldCss(fontFamily);
      return input;
    }

    function pickerHex(value) {
      const text = String(value || '').trim();
      const short = text.match(/^#([0-9a-f]{3})$/i);
      if (short) return '#' + short[1].split('').map(function (part) { return part + part; }).join('').toLowerCase();
      const full = text.match(/^#([0-9a-f]{6})$/i);
      if (full) return '#' + full[1].toLowerCase();
      const rgb = text.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i);
      if (rgb) {
        return '#' + rgb.slice(1, 4).map(function (part) {
          return Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0');
        }).join('');
      }
      const fallback = text.match(/#[0-9a-f]{6}/i);
      return fallback ? fallback[0].toLowerCase() : '#000000';
    }

    function colorChoiceField(config, value, inheritedValue) {
      const wrap = document.createElement('div');
      wrap.className = 'style-color-control';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', config.label + ' color controls');
      wrap.style.cssText = 'display:grid;grid-template-columns:36px minmax(0,1fr);gap:6px;align-items:center;';
      wrap._ditaeditorCompound = true;

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = pickerHex(value || inheritedValue);
      picker.setAttribute('aria-label', 'Pick ' + config.label.toLowerCase() + ' color');
      picker.className = 'style-color-picker';
      picker.style.cssText = 'width:36px;height:32px;padding:2px;border:1px solid ' + GRAY_HAIRLINE + ';border-radius:6px;background:#fff;cursor:pointer;';

      const raw = document.createElement('input');
      raw.type = 'text';
      raw.value = value || '';
      raw.placeholder = inheritedValue || 'Default or CSS color value';
      raw.setAttribute('aria-label', config.label + ' CSS color value');
      raw.setAttribute('data-style-field', config.key);
      raw.className = 'style-field style-color-value';
      raw.style.cssText = fieldCss(fontFamily);

      const presets = document.createElement('select');
      presets.setAttribute('aria-label', config.label + ' color preset');
      presets.className = 'style-field style-color-preset';
      presets.style.cssText = fieldCss(fontFamily) + 'grid-column:1 / -1;';
      let matched = false;
      for (const choice of config.choices) {
        const option = document.createElement('option');
        option.value = choice[0];
        option.textContent = choice[0] === '' && inheritedValue
          ? inheritedValue + ' (default)'
          : choice[1];
        if (value === choice[0]) matched = true;
        presets.appendChild(option);
      }
      if (value && !matched) {
        const custom = document.createElement('option');
        custom.value = value;
        custom.textContent = 'Custom: ' + value;
        presets.appendChild(custom);
      }
      presets.value = value || '';

      const defaultButton = smallButton(document, 'Default', fontFamily);
      defaultButton.setAttribute('aria-label', 'Clear ' + config.label.toLowerCase() + ' color and use the default');
      defaultButton.style.gridColumn = '1 / -1';

      function syncPicker() {
        const normalized = pickerHex(raw.value);
        picker.value = normalized;
        const representable = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(raw.value.trim())
          || /^rgb\(/i.test(raw.value.trim());
        picker.setAttribute('data-color-representable', String(representable));
        picker.title = representable || raw.value.trim() === ''
          ? 'Choose color'
          : 'The authored CSS value is preserved in the text field; choosing here replaces it with a hex color.';
      }
      syncPicker();
      wrap.append(picker, raw, presets, defaultButton);
      wrap._ditaeditorSubscribe = function (save) {
        picker.addEventListener('input', function () {
          raw.value = String(picker.value || '').toLowerCase();
          presets.value = '';
          syncPicker();
          save();
        });
        presets.addEventListener('change', function () {
          raw.value = presets.value || '';
          syncPicker();
          save();
        });
        defaultButton.addEventListener('click', function (event) {
          if (event.preventDefault) event.preventDefault();
          raw.value = '';
          presets.value = '';
          syncPicker();
          save();
        });
        raw.addEventListener('input', function () {
          presets.value = config.choices.some(function (choice) { return choice[0] === raw.value; }) ? raw.value : '';
          syncPicker();
          save();
        });
        raw.addEventListener('change', function () {
          syncPicker();
          save();
        });
      };
      return wrap;
    }

    function choiceField(config, value, inheritedValue) {
      if (config.color) return colorChoiceField(config, value, inheritedValue);
      if (config.text) {
        // Free-text value field (e.g. the masthead title). Carries data-style-field so
        // readDraft collects it exactly like a choice select.
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', config.label);
        input.setAttribute('data-style-field', config.key);
        input.className = 'style-field';
        input.style.cssText = fieldCss(fontFamily);
        input.placeholder = inheritedValue || 'Default';
        input.value = value || '';
        return input;
      }
      const select = document.createElement('select');
      select.setAttribute('aria-label', config.label);
      select.setAttribute('data-style-field', config.key);
      select.className = 'style-field';
      select.style.cssText = fieldCss(fontFamily);
      let matched = false;
      for (const [choiceValue, choiceLabel] of config.choices) {
        const option = document.createElement('option');
        option.value = choiceValue;
        // The empty choice keeps meaning "no override", but shows the value the
        // element actually inherits so nothing reads as an opaque "Default".
        option.textContent = choiceValue === '' && inheritedValue
          ? inheritedValue + ' (default)'
          : choiceLabel;
        if (value === choiceValue) matched = true;
        select.appendChild(option);
      }
      if (value && !matched) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = value || '';
      return select;
    }
  }

  function smallButton(document, label, fontFamily) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText =
      'border:1px solid ' + GRAY_HAIRLINE + ';border-radius:6px;background:#fff;color:' + GRAY_STRONG + ';cursor:pointer;' +
      'font:600 11.5px/1 ' + fontFamily + ';padding:6px 8px;white-space:nowrap;';
    return btn;
  }

  function labelWrap(document, label, control) {
    const wrap = document.createElement(control && control._ditaeditorCompound ? 'div' : 'label');
    wrap.style.cssText = 'display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:center;';
    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'font-size:11.5px;color:' + GRAY_LABEL + ';';
    if (control && control._ditaeditorCompound) text.setAttribute('aria-hidden', 'true');
    wrap.append(text, control);
    return wrap;
  }

  function sectionLabel(document, text) {
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText =
      'font-weight:650;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:' + GRAY_LABEL + ';margin:17px 0 8px;';
    return label;
  }

  function fieldCss(fontFamily) {
    return 'width:100%;box-sizing:border-box;border:1px solid ' + GRAY_HAIRLINE + ';border-radius:6px;background:#fff;' +
      'color:' + GRAY_STRONG + ';font:12px ' + fontFamily + ';padding:5px 7px;min-width:0;';
  }

  function iconButtonCss(fontFamily) {
    return 'width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;flex:none;' +
      'border:1px solid transparent;border-radius:6px;background:transparent;color:' + GRAY_LABEL + ';cursor:pointer;' +
      'font:600 18px/1 ' + fontFamily + ';padding:0;';
  }

  function previewCss(style) {
    const size = previewFontSize(style.fontSize);
    const weight = style.fontWeight || '600';
    const color = style.color || GRAY_STRONG;
    const bg = style.backgroundColor ? 'background:' + style.backgroundColor + ';padding:2px 6px;border-radius:5px;' : '';
    const letter = style.letterSpacing ? 'letter-spacing:' + style.letterSpacing + ';' : '';
    const transform = style.textTransform ? 'text-transform:' + style.textTransform + ';' : '';
    return 'display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'font-size:' + size + ';font-weight:' + weight + ';color:' + color + ';line-height:1.2;' + bg + letter + transform;
  }

  function previewFontSize(value) {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(String(value || ''));
    if (!px) return '13px';
    const n = Number(px[1]);
    if (!Number.isFinite(n)) return '13px';
    return Math.max(12, Math.min(18, n)) + 'px';
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

  window.DitaEditorCanvasStyles = { installStylesPanel: installStylesPanel };
})();
