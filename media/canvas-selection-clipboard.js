// Clipboard helpers for the DITA Editor canvas selection controller.
//
// Loaded before canvas-selection-controller.js. This module owns pure copy/paste
// formatting and table-matrix expansion so the controller can stay focused on
// selection state and event routing.
(function () {
  const clipboardStripAttrs = [
    'aria-current',
    'contenteditable',
    'data-autofocus',
    'data-cell-id',
    'data-dita',
    'data-edit-id',
    'data-edit-run',
    'data-href',
    'data-inline-html',
    'data-selectable',
    'data-selection-kind',
    'data-struct-id',
    'data-struct-kind',
    'spellcheck',
    'tabindex',
  ];

  function escapeHtml(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function tagNameOf(el) {
    return String((el && el.tagName) || '').toLowerCase();
  }

  function childrenOf(el) {
    return el && el.children ? Array.prototype.slice.call(el.children) : [];
  }

  function scrubClipboardNode(root) {
    const nodes = [root];
    if (root && typeof root.querySelectorAll === 'function') {
      for (const node of root.querySelectorAll('*')) nodes.push(node);
    }
    for (const node of nodes) {
      if (!node || typeof node.removeAttribute !== 'function') continue;
      for (const attr of clipboardStripAttrs) node.removeAttribute(attr);
      if (node.classList && typeof node.classList.remove === 'function') {
        node.classList.remove('is-selected');
        node.classList.remove('is-nav-focus');
        if (String(node.classList || '') === '') node.removeAttribute('class');
      }
    }
  }

  function cloneForClipboard(el) {
    if (!el || typeof el.cloneNode !== 'function') return el;
    const clone = el.cloneNode(true);
    scrubClipboardNode(clone);
    return clone;
  }

  function elementBodyHtml(el) {
    if (typeof el.innerHTML === 'string' && el.innerHTML !== '') return el.innerHTML;
    const children = childrenOf(el);
    if (children.length) return children.map((child) => elementClipboardHtml(child, false)).join('');
    return escapeHtml(el.textContent || '');
  }

  function elementClipboardHtml(el, innerOnly) {
    const source = cloneForClipboard(el);
    if (innerOnly) return elementBodyHtml(source);
    if (source && typeof source.outerHTML === 'string' && source.outerHTML) return source.outerHTML;
    const tag = tagNameOf(el) || 'div';
    const body = elementBodyHtml(el);
    return '<' + tag + '>' + body + '</' + tag + '>';
  }

  function cellRectWidth(selection) {
    return Math.max(1, (selection.rect.c1 || 0) - (selection.rect.c0 || 0) + 1);
  }

  function cellRectClipboardRows(selection) {
    if (!selection || selection.mode !== 'cellRect' || !selection.rect || !Array.isArray(selection.members)) return null;
    const width = cellRectWidth(selection);
    const values = selection.members.map((m) => (typeof m.text === 'string' ? m.text : ''));
    const rows = [];
    for (let i = 0; i < values.length; i += width) rows.push(values.slice(i, i + width));
    return rows;
  }

  function cellRectClipboardElementRows(selection, els) {
    if (!selection || selection.mode !== 'cellRect' || !selection.rect || !Array.isArray(selection.members)) return null;
    if (!Array.isArray(els) || els.length !== selection.members.length) return null;
    const width = cellRectWidth(selection);
    const rows = [];
    for (let i = 0; i < els.length; i += width) rows.push(els.slice(i, i + width));
    return rows;
  }

  function cellRectClipboardText(rows) {
    if (!rows) return null;
    return rows.map((row) => row.join('\t')).join('\n');
  }

  function pruneNestedElements(els) {
    return els.filter((el) => !els.some((other) => other !== el && other && typeof other.contains === 'function' && other.contains(el)));
  }

  function selectionPlainText(selection, els) {
    const cellRect = cellRectClipboardText(cellRectClipboardRows(selection));
    if (cellRect !== null) return cellRect;
    return pruneNestedElements(els).map((el) => el.textContent || '').join('\n');
  }

  function selectionHtml(selection, els) {
    const rows = cellRectClipboardElementRows(selection, els);
    if (rows) {
      return '<table><tbody>' + rows.map(
        (row) => '<tr>' + row.map((cell) => '<td>' + elementClipboardHtml(cell, true) + '</td>').join('') + '</tr>',
      ).join('') + '</tbody></table>';
    }
    return pruneNestedElements(els).map((el) => elementClipboardHtml(el, false)).join('');
  }

  function clipboardText(e, windowObj) {
    const data = e.clipboardData || (windowObj && windowObj.clipboardData);
    if (!data || typeof data.getData !== 'function') return '';
    const text = data.getData('text/plain');
    return typeof text === 'string' ? text : '';
  }

  function clipboardHtml(e, windowObj) {
    const data = e.clipboardData || (windowObj && windowObj.clipboardData);
    if (!data || typeof data.getData !== 'function') return '';
    const html = data.getData('text/html');
    return typeof html === 'string' ? html : '';
  }

  function normalizedClipboardText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function tabularPasteMatrix(text, allowLineRows) {
    const normalized = normalizedClipboardText(text);
    if (!allowLineRows && normalized.indexOf('\t') < 0) return null;
    let rows = normalized.split('\n');
    if (rows.length > 1 && rows[rows.length - 1] === '') rows = rows.slice(0, -1);
    const matrix = rows.map((row) => row.split('\t'));
    if (matrix.length === 0 || (matrix.length === 1 && matrix[0].length <= 1)) return null;
    return matrix;
  }

  function htmlTablePasteMatrix(html, windowObj) {
    if (!html || String(html).toLowerCase().indexOf('<table') < 0) return null;
    const Parser = (windowObj && windowObj.DOMParser) || (typeof DOMParser === 'function' ? DOMParser : null);
    if (!Parser) return null;
    let parsed = null;
    try {
      parsed = new Parser().parseFromString(String(html), 'text/html');
    } catch (_err) {
      return null;
    }
    const table = parsed && typeof parsed.querySelector === 'function' ? parsed.querySelector('table') : null;
    if (!table || typeof table.querySelectorAll !== 'function') return null;
    const rows = [];
    for (const row of table.querySelectorAll('tr')) {
      const values = [];
      for (const cell of row.querySelectorAll('td, th')) {
        values.push(String(cell.textContent || '').replace(/\u00a0/g, ' '));
      }
      if (values.length) rows.push(values);
    }
    return rows.length ? rows : null;
  }

  function cellRectPasteValuesFromMatrix(selection, matrix) {
    if (!selection || selection.mode !== 'cellRect' || !selection.rect || !Array.isArray(selection.members)) return null;
    const count = selection.members.length;
    if (count <= 0) return [];
    const flat = matrix.flatMap((row) => row);
    if (flat.length === 1) return Array(count).fill(flat[0]);
    const width = cellRectWidth(selection);
    const out = [];
    for (let i = 0; i < count; i++) {
      const row = matrix[Math.floor(i / width)];
      const value = row ? row[i % width] : undefined;
      out.push(value === undefined ? '' : value);
    }
    return out;
  }

  function flattenPasteMatrix(matrix, count) {
    if (count <= 0) return [];
    const values = matrix.flatMap((row) => row);
    if (values.length === 1) return Array(count).fill(values[0]);
    const out = values.slice(0, count);
    while (out.length < count) out.push('');
    return out;
  }

  function ancestorByTag(el, tag) {
    let cur = el;
    while (cur) {
      if (tagNameOf(cur) === tag) return cur;
      cur = cur.parentElement || null;
    }
    return null;
  }

  function tableRowsOf(table) {
    const out = [];
    const visit = (node) => {
      for (const child of childrenOf(node)) {
        const tag = tagNameOf(child);
        if (tag === 'table') continue;
        if (tag === 'tr') out.push(child);
        else if (tag !== 'td' && tag !== 'th') visit(child);
      }
    };
    visit(table);
    return out;
  }

  function rowCells(row) {
    return childrenOf(row).filter((child) => {
      const tag = tagNameOf(child);
      return tag === 'td' || tag === 'th';
    });
  }

  function hasTableSpan(el) {
    return !!(el && typeof el.hasAttribute === 'function' && (el.hasAttribute('rowspan') || el.hasAttribute('colspan')));
  }

  function singleCellTabularPasteTarget(selection, matrix, ids, els) {
    if (!selection || selection.mode !== 'single' || selection.unit !== 'cell' || ids.length !== 1) return null;
    if (!matrix || matrix.length === 0 || (matrix.length === 1 && matrix[0].length <= 1)) return null;
    const anchor = Array.isArray(els) && els.length === 1 ? els[0] : null;
    const anchorRow = ancestorByTag(anchor, 'tr');
    const table = ancestorByTag(anchor, 'table');
    if (!anchor || !anchorRow || !table) return null;

    const tableRows = tableRowsOf(table);
    const rowIndex = tableRows.indexOf(anchorRow);
    const anchorCells = rowCells(anchorRow);
    const colIndex = anchorCells.indexOf(anchor);
    if (rowIndex < 0 || colIndex < 0 || anchorCells.some(hasTableSpan)) return null;

    const targetIds = [];
    const values = [];
    for (let r = 0; r < matrix.length; r++) {
      const row = tableRows[rowIndex + r];
      if (!row) return null;
      const cells = rowCells(row);
      if (cells.some(hasTableSpan)) return null;
      for (let c = 0; c < matrix[r].length; c++) {
        const cell = cells[colIndex + c];
        if (!cell || typeof cell.getAttribute !== 'function') return null;
        const id = cell.getAttribute('data-cell-id');
        if (!id) return null;
        targetIds.push(id);
        values.push(matrix[r][c]);
      }
    }
    return targetIds.length > 1 ? { ids: targetIds, values } : null;
  }

  function cellPasteValues(text, count) {
    if (count <= 0) return [];
    const normalized = normalizedClipboardText(text);
    if (count === 1) return [normalized];
    let rows = normalized.split('\n');
    if (rows.length > 1 && rows[rows.length - 1] === '') rows = rows.slice(0, -1);
    const values = rows.flatMap((row) => row.split('\t'));
    if (values.length === 1) return Array(count).fill(values[0]);
    const out = values.slice(0, count);
    while (out.length < count) out.push('');
    return out;
  }

  window.DitaEditorCanvasSelectionClipboard = {
    clipboardHtml: clipboardHtml,
    clipboardText: clipboardText,
    selectionHtml: selectionHtml,
    selectionPlainText: selectionPlainText,
    tabularPasteMatrix: tabularPasteMatrix,
    htmlTablePasteMatrix: htmlTablePasteMatrix,
    cellRectPasteValuesFromMatrix: cellRectPasteValuesFromMatrix,
    flattenPasteMatrix: flattenPasteMatrix,
    singleCellTabularPasteTarget: singleCellTabularPasteTarget,
    cellPasteValues: cellPasteValues,
  };
})();
