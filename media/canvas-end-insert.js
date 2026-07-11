// End-of-document paragraph insert affordance for the DITA Editor canvas.
//
// Loaded before canvas.js. This is render-only chrome: clicking the trailing hit
// area posts the existing host-backed insert message. The insert core still owns
// validation and persistence.
(function () {
  const END_ANCHOR_KINDS = new Set([
    'p',
    'shortdesc',
    'lines',
    'codeblock',
    'note',
    'section',
    'table',
    'fig',
    'ul',
    'ol',
    'image',
  ]);

  function depthOf(el) {
    let depth = 0;
    let cur = el;
    while (cur && cur.parentElement) {
      depth += 1;
      cur = cur.parentElement;
    }
    return depth;
  }

  function isNestedInside(kind, el, containerKind) {
    const container = el.closest ? el.closest('[data-struct-kind="' + containerKind + '"]') : null;
    return container && (kind !== containerKind || container !== el);
  }

  function rectFor(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const rect = el.getBoundingClientRect();
    if (!rect || typeof rect.bottom !== 'number') return null;
    return rect;
  }

  function findEndAnchorRecord(document) {
    const main = document.querySelector('main');
    if (!main || typeof main.querySelectorAll !== 'function') return null;
    let best = null;
    for (const el of main.querySelectorAll('[data-struct-id]')) {
      const id = el.getAttribute('data-struct-id');
      const kind = el.getAttribute('data-struct-kind');
      if (!id || !kind || !END_ANCHOR_KINDS.has(kind)) continue;
      if (isNestedInside(kind, el, 'table')) continue;
      if (isNestedInside(kind, el, 'fig')) continue;
      const rect = rectFor(el);
      if (!rect) continue;
      const top = typeof rect.top === 'number' ? rect.top : rect.bottom;
      if (rect.bottom < top) continue;
      const depth = depthOf(el);
      if (
        !best ||
        rect.bottom > best.bottom + 0.5 ||
        (Math.abs(rect.bottom - best.bottom) <= 0.5 && depth < best.depth)
      ) {
        best = { id: id, kind: kind, el: el, rect: rect, bottom: rect.bottom, depth: depth };
      }
    }
    return best;
  }

  function findEndAnchor(document) {
    const best = findEndAnchorRecord(document);
    return best ? { id: best.id, kind: best.kind } : null;
  }

  function isExistingContentOrControl(target) {
    return !!(
      target &&
      typeof target.closest === 'function' &&
      target.closest(
        '.dc-end-insert,.cmd-bar,[data-ditaeditor-breadcrumb],[contenteditable],button,a,input,textarea,select,[role="toolbar"],[data-struct-id],[data-cell-id]',
      )
    );
  }

  function installEndInsert(opts) {
    const document = opts.document;
    const vscode = opts.vscode;
    const insertAvailFor = opts.insertAvailFor || function () { return { enabled: true }; };
    const announceNav = opts.announceNav || function () {};
    let button = null;

    function postAtEnd(anchor) {
      const available = insertAvailFor(anchor.id, 'after', 'paragraph');
      if (available && available.enabled === false) {
        announceNav('Unavailable: ' + (available.reason || 'Paragraph cannot be inserted here') + '.');
        return false;
      }
      vscode.postMessage({
        type: 'insert',
        op: 'paragraph',
        payload: { mode: 'after', refId: anchor.id },
      });
      announceNav('Insert paragraph at end...');
      return true;
    }

    function ensureButton() {
      if (button) return button;
      button = document.createElement('button');
      button.type = 'button';
      button.classList.add('dc-end-insert');
      button.setAttribute('aria-label', 'Add paragraph at end');
      button.title = 'Add paragraph at end';
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const anchor = button._endInsertAnchor || findEndAnchor(document);
        if (!anchor) {
          announceNav('No end-of-document insert target is available.');
          return;
        }
        postAtEnd(anchor);
      });
      return button;
    }

    function handleTrailingClick(e) {
      const main = document.querySelector('main');
      if (!main || !e) return;
      if (document.body && document.body.contains && !document.body.contains(e.target)) return;
      if (isExistingContentOrControl(e.target)) return;

      const anchor = findEndAnchorRecord(document);
      if (!anchor) return;

      const clickY = typeof e.clientY === 'number' ? e.clientY : null;
      if (clickY != null && clickY < anchor.rect.bottom + 6) return;

      const available = insertAvailFor(anchor.id, 'after', 'paragraph');
      if (available && available.enabled === false) return;

      e.preventDefault();
      e.stopPropagation();
      postAtEnd(anchor);
    }

    function refresh() {
      const main = document.querySelector('main');
      if (!main) {
        if (button) button.remove();
        return;
      }
      const b = ensureButton();
      if (b.parentElement !== main) main.appendChild(b);
      const anchor = findEndAnchor(document);
      b._endInsertAnchor = anchor;
      if (!anchor) {
        b.style.display = 'none';
        b.title = 'No end-of-document insert target is available';
        b.setAttribute('aria-disabled', 'true');
        return;
      }
      const available = insertAvailFor(anchor.id, 'after', 'paragraph');
      if (available && available.enabled === false) {
        b.style.display = 'none';
        b.title = available.reason || 'Paragraph cannot be inserted here';
        b.setAttribute('aria-disabled', 'true');
        return;
      }
      b.style.display = 'block';
      b.title = 'Add paragraph at end';
      b.removeAttribute('aria-disabled');
    }

    refresh();
    document.addEventListener('click', handleTrailingClick, true);

    return {
      refresh: refresh,
      findEndAnchor: () => findEndAnchor(document),
    };
  }

  window.DitaEditorCanvasEndInsert = {
    installEndInsert: installEndInsert,
    findEndAnchor: findEndAnchor,
  };
})();
