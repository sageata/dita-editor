// Static icon set for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns author-authored SVG strings only:
// no DOM writes, no VS Code API access, and no document state.
(function () {
  const menu = {
    paragraph:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="5" x2="16" y2="5"/><line x1="4" y1="9" x2="16" y2="9"/><line x1="4" y1="13" x2="12" y2="13"/></svg>',
    lines:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4.5" x2="4" y2="15.5"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="13" y2="14"/></svg>',
    ul:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="1.2" fill="currentColor" stroke="none"/><line x1="9" y1="6" x2="16" y2="6"/><circle cx="5" cy="10" r="1.2" fill="currentColor" stroke="none"/><line x1="9" y1="10" x2="16" y2="10"/><circle cx="5" cy="14" r="1.2" fill="currentColor" stroke="none"/><line x1="9" y1="14" x2="16" y2="14"/></svg>',
    ol:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><text x="2.4" y="8" font-size="6.5" fill="currentColor" stroke="none">1</text><line x1="8" y1="6" x2="16" y2="6"/><text x="2.4" y="13" font-size="6.5" fill="currentColor" stroke="none">2</text><line x1="8" y1="11" x2="16" y2="11"/><text x="2.4" y="18" font-size="6.5" fill="currentColor" stroke="none">3</text><line x1="8" y1="16" x2="16" y2="16"/></svg>',
    alphaOl:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><text x="2.2" y="8" font-size="6.5" fill="currentColor" stroke="none">a</text><line x1="8" y1="6" x2="16" y2="6"/><text x="2.2" y="13" font-size="6.5" fill="currentColor" stroke="none">b</text><line x1="8" y1="11" x2="16" y2="11"/><text x="2.2" y="18" font-size="6.5" fill="currentColor" stroke="none">c</text><line x1="8" y1="16" x2="16" y2="16"/></svg>',
    table:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="11" rx="1.5"/><line x1="3" y1="8.5" x2="17" y2="8.5"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="8.5" y1="4.5" x2="8.5" y2="15.5"/></svg>',
    tableCell:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="11" rx="1.5"/><line x1="3" y1="8.5" x2="17" y2="8.5"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="8.5" y1="4.5" x2="8.5" y2="15.5"/><rect x="8.9" y="8.9" width="7.7" height="3.2" fill="currentColor" stroke="none" opacity=".16"/></svg>',
    rowAdd:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="7" rx="1.5"/><line x1="3" y1="7" x2="17" y2="7"/><line x1="10" y1="12.5" x2="10" y2="17"/><line x1="7.8" y1="14.8" x2="12.2" y2="14.8"/></svg>',
    rowDelete:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="7" rx="1.5"/><line x1="3" y1="7" x2="17" y2="7"/><line x1="7.8" y1="14.8" x2="12.2" y2="14.8"/></svg>',
    columnAdd:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="14" rx="1.5"/><line x1="6.5" y1="3" x2="6.5" y2="17"/><line x1="14" y1="7.8" x2="14" y2="12.2"/><line x1="11.8" y1="10" x2="16.2" y2="10"/></svg>',
    columnDelete:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="14" rx="1.5"/><line x1="6.5" y1="3" x2="6.5" y2="17"/><line x1="11.8" y1="10" x2="16.2" y2="10"/></svg>',
    mergeRight:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="5.5" height="8" rx="1"/><rect x="11.5" y="6" width="5.5" height="8" rx="1"/><path d="M8.7 10h2.4"/><polyline points="9.7 8.6 11.1 10 9.7 11.4"/></svg>',
    mergeDown:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="8" height="5.5" rx="1"/><rect x="6" y="11.5" width="8" height="5.5" rx="1"/><path d="M10 8.7v2.4"/><polyline points="8.6 9.7 10 11.1 11.4 9.7"/></svg>',
    splitCell:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="10" rx="1.5"/><line x1="10" y1="5" x2="10" y2="15"/><polyline points="8 8 6 10 8 12"/><polyline points="12 8 14 10 12 12"/></svg>',
    convert:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 7 14 7"/><polyline points="11 4 14 7 11 10"/><polyline points="15 13 6 13"/><polyline points="9 10 6 13 9 16"/></svg>',
    indent:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 7 9 10 6 13"/><line x1="11" y1="6" x2="16" y2="6"/><line x1="11" y1="10" x2="16" y2="10"/><line x1="11" y1="14" x2="16" y2="14"/></svg>',
    outdent:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 6 10 9 13"/><line x1="11" y1="6" x2="16" y2="6"/><line x1="11" y1="10" x2="16" y2="10"/><line x1="11" y1="14" x2="16" y2="14"/></svg>',
    trash:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 16 6"/><path d="M7.5 6V4.5h5V6"/><path d="M5.8 6l.9 9.5h6.6L14.2 6"/><line x1="9" y1="9" x2="9" y2="13"/><line x1="11" y1="9" x2="11" y2="13"/></svg>',
    note:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.2"/><line x1="10" y1="9.4" x2="10" y2="13"/><circle cx="10" cy="6.8" r=".7" fill="currentColor" stroke="none"/></svg>',
    codeblock:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="M8.5 8.5l-2 1.5 2 1.5"/><path d="M11.5 8.5l2 1.5-2 1.5"/></svg>',
    section:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4.5" width="12" height="3.2" rx="1" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="15" y2="12"/><line x1="4" y1="15.3" x2="11" y2="15.3"/></svg>',
    insertInside:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="2"/><line x1="10" y1="7.5" x2="10" y2="12.5"/><line x1="7.5" y1="10" x2="12.5" y2="10"/></svg>',
    insertBefore:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 8 10 4 14 8"/><line x1="10" y1="4" x2="10" y2="11"/><line x1="4" y1="16" x2="16" y2="16"/></svg>',
    insertAfter:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="16" y2="4"/><line x1="10" y1="9" x2="10" y2="16"/><polyline points="6 12 10 16 14 12"/></svg>',
  };

  const bar = {
    undo:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H14a4 4 0 110 8H7"/><polyline points="9 4 6 7 9 10"/></svg>',
    redo:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 7H6a4 4 0 100 8h7"/><polyline points="11 4 14 7 11 10"/></svg>',
    find:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5"/><line x1="13" y1="13" x2="16.5" y2="16.5"/></svg>',
    code:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 6 3 10 7 14"/><polyline points="13 6 17 10 13 14"/></svg>',
    clearFormat:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h8"/><path d="M9 5v9"/><path d="M6.5 14h5"/><path d="M14.5 12.5l2 2"/><path d="M16.5 12.5l-2 2"/></svg>',
    image:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M4 14.5l4-3.5 3 2.5 2-1.5 3 2.5"/></svg>',
    xref:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 11.8l3.6-3.6"/><path d="M7.5 9l-1.8 1.8a2.5 2.5 0 003.5 3.5L11 12.5"/><path d="M12.5 11l1.8-1.8a2.5 2.5 0 00-3.5-3.5L9 7.5"/></svg>',
    conref:
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="9.5" y="9.5" width="6.5" height="6.5" rx="1.4"/></svg>',
  };

  function menuIconForOp(op) {
    if (op === 'unorderedList' || op === 'listItem') return menu.ul;
    if (op === 'alphabeticList') return menu.alphaOl;
    if (op === 'orderedList') return menu.ol;
    if (op === 'table') return menu.table;
    if (op === 'lines') return menu.lines;
    if (op === 'note') return menu.note;
    if (op === 'codeblock') return menu.codeblock;
    if (op === 'section') return menu.section;
    return menu.paragraph;
  }

  window.DitaEditorCanvasIcons = { menu: menu, bar: bar, menuIconForOp: menuIconForOp };
})();
