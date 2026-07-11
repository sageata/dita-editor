// Render-only canvas chrome for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns the shared announcer, keyboard
// hint, error banner, and breadcrumb. It does not call acquireVsCodeApi().
(function () {
  const DITA_PATH_SEGMENTS = {
    topic: { label: 'Topic', tag: 'topic', tier: 'root' },
    concept: { label: 'Concept', tag: 'concept', tier: 'root' },
    task: { label: 'Task', tag: 'task', tier: 'root' },
    reference: { label: 'Reference', tag: 'reference', tier: 'root' },
    body: { label: 'Body', tag: 'body', tier: 'container' },
    conbody: { label: 'Concept body', tag: 'conbody', tier: 'container' },
    taskbody: { label: 'Task body', tag: 'taskbody', tier: 'container' },
    refbody: { label: 'Reference body', tag: 'refbody', tier: 'container' },
    title: { label: 'Title', tag: 'title', tier: 'heading' },
    shortdesc: { label: 'Short description', tag: 'shortdesc', tier: 'text' },
    section: { label: 'Section', tag: 'section', tier: 'heading' },
    p: { label: 'Paragraph', tag: 'p', tier: 'text' },
    lines: { label: 'Lines block', tag: 'lines', tier: 'text' },
    codeblock: { label: 'Code block', tag: 'codeblock', tier: 'text' },
    note: { label: 'Note', tag: 'note', tier: 'container' },
    ul: { label: 'Bulleted list', tag: 'ul', tier: 'list' },
    ol: { label: 'Ordered list', tag: 'ol', tier: 'list' },
    li: { label: 'List item', tag: 'li', tier: 'text' },
    table: { label: 'Table', tag: 'table', tier: 'table' },
    thead: { label: 'Header', tag: 'thead', tier: 'table' },
    tbody: { label: 'Body rows', tag: 'tbody', tier: 'table' },
    row: { label: 'Row', tag: 'row', tier: 'table' },
    entry: { label: 'Cell', tag: 'entry', tier: 'table' },
    fig: { label: 'Figure', tag: 'fig', tier: 'media' },
    image: { label: 'Image', tag: 'image', tier: 'media' },
    codeph: { label: 'Inline code', tag: 'codeph', tier: 'text' },
    steps: { label: 'Steps', tag: 'steps', tier: 'list' },
    step: { label: 'Step', tag: 'step', tier: 'text' },
    cmd: { label: 'Command', tag: 'cmd', tier: 'text' },
    info: { label: 'Info', tag: 'info', tier: 'container' },
  };
  const DITA_CLASSES = new Set(Object.keys(DITA_PATH_SEGMENTS));

  const CHIP_STYLES = {
    root: 'border-color:#cbb47b;background:#fff9e7;color:#4d3a12;',
    container: 'border-color:#c9d5dc;background:#f7fafb;color:#314652;',
    heading: 'border-color:#d0b16b;background:#fff7df;color:#5d4210;',
    text: 'border-color:#d7dce0;background:#ffffff;color:#26343b;',
    list: 'border-color:#bcceda;background:#f2f8fb;color:#213f50;',
    table: 'border-color:#b9d2cb;background:#f1faf6;color:#1f4c3f;',
    media: 'border-color:#d6c4df;background:#fbf7fd;color:#4d315d;',
  };

  function installCanvasChrome(options) {
    const document = options.document;
    const window = options.window;
    const editableTarget = options.editableTarget;
    const clearNavFocus = options.clearNavFocus;

    const navStatus = document.createElement('div');
    navStatus.setAttribute('role', 'status');
    navStatus.setAttribute('aria-live', 'polite');
    navStatus.setAttribute('aria-label', 'Navigation status');
    navStatus.style.cssText =
      'position:fixed;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
      'clip:rect(0 0 0 0);white-space:nowrap;border:0;';
    document.body.appendChild(navStatus);

    function announceNav(message) {
      navStatus.textContent = '';
      window.setTimeout(() => {
        navStatus.textContent = message || '';
      }, 30);
    }

    const kbHint = document.createElement('div');
    kbHint.setAttribute('role', 'note');
    kbHint.setAttribute('aria-hidden', 'true');
    kbHint.style.cssText =
      'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);display:none;z-index:65;' +
      'padding:6px 14px;max-width:90vw;background:#1b2932;color:#e8eff2;border:1px solid #2e4755;' +
      'border-radius:6px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 1px 6px rgba(0,0,0,0.3);pointer-events:none;';
    kbHint.textContent = 'Alt+F10 opens editing controls · Arrow / Home / End navigate';
    document.body.appendChild(kbHint);
    let kbHintShown = false;

    function showKeyboardHint() {
      if (kbHintShown) return;
      kbHintShown = true;
      kbHint.style.display = 'block';
      announceNav('Press Alt+F10 for editing controls. Arrow, Home and End navigate.');
      window.setTimeout(() => { kbHint.style.display = 'none'; }, 6000);
    }

    document.addEventListener('focusin', (e) => {
      if (editableTarget(e.target)) {
        showKeyboardHint();
        clearNavFocus();
      }
    });

    const banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;display:none;z-index:100;padding:8px 36px 8px 12px;' +
      'font:13px sans-serif;background:#b00020;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);';
    const bannerText = document.createElement('span');
    const bannerClose = document.createElement('button');
    bannerClose.textContent = '×';
    bannerClose.title = 'Dismiss';
    bannerClose.setAttribute('aria-label', 'Dismiss error');
    bannerClose.style.cssText =
      'position:absolute;top:2px;right:8px;border:0;background:transparent;color:#fff;font-size:18px;cursor:pointer;';
    bannerClose.addEventListener('click', () => {
      banner.style.display = 'none';
    });
    banner.append(bannerText, bannerClose);
    document.body.appendChild(banner);

    function showError(message) {
      bannerText.textContent = message || 'An error occurred.';
      banner.style.display = 'block';
    }

    function hideError() {
      banner.style.display = 'none';
    }

    const BREADCRUMB_HIDDEN_KEY = 'ditaeditor.visual.pathBarHidden';

    function storedBreadcrumbHidden() {
      try {
        return !!(window.localStorage && window.localStorage.getItem(BREADCRUMB_HIDDEN_KEY) === 'true');
      } catch {
        return false;
      }
    }

    function storeBreadcrumbHidden(hidden) {
      try {
        if (!window.localStorage) return;
        if (hidden) window.localStorage.setItem(BREADCRUMB_HIDDEN_KEY, 'true');
        else window.localStorage.removeItem(BREADCRUMB_HIDDEN_KEY);
      } catch {
        // Storage is best-effort in VS Code webviews.
      }
    }

    function pixelValue(value) {
      const n = Number.parseFloat(String(value || ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    function editorLeftInset() {
      const main = document.querySelector('main');
      if (!main) return 0;
      const inline = main.style && main.style.paddingLeft;
      if (inline) return pixelValue(inline);
      if (typeof window.getComputedStyle === 'function') {
        const computed = window.getComputedStyle(main);
        return pixelValue(computed && computed.paddingLeft);
      }
      return 0;
    }

    const crumb = document.createElement('div');
    crumb.setAttribute('data-ditaeditor-breadcrumb', 'bar');
    crumb.setAttribute('aria-label', 'Current document structure');
    crumb.style.cssText =
      'position:fixed;bottom:10px;left:0;right:12px;display:none;z-index:60;box-sizing:border-box;' +
      'align-items:center;gap:10px;min-height:38px;padding:7px 9px 7px 10px;background:rgba(255,255,255,0.97);' +
      'color:#26343b;border:1px solid #d8e0e4;border-left:4px solid #b88746;border-radius:0 8px 8px 0;' +
      'font:12px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;' +
      'box-shadow:0 8px 22px rgba(21,32,38,.16),0 1px 2px rgba(21,32,38,.10);white-space:nowrap;';
    crumb.style.display = 'none';
    crumb.style.left = '0px';
    const crumbLabel = document.createElement('span');
    crumbLabel.setAttribute('aria-hidden', 'true');
    crumbLabel.textContent = 'Structure';
    crumbLabel.style.cssText =
      'flex:none;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;' +
      'background:#243844;color:#fff;font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;';
    const crumbText = document.createElement('span');
    crumbText.setAttribute('aria-hidden', 'true');
    crumbText.style.cssText =
      'min-width:0;flex:1;display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;';
    const crumbHide = document.createElement('button');
    crumbHide.type = 'button';
    crumbHide.textContent = 'Hide';
    crumbHide.title = 'Hide path bar';
    crumbHide.setAttribute('aria-label', 'Hide path bar');
    crumbHide.style.cssText =
      'flex:none;border:1px solid #d6dde1;border-radius:6px;background:#fff;color:#52646f;' +
      'font:11px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;' +
      'padding:3px 8px;cursor:pointer;';
    crumb.append(crumbLabel, crumbText, crumbHide);
    document.body.appendChild(crumb);

    const crumbShow = document.createElement('button');
    crumbShow.type = 'button';
    crumbShow.textContent = 'Path';
    crumbShow.title = 'Show path bar';
    crumbShow.setAttribute('aria-label', 'Show path bar');
    crumbShow.style.cssText =
      'position:fixed;bottom:12px;left:8px;display:none;z-index:61;border:1px solid #d8e0e4;' +
      'border-left:4px solid #b88746;border-radius:0 8px 8px 0;background:#fff;color:#26343b;' +
      'font:700 10px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;' +
      'letter-spacing:.08em;text-transform:uppercase;padding:5px 9px;cursor:pointer;box-shadow:0 4px 14px rgba(21,32,38,.14);';
    crumbShow.style.display = 'none';
    crumbShow.style.left = '8px';
    document.body.appendChild(crumbShow);
    let crumbHidden = storedBreadcrumbHidden();

    function applyBreadcrumbInset() {
      const left = editorLeftInset();
      crumb.style.left = left + 'px';
      crumbShow.style.left = left + 8 + 'px';
    }

    function applyBreadcrumbVisibility() {
      applyBreadcrumbInset();
      const hasText = !!crumbText.textContent;
      crumb.style.display = !crumbHidden && hasText ? 'flex' : 'none';
      crumbShow.style.display = crumbHidden ? 'inline-flex' : 'none';
    }

    function setBreadcrumbHidden(hidden) {
      crumbHidden = !!hidden;
      storeBreadcrumbHidden(crumbHidden);
      applyBreadcrumbVisibility();
    }

    crumbHide.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      setBreadcrumbHidden(true);
    });
    crumbShow.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      setBreadcrumbHidden(false);
    });
    if (window.addEventListener) {
      window.addEventListener('resize', applyBreadcrumbInset);
      window.addEventListener('ditaeditor:layoutchange', applyBreadcrumbInset);
    }

    function ditaSegmentOf(el) {
      if (!el || !el.classList) return null;
      for (const c of el.classList) {
        if (DITA_CLASSES.has(c)) {
          const segment = DITA_PATH_SEGMENTS[c];
          return { name: c, label: segment.label, tag: segment.tag, tier: segment.tier };
        }
      }
      return null;
    }

    function elementPathSegments(node) {
      if (node && node.nodeType === 3) node = node.parentElement;
      const main = document.querySelector('main');
      if (!node || !main || !main.contains(node)) return [];
      const path = [];
      for (let el = node; el && el !== main; el = el.parentElement) {
        const segment = ditaSegmentOf(el);
        if (segment && (!path.length || path[path.length - 1].name !== segment.name)) path.push(segment);
      }
      return path.reverse();
    }

    function elementPath(node) {
      return elementPathSegments(node).map((segment) => segment.label).join(' › ');
    }

    function chipForSegment(segment, isLeaf) {
      const chip = document.createElement('span');
      chip.title = '<' + segment.tag + '>';
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:6px;max-width:190px;height:24px;box-sizing:border-box;' +
        'padding:0 8px;border:1px solid;border-radius:6px;font-weight:' + (isLeaf ? '700' : '600') + ';' +
        (CHIP_STYLES[segment.tier] || CHIP_STYLES.text) +
        (isLeaf ? 'box-shadow:inset 0 -2px 0 rgba(184,135,70,.55);' : '');
      const label = document.createElement('span');
      label.textContent = segment.label;
      label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;';
      const tag = document.createElement('span');
      tag.textContent = '<' + segment.tag + '>';
      tag.style.cssText =
        'font:10px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;color:#6f7d84;opacity:.82;';
      chip.append(label, tag);
      return chip;
    }

    function renderBreadcrumb(segments) {
      crumbText.textContent = '';
      for (let i = 0; i < segments.length; i += 1) {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '›';
          sep.style.cssText = 'flex:none;color:#9aa6ad;font-weight:700;';
          crumbText.appendChild(sep);
        }
        crumbText.appendChild(chipForSegment(segments[i], i === segments.length - 1));
      }
    }

    function updateBreadcrumb() {
      const sel = window.getSelection();
      const segments = elementPathSegments(sel && sel.anchorNode ? sel.anchorNode : null);
      renderBreadcrumb(segments);
      applyBreadcrumbVisibility();
    }

    document.addEventListener('selectionchange', updateBreadcrumb);

    return {
      announceNav: announceNav,
      showError: showError,
      hideError: hideError,
      elementPath: elementPath,
    };
  }

  window.DitaEditorCanvasChrome = { installCanvasChrome: installCanvasChrome };
})();
