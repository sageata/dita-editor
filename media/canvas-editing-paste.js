// Paste handling for the visual canvas editing adapter.
(function () {
  function installPasteHandling(opts) {
    const doc = opts.document || document;
    const win = opts.window || window;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const postStructural = opts.postStructural;
    const withStructuralSuccess = opts.withStructuralSuccess;
    const looksLikeRichHtml = opts.looksLikeRichHtml;
    const htmlPasteBlocks = opts.htmlPasteBlocks;
    const textPasteBlocks = opts.textPasteBlocks;
    const escapeHtmlSnippet = opts.escapeHtmlSnippet || function (text) {
      return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    const inlineHtmlSelectionParts = opts.inlineHtmlSelectionParts;
    const selectionTextBounds = opts.selectionTextBounds;

    function supportsInlineHtmlPaste(el) {
      if (!el || el.hasAttribute('data-edit-run')) return false;
      if (el.getAttribute('data-inline-html') === 'true') return true;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'pre') return false;
      if (tag === 'p' || tag === 'h1' || tag === 'li' || tag === 'td' || tag === 'th') return true;
      const struct = el.closest('[data-struct-id]');
      const kind = struct && struct.getAttribute('data-struct-kind');
      return kind === 'p' || kind === 'li' || kind === 'title' || kind === 'shortdesc';
    }

    function clipboardHtml(e) {
      const data = e.clipboardData || win.clipboardData;
      if (!data || typeof data.getData !== 'function') return '';
      const html = data.getData('text/html');
      return typeof html === 'string' ? html : '';
    }

    function clipboardText(e) {
      const data = e.clipboardData || win.clipboardData;
      if (!data || typeof data.getData !== 'function') return '';
      const text = data.getData('text/plain');
      return typeof text === 'string' ? text : '';
    }

    function pasteBlocksFromClipboard(e) {
      const html = clipboardHtml(e);
      const htmlBlocks = htmlPasteBlocks(doc, html);
      if (htmlBlocks.length > 1) return htmlBlocks;
      return textPasteBlocks(clipboardText(e));
    }

    function selectedBlockPasteBlocksFromClipboard(e) {
      const htmlBlocks = htmlPasteBlocks(doc, clipboardHtml(e));
      if (htmlBlocks.length > 0) return htmlBlocks;
      const text = clipboardText(e);
      const textBlocks = textPasteBlocks(text);
      if (textBlocks.length > 0) return textBlocks;
      return text === '' ? [] : [escapeHtmlSnippet(text)];
    }

    doc.addEventListener('paste', (e) => {
      const el = editableTarget(e.target);
      if (!el || !supportsInlineHtmlPaste(el)) return;
      const struct = structTarget(el);
      const kind = struct && struct.getAttribute('data-struct-kind');
      const structId = struct && struct.getAttribute('data-struct-id');
      const blocks = kind === 'p' || kind === 'li' ? pasteBlocksFromClipboard(e) : [];
      const bounds = selectionTextBounds(el);
      if (structId && blocks.length > 1 && bounds) {
        e.preventDefault();
        const text = el.textContent || '';
        const richParts = inlineHtmlSelectionParts(el);
        const payload = richParts || {
          prefix: text.slice(0, bounds.start),
          suffix: text.slice(bounds.end),
        };
        postStructural('pasteBlocks', structId, withStructuralSuccess('pasteBlocks', kind, Object.assign(payload, {
          blocks: blocks,
        })));
        return;
      }
      const html = clipboardHtml(e);
      if (!looksLikeRichHtml(html)) return;
      el.setAttribute('data-inline-html', 'true');
    });

    return {
      supportsInlineHtmlPaste: supportsInlineHtmlPaste,
      clipboardHtml: clipboardHtml,
      clipboardText: clipboardText,
      pasteBlocksFromClipboard: pasteBlocksFromClipboard,
      selectedBlockPasteBlocksFromClipboard: selectedBlockPasteBlocksFromClipboard,
    };
  }

  window.DitaEditorCanvasEditingPaste = {
    installPasteHandling: installPasteHandling,
  };
})();
