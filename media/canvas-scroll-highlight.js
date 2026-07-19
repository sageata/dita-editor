// Exact-match highlight for scroll-anchor landings (topic search). Helper
// module: attaches a namespace, never calls the vscode api. Given the anchored
// element and a {text, occurrence, matchCase} payload, finds the nth occurrence
// of the rendered text across the anchor's editable leaves ([data-edit-id]) and
// selects it via a DOM Range — the same flat-offset walker the find bar uses.
// The DOM textContent IS the rendered text, so counting occurrences here can
// never drift against host-side offsets. Any miss returns false and the caller
// keeps the element-level scroll (deliberately silent).
(function (root) {
  'use strict';

  function normalized(text, matchCase) {
    return matchCase ? text : text.toLowerCase();
  }

  // Map a flat character offset range onto a DOM Range by walking text nodes.
  function selectRange(documentObj, windowObj, leaf, start, end) {
    if (!documentObj.createRange || !windowObj.getSelection) return false;
    const range = documentObj.createRange();
    let remainingStart = start;
    let remainingEnd = end;
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
    walk(leaf);
    if (!startNode || !endNode) return false;
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const sel = windowObj.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      return false;
    }
    return true;
  }

  function leavesOf(anchor) {
    const leaves = [];
    if (anchor.matches && anchor.matches('[data-edit-id]')) leaves.push(anchor);
    return leaves.concat(Array.prototype.slice.call(anchor.querySelectorAll('[data-edit-id]')));
  }

  function findOccurrence(anchor, needle, matchCase, target) {
    let seen = 0;
    const leaves = leavesOf(anchor);
    for (const leaf of leaves) {
      const hay = normalized(leaf.textContent || '', matchCase);
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        if (seen === target) return { leaf: leaf, start: at, end: at + needle.length };
        seen += 1;
        from = at + Math.max(1, needle.length);
      }
    }
    return seen > 0 ? 'drifted' : null;
  }

  function highlightMatch(opts) {
    const anchor = opts.anchor;
    const highlight = opts.highlight;
    const documentObj = opts.documentObj;
    const windowObj = opts.windowObj;
    if (!anchor || !highlight || typeof highlight.text !== 'string' || highlight.text === '') return false;
    const matchCase = highlight.matchCase === true;
    const needle = normalized(highlight.text, matchCase);
    const target =
      typeof highlight.occurrence === 'number' && highlight.occurrence >= 0 ? highlight.occurrence : 0;
    let found = findOccurrence(anchor, needle, matchCase, target);
    // The document changed since the search indexed it: the nth instance is
    // gone but the text still exists — land on the first instance instead.
    if (found === 'drifted') found = findOccurrence(anchor, needle, matchCase, 0);
    if (!found || found === 'drifted') return false;
    const selected = selectRange(documentObj, windowObj, found.leaf, found.start, found.end);
    // Center the matched leaf (find-bar behavior) so the selection is never
    // hidden behind the canvas's fixed command bar.
    if (selected && found.leaf.scrollIntoView) found.leaf.scrollIntoView({ block: 'center' });
    return selected;
  }

  root.DitaEditorCanvasScrollHighlight = { highlightMatch: highlightMatch };
})(window);
