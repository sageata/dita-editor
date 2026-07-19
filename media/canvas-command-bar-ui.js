// DOM factory for the persistent command bar.
(function () {
  function createCommandBarUi(opts) {
    const document = opts.document;
    const fontFamily = opts.fontFamily;
    const makeBtn = opts.controls.makeBtn;
    const menuIcons = opts.menuIcons;
    const barIcons = opts.barIcons;
    let groupSequence = 0;

    function makeBarBtn(content, title, isSvg) {
      const b = makeBtn('', title);
      b.classList.add('tb-iconbtn');
      // Command-bar buttons use the fast custom tooltip (canvas-tooltips.js)
      // instead of the slow native title bubble; aria-label stays the source
      // of truth. tooltipOnly tells setBtnEnabled not to restore the title.
      b.title = '';
      if (typeof b.removeAttribute === 'function') b.removeAttribute('title');
      b.dataset.tooltipOnly = '1';
      if (isSvg) b.innerHTML = content;
      else b.textContent = content;
      b.style.cssText =
        'width:34px;height:32px;display:inline-flex;align-items:center;justify-content:center;' +
        'border:0;border-radius:7px;background:transparent;color:#5f5f5f;cursor:pointer;padding:0;' +
        'font:600 13px/1 ' + fontFamily + ';';
      return b;
    }

    function makeBarGroup(label) {
      groupSequence += 1;
      const wrap = document.createElement('div');
      const labelId = 'ditaeditor-command-group-' + groupSequence;
      wrap.className = 'cmd-group';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-labelledby', labelId);
      wrap.style.cssText = 'display:flex;flex:0 0 auto;flex-direction:column;align-items:flex-start;gap:7px;';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:2px;';
      const lab = document.createElement('div');
      lab.id = labelId;
      lab.className = 'cmd-group-label';
      lab.textContent = label;
      lab.style.cssText =
        'font:600 10px/1 ' + fontFamily + ';letter-spacing:.09em;text-transform:uppercase;color:#a3a3a3;padding-left:4px;';
      wrap.append(row, lab);
      return { wrap: wrap, row: row, label: lab };
    }

    function makeBarDivider() {
      const d = document.createElement('div');
      d.setAttribute('role', 'presentation');
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText = 'width:1px;flex:0 0 1px;align-self:stretch;background:#ececec;margin:0 12px;';
      return d;
    }

    const cmdBar = document.createElement('div');
    cmdBar.setAttribute('role', 'toolbar');
    cmdBar.setAttribute('aria-label', 'Document commands');
    cmdBar.className = 'cmd-bar';
    cmdBar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:75;display:flex;align-items:stretch;gap:0;' +
      'box-sizing:border-box;min-height:36px;padding:8px 14px;overflow:visible;background:#fafafa;' +
      'border-bottom:1px solid #ebebeb;font-family:' + fontFamily + ';';
    document.body.appendChild(cmdBar);

    // One fixed row of groups. When the row cannot fit them all it hands
    // trailing groups to the overflow popover (the » caret) — nothing is ever
    // clipped. overflow-x:auto on the row is a safety net if the overflow
    // script fails to load.
    const cmdRows = document.createElement('div');
    cmdRows.className = 'cmd-rows';
    cmdRows.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:0;';
    function makeCmdRow() {
      const row = document.createElement('div');
      row.className = 'cmd-row';
      row.style.cssText = 'display:flex;align-items:flex-start;gap:0;overflow-x:auto;overflow-y:hidden;';
      return row;
    }
    const cmdRow = makeCmdRow();
    cmdRows.append(cmdRow);

    const cmdMain = document.querySelector('main');
    if (cmdMain) cmdMain.style.paddingTop = 'var(--ditaeditor-toolbar-height, 72px)';

    const topicGroup = makeBarGroup('Topic');
    const tPrev = makeBarBtn('‹', 'Previous topic in this folder', false);
    const tNext = makeBarBtn('›', 'Next topic in this folder', false);
    topicGroup.row.append(tPrev, tNext);

    const historyGroup = makeBarGroup('History');
    const hUndo = makeBarBtn(barIcons.undo, 'Undo', true);
    const hRedo = makeBarBtn(barIcons.redo, 'Redo', true);
    const hFind = makeBarBtn(barIcons.find, 'Find', true);
    const hReplace = makeBarBtn('⇄', 'Find and replace', false);
    historyGroup.row.append(hUndo, hRedo, hFind, hReplace);

    const fmtGroup = makeBarGroup('Format');
    const fmtBold = makeBarBtn('<span style="font-weight:700;font-size:15px">B</span>', 'Bold', true);
    const fmtItalic = makeBarBtn('<span style="font-style:italic;font-weight:600;font-size:15px">I</span>', 'Italic', true);
    const fmtUnderline = makeBarBtn('<span style="font-weight:600;font-size:15px;text-decoration:underline">U</span>', 'Underline', true);
    const fmtStrike = makeBarBtn('<span style="font-weight:600;font-size:15px;text-decoration:line-through">S</span>', 'Strikethrough', true);
    const fmtCode = makeBarBtn(barIcons.code, 'Inline code', true);
    const fmtSub = makeBarBtn('<span style="font-weight:600;font-size:13px">X<sub style="font-size:9px">2</sub></span>', 'Subscript', true);
    const fmtSup = makeBarBtn('<span style="font-weight:600;font-size:13px">X<sup style="font-size:9px">2</sup></span>', 'Superscript', true);
    const fmtClear = makeBarBtn(barIcons.clearFormat, 'Remove all styles', true);
    const cAlignHorizontal = makeBarBtn('H↔', 'Horizontal alignment', false);
    cAlignHorizontal.setAttribute('aria-haspopup', 'menu');
    cAlignHorizontal.setAttribute('aria-expanded', 'false');
    fmtGroup.row.append(fmtBold, fmtItalic, fmtUnderline, fmtStrike, fmtCode, fmtSub, fmtSup, fmtClear, cAlignHorizontal);
    const fmtBtns = [fmtBold, fmtItalic, fmtUnderline, fmtStrike, fmtCode, fmtSub, fmtSup];
    const fmtActionBtns = [fmtBold, fmtItalic, fmtUnderline, fmtStrike, fmtCode, fmtSub, fmtSup, fmtClear];
    const fmtOp = { Bold: 'b', Italic: 'i', Underline: 'u', Strikethrough: 'line-through', 'Inline code': 'codeph', Subscript: 'sub', Superscript: 'sup' };
    const fmtBtnByOp = { b: fmtBold, i: fmtItalic, u: fmtUnderline, 'line-through': fmtStrike, codeph: fmtCode, sub: fmtSub, sup: fmtSup };
    const fmtSelector = {
      b: 'strong.ph.b,b',
      i: 'em.ph.i,i',
      u: 'u.ph.u,span.ph.u,u',
      'line-through': 'span.ph.line-through,s,del,strike',
      codeph: 'code.ph.codeph,code',
      sub: 'sub.ph.sub,sub',
      sup: 'sup.ph.sup,sup',
    };

    const structGroup = makeBarGroup('Structure');
    const biParagraph = makeBarBtn(menuIcons.paragraph, 'Paragraph', true);
    const biSection = makeBarBtn(menuIcons.section, 'Section heading', true);
    const biList = makeBarBtn(menuIcons.ul, 'Bulleted list', true);
    const aiList = makeBarBtn(menuIcons.alphaOl || '<span style="font-weight:600;font-size:14px">a.</span>', 'Alphabetic list', true);
    const niList = makeBarBtn(menuIcons.ol, 'Numbered list', true);
    const biLines = makeBarBtn(menuIcons.lines, 'Lines', true);
    const biNote = makeBarBtn(menuIcons.note, 'Note', true);
    const biCode = makeBarBtn(menuIcons.codeblock, 'Code block', true);
    const biIndent = makeBarBtn(menuIcons.indent, 'Increase indent', true);
    const biOutdent = makeBarBtn(menuIcons.outdent, 'Decrease indent', true);
    structGroup.row.append(biParagraph, biSection, biList, aiList, niList, biLines, biNote, biCode, biIndent, biOutdent);

    const insertGroup = makeBarGroup('Insert');
    const biTable = makeBarBtn(menuIcons.table, 'Table', true);
    const biImage = makeBarBtn(barIcons.image, 'Image', true);
    const biXref = makeBarBtn(barIcons.xref, 'Cross-reference', true);
    const biConref = makeBarBtn(barIcons.conref, 'Reuse content', true);
    insertGroup.row.append(biTable, biImage, biXref, biConref);
    const inlineInsertBtns = [biImage, biXref, biConref];
    const inlineInsertOp = { Image: 'image', 'Cross-reference': 'xref', 'Reuse content': 'conref' };

    const tableGroup = makeBarGroup('Table');
    const cRowAdd = makeBarBtn('+▭', 'Add row below', false);
    const cRowDel = makeBarBtn('−▭', 'Delete this row', false);
    const cColAdd = makeBarBtn('+|', 'Add column to the right', false);
    const cColDel = makeBarBtn('−|', 'Delete this column', false);
    const cAlignVertical = makeBarBtn('V↕', 'Vertical alignment', false);
    cAlignVertical.setAttribute('aria-haspopup', 'menu');
    cAlignVertical.setAttribute('aria-expanded', 'false');
    tableGroup.row.append(cRowAdd, cRowDel, cColAdd, cColDel, cAlignVertical);

    const viewGroup = makeBarGroup('View');
    const vZoomOut = makeBarBtn('−', 'Zoom out', false);
    const vZoomPct = makeBarBtn('100%', 'Reset zoom', false);
    vZoomPct.style.width = 'auto';
    vZoomPct.style.minWidth = '42px';
    vZoomPct.style.padding = '0 5px';
    vZoomPct.style.font = '600 11px/1 ' + fontFamily;
    const vZoomIn = makeBarBtn('+', 'Zoom in', false);
    const vSpell = makeBarBtn('abc', 'Toggle spellcheck', false);
    vSpell.style.font = '600 11px/1 ' + fontFamily;
    const vHelp = makeBarBtn('?', 'Keyboard shortcuts', false);
    viewGroup.row.append(vZoomOut, vZoomPct, vZoomIn, vSpell, vHelp);

    const topicDivider = makeBarDivider();
    const historyDivider = makeBarDivider();
    const fmtDivider = makeBarDivider();
    const tableDivider = makeBarDivider();
    const insertDivider = makeBarDivider();
    const viewDivider = makeBarDivider();

    const cmdStatus = document.createElement('span');
    cmdStatus.className = 'cmd-status';
    cmdStatus.textContent = 'DITA · visual';
    cmdStatus.setAttribute('aria-label', 'DITA Editor visual editor');
    cmdStatus.style.cssText =
      'margin-left:auto;flex:0 0 auto;align-self:center;font:11px/1.5 ' + fontFamily + ';color:#5a6b78;white-space:nowrap;';
    cmdRow.append(
      topicGroup.wrap, topicDivider,
      historyGroup.wrap, historyDivider,
      fmtGroup.wrap, fmtDivider,
      structGroup.wrap, insertDivider, insertGroup.wrap,
      tableDivider, tableGroup.wrap,
      viewDivider, viewGroup.wrap,
      cmdStatus,
    );

    // Large caret at the bar's right edge; hidden until the row overflows.
    // The overflow module toggles it and owns the popover it points at.
    const moreBtn = makeBarBtn('»', 'More commands', false);
    moreBtn.classList.add('cmd-more');
    moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.setAttribute('aria-controls', 'ditaeditor-command-overflow');
    moreBtn.style.width = '30px';
    moreBtn.style.height = 'auto';
    moreBtn.style.alignSelf = 'stretch';
    moreBtn.style.flex = '0 0 auto';
    moreBtn.style.marginLeft = '8px';
    moreBtn.style.fontSize = '20px';
    moreBtn.style.display = 'none';

    const overflowPop = document.createElement('div');
    overflowPop.id = 'ditaeditor-command-overflow';
    overflowPop.className = 'cmd-overflow-pop';
    overflowPop.setAttribute('role', 'group');
    overflowPop.setAttribute('aria-label', 'More commands');
    overflowPop.style.cssText =
      'position:fixed;top:var(--ditaeditor-toolbar-height, 72px);right:8px;z-index:80;display:none;' +
      'flex-direction:column;align-items:flex-start;gap:14px;padding:12px 14px;background:#fafafa;' +
      'border:1px solid #e3e3e3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.14);' +
      'max-height:calc(100vh - 140px);overflow:auto;font-family:' + fontFamily + ';';
    // Set separately from cssText: the overflow manager and roving filter key
    // off style.display, and the closed state must survive a stale stylesheet.
    overflowPop.style.display = 'none';
    document.body.appendChild(overflowPop);

    cmdBar.append(cmdRows, moreBtn);

    // Canonical row membership for the overflow manager: each entry pairs a
    // group with the divider rendered before it in the row.
    const cmdRowEntries = [
      { wrap: topicGroup.wrap, divider: null },
      { wrap: historyGroup.wrap, divider: topicDivider },
      { wrap: fmtGroup.wrap, divider: historyDivider },
      { wrap: structGroup.wrap, divider: fmtDivider },
      { wrap: insertGroup.wrap, divider: insertDivider },
      { wrap: tableGroup.wrap, divider: tableDivider },
      { wrap: viewGroup.wrap, divider: viewDivider },
    ];

    const cmdBtns = [
      tPrev, tNext,
      hUndo, hRedo, hFind, hReplace,
      fmtBold, fmtItalic, fmtUnderline, fmtStrike, fmtCode, fmtSub, fmtSup, fmtClear,
      biParagraph, biSection, biList, aiList, niList, biLines, biNote, biCode, biIndent, biOutdent, biTable, biImage, biXref, biConref,
      cRowAdd, cRowDel, cColAdd, cColDel, cAlignHorizontal, cAlignVertical,
      vZoomOut, vZoomPct, vZoomIn, vSpell, vHelp,
      moreBtn,
    ];

    return {
      cmdBar: cmdBar,
      historyGroup: historyGroup,
      fmtGroup: fmtGroup,
      structGroup: structGroup,
      insertGroup: insertGroup,
      tableGroup: tableGroup,
      historyDivider: historyDivider,
      fmtDivider: fmtDivider,
      insertDivider: insertDivider,
      tableDivider: tableDivider,
      cmdStatus: cmdStatus,
      cmdBtns: cmdBtns,
      hUndo: hUndo,
      hRedo: hRedo,
      hFind: hFind,
      hReplace: hReplace,
      topicGroup: topicGroup,
      topicDivider: topicDivider,
      tPrev: tPrev,
      tNext: tNext,
      fmtBold: fmtBold,
      fmtItalic: fmtItalic,
      fmtUnderline: fmtUnderline,
      fmtStrike: fmtStrike,
      fmtCode: fmtCode,
      fmtSub: fmtSub,
      fmtSup: fmtSup,
      fmtClear: fmtClear,
      fmtBtns: fmtBtns,
      fmtActionBtns: fmtActionBtns,
      fmtOp: fmtOp,
      fmtBtnByOp: fmtBtnByOp,
      fmtSelector: fmtSelector,
      biParagraph: biParagraph,
      biSection: biSection,
      biList: biList,
      aiList: aiList,
      niList: niList,
      biLines: biLines,
      biNote: biNote,
      biCode: biCode,
      biIndent: biIndent,
      biOutdent: biOutdent,
      biTable: biTable,
      biImage: biImage,
      biXref: biXref,
      biConref: biConref,
      inlineInsertBtns: inlineInsertBtns,
      inlineInsertOp: inlineInsertOp,
      cRowAdd: cRowAdd,
      cRowDel: cRowDel,
      cColAdd: cColAdd,
      cColDel: cColDel,
      cAlignHorizontal: cAlignHorizontal,
      cAlignVertical: cAlignVertical,
      viewGroup: viewGroup,
      viewDivider: viewDivider,
      vZoomOut: vZoomOut,
      vZoomPct: vZoomPct,
      vZoomIn: vZoomIn,
      vSpell: vSpell,
      vHelp: vHelp,
      cmdRows: cmdRows,
      cmdRow: cmdRow,
      cmdRowEntries: cmdRowEntries,
      moreBtn: moreBtn,
      overflowPop: overflowPop,
    };
  }

  window.DitaEditorCanvasCommandBarUi = {
    createCommandBarUi: createCommandBarUi,
  };
})();
