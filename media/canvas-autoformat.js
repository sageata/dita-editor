// Markdown-style autoformat for the DITA Editor canvas (IX-6).
//
// Loaded before canvas.js. Typing a list marker at the start of a paragraph
// and pressing Space converts the paragraph through the existing transform
// pipeline:  "-" / "*" → bulleted list · "1." → numbered list · "a." →
// alphabetic list. The marker text is removed first (a normal byte-minimal
// 'edit'), then the standard single-target transform posts — both host ops
// the canvas already uses, no new contract.
(function () {
  const MARKERS = {
    '-': 'paragraphToUnorderedList',
    '*': 'paragraphToUnorderedList',
    '1.': 'paragraphToOrderedList',
    'a.': 'paragraphToAlphabeticList',
  };

  function installAutoformat(opts) {
    const document = opts.document;
    const vscode = opts.vscode;
    const editableTarget = opts.editableTarget;
    const structTarget = opts.structTarget;
    const caretOffset = opts.caretOffset;
    const sourceTextLength = opts.sourceTextLength;
    const clearTimer = opts.clearTimer;
    const transformAvailFor = opts.transformAvailFor;
    const postTransform = opts.postTransform;
    const announceNav = opts.announceNav || function () {};

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const leaf = editableTarget(e.target);
      if (!leaf) return;
      const struct = structTarget(leaf);
      if (!struct || struct.getAttribute('data-struct-kind') !== 'p') return;
      const text = (leaf.textContent || '').trim();
      const transform = MARKERS[text];
      if (!transform) return;
      // Only when the marker is the whole paragraph and the caret sits after it.
      const offset = caretOffset(leaf);
      if (offset == null || offset < sourceTextLength(leaf)) return;
      const editId = leaf.getAttribute('data-edit-id');
      const structId = struct.getAttribute('data-struct-id');
      if (editId == null || structId == null) return;
      const avail = transformAvailFor(structId, transform);
      if (avail.status !== 'ok') return; // marker stays ordinary text
      e.preventDefault();
      e.stopPropagation();
      clearTimer(); // a pending debounce would re-post the marker text after our edit
      vscode.postMessage({ type: 'edit', id: editId, text: '' });
      postTransform(transform, structId);
      announceNav(
        transform === 'paragraphToOrderedList' ? 'Converted to a numbered list.'
          : transform === 'paragraphToAlphabeticList' ? 'Converted to an alphabetic list.'
            : 'Converted to a bulleted list.');
    });

    return {};
  }

  window.DitaEditorCanvasAutoformat = { installAutoformat: installAutoformat };
})();
