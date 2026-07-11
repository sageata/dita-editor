// Find & Replace for the DITA Editor canvas (IX-4).
//
// Loaded before canvas.js. A fixed bar under the command bar that searches the
// editable text leaves. Navigation and counting are render-only; each replace
// posts the SAME byte-minimal {type:'edit'} message typing uses (so undo and
// the CST diff behave identically). Leaves containing inline elements
// (formatting, conref chips, xrefs) are matched for navigation but never
// rewritten — replacing flattened text would destroy their markup — and the
// bar says so when one is current.
(function () {
  const SYSTEM_SANS = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  function installFindReplace(opts) {
    const document = opts.document;
    const windowObj = opts.window || window;
    const vscode = opts.vscode;
    const clearTimer = opts.clearTimer;
    const announceNav = opts.announceNav || function () {};

    const bar = document.createElement('div');
    bar.setAttribute('role', 'search');
    bar.setAttribute('aria-label', 'Find and replace');
    bar.setAttribute('data-ditaeditor-find-replace', 'bar');
    bar.style.cssText =
      'position:fixed;top:76px;right:14px;display:none;z-index:105;align-items:center;gap:6px;' +
      'flex-wrap:wrap;max-width:min(560px,92vw);padding:8px 10px;background:#fff;color:#26343b;' +
      'border:1px solid #d8e0e4;border-radius:8px;box-shadow:0 8px 22px rgba(21,32,38,.16);' +
      'font:12px/1.4 ' + SYSTEM_SANS + ';';
    document.body.appendChild(bar);

    function makeInput(placeholder, ariaLabel) {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.setAttribute('aria-label', ariaLabel);
      input.style.cssText =
        'width:150px;padding:4px 8px;border:1px solid #d6dde1;border-radius:5px;' +
        'font:12px/1.4 ' + SYSTEM_SANS + ';color:#26343b;outline-offset:1px;';
      return input;
    }

    function makeBtn(label, title) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText =
        'padding:4px 8px;border:1px solid #d6dde1;border-radius:5px;background:#f7fafb;color:#314652;' +
        'font:600 11px/1.2 ' + SYSTEM_SANS + ';cursor:pointer;white-space:nowrap;';
      return b;
    }

    const findInput = makeInput('Find', 'Find text');
    const replaceInput = makeInput('Replace with', 'Replacement text');
    const caseBtn = makeBtn('Aa', 'Match case');
    caseBtn.setAttribute('aria-pressed', 'false');
    const countLabel = document.createElement('span');
    countLabel.setAttribute('aria-live', 'polite');
    countLabel.style.cssText = 'min-width:64px;color:#52646f;text-align:center;';
    const prevBtn = makeBtn('‹', 'Previous match');
    const nextBtn = makeBtn('›', 'Next match');
    const replaceBtn = makeBtn('Replace', 'Replace this match');
    const replaceAllBtn = makeBtn('All', 'Replace all matches');
    const closeBtn = makeBtn('×', 'Close find and replace');
    closeBtn.style.border = '0';
    closeBtn.style.background = 'transparent';
    bar.append(findInput, countLabel, prevBtn, nextBtn, caseBtn, replaceInput, replaceBtn, replaceAllBtn, closeBtn);

    let open = false;
    let matchCase = false;
    let matches = []; // { leaf, id, start, end, plain }
    let current = -1;
    let restoreFocusEl = null;

    function leaves() {
      const main = document.querySelector('main');
      if (!main) return [];
      return Array.prototype.slice.call(main.querySelectorAll('[data-edit-id][contenteditable]'));
    }

    function isPlainLeaf(leaf) {
      // Only text/BR children: safe to rewrite as plain text. Any inline element
      // (b/i/conref chip/xref) makes a rewrite lossy, so those leaves are read-only here.
      for (const child of leaf.children || []) {
        if ((child.tagName || '').toLowerCase() !== 'br') return false;
      }
      return true;
    }

    function normalized(text) {
      return matchCase ? text : text.toLowerCase();
    }

    function computeMatches() {
      matches = [];
      const q = findInput.value || '';
      if (!q) return;
      const needle = normalized(q);
      for (const leaf of leaves()) {
        const text = leaf.textContent || '';
        const hay = normalized(text);
        const plain = isPlainLeaf(leaf);
        const id = leaf.getAttribute('data-edit-id');
        let from = 0;
        for (;;) {
          const i = hay.indexOf(needle, from);
          if (i < 0) break;
          matches.push({ leaf: leaf, id: id, start: i, end: i + q.length, plain: plain });
          from = i + Math.max(1, q.length);
        }
      }
    }

    function updateCount() {
      const total = matches.length;
      countLabel.textContent = total ? (current + 1) + ' of ' + total : 'No matches';
      if (!findInput.value) countLabel.textContent = '';
      const m = current >= 0 ? matches[current] : null;
      const canReplace = !!(m && m.plain);
      replaceBtn.disabled = !canReplace;
      replaceBtn.style.opacity = canReplace ? '1' : '0.5';
      replaceBtn.title = !m ? 'Replace this match'
        : m.plain ? 'Replace this match'
          : 'This match is inside styled text and cannot be auto-replaced';
      const anyPlain = matches.some((x) => x.plain);
      replaceAllBtn.disabled = !anyPlain;
      replaceAllBtn.style.opacity = anyPlain ? '1' : '0.5';
    }

    function selectMatch(m) {
      // Walk the text nodes to map the flat offset onto a DOM range.
      const range = document.createRange ? document.createRange() : null;
      if (!range) return;
      let remainingStart = m.start;
      let remainingEnd = m.end;
      let startNode = null;
      let startOffset = 0;
      let endNode = null;
      let endOffset = 0;
      const walk = (node) => {
        for (const child of Array.prototype.slice.call(node.childNodes || [])) {
          if (child.nodeType === 3) {
            const len = (child.nodeValue || '').length;
            if (!startNode && remainingStart <= len) {
              startNode = child;
              startOffset = remainingStart;
            }
            remainingStart -= len;
            if (!endNode && remainingEnd <= len) {
              endNode = child;
              endOffset = remainingEnd;
              return true;
            }
            remainingEnd -= len;
          } else if (walk(child)) {
            return true;
          }
        }
        return false;
      };
      walk(m.leaf);
      if (!startNode || !endNode) return;
      try {
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const sel = windowObj.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        // A stale match after an external change — the next recompute fixes it.
      }
    }

    function goTo(index, silent) {
      if (!matches.length) {
        current = -1;
        updateCount();
        return;
      }
      current = ((index % matches.length) + matches.length) % matches.length;
      const m = matches[current];
      if (m.leaf.scrollIntoView) m.leaf.scrollIntoView({ block: 'center' });
      selectMatch(m);
      updateCount();
      if (!silent) announceNav('Match ' + (current + 1) + ' of ' + matches.length + '.');
    }

    function refresh(keepIndex) {
      const prev = current;
      computeMatches();
      if (!matches.length) {
        current = -1;
        updateCount();
        return;
      }
      current = keepIndex ? Math.min(Math.max(prev, 0), matches.length - 1) : 0;
      updateCount();
    }

    function postLeafText(m, newText) {
      clearTimer(); // a pending typing debounce would clobber this edit
      m.leaf.textContent = newText;
      vscode.postMessage({ type: 'edit', id: m.id, text: newText });
    }

    function replaceCurrent() {
      const m = current >= 0 ? matches[current] : null;
      if (!m || !m.plain) {
        announceNav('This match is inside styled text and cannot be auto-replaced.');
        return;
      }
      const text = m.leaf.textContent || '';
      const replacement = replaceInput.value || '';
      postLeafText(m, text.slice(0, m.start) + replacement + text.slice(m.end));
      refresh(true);
      announceNav('Replaced. ' + (matches.length ? matches.length + ' match' + (matches.length === 1 ? '' : 'es') + ' left.' : 'No matches left.'));
      if (matches.length) goTo(current, true);
    }

    function replaceAll() {
      const q = findInput.value || '';
      if (!q) return;
      const replacement = replaceInput.value || '';
      let replaced = 0;
      let skipped = 0;
      const needle = normalized(q);
      for (const leaf of leaves()) {
        const text = leaf.textContent || '';
        if (normalized(text).indexOf(needle) < 0) continue;
        if (!isPlainLeaf(leaf)) {
          skipped += 1;
          continue;
        }
        let out = '';
        let from = 0;
        const hay = normalized(text);
        for (;;) {
          const i = hay.indexOf(needle, from);
          if (i < 0) break;
          out += text.slice(from, i) + replacement;
          from = i + q.length;
          replaced += 1;
        }
        out += text.slice(from);
        postLeafText({ leaf: leaf, id: leaf.getAttribute('data-edit-id') }, out);
      }
      refresh(false);
      announceNav(
        'Replaced ' + replaced + ' match' + (replaced === 1 ? '' : 'es') + '.' +
        (skipped ? ' ' + skipped + ' styled leaf' + (skipped === 1 ? '' : 'ves') + ' skipped.' : ''));
    }

    function show() {
      if (open) {
        findInput.focus();
        findInput.select();
        return;
      }
      open = true;
      restoreFocusEl = document.activeElement;
      bar.style.display = 'flex';
      const sel = windowObj.getSelection();
      const seed = sel && !sel.isCollapsed ? String(sel).trim() : '';
      if (seed && seed.length <= 80 && seed.indexOf('\n') < 0) findInput.value = seed;
      findInput.focus();
      findInput.select();
      refresh(false);
      if (matches.length) goTo(0, true);
      announceNav('Find and replace. Enter for next match, Escape to close.');
    }

    function hide() {
      if (!open) return;
      open = false;
      bar.style.display = 'none';
      matches = [];
      current = -1;
      if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') restoreFocusEl.focus();
      restoreFocusEl = null;
    }

    function toggle() {
      if (open) hide();
      else show();
    }

    findInput.addEventListener('input', () => {
      refresh(false);
      if (matches.length) goTo(0, true);
    });
    prevBtn.addEventListener('click', () => goTo(current - 1));
    nextBtn.addEventListener('click', () => goTo(current + 1));
    replaceBtn.addEventListener('click', replaceCurrent);
    replaceAllBtn.addEventListener('click', replaceAll);
    closeBtn.addEventListener('click', hide);
    caseBtn.addEventListener('click', () => {
      matchCase = !matchCase;
      caseBtn.setAttribute('aria-pressed', matchCase ? 'true' : 'false');
      caseBtn.style.background = matchCase ? '#e9eef2' : '#f7fafb';
      refresh(false);
      if (matches.length) goTo(0, true);
    });

    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.target === replaceInput) replaceCurrent();
        else goTo(e.shiftKey ? current - 1 : current + 1);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && (e.key || '').toLowerCase() === 'f') {
        e.preventDefault();
        toggle();
      }
    });

    return {
      toggle: toggle,
      hide: hide,
      isOpen: () => open,
      // After a host rerender the leaves were replaced: recompute in place.
      refreshAfterRerender: () => {
        if (open) refresh(true);
      },
    };
  }

  window.DitaEditorCanvasFindReplace = { installFindReplace: installFindReplace };
})();
