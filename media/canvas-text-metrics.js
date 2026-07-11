// Source-text metrics for editable DOM surfaces.
//
// Render-only conref chips are visible in the canvas but zero-length in the
// source text payloads sent back to the host. Keep caret, formatting, insert,
// and navigation offsets on that same source-text coordinate system.
(function () {
  function childNodesOf(node) {
    return Array.prototype.slice.call((node && (node.childNodes || node.children)) || []);
  }

  function parentElementOf(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    return node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null;
  }

  function isZeroLengthAtom(el) {
    return !!(
      el &&
      el.nodeType === 1 &&
      el.getAttribute &&
      el.getAttribute('data-dita') === 'ph' &&
      el.getAttribute('data-conref')
    );
  }

  function zeroLengthAtomAncestor(node) {
    let el = node && node.nodeType === 3 ? parentElementOf(node) : node;
    while (el) {
      if (isZeroLengthAtom(el)) return el;
      el = parentElementOf(el);
    }
    return null;
  }

  function sourceLength(node) {
    if (!node) return 0;
    if (node.nodeType === 3) return zeroLengthAtomAncestor(node) ? 0 : (node.nodeValue || '').length;
    if (isZeroLengthAtom(node)) return 0;
    let total = 0;
    for (const child of childNodesOf(node)) total += sourceLength(child);
    return total;
  }

  function sourceText(root) {
    let out = '';
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        if (!zeroLengthAtomAncestor(node)) out += node.nodeValue || '';
        return;
      }
      if (isZeroLengthAtom(node)) return;
      for (const child of childNodesOf(node)) visit(child);
    };
    visit(root);
    return out;
  }

  function offsetWithin(root, container, off) {
    let total = 0;
    let found = false;
    const visit = (node) => {
      if (!node || found) return;
      if (node === container) {
        if (node.nodeType === 3) {
          if (!zeroLengthAtomAncestor(node)) {
            const text = node.nodeValue || '';
            total += Math.max(0, Math.min(off, text.length));
          }
        } else {
          const children = childNodesOf(node);
          const limit = Math.max(0, Math.min(off, children.length));
          for (let i = 0; i < limit; i++) total += sourceLength(children[i]);
        }
        found = true;
        return;
      }
      if (node.nodeType === 3) {
        if (!zeroLengthAtomAncestor(node)) total += (node.nodeValue || '').length;
        return;
      }
      if (isZeroLengthAtom(node)) return;
      for (const child of childNodesOf(node)) visit(child);
    };
    visit(root);
    return total;
  }

  function textNodesIn(root) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        if (!zeroLengthAtomAncestor(node)) out.push(node);
        return;
      }
      if (isZeroLengthAtom(node)) return;
      for (const child of childNodesOf(node)) visit(child);
    };
    visit(root);
    return out;
  }

  window.DitaEditorCanvasTextMetrics = {
    childNodesOf: childNodesOf,
    isZeroLengthAtom: isZeroLengthAtom,
    offsetWithin: offsetWithin,
    parentElementOf: parentElementOf,
    sourceLength: sourceLength,
    sourceText: sourceText,
    textNodesIn: textNodesIn,
    zeroLengthAtomAncestor: zeroLengthAtomAncestor,
  };
})();
