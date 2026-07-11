// Shared pure helpers for the visual canvas editing adapter.
(function () {
  function successNoun(kind) {
    switch (kind) {
      case 'row': return 'Row';
      case 'li': return 'Item';
      case 'p': return 'Paragraph';
      case 'codeblock': return 'Code block';
      case 'lines': return 'Lines block';
      case 'note': return 'Note';
      case 'section': return 'Section';
      case 'shortdesc': return 'Short description';
      case 'table': return 'Table';
      case 'fig': return 'Figure';
      case 'image': return 'Image';
      case 'title': return 'Title';
      default: return 'Element';
    }
  }

  function structuralSuccessMessage(op, kind) {
    switch (op) {
      case 'addRowAfter': return 'Row added.';
      case 'addRowBefore': return 'Row added.';
      case 'addItemAfter': return 'Item added.';
      case 'addParaAfter': return 'Paragraph added.';
      case 'deleteRow': return 'Row deleted.';
      case 'deleteItem': return 'Item deleted.';
      case 'deletePara': return 'Paragraph deleted.';
      case 'deleteElement': return successNoun(kind) + ' deleted.';
      case 'deleteTable': return 'Table deleted.';
      case 'deleteFig': return 'Figure deleted.';
      case 'deleteList': return 'List deleted.';
      case 'deleteImage': return 'Image deleted.';
      case 'deleteTitle': return 'Title deleted.';
      case 'addColumnAfter': return 'Column added.';
      case 'addColumnBefore': return 'Column added.';
      case 'deleteColumn': return 'Column deleted.';
      case 'mergeRight':
      case 'mergeDown':
      case 'mergeLeft':
      case 'mergeUp': return 'Cells merged.';
      case 'splitCell': return 'Cell split.';
      case 'promoteRowToHeader': return 'Row promoted to header.';
      case 'demoteRowFromHeader': return 'Header row moved into body.';
      case 'moveColumnLeft': return 'Column moved left.';
      case 'moveColumnRight': return 'Column moved right.';
      case 'addTableTitle': return 'Table title added.';
      case 'indentItem': return 'Item indented.';
      case 'outdentItem': return 'Item outdented.';
      case 'split': return kind === 'li' ? 'Item split.' : 'Paragraph split.';
      case 'pasteBlocks': return 'Content pasted.';
      case 'join': return kind === 'li' ? 'Items joined.' : 'Paragraphs joined.';
      default: return null;
    }
  }

  function withStructuralSuccess(op, kind, extra) {
    const message = structuralSuccessMessage(op, kind);
    return Object.assign({}, extra || {}, message ? { announceOnSuccess: message } : {});
  }

  function looksLikeRichHtml(html) {
    return /<\/?[a-zA-Z][^>]*>/.test(html);
  }

  const PASTE_BLOCK_TAGS = new Set(['p', 'div', 'li']);

  function htmlPasteBlocksFromDom(doc, html) {
    if (typeof doc.createElement !== 'function') return [];
    const template = doc.createElement('template');
    template.innerHTML = html;
    const root = template.content || template;
    const out = [];
    collectHtmlPasteBlocks(root, out);
    return out;
  }

  function collectHtmlPasteBlocks(root, out) {
    const nodes = Array.prototype.slice.call(root.childNodes || []);
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      const tag = String(node.tagName || '').toLowerCase();
      if (!PASTE_BLOCK_TAGS.has(tag)) {
        collectHtmlPasteBlocks(node, out);
        continue;
      }
      if (hasDirectPasteBlockChild(node)) {
        collectHtmlPasteBlocks(node, out);
      } else {
        out.push(node.innerHTML || node.textContent || '');
      }
    }
  }

  function hasDirectPasteBlockChild(el) {
    const children = Array.prototype.slice.call(el.children || []);
    return children.some((child) => PASTE_BLOCK_TAGS.has(String(child.tagName || '').toLowerCase()));
  }

  function htmlPasteBlocksByRegex(html) {
    const out = [];
    const re = /<(p|div|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m = null;
    while ((m = re.exec(html))) out.push(m[2]);
    return out;
  }

  function htmlPasteBlocks(doc, html) {
    if (!/<\/?(?:p|div|li)\b/i.test(html)) return [];
    const domBlocks = htmlPasteBlocksFromDom(doc, html);
    if (domBlocks.length > 0) return domBlocks;
    return htmlPasteBlocksByRegex(html);
  }

  function escapeHtmlSnippet(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function textPasteBlocks(text) {
    const normalized = text.replace(/\r\n?/g, '\n');
    if (!normalized.includes('\n')) return [];
    const lines = normalized.split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.length > 1 ? lines.map(escapeHtmlSnippet) : [];
  }

  function inlineHtmlForJoin(el) {
    if (el.getAttribute('data-inline-html') === 'true') return el.innerHTML || '';
    return escapeHtmlSnippet(el.textContent || '');
  }

  function createSelectionPayloads(opts) {
    const doc = opts.document;
    const win = opts.window;
    const caretOffset = opts.caretOffset;

    function insertTextAtSelection(root, text) {
      const sel = win.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return false;
      range.deleteContents();
      const node = doc.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      let fallbackOffset = null;
      if (typeof range.cloneRange === 'function') {
        const clone = range.cloneRange();
        if (clone && typeof clone.endOffset === 'number') fallbackOffset = clone.endOffset;
      }
      const measured = caretOffset(root);
      return { caretOffset: measured > 0 ? measured : fallbackOffset };
    }

    function fragmentHtml(fragment) {
      if (typeof doc.createElement !== 'function') return null;
      const wrapper = doc.createElement('div');
      if (!wrapper || typeof wrapper.appendChild !== 'function') return null;
      wrapper.appendChild(fragment);
      return typeof wrapper.innerHTML === 'string' ? wrapper.innerHTML : null;
    }

    function inlineHtmlSelectionParts(el) {
      if (el.getAttribute('data-inline-html') !== 'true') return null;
      const sel = win.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!range || !el.contains(range.commonAncestorContainer)) return null;
      if (
        typeof range.cloneRange !== 'function' ||
        typeof range.cloneContents !== 'function' ||
        typeof range.setStart !== 'function'
      ) {
        return null;
      }
      const prefixRange = range.cloneRange();
      prefixRange.selectNodeContents(el);
      prefixRange.setEnd(range.startContainer, range.startOffset);
      const suffixRange = range.cloneRange();
      suffixRange.selectNodeContents(el);
      suffixRange.setStart(range.endContainer, range.endOffset);
      const prefixHtml = fragmentHtml(prefixRange.cloneContents());
      const suffixHtml = fragmentHtml(suffixRange.cloneContents());
      if (prefixHtml === null || suffixHtml === null) return null;
      return { prefixHtml: prefixHtml, suffixHtml: suffixHtml };
    }

    function selectionTextBounds(el) {
      const sel = win.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!range || !el.contains(range.commonAncestorContainer)) return null;
      const startMeasure = doc.createRange();
      startMeasure.selectNodeContents(el);
      startMeasure.setEnd(range.startContainer, range.startOffset);
      const endMeasure = doc.createRange();
      endMeasure.selectNodeContents(el);
      endMeasure.setEnd(range.endContainer, range.endOffset);
      return {
        start: startMeasure.toString().length,
        end: endMeasure.toString().length,
      };
    }

    function splitPayload(el) {
      const richParts = inlineHtmlSelectionParts(el);
      if (richParts) return richParts;
      const text = el.textContent || '';
      const bounds = selectionTextBounds(el);
      if (bounds) return { prefix: text.slice(0, bounds.start), suffix: text.slice(bounds.end) };
      const at = caretOffset(el);
      return { prefix: text.slice(0, at), suffix: text.slice(at) };
    }

    return {
      insertTextAtSelection: insertTextAtSelection,
      inlineHtmlSelectionParts: inlineHtmlSelectionParts,
      selectionTextBounds: selectionTextBounds,
      splitPayload: splitPayload,
    };
  }

  window.DitaEditorCanvasEditingUtils = {
    structuralSuccessMessage: structuralSuccessMessage,
    withStructuralSuccess: withStructuralSuccess,
    looksLikeRichHtml: looksLikeRichHtml,
    htmlPasteBlocks: htmlPasteBlocks,
    textPasteBlocks: textPasteBlocks,
    escapeHtmlSnippet: escapeHtmlSnippet,
    inlineHtmlForJoin: inlineHtmlForJoin,
    createSelectionPayloads: createSelectionPayloads,
  };
})();
