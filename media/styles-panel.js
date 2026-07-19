// CSS-backed author Styles panel engine for the DITA Editor Styles view.
//
// Runs inside the native Styles webview view. The panel renders only
// host-provided style definitions and posts save/apply intents; the host owns
// CSS file writes and DITA outputclass edits. Live-CSS painting and
// computed-style sampling stay canvas-side (media/canvas-style-bridge.js);
// the panel reads those snapshots through getInspectorState().
(function () {
  const SAVE_CONTROLLER_STATE_KEY = 'ditaeditorStyleSaveController';
  const SAVE_CONTROLLER_STATE_VERSION = 1;
  // VS Code theme tokens (with the panel's historical light-theme values as
  // fallbacks) so the view follows the editor theme.
  const C = {
    text: 'var(--vscode-foreground, #363636)',
    muted: 'var(--vscode-descriptionForeground, #737373)',
    faint: 'var(--vscode-disabledForeground, #c4c4c4)',
    border: 'var(--vscode-panel-border, rgba(128, 128, 128, 0.25))',
    inputBg: 'var(--vscode-input-background, #fff)',
    inputText: 'var(--vscode-input-foreground, #3f3f3f)',
    inputBorder: 'var(--vscode-input-border, #dedede)',
    badgeBg: 'var(--vscode-badge-background, #ececec)',
    badgeText: 'var(--vscode-badge-foreground, #767676)',
    // Group headers use the sidebar's own section-header tokens: badge colors
    // are a vivid accent in dark themes and turned every header into a blue bar.
    headerBg: 'var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.12))',
    headerText: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground, #363636))',
    iconFg: 'var(--vscode-icon-foreground, #737373)',
    btnBg: 'var(--vscode-button-background, #0e639c)',
    btnFg: 'var(--vscode-button-foreground, #ffffff)',
    btn2Bg: 'var(--vscode-button-secondaryBackground, #e4e4e4)',
    btn2Fg: 'var(--vscode-button-secondaryForeground, #3f3f3f)',
    errorFg: 'var(--vscode-errorForeground, #9c2f2f)',
    warnFg: 'var(--vscode-editorWarning-foreground, #8a6b2b)',
    mono: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
  };
  // One small gray scale for the whole panel — it had 8+ near-identical grays
  // that read as noise. Now mapped onto the theme tokens above; the accent
  // applied state and error red remain distinct.
  const GRAY_STRONG = C.text;
  const GRAY_LABEL = C.muted;
  const GRAY_MUTED = C.muted;
  const GRAY_HAIRLINE = C.border;

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
  const STRUCTURAL_VARIANTS = {};
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
      key: 'borderEdge',
      label: 'Accent edge',
      choices: [
        ['', 'Top + bottom (default)'],
        ['left', 'Left'],
        ['top', 'Top'],
        ['bottom', 'Bottom'],
        ['right', 'Right'],
        ['full', 'All sides'],
      ],
    },
    {
      key: 'borderWidth',
      label: 'Accent width',
      choices: [
        ['', 'Default'],
        ['1px', '1 px'],
        ['2px', '2 px'],
        ['3px', '3 px'],
        ['4px', '4 px'],
        ['5px', '5 px'],
        ['6px', '6 px'],
      ],
    },
    {
      key: 'borderRadius',
      label: 'Corner radius',
      choices: [
        ['', 'Default'],
        ['0', 'None'],
        ['2px', '2 px'],
        ['4px', '4 px'],
        ['6px', '6 px'],
        ['8px', '8 px'],
        ['12px', '12 px'],
      ],
    },
    {
      key: 'width',
      label: 'Width',
      choices: [
        ['', 'Default'],
        ['auto', 'Auto'],
        ['100%', '100%'],
      ],
    },
    {
      key: 'overflowX',
      label: 'Horizontal overflow',
      choices: [
        ['', 'Default'],
        ['visible', 'Visible'],
        ['auto', 'Auto'],
        ['hidden', 'Hidden'],
      ],
    },
    { key: 'markerColor', label: 'Marker', color: true, choices: COLOR_CHOICES },
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
  ];
  const COMMON_VALUE_FIELD_KEYS = [
    'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderColor',
    'textTransform', 'letterSpacing', 'lineHeight', 'padding', 'textAlign',
    'spacingBefore', 'spacingAfter',
  ];
  const TARGET_FIELD_CAPABILITIES = {};
  for (const target of Object.keys(TARGET_LABEL)) {
    TARGET_FIELD_CAPABILITIES[target] = new Set(COMMON_VALUE_FIELD_KEYS);
  }
  TARGET_FIELD_CAPABILITIES.page = new Set(PAGE_VALUE_FIELDS.map(function (field) { return field.key; }));
  TARGET_FIELD_CAPABILITIES.table = new Set(COMMON_VALUE_FIELD_KEYS.concat([
    'borderEdge', 'borderWidth', 'borderRadius', 'width', 'overflowX',
  ]));
  TARGET_FIELD_CAPABILITIES.listItem = new Set(COMMON_VALUE_FIELD_KEYS.concat(['markerColor']));
  TARGET_FIELD_CAPABILITIES.all = new Set(COMMON_VALUE_FIELD_KEYS.concat(['markerColor', 'verticalAlign']));
  for (const cellTarget of ['tableRow', 'tableCell', 'tableHeadCell', 'tableBodyCell']) {
    TARGET_FIELD_CAPABILITIES[cellTarget] = new Set(COMMON_VALUE_FIELD_KEYS.concat(['verticalAlign']));
  }
  const VARIANT_FIELD_CAPABILITIES = {
    zebraEven: new Set(['backgroundColor']),
  };
  const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

  function installStylesPanel(options) {
    const document = options.document;
    const vscode = options.vscode;
    const fontFamily = options.fontFamily;
    const saveRequestSessionId = options.saveRequestSessionId;
    const getStyleState = options.getStyleState;
    const getCurrentTarget = options.getCurrentTarget;
    const getStructVersion = options.getStructVersion || function () { return 0; };
    // Latest bridge snapshot ({ structVersion, target, computed, inherited,
    // hasConfiguredStylesheet }) relayed from the canvas, or null before the
    // first emission — the inspector and "(default)" labels render from it.
    const getInspectorState = options.getInspectorState || function () { return null; };
    const announceNav = options.announceNav || function () {};
    // Optional hover-preview popup manager (media/styles-preview-popup.js).
    // The engine degrades to a plain inert eye when the module is absent.
    const previewPopup = options.previewPopup || null;
    const container = options.container || document.body;
    if (typeof saveRequestSessionId !== 'string' || !saveRequestSessionId) {
      throw new Error('A per-webview save request session ID is required.');
    }
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

    const panel = document.createElement('aside');
    panel.id = 'ditaeditor-styles-panel';
    panel.setAttribute('aria-label', 'Styles');
    panel.className = 'style-panel';
    panel.style.cssText =
      // The panel IS the scroll container: buildPanel saves/restores its
      // scrollTop and styles-view.css thins its scrollbar. overflow-y:auto
      // (not hidden) so content growth — expanded style editors — extends the
      // scroll range instead of being clipped at the viewport edge.
      'display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;font-family:' + fontFamily + ';';
    container.appendChild(panel);

    function state() {
      return getStyleState() || { styles: [], cssText: '', status: 'refused', writable: false };
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
      if (!force && panel.contains(document.activeElement)) return;
      // The rebuild is about to destroy every eye anchor; a popup left open
      // would dangle over a detached element.
      if (previewPopup) previewPopup.closeNow();
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
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;margin-bottom:4px;';
      const title = document.createElement('span');
      title.textContent = 'Styles';
      title.style.cssText = 'font-weight:600;font-size:13px;color:' + GRAY_STRONG + ';flex:1;';
      const newBtn = primaryButton(document, 'New', fontFamily);
      newBtn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        editClassName = '';
        draftTarget = null;
        revealCreateForm = true;
        buildPanel(true);
      });
      const missingStylesheet = styleState.status === 'missing';
      if (!missingStylesheet) head.append(title, newBtn);
      else head.appendChild(title);
      panel.appendChild(head);

      if (missingStylesheet) {
        const card = document.createElement('section');
        card.className = 'style-setup-card';
        card.style.cssText = 'margin:4px 8px;padding:12px;border:1px solid ' + C.border + ';border-radius:4px;';
        const cardTitle = document.createElement('div');
        cardTitle.textContent = 'Initialize author stylesheet';
        cardTitle.style.cssText = 'font-weight:600;font-size:13px;color:' + GRAY_STRONG + ';margin-bottom:6px;';
        const explanation = document.createElement('p');
        explanation.textContent = 'This repository owns its typography, colors, spacing, borders, tokens, and presets. DITA Editor will create the empty stylesheet contract at ' + (styleState.cssPath || 'css/ditaeditor-author-styles.css') + '.';
        explanation.style.cssText = 'font-size:12px;line-height:1.45;color:' + GRAY_LABEL + ';margin:0 0 10px;';
        const initialize = primaryButton(document, 'Initialize author stylesheet', fontFamily);
        initialize.disabled = !styleState.writable;
        if (!styleState.writable) {
          initialize.title = styleState.error || 'A writable local workspace stylesheet destination is required.';
        }
        initialize.addEventListener('click', function (event) {
          if (event.preventDefault) event.preventDefault();
          if (!styleState.writable) return;
          vscode.postMessage({
            type: 'initializeAuthorStylesheet',
            targetToken: styleState.targetToken || '',
          });
        });
        card.append(cardTitle, explanation, initialize);
        panel.appendChild(card);
        if (typeof panel.scrollTop === 'number') panel.scrollTop = prevScrollTop;
        return;
      }

      const current = document.createElement('div');
      current.className = 'style-current';
      if (current.classList && typeof current.classList.add === 'function') current.classList.add('style-current');
      current.style.cssText =
        (activeStyle && activeStyle.borderColor ? 'border-left:3px solid ' + activeStyle.borderColor + ';' : '') +
        'padding:4px 8px 6px ' + (activeStyle && activeStyle.borderColor ? '5px' : '8px') + ';margin-bottom:8px;';
      const currentEyebrow = document.createElement('div');
      currentEyebrow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
      const currentEyebrowText = document.createElement('span');
      currentEyebrowText.textContent = 'Selected element';
      currentEyebrowText.style.cssText =
        'font-weight:600;font-size:11px;color:' + GRAY_LABEL + ';';
      currentEyebrow.appendChild(currentEyebrowText);
      const currentLabel = document.createElement('div');
      currentLabel.style.cssText = 'font-size:13px;color:' + GRAY_STRONG + ';font-weight:600;margin-bottom:2px;text-transform:capitalize;';
      const currentName = document.createElement('span');
      currentName.textContent = targetSummary(target);
      currentLabel.appendChild(currentName);
      if (target && target.ids && target.ids.length === 1 && target.kind) {
        const currentTag = document.createElement('span');
        currentTag.textContent = '<' + target.kind + '>';
        currentTag.style.cssText =
          'margin-left:6px;font:11px/1 ' + C.mono + ';color:' + GRAY_LABEL + ';text-transform:none;';
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
        err.style.cssText = 'font-size:12px;color:' + C.errorFg + ';line-height:1.4;margin:0 0 8px;padding:0 8px;';
        panel.appendChild(err);
      }
      if (styleState.status === 'migration-required') {
        const migration = document.createElement('div');
        migration.textContent = 'This stylesheet uses an older managed format. Your next explicit style save will migrate only the managed region; project CSS outside it will remain unchanged.';
        migration.style.cssText = 'font-size:12px;color:' + C.warnFg + ';line-height:1.4;margin:0 0 8px;padding:0 8px;';
        panel.appendChild(migration);
      }
      if (!styleState.writable) {
        const locked = document.createElement('div');
        locked.textContent = styleState.error
          ? 'Styles are read-only until the issue above is resolved.'
          : 'Styles are read-only because this file is outside a workspace.';
        locked.style.cssText = 'font-size:12px;color:' + C.warnFg + ';line-height:1.4;margin:0 0 8px;padding:0 8px;';
        panel.appendChild(locked);
      }

      panel.appendChild(sectionLabel(document, 'Available styles'));
      if (!styles.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No CSS-backed styles are defined yet.';
        empty.style.cssText = 'font-size:13px;color:' + GRAY_MUTED + ';line-height:1.45;margin:4px 0 8px;padding:0 8px;';
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
      group.style.cssText = 'margin:0 0 2px;';

      const expanded = groupExpanded('page', styles, null);
      const bodyId = 'style-group-body-page';

      const header = document.createElement('div');
      header.className = 'style-target-heading';
      if (header.classList && typeof header.classList.add === 'function') header.classList.add('style-target-heading');
      header.style.cssText =
        'display:flex;align-items:center;height:22px;padding:0 8px;background:' + C.headerBg + ';';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'style-group-toggle';
      if (toggle.classList && typeof toggle.classList.add === 'function') toggle.classList.add('style-group-toggle');
      toggle.style.cssText =
        'flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:100%;text-align:left;border:0;background:transparent;padding:0;' +
        'cursor:pointer;color:' + C.headerText + ';font-family:' + fontFamily + ';';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + 'Page styles');
      toggle.setAttribute('aria-controls', bodyId);
      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = expanded ? '▾' : '▸';
      chevron.style.cssText = 'flex:none;font-size:10px;color:' + C.headerText + ';';
      const headerText = document.createElement('span');
      headerText.textContent = 'Page';
      headerText.style.cssText =
        'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-weight:700;font-size:11px;text-transform:uppercase;color:' + C.headerText + ';';
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
      group.style.cssText = 'margin:0 0 2px;';

      const expanded = groupExpanded(targetKey, styles, target);
      const bodyId = 'style-group-body-' + targetKey;

      const header = document.createElement('div');
      header.className = 'style-target-heading';
      if (header.classList && typeof header.classList.add === 'function') header.classList.add('style-target-heading');
      header.style.cssText =
        'display:flex;align-items:center;height:22px;padding:0 8px;background:' + C.headerBg + ';';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'style-group-toggle';
      if (toggle.classList && typeof toggle.classList.add === 'function') toggle.classList.add('style-group-toggle');
      toggle.style.cssText =
        'flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:100%;text-align:left;border:0;background:transparent;padding:0;' +
        'cursor:pointer;color:' + C.headerText + ';font-family:' + fontFamily + ';';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + label + ' styles');
      toggle.setAttribute('aria-controls', bodyId);
      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = expanded ? '▾' : '▸';
      chevron.style.cssText = 'flex:none;font-size:10px;color:' + C.headerText + ';';
      const headerText = document.createElement('span');
      headerText.textContent = label;
      headerText.style.cssText =
        'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-weight:700;font-size:11px;text-transform:uppercase;color:' + C.headerText + ';';
      const countBadge = document.createElement('span');
      countBadge.className = 'style-group-count';
      if (countBadge.classList && typeof countBadge.classList.add === 'function') countBadge.classList.add('style-group-count');
      countBadge.textContent = String(presets.length);
      countBadge.style.cssText =
        'flex:none;background:' + C.badgeBg + ';color:' + C.badgeText + ';border-radius:11px;' +
        'font-size:11px;font-weight:400;line-height:16px;padding:1px 6px;text-transform:none;';
      toggle.append(chevron, headerText, countBadge);
      toggle.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (expandedGroups.has(targetKey)) expandedGroups.delete(targetKey);
        else expandedGroups.add(targetKey);
        buildPanel(true);
      });
      header.append(toggle);
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+';
      addBtn.className = 'style-icon-btn';
      if (addBtn.classList && typeof addBtn.classList.add === 'function') addBtn.classList.add('style-icon-btn');
      addBtn.style.cssText = iconButtonCss(fontFamily);
      addBtn.title = 'Add ' + label + ' style';
      addBtn.setAttribute('aria-label', 'Add ' + label + ' style');
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
        body.appendChild(baseStyleRow(targetKey, label, styles, writable, target, undefined, undefined, activeManaged));
        const variants = STRUCTURAL_VARIANTS[targetKey];
        if (variants) {
          for (const entry of variants) {
            body.appendChild(baseStyleRow(targetKey, label, styles, writable, target, entry[0], entry[1], activeManaged));
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
        empty.style.cssText = 'font-size:11px;color:' + GRAY_MUTED + ';padding:2px 8px 4px 16px;';
        body.appendChild(empty);
      }
      group.appendChild(body);
      return group;
    }

    // The always-on look of every element of this kind. Clicking edits it in
    // place — it is never "applied" to a selection, so no applyStyle is posted.
    function baseStyleRow(targetKey, label, styles, writable, target, variant, variantLabel, activeManaged) {
      const className = DEFAULT_CLASS_PREFIX + targetKey + (variant ? '-' + variant : '');
      const base = styles.find((style) => style.isDefault && style.target === targetKey
        && (variant ? style.structuralVariant === variant : !style.structuralVariant)) || null;
      // Variant rows are caret-only, like the page row: they are structural defaults,
      // not something you apply to or clear from a selection.
      const caretOnly = targetKey === 'page' || !!variant;
      const rowLabel = variantLabel ? label + ' — ' + variantLabel : label;
      // Radio semantics for the selection's own kind: when the selected element
      // carries no managed preset of its own, its Default row is the current look.
      // Ancestor kinds are excluded (the snapshot has ancestor classes, not kinds).
      const isActive = !caretOnly
        && !!(target && target.ids && target.ids.length)
        && targetForKind(target.kind) === targetKey
        && !activeManaged;
      const wrap = document.createElement('div');
      wrap.className = 'style-base-wrap';
      if (wrap.classList && typeof wrap.classList.add === 'function') {
        wrap.classList.add('style-base-wrap');
        if (isActive) wrap.classList.add('style-row-applied');
      }
      wrap.style.cssText = 'padding:0;';
      const row = document.createElement('div');
      row.className = 'style-base-row';
      if (row.classList && typeof row.classList.add === 'function') row.classList.add('style-base-row');
      row.style.cssText =
        'display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;min-height:22px;padding:1px 8px 1px 16px;' +
        // Same focus-tinted background the applied preset row uses as its marker.
        (isActive ? 'background:color-mix(in srgb, var(--vscode-focusBorder, #2563eb) 14%, transparent);' : '');

      const meta = document.createElement('button');
      meta.type = 'button';
      meta.className = 'style-base-edit';
      if (meta.classList && typeof meta.classList.add === 'function') meta.classList.add('style-base-edit');
      if (caretOnly) {
        meta.title = 'Edit default style for ' + rowLabel;
        meta.setAttribute('aria-label', 'Edit default style for ' + rowLabel);
      } else {
        meta.title = 'Use default style for ' + rowLabel + ' — clears the applied style on the selected element';
        meta.setAttribute('aria-label', 'Apply default style for ' + rowLabel);
      }
      meta.style.cssText =
        'display:flex;align-items:center;gap:7px;text-align:left;border:0;background:transparent;padding:0;' +
        'min-width:0;cursor:pointer;color:' + GRAY_STRONG + ';font-family:' + fontFamily + ';';
      const summary = document.createElement('span');
      // The row shows the ROLE, not the stored name: on-disk stylesheets keep
      // legacy names like "Base paragraph", and the radio metaphor needs every
      // kind's first row to read the same. Variant rows stay self-describing;
      // the authored name remains editable in the form. A kind with no
      // authored default shows the same label, muted — the caret authors it.
      summary.textContent = variant ? (base ? base.name : variantLabel) : 'Default';
      if (base) {
        summary.style.cssText = PLAIN_NAME_CSS;
      } else {
        summary.style.cssText =
          'display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:' + GRAY_MUTED + ';';
        summary.title = 'Not customized yet — expand the editor to author this default.';
      }
      // Leading accent rail when the base style defines a border colour, mirroring
      // styleRow so the "border colour ⟺ accent rail" cue holds for base rows too.
      if (base && base.borderColor) {
        const rail = document.createElement('span');
        rail.className = 'style-accent-rail';
        if (rail.classList && typeof rail.classList.add === 'function') rail.classList.add('style-accent-rail');
        rail.setAttribute('aria-hidden', 'true');
        rail.style.cssText = 'flex:none;width:3px;align-self:stretch;background:' + base.borderColor + ';';
        meta.append(rail, summary);
      } else {
        meta.append(summary);
      }

      const expanded = editClassName === className;
      const editorId = 'style-editor-' + className;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = expanded ? '▴' : '▾';
      editBtn.className = 'style-icon-btn';
      if (editBtn.classList && typeof editBtn.classList.add === 'function') editBtn.classList.add('style-icon-btn');
      editBtn.style.cssText = iconButtonCss(fontFamily);
      editBtn.title = expanded ? 'Collapse default style editor' : 'Expand default style editor';
      editBtn.setAttribute('aria-label', (expanded ? 'Collapse' : 'Expand') + ' default style editor for ' + rowLabel);
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
      // Every base row gets the eye: an unauthored kind still previews how
      // its elements currently look amid the document's other styles.
      row.append(meta, previewEyeButton(
        variant ? targetKey + ':' + variant : targetKey,
        null,
        variant ? (base ? base.name : variantLabel) : 'Default',
      ), actions);
      wrap.appendChild(row);
      if (expanded) {
        const draft = base || {
          name: variant ? rowLabel : 'Default',
          className: className,
          target: targetKey,
          isDefault: true,
          structuralVariant: variant || undefined,
        };
        const form = styleForm(draft, styles, writable);
        form.setAttribute('id', editorId);
        form.style.margin = '0 0 5px;';
        form.style.padding = '4px 8px 8px 16px;';
        form.style.boxSizing = 'border-box';
        wrap.appendChild(form);
      }
      return wrap;
    }

    // Per-row eye: hover/focus anchor for the style preview popup. Clicking it
    // does nothing — the preview affordance must never apply or clear a style.
    // It sits in its own grid cell, sibling to the row's apply button.
    function previewEyeButton(kind, presetClassName, styleName) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'style-icon-btn style-preview-toggle';
      if (btn.classList && typeof btn.classList.add === 'function') {
        btn.classList.add('style-icon-btn');
        btn.classList.add('style-preview-toggle');
      }
      btn.style.cssText = iconButtonCss(fontFamily);
      btn.innerHTML = EYE_SVG;
      btn.title = 'Preview ' + styleName;
      btn.setAttribute('aria-label', 'Preview ' + styleName);
      btn.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
      });
      if (previewPopup) {
        const open = () => previewPopup.scheduleOpen(btn, kind, presetClassName, styleName);
        const close = () => previewPopup.scheduleClose();
        btn.addEventListener('mouseenter', open);
        btn.addEventListener('focus', open);
        btn.addEventListener('mouseleave', close);
        btn.addEventListener('blur', close);
      }
      return btn;
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
      wrap.style.cssText = 'padding:0;';
      const row = document.createElement('div');
      row.className = 'style-row';
      row.style.cssText =
        'display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;min-height:22px;padding:1px 8px 1px 16px;' +
        // The applied row keeps its focus-tinted background as the "applied" marker.
        (isApplied ? 'background:color-mix(in srgb, var(--vscode-focusBorder, #2563eb) 14%, transparent);' : '');
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
      name.style.cssText = PLAIN_NAME_CSS;
      if (style.backgroundColor && (style.target === 'tableCell' || style.target === 'tableRow')) {
        const swatch = document.createElement('span');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.cssText = 'flex:none;width:10px;height:10px;border-radius:3px;border:1px solid ' + GRAY_HAIRLINE + ';background:' + style.backgroundColor + ';';
        topLine.append(swatch);
      }
      topLine.append(name);
      copy.append(topLine);
      // Left accent rail cue — only where the accent really is a left border.
      // Table presets emit their accent HORIZONTALLY (border-top 3px /
      // border-bottom 1px), so a vertical rail would promise a side line the
      // applied style never draws; the hover popup shows the true effect.
      if (style.borderColor && style.target !== 'table') {
        const rail = document.createElement('span');
        rail.className = 'style-accent-rail';
        if (rail.classList && typeof rail.classList.add === 'function') rail.classList.add('style-accent-rail');
        rail.setAttribute('aria-hidden', 'true');
        rail.style.cssText =
          'flex:none;width:3px;align-self:stretch;background:' + style.borderColor + ';';
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
      editBtn.className = 'style-icon-btn';
      if (editBtn.classList && typeof editBtn.classList.add === 'function') editBtn.classList.add('style-icon-btn');
      editBtn.style.cssText = iconButtonCss(fontFamily);
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
      row.append(meta, previewEyeButton(TARGET_LABEL[style.target] ? style.target : 'all', style.className, style.name), actions);
      wrap.appendChild(row);
      if (expanded) {
        const form = styleForm(style, styles, writable);
        form.setAttribute('id', editorId);
        form.style.margin = '0 0 5px;';
        form.style.padding = '4px 8px 8px 16px;';
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
          : 'Default style — applies to every ' + (TARGET_LABEL[style.target] || style.target).toLowerCase() + ' without marking the document.';
        hint.style.cssText = 'font-size:11px;color:' + GRAY_MUTED + ';line-height:1.4;';
        form.append(labelWrap(document, 'Name', nameInput), hint);
      } else {
        controls.push(nameInput, classInput, targetSelect);
        form.append(labelWrap(document, 'Name', nameInput), labelWrap(document, 'Class', classInput), labelWrap(document, 'Target', targetSelect));
      }
      const valueFieldsHost = document.createElement('div');
      valueFieldsHost.style.cssText = 'display:flex;flex-direction:column;gap:9px;';
      form.appendChild(valueFieldsHost);

      function rebuildValueFields(nextTarget, subscribeNow) {
        const retainedValues = {};
        for (const input of Array.prototype.slice.call(valueFieldsHost.querySelectorAll('[data-style-field]'))) {
          const key = input.getAttribute('data-style-field');
          if (key) retainedValues[key] = String(input.value || '');
        }
        valueFieldsHost.textContent = '';
        if (Array.isArray(valueFieldsHost.childNodes)) valueFieldsHost.childNodes.length = 0;
        if (Array.isArray(valueFieldsHost.children)) valueFieldsHost.children.length = 0;
        const fieldStyle = Object.assign({}, style, { target: nextTarget });
        if (fieldStyle.structuralVariant &&
            !(fieldStyle.target === 'table' && fieldStyle.structuralVariant === 'zebraEven')) {
          delete fieldStyle.structuralVariant;
        }
        const inherited = inheritedFieldValues(TARGET_LABEL[nextTarget] ? nextTarget : 'all');
        const valueFields = nextTarget === 'page' ? PAGE_VALUE_FIELDS : VALUE_FIELDS;
        for (const config of valueFields) {
          if (!styleFieldVisible(config, fieldStyle)) continue;
          const value = Object.prototype.hasOwnProperty.call(retainedValues, config.key)
            ? retainedValues[config.key]
            : style[config.key] || '';
          const input = choiceField(config, value, inherited[config.key]);
          if (subscribeNow) subscribeControl(input);
          else controls.push(input);
          valueFieldsHost.appendChild(labelWrap(document, config.label, input));
        }
      }
      rebuildValueFields(style.target, false);
      const error = document.createElement('div');
      error.style.cssText = 'display:none;font-size:12px;color:' + C.errorFg + ';line-height:1.35;';
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

      function subscribeControl(control) {
        if (typeof control._ditaeditorSubscribe === 'function') {
          control._ditaeditorSubscribe(scheduleAutoSave);
        } else {
          control.addEventListener('input', () => scheduleAutoSave());
          control.addEventListener('change', () => scheduleAutoSave());
        }
      }

      if (!isDefaultStyle) {
        targetSelect.addEventListener('change', function () {
          rebuildValueFields(String(targetSelect.value || 'all'), true);
        });
      }
      for (const control of controls) subscribeControl(control);

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
        const next = readDraft(form, nameInput, classInput, targetSelect, style);
        if (isDefaultStyle) {
          next.className = style.className;
          next.target = style.target;
          next.isDefault = true;
          // Preserve the structural variant so the reserved class name (and thus the
          // predicate selector) survives a base-row edit; dropping it would collapse
          // the class onto the plain base and destroy this variant.
          if (style.structuralVariant) next.structuralVariant = style.structuralVariant;
        }
        const reason = validationError(next, styles, style.className, style);
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

    function readDraft(form, nameInput, classInput, targetSelect, originalStyle) {
      const next = Object.assign({}, originalStyle, {
        name: String(nameInput.value || '').trim(),
        className: String(classInput.value || '').trim(),
        target: String(targetSelect.value || 'heading'),
      });
      const targetChanged = next.target !== originalStyle.target;
      if (targetChanged && next.structuralVariant &&
          !(next.target === 'table' && next.structuralVariant === 'zebraEven')) {
        delete next.structuralVariant;
      }
      const fields = Array.prototype.slice.call(form.querySelectorAll('[data-style-field]'));
      for (const input of fields) {
        const key = input.getAttribute('data-style-field');
        if (!key) continue;
        const value = String(input.value || '').trim();
        if (value) next[key] = value;
        else delete next[key];
      }
      if (targetChanged) {
        const capabilities = styleFieldCapabilities(next);
        for (const config of VALUE_FIELDS.concat(PAGE_VALUE_FIELDS)) {
          if (!capabilities.has(config.key)) delete next[config.key];
        }
      }
      return next;
    }

    function validationError(style, styles, previousClassName, previousStyle) {
      if (!style.name) return 'Style name is required.';
      if (!CLASS_NAME_RE.test(style.className)) return 'Class must use CSS-safe letters, numbers, underscores, or hyphens.';
      if (!style.isDefault && style.className.indexOf(DEFAULT_CLASS_PREFIX) === 0) {
        return 'Class names starting with "' + DEFAULT_CLASS_PREFIX + '" are reserved for default styles.';
      }
      if (styles.some((item) => item.className === style.className && item.className !== previousClassName)) {
        return 'A style with that class already exists.';
      }
      const capabilities = styleFieldCapabilities(style);
      const cssValueKeys = new Set(VALUE_FIELDS.concat(PAGE_VALUE_FIELDS).map((field) => field.key));
      for (const key of Object.keys(style)) {
        if (!cssValueKeys.has(key)) continue;
        if (!capabilities.has(key) && (!previousStyle || style[key] !== previousStyle[key])) {
          return 'That property does not affect the selected style target.';
        }
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

    // No self-listeners: the view re-renders when the host pushes fresh
    // style/target state, and callers force-refresh on navigation.
    restoreSaveController();
    refresh(true);
    return {
      refresh: refresh,
      acceptSaveResult: acceptSaveResult,
      panel: panel,
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

    // Effective inherited values per style-target kind, sampled canvas-side by
    // the bridge, so the style editor's empty choices can say "16px (default)"
    // instead of a bare "Default". Empty map (plain "Default" labels) when the
    // bridge has not computed anything — the same degradation as before.
    function inheritedFieldValues(targetKey) {
      const snapshot = getInspectorState();
      const inherited = snapshot && snapshot.inherited && typeof snapshot.inherited === 'object'
        ? snapshot.inherited[targetKey]
        : null;
      return inherited && typeof inherited === 'object' ? inherited : {};
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
      // The bridge publishes computed entries only for a single resolvable
      // element; a null computed snapshot renders no inspector, matching the
      // old in-canvas degradation when getComputedStyle was unavailable.
      const snapshot = getInspectorState();
      const computed = snapshot && Array.isArray(snapshot.computed) ? snapshot.computed : null;
      if (!computed) return null;
      const styleTarget = targetForKind(target.kind);
      const baseStyle = styles.find((style) => style.isDefault && style.target === styleTarget) || null;

      const box = document.createElement('div');
      box.className = 'style-inspector';
      if (box.classList && typeof box.classList.add === 'function') box.classList.add('style-inspector');
      box.style.cssText = 'margin-top:9px;';
      const hasConfiguredStylesheet = snapshot.hasConfiguredStylesheet === true;
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
        'margin:0 0 4px;color:' + GRAY_MUTED + ';font:11px/1.4 ' + fontFamily + ';';
      box.appendChild(sourceSummary);
      for (const entry of computed) {
        const fieldKey = entry.key;
        const value = String(entry.value || '').trim();
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'style-inspect-row';
        if (row.classList && typeof row.classList.add === 'function') row.classList.add('style-inspect-row');
        row.style.cssText = 'display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:6px;align-items:center;padding:2px 0;';
        const labEl = document.createElement('span');
        labEl.textContent = entry.label;
        labEl.style.cssText = 'font-size:11px;color:' + GRAY_LABEL + ';';
        const valEl = document.createElement('span');
        valEl.textContent = value;
        valEl.style.cssText =
          'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
          'font:11px/1.4 ' + C.mono + ';color:' + GRAY_STRONG + ';';
        const provenance = provenanceForField(fieldKey, activeStyle, baseStyle);
        row.append(labEl, valEl);
        if (provenance) {
          const provEl = document.createElement('span');
          provEl.className = 'style-inspect-prov';
          if (provEl.classList && typeof provEl.classList.add === 'function') provEl.classList.add('style-inspect-prov');
          provEl.textContent = provenance;
          provEl.title = provenance;
          provEl.style.cssText =
            'flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            'font:11px/1.4 ' + fontFamily + ';color:' + GRAY_MUTED + ';';
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
      picker.style.cssText = 'width:36px;height:26px;padding:2px;border:1px solid ' + C.inputBorder + ';border-radius:2px;background:' + C.inputBg + ';cursor:pointer;';

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

    // Per-target capability matrix shared by field rendering and draft cleanup.
    // Structural variants get their own deliberately narrow capability set.
    function styleFieldCapabilities(style) {
      if (style.structuralVariant && VARIANT_FIELD_CAPABILITIES[style.structuralVariant]) {
        return VARIANT_FIELD_CAPABILITIES[style.structuralVariant];
      }
      return TARGET_FIELD_CAPABILITIES[style.target] || TARGET_FIELD_CAPABILITIES.all;
    }

    function styleFieldVisible(config, style) {
      if (!styleFieldCapabilities(style).has(config.key)) return false;
      if (config.key === 'borderEdge' && style.isDefault === true) return false;
      return true;
    }

    function choiceField(config, value, inheritedValue) {
      if (config.color) return colorChoiceField(config, value, inheritedValue);
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

  // Secondary action button — VS Code secondary button tokens.
  function smallButton(document, label, fontFamily) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = 'style-btn-secondary';
    if (btn.classList && typeof btn.classList.add === 'function') btn.classList.add('style-btn-secondary');
    btn.style.cssText =
      'border:0;border-radius:2px;background:' + C.btn2Bg + ';color:' + C.btn2Fg + ';cursor:pointer;' +
      'font:13px/1.4 ' + fontFamily + ';padding:2px 11px;white-space:nowrap;';
    return btn;
  }

  // Primary action button — VS Code primary button tokens.
  function primaryButton(document, label, fontFamily) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = 'style-btn-primary';
    if (btn.classList && typeof btn.classList.add === 'function') btn.classList.add('style-btn-primary');
    btn.style.cssText =
      'border:0;border-radius:2px;background:' + C.btnBg + ';color:' + C.btnFg + ';cursor:pointer;' +
      'font:13px/1.4 ' + fontFamily + ';padding:2px 11px;white-space:nowrap;';
    return btn;
  }

  function labelWrap(document, label, control) {
    const wrap = document.createElement(control && control._ditaeditorCompound ? 'div' : 'label');
    wrap.style.cssText = 'display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:center;';
    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'font-size:13px;color:' + GRAY_LABEL + ';';
    if (control && control._ditaeditorCompound) text.setAttribute('aria-hidden', 'true');
    wrap.append(text, control);
    return wrap;
  }

  // Non-collapsible section header — same native strip as the group headers.
  function sectionLabel(document, text) {
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText =
      'display:flex;align-items:center;min-height:22px;padding:0 8px;margin:8px 0 2px;background:' + C.headerBg + ';' +
      'font-weight:700;font-size:11px;text-transform:uppercase;color:' + C.headerText + ';';
    return label;
  }

  function fieldCss(fontFamily) {
    return 'width:100%;box-sizing:border-box;border:1px solid ' + C.inputBorder + ';border-radius:2px;background:' + C.inputBg + ';' +
      'color:' + C.inputText + ';font:13px ' + fontFamily + ';padding:2px 6px;min-height:26px;min-width:0;';
  }

  function iconButtonCss(fontFamily) {
    return 'width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;flex:none;' +
      'border:0;border-radius:3px;background:transparent;color:' + C.iconFg + ';cursor:pointer;' +
      'font:14px/1 ' + fontFamily + ';padding:0;';
  }

  // Row-name rendering: native list-item look. The authored look lives in the
  // hover preview popup, never inline in the row.
  const PLAIN_NAME_CSS =
    'display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'font-size:13px;font-weight:400;color:var(--vscode-foreground);line-height:1.2;';

  // Static inline eye icon for the preview anchor (~14px, currentColor so it
  // follows the icon-foreground token from iconButtonCss).
  const EYE_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3.5C4.7 3.5 2.1 6.6 1.3 8c.8 1.4 3.4 4.5 6.7 4.5s5.9-3.1 6.7-4.5C13.9 6.6 11.3 3.5 8 3.5Z"/>' +
    '<circle cx="8" cy="8" r="2.2"/></svg>';

  window.DitaEditorStylesPanel = { installStylesPanel: installStylesPanel };
})();
