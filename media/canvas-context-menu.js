// Right-click context menu for the DITA Editor canvas.
//
// Loaded before canvas.js. Owns the persistent cell/element context menu and
// routes actions through existing host message callbacks.
(function () {
  function installContextMenu(opts) {
    const document = opts.document;
    const menu = opts.menu;
    const menuIcons = opts.menuIcons;
    const menuIconForOp = opts.menuIconForOp;
    const editableTarget = opts.editableTarget;
    const toolbar = opts.toolbar;
    const clearHideTimer = opts.clearHideTimer;
    const highlightCell = opts.highlightCell;
    const clearCellHighlight = opts.clearCellHighlight;
    const caretOffset = opts.caretOffset;
    const setCaret = opts.setCaret;
    const columnAnchorId = opts.columnAnchorId;
    const availFor = opts.availFor;
    const postStructural = opts.postStructural;
    const withStructuralSuccess = opts.withStructuralSuccess || function (_op, _kind, extra) { return extra || {}; };
    const transformAvailFor = opts.transformAvailFor;
    const postTransform = opts.postTransform;
    const resolveInsertEntries = opts.resolveInsertEntries;
    const insertAvailFor = opts.insertAvailFor;
    const idOfPayload = opts.idOfPayload;
    const nounForKind = opts.nounForKind;
    const announceNav = opts.announceNav;
    const showError = opts.showError;
    const vscode = opts.vscode;
    const getStyleState = opts.getStyleState || function () { return {}; };
    const getStructVersion = opts.getStructVersion || function () { return 0; };

    function createMenu(ariaLabel, onToggle) {
      return menu.createMenu(ariaLabel, onToggle, {
        announceNav: announceNav,
        showError: showError,
      });
    }

    function postConfirmedStructural(op, id, kind) {
      postStructural(op, id, withStructuralSuccess(op, kind));
    }

    let ctxMenuOpen = false;
    const ctxMenu = createMenu('Table cell actions', (o) => {
      ctxMenuOpen = o;
    });

    function elementTagForKind(kind) {
      if (kind === 'p') return '<p>';
      if (kind === 'li') return '<li>';
      if (kind === 'title') return '<title>';
      if (kind === 'shortdesc') return '<shortdesc>';
      if (kind === 'section') return '<section>';
      if (kind === 'image') return '<image>';
      if (kind === 'fig') return '<fig>';
      if (kind === 'table') return '<table>';
      if (kind === 'ul') return '<ul>';
      if (kind === 'ol') return '<ol>';
      if (kind === 'lines') return '<lines>';
      if (kind === 'codeblock') return '<codeblock>';
      if (kind === 'note') return '<note>';
      if (kind === 'row') return '<row>';
      return kind ? '<' + kind + '>' : '<element>';
    }

    function menuIconForKind(kind) {
      if (kind === 'p' || kind === 'shortdesc') return menuIcons.paragraph;
      if (kind === 'li' || kind === 'ul') return menuIcons.ul;
      if (kind === 'ol') return menuIcons.ol;
      if (kind === 'table') return menuIcons.table;
      if (kind === 'lines') return menuIcons.lines;
      if (kind === 'codeblock') return menuIcons.codeblock;
      if (kind === 'note') return menuIcons.note;
      if (kind === 'alphabeticList') return menuIcons.alphaOl || menuIcons.ol;
      if (kind === 'section' || kind === 'title') return menuIcons.section;
      return menuIcons.paragraph;
    }

    function insertNounForOp(op) {
      if (op === 'paragraph') return 'Paragraph';
      if (op === 'unorderedList') return 'Bulleted list';
      if (op === 'alphabeticList') return 'Alphabetic list';
      if (op === 'orderedList') return 'Numbered list';
      if (op === 'table') return 'Table';
      if (op === 'lines') return 'Line-respecting text';
      if (op === 'note') return 'Note';
      if (op === 'codeblock') return 'Code block';
      if (op === 'section') return 'Section';
      if (op === 'listItem') return 'List item';
      return op;
    }

    function listStyleFromElement(listEl) {
      if (!listEl) return null;
      const tag = listEl.tagName.toLowerCase();
      if (tag === 'ul') return 'unordered';
      const outputclass = listEl.getAttribute('data-outputclass') || '';
      const className = typeof listEl.className === 'string' ? listEl.className : '';
      const tokens = (outputclass + ' ' + className).split(/\s+/).filter(Boolean);
      return tokens.indexOf('lower-alpha') >= 0 ? 'alpha' : 'ordered';
    }

    function postInsert(entry) {
      vscode.postMessage({ type: 'insert', op: entry.op, payload: entry.payload });
      announceNav(entry.label + '…');
    }

    function nearestContainerDelete(node) {
      let el = node && node.closest ? node.closest('[data-struct-kind="table"],[data-struct-kind="fig"],ul.ul,ol.ol') : null;
      while (el) {
        const kind = el.getAttribute('data-struct-kind');
        if (kind === 'table') return { op: 'deleteTable', id: el.getAttribute('data-struct-id'), noun: 'table' };
        if (kind === 'fig') return { op: 'deleteFig', id: el.getAttribute('data-struct-id'), noun: 'figure' };
        if (el.hasAttribute('data-struct-id')) return { op: 'deleteList', id: el.getAttribute('data-struct-id'), noun: 'list' };
        const p = el.parentElement;
        el = p && p.closest ? p.closest('[data-struct-kind="table"],[data-struct-kind="fig"],ul.ul,ol.ol') : null;
      }
      return null;
    }

    // IX-3 structural copy/paste as real DITA. Copy slices the element's exact
    // source bytes host-side; paste splices the OS-clipboard fragment next to
    // this element (the host validates well-formedness + compatibility and
    // announces refusals — the menu never guesses the clipboard's contents).
    function pushDitaClipboard(defs, ctx) {
      defs.push({ separator: true, inset: true });
      defs.push({
        label: 'Copy as DITA',
        icon: menuIcons.convert,
        enabled: true,
        onActivate: () => {
          vscode.postMessage({ type: 'copyDita', ids: [ctx.id] });
        },
      });
      defs.push({
        label: 'Paste DITA before',
        icon: menuIcons.insertBefore,
        enabled: true,
        onActivate: () => {
          vscode.postMessage({ type: 'pasteDita', id: ctx.id, op: 'before', baseStructVersion: getStructVersion() });
        },
      });
      defs.push({
        label: 'Paste DITA after',
        icon: menuIcons.insertAfter,
        enabled: true,
        onActivate: () => {
          vscode.postMessage({ type: 'pasteDita', id: ctx.id, op: 'after', baseStructVersion: getStructVersion() });
        },
      });
    }

    function pushContainerDelete(defs, node) {
      const cont = nearestContainerDelete(node);
      if (!cont || cont.id == null) return;
      const a = availFor(cont.id, cont.op);
      defs.push({
        label: 'Delete this ' + cont.noun,
        icon: menuIcons.trash,
        del: true,
        enabled: a.enabled,
        reason: a.reason,
        onActivate: () => postConfirmedStructural(cont.op, cont.id, cont.noun),
      });
    }

    // F1/F3/F4 presentation flyouts. Values post the dedicated CALS message (the
    // host re-resolves the element kind, validates the closed matrix, and splices
    // byte-minimal attrs); the current
    // value is read back from the renderer's resolved data-* attributes, so an
    // inherited (colspec/tgroup) value also reads as "already".
    function postSetAttr(id, attrName, attrValue) {
      vscode.postMessage({
        type: 'setCalsAttr', id: id, attrName: attrName,
        attrValue: attrValue, baseStructVersion: getStructVersion(),
      });
    }
    function attrChoice(prefix, id, attrName, value, label, current) {
      return {
        label: prefix ? prefix + ': ' + label : label,
        enabled: (current || '') !== value,
        reason: 'Already ' + label.toLowerCase(),
        onActivate: () => postSetAttr(id, attrName, value),
      };
    }

    // F2 shading palette: hex-only (the managed class name encodes the color).
    const SHADE_CHOICES = [
      ['#eff1f3', 'Neutral'],
      ['#f7f0e4', 'Gold tint'],
      ['#e3edf7', 'Blue tint'],
      ['#ffffff', 'White'],
    ];
    function shadeSubmenu(id) {
      const post = (color) => {
        const styleState = getStyleState() || {};
        const message = {
          type: color ? 'applyShade' : 'clearShade',
          ids: [id],
          sourceHash: String(styleState.sourceHash || ''),
          targetToken: String(styleState.targetToken || ''),
          baseStructVersion: getStructVersion(),
        };
        if (color) message.color = color;
        vscode.postMessage(message);
      };
      const items = SHADE_CHOICES.map(([color, label]) => ({
        label: label,
        enabled: true,
        onActivate: () => post(color),
      }));
      items.push({ label: 'Custom color…', enabled: true, onActivate: () => post('custom') });
      items.push({ separator: true });
      items.push({ label: 'Clear shading', enabled: true, onActivate: () => post('') });
      return items;
    }

    function pushPresentation(defs, tr, cell, rowId, cellEntryId) {
      const sep = (prefix, id, attrName, current) => [
        attrChoice(prefix, id, attrName, '1', 'On', current),
        attrChoice(prefix, id, attrName, '0', 'Off', current),
        attrChoice(prefix, id, attrName, '', 'Default', current),
      ];
      defs.push({
        label: 'Borders',
        icon: menuIcons.table,
        enabled: true,
        submenu: [
          ...sep('Right border', cellEntryId, 'colsep', cell.getAttribute('data-colsep')),
          { separator: true },
          ...sep('Bottom border', cellEntryId, 'rowsep', cell.getAttribute('data-rowsep')),
          { separator: true },
          ...sep('Row bottom border', rowId, 'rowsep', tr.getAttribute('data-rowsep')),
        ],
        submenuWidth: 230,
      });
      const curAlign = cell.getAttribute('data-align');
      defs.push({
        label: 'Align text',
        icon: menuIcons.paragraph,
        enabled: true,
        submenu: [
          attrChoice('', cellEntryId, 'align', 'left', 'Left', curAlign),
          attrChoice('', cellEntryId, 'align', 'center', 'Center', curAlign),
          attrChoice('', cellEntryId, 'align', 'right', 'Right', curAlign),
          attrChoice('', cellEntryId, 'align', 'justify', 'Justify', curAlign),
          attrChoice('', cellEntryId, 'align', '', 'Default', curAlign),
        ],
      });
      const curValign = cell.getAttribute('data-valign');
      defs.push({
        label: 'Vertical align',
        icon: menuIcons.lines,
        enabled: true,
        submenu: [
          attrChoice('Cell', cellEntryId, 'valign', 'top', 'Top', curValign),
          attrChoice('Cell', cellEntryId, 'valign', 'middle', 'Middle', curValign),
          attrChoice('Cell', cellEntryId, 'valign', 'bottom', 'Bottom', curValign),
          attrChoice('Cell', cellEntryId, 'valign', '', 'Default', curValign),
          { separator: true },
          attrChoice('Row', rowId, 'valign', 'top', 'Top', null),
          attrChoice('Row', rowId, 'valign', 'middle', 'Middle', null),
          attrChoice('Row', rowId, 'valign', 'bottom', 'Bottom', null),
          attrChoice('Row', rowId, 'valign', '', 'Default', null),
        ],
        submenuWidth: 190,
      });
      defs.push({
        label: 'Cell shading',
        icon: menuIcons.tableCell || menuIcons.table,
        enabled: true,
        submenu: shadeSubmenu(cellEntryId),
      });
      defs.push({
        label: 'Row shading',
        icon: menuIcons.table,
        enabled: true,
        submenu: shadeSubmenu(rowId),
      });
    }

    // F5 @frame picker + F1 table-wide grid lines, reachable from any cell.
    function pushTablePresentation(defs, node) {
      const table = node && node.closest ? node.closest('table[data-struct-id]') : null;
      if (!table) return;
      const tableId = table.getAttribute('data-struct-id');
      const frameCurrent = (() => {
        const m = /(?:^|\s)frame-([a-z]+)(?:\s|$)/.exec(table.className || '');
        return m ? m[1] : '';
      })();
      const frameChoice = (value, label) =>
        attrChoice('', tableId, 'frame', value, label, frameCurrent);
      defs.push({
        label: 'Table frame',
        icon: menuIcons.table,
        enabled: true,
        submenu: [
          frameChoice('all', 'All'),
          frameChoice('topbot', 'Top and bottom'),
          frameChoice('sides', 'Sides'),
          frameChoice('top', 'Top'),
          frameChoice('bottom', 'Bottom'),
          frameChoice('none', 'None'),
          frameChoice('', 'Default'),
        ],
      });
      const postGrid = (value) => {
        vscode.postMessage({
          type: 'setTgroupAttr',
          id: tableId,
          attrs: [{ name: 'colsep', value: value }, { name: 'rowsep', value: value }],
          baseStructVersion: getStructVersion(),
        });
      };
      defs.push({
        label: 'Grid lines',
        icon: menuIcons.table,
        enabled: true,
        submenu: [
          { label: 'All grid lines', enabled: true, onActivate: () => postGrid('1') },
          { label: 'No grid lines', enabled: true, onActivate: () => postGrid('0') },
          { label: 'Default', enabled: true, onActivate: () => postGrid('') },
        ],
      });
    }

    // F10 table title: "Add" when the table has no <title>; "Remove" (deleteTitle
    // on the caption's struct id) when it does. The caption itself is also a normal
    // editable leaf, so renaming needs no menu item.
    function pushTableTitle(defs, node) {
      const table = node && node.closest ? node.closest('table[data-struct-id]') : null;
      if (!table) return;
      const tableId = table.getAttribute('data-struct-id');
      const caption = table.querySelector('caption[data-struct-id]');
      if (caption) {
        const titleId = caption.getAttribute('data-struct-id');
        const a = availFor(titleId, 'deleteTitle');
        defs.push({
          label: 'Remove table title',
          icon: menuIcons.trash,
          enabled: a.enabled,
          reason: a.reason,
          onActivate: () => postConfirmedStructural('deleteTitle', titleId, 'title'),
        });
      } else {
        const a = availFor(tableId, 'addTableTitle');
        defs.push({
          label: 'Add table title',
          icon: menuIcons.section,
          enabled: a.enabled,
          reason: a.reason,
          onActivate: () => postConfirmedStructural('addTableTitle', tableId, 'table'),
        });
      }
    }

    function openCellMenuFor(tr, cell, x, y, leaf) {
      const rowId = tr.getAttribute('data-struct-id');
      const cellEntryId = cell.getAttribute('data-cell-id');
      const colAnchorId = columnAnchorId(cell);
      const cellMerged = cell.hasAttribute('colspan') || cell.hasAttribute('rowspan');
      const defs = [
        { elementHeader: { label: 'Table cell', icon: menuIcons.tableCell || menuIcons.table, tag: '<entry>' } },
        { separator: true },
        { header: 'TRANSFORM' },
      ];
      const tf = (label, transform, icon) => {
        const a = transformAvailFor(cellEntryId, transform);
        defs.push({
          label: label,
          icon: icon,
          enabled: a.status === 'ok',
          reason: a.reason || (a.status === 'noop' ? 'Already in that form' : 'Not available here'),
          onActivate: () => postTransform(transform, cellEntryId),
        });
      };
      tf('Convert content to paragraph', 'entryToParagraph', menuIcons.paragraph);
      tf('Convert content to bulleted list', 'entryToUnorderedList', menuIcons.ul);
      tf('Convert content to alphabetic list', 'entryToAlphabeticList', menuIcons.alphaOl || menuIcons.ol);
      tf('Convert content to numbered list', 'entryToOrderedList', menuIcons.ol);
      tf('Convert content to lines', 'entryToLines', menuIcons.lines);
      tf('Convert content to note', 'entryToNote', menuIcons.note);
      tf('Convert content to code block', 'entryToCodeblock', menuIcons.codeblock);
      defs.push(
        { separator: true },
        { header: 'ROW' },
      );
      const op = (label, icon, opName, id, av) => {
        defs.push({
          label: label,
          icon: icon,
          enabled: av.enabled,
          reason: av.reason,
          onActivate: () => postConfirmedStructural(opName, id, 'row'),
        });
      };
      op('Add row above', menuIcons.rowAdd, 'addRowBefore', rowId, availFor(rowId, 'addRowBefore'));
      op('Add row below', menuIcons.rowAdd, 'addRowAfter', rowId, availFor(rowId, 'addRowAfter'));
      // F6 header toggle: the item matches the row's CURRENT section.
      const inHeader = !!(tr.closest && tr.closest('thead'));
      if (inHeader) {
        op('Move header row into body', menuIcons.table, 'demoteRowFromHeader', rowId, availFor(rowId, 'demoteRowFromHeader'));
      } else {
        op('Make this the header row', menuIcons.table, 'promoteRowToHeader', rowId, availFor(rowId, 'promoteRowToHeader'));
      }
      op('Delete row', menuIcons.rowDelete, 'deleteRow', rowId, availFor(rowId, 'deleteRow'));
      defs.push({ header: 'COLUMN' });
      const anchorOk = !!colAnchorId;
      const colOp = (label, icon, opName) => {
        const av = availFor(cellEntryId, opName);
        defs.push({
          label: label,
          icon: icon,
          enabled: anchorOk && av.enabled,
          reason: !anchorOk ? 'No editable cell in this column' : av.reason,
          onActivate: () => postConfirmedStructural(opName, colAnchorId, 'row'),
        });
      };
      colOp('Add column to the left', menuIcons.columnAdd, 'addColumnBefore');
      colOp('Add column to the right', menuIcons.columnAdd, 'addColumnAfter');
      colOp('Move column left', menuIcons.insertBefore, 'moveColumnLeft');
      colOp('Move column right', menuIcons.insertAfter, 'moveColumnRight');
      colOp('Delete column', menuIcons.columnDelete, 'deleteColumn');
      defs.push({ header: 'MERGE' });
      op('Merge with the cell on the right', menuIcons.mergeRight, 'mergeRight', cellEntryId, availFor(cellEntryId, 'mergeRight'));
      op('Merge with the cell on the left', menuIcons.mergeRight, 'mergeLeft', cellEntryId, availFor(cellEntryId, 'mergeLeft'));
      op('Merge with the cell below', menuIcons.mergeDown, 'mergeDown', cellEntryId, availFor(cellEntryId, 'mergeDown'));
      op('Merge with the cell above', menuIcons.mergeDown, 'mergeUp', cellEntryId, availFor(cellEntryId, 'mergeUp'));
      if (cellMerged) op('Split this merged cell', menuIcons.splitCell, 'splitCell', cellEntryId, availFor(cellEntryId, 'splitCell'));
      defs.push({ separator: true });
      defs.push({ header: 'PRESENTATION' });
      pushPresentation(defs, tr, cell, rowId, cellEntryId);
      defs.push({ separator: true });
      defs.push({ header: 'TABLE' });
      pushTableTitle(defs, cell);
      pushTablePresentation(defs, cell);
      defs.push({ header: 'DELETE' });
      pushContainerDelete(defs, cell);

      const interactive = defs.filter((d) => d.onActivate).length;
      clearHideTimer();
      toolbar.style.display = 'none';
      highlightCell(cell);
      const off = leaf ? caretOffset(leaf) : 0;
      ctxMenu.openAt(defs, x, y, {
        ariaLabel: 'Table cell actions',
        width: 340,
        announce:
          'Table cell actions. ' + interactive + ' commands. Up and Down to choose, Enter to apply, Escape to close.',
        onClose: (restore) => {
          clearCellHighlight();
          if (restore && leaf && leaf.isConnected) setCaret(leaf, off);
        },
      });
    }

    function elementCtx(el) {
      const structEl = el && el.closest ? el.closest('[data-struct-id]') : null;
      if (!structEl) return null;
      const cellEl = el.closest ? el.closest('td[data-cell-id], th[data-cell-id]') : null;
      return {
        id: structEl.getAttribute('data-struct-id'),
        kind: structEl.getAttribute('data-struct-kind'),
        structEl: structEl,
        cellEl: cellEl || null,
        cellEntryId: cellEl ? cellEl.getAttribute('data-cell-id') : null,
      };
    }

    function transformDefsForContext(ctx, compact) {
      const id = ctx.id;
      const local = [];
      const tf = (label, transform, icon, forceReason) => {
        const a = transformAvailFor(id, transform);
        const enabled = !forceReason && a.status === 'ok';
        const reason = forceReason || a.reason || (a.status === 'noop' ? 'Already in that form' : 'Not available here');
        local.push({ label: label, icon: icon, enabled: enabled, reason: reason, onActivate: () => postTransform(transform, id) });
      };
      if (ctx.kind === 'p') {
        tf(compact ? 'Section' : 'Convert to section', 'paragraphToSection', menuIcons.section);
        tf(compact ? 'Bulleted list' : 'Convert to bulleted list', 'paragraphToUnorderedList', menuIcons.ul);
        tf(compact ? 'Alphabetic list' : 'Convert to alphabetic list', 'paragraphToAlphabeticList', menuIcons.alphaOl || menuIcons.ol);
        tf(compact ? 'Numbered list' : 'Convert to numbered list', 'paragraphToOrderedList', menuIcons.ol);
        tf(compact ? 'Note' : 'Convert to note', 'paragraphToNote', menuIcons.note);
        tf(compact ? 'Code block' : 'Convert to code block', 'paragraphToCodeblock', menuIcons.codeblock);
        tf(compact ? 'List item' : 'Convert to list item', 'paragraphToItem', menuIcons.ul);
      } else if (ctx.kind === 'li') {
        const listEl = ctx.structEl.closest('ul, ol');
        const listStyle = listStyleFromElement(listEl);
        tf(compact ? 'Paragraph' : 'Convert to paragraph', 'itemToParagraph', menuIcons.paragraph);
        tf(compact ? 'Alphabetic list' : 'Convert to alphabetic list', 'toAlphabeticList', menuIcons.alphaOl || menuIcons.ol, listStyle === 'alpha' ? 'List is already alphabetic' : null);
        tf(compact ? 'Numbered list' : 'Convert to numbered list', 'toOrderedList', menuIcons.ol, listStyle === 'ordered' ? 'List is already numbered' : null);
        tf(compact ? 'Bulleted list' : 'Convert to bulleted list', 'toUnorderedList', menuIcons.ul, listStyle === 'unordered' ? 'List is already a bulleted list' : null);
      } else if (ctx.kind === 'lines') {
        tf(compact ? 'Paragraph' : 'Convert to paragraph', 'linesToParagraph', menuIcons.paragraph);
        tf(compact ? 'Bulleted list' : 'Convert to bulleted list', 'linesToUnorderedList', menuIcons.ul);
        tf(compact ? 'Alphabetic list' : 'Convert to alphabetic list', 'linesToAlphabeticList', menuIcons.alphaOl || menuIcons.ol);
        tf(compact ? 'Numbered list' : 'Convert to numbered list', 'linesToOrderedList', menuIcons.ol);
        tf(compact ? 'Section' : 'Convert to section', 'linesToSection', menuIcons.section);
        tf(compact ? 'Note' : 'Convert to note', 'linesToNote', menuIcons.note);
        tf(compact ? 'Code block' : 'Convert to code block', 'linesToCodeblock', menuIcons.codeblock);
      } else if (ctx.kind === 'ul' || ctx.kind === 'ol') {
        const listStyle = listStyleFromElement(ctx.structEl);
        tf(compact ? 'Alphabetic list' : 'Convert to alphabetic list', 'toAlphabeticList', menuIcons.alphaOl || menuIcons.ol, listStyle === 'alpha' ? 'List is already alphabetic' : null);
        tf(compact ? 'Numbered list' : 'Convert to numbered list', 'toOrderedList', menuIcons.ol, listStyle === 'ordered' ? 'List is already numbered' : null);
        tf(compact ? 'Bulleted list' : 'Convert to bulleted list', 'toUnorderedList', menuIcons.ul, listStyle === 'unordered' ? 'List is already a bulleted list' : null);
      }
      return local;
    }

    function pushConvertFlyout(defs, ctx) {
      const transforms = transformDefsForContext(ctx, true);
      if (!transforms.length) return;
      defs.push({
        label: 'Convert to',
        icon: menuIcons.convert,
        enabled: true,
        submenuWidth: 210,
        submenu: transforms,
      });
    }

    function entriesForPlacement(ctx, entries, mode) {
      return entries.filter((entry) => entry.payload && entry.payload.mode === mode && idOfPayload(entry.payload) === ctx.id);
    }

    function entriesGroupedByPlacement(entries, mode) {
      const groups = [];
      for (const entry of entries) {
        if (!entry.payload || entry.payload.mode !== mode) continue;
        const targetId = idOfPayload(entry.payload);
        let group = groups.find((g) => g.targetId === targetId);
        if (!group) {
          group = { targetId: targetId, entries: [] };
          groups.push(group);
        }
        group.entries.push(entry);
      }
      return groups;
    }

    function insertSubmenuItems(entries) {
      return entries.map((entry) => {
        const a = insertAvailFor(idOfPayload(entry.payload), entry.payload.mode, entry.op);
        return {
          label: insertNounForOp(entry.op),
          icon: menuIconForOp(entry.op),
          enabled: a.enabled,
          reason: a.reason,
          onActivate: () => postInsert(entry),
        };
      });
    }

    function pushInsertFlyout(defs, label, icon, entries) {
      if (!entries.length) return;
      defs.push({
        label: label,
        icon: icon,
        enabled: true,
        submenuWidth: 210,
        submenu: insertSubmenuItems(entries),
      });
    }

    function structKindForId(id) {
      if (id == null) return null;
      const value = String(id);
      const root = typeof document.querySelectorAll === 'function' ? document : document.body;
      for (const el of root.querySelectorAll('[data-struct-id]')) {
        if (el.getAttribute('data-struct-id') === value) return el.getAttribute('data-struct-kind');
      }
      return null;
    }

    function targetSuffix(ctx, targetId) {
      if (targetId === ctx.id) return '';
      const kind = structKindForId(targetId);
      return kind ? ' ' + nounForKind(kind) : '';
    }

    function pushGroupedInsertFlyouts(defs, ctx, entries) {
      const placements = [
        { mode: 'into', label: 'Insert inside', icon: menuIcons.insertInside },
        { mode: 'before', label: 'Insert before', icon: menuIcons.insertBefore },
        { mode: 'after', label: 'Insert after', icon: menuIcons.insertAfter },
      ];
      for (const placement of placements) {
        for (const group of entriesGroupedByPlacement(entries, placement.mode)) {
          pushInsertFlyout(
            defs,
            placement.label + targetSuffix(ctx, group.targetId),
            placement.icon,
            group.entries,
          );
        }
      }
    }

    function compactElementMenuDefs(ctx) {
      const defs = [
        { elementHeader: { label: nounForKind(ctx.kind), icon: menuIconForKind(ctx.kind), tag: elementTagForKind(ctx.kind) } },
        { separator: true },
        { spacer: 6 },
      ];
      pushConvertFlyout(defs, ctx);

      const entries = resolveInsertEntries(ctx);
      if (entries.length) {
        defs.push({ separator: true, inset: true });
        pushGroupedInsertFlyouts(defs, ctx, entries);
      }
      pushDitaClipboard(defs, ctx);

      defs.push({ separator: true });
      const del = availFor(ctx.id, 'deleteElement');
      defs.push({
        label: 'Delete this ' + nounForKind(ctx.kind),
        icon: menuIcons.trash,
        del: true,
        shortcut: 'Del',
        enabled: del.enabled,
        reason: del.reason,
        onActivate: () => postConfirmedStructural('deleteElement', ctx.id, ctx.kind),
      });
      return defs;
    }

    function listItemMenuDefs(ctx) {
      const defs = [
        { elementHeader: { label: 'List item', icon: menuIcons.ul, tag: '<li>' } },
        { separator: true },
        { spacer: 6 },
      ];
      pushConvertFlyout(defs, ctx);

      const indent = availFor(ctx.id, 'indentItem');
      const outdent = availFor(ctx.id, 'outdentItem');
      defs.push({ separator: true, inset: true });
      defs.push({
        label: 'Indent',
        icon: menuIcons.indent,
        shortcut: 'Tab',
        enabled: indent.enabled,
        reason: indent.reason,
        onActivate: () => postConfirmedStructural('indentItem', ctx.id, ctx.kind),
      });
      defs.push({
        label: 'Outdent',
        icon: menuIcons.outdent,
        shortcut: 'Shift+Tab',
        enabled: outdent.enabled,
        reason: outdent.reason,
        onActivate: () => postConfirmedStructural('outdentItem', ctx.id, ctx.kind),
      });

      const entries = resolveInsertEntries(ctx);
      defs.push({ separator: true, inset: true });
      pushInsertFlyout(defs, 'Insert inside', menuIcons.insertInside, entriesForPlacement(ctx, entries, 'into'));
      pushInsertFlyout(defs, 'Insert before', menuIcons.insertBefore, entriesForPlacement(ctx, entries, 'before'));
      pushInsertFlyout(defs, 'Insert after', menuIcons.insertAfter, entriesForPlacement(ctx, entries, 'after'));
      pushDitaClipboard(defs, ctx);

      defs.push({ separator: true });
      const del = availFor(ctx.id, 'deleteElement');
      defs.push({
        label: 'Delete this list item',
        icon: menuIcons.trash,
        del: true,
        shortcut: 'Del',
        enabled: del.enabled,
        reason: del.reason,
        onActivate: () => postConfirmedStructural('deleteElement', ctx.id, ctx.kind),
      });
      return defs;
    }

    // IX-9: image-specific menu — the two image-bar actions (change / alt text)
    // PLUS the insert fly-outs and structural delete the generic element menu
    // already offered for images, so nothing regresses.
    function imageMenuDefs(ctx) {
      const del = availFor(ctx.id, 'deleteImage');
      const defs = [
        { elementHeader: { label: 'Image', icon: menuIcons.image, tag: '<image>' } },
        { separator: true },
        { spacer: 6 },
        {
          label: 'Change image…',
          icon: menuIcons.image,
          enabled: true,
          onActivate: () => {
            vscode.postMessage({ type: 'pickImage', id: ctx.id });
            announceNav('Choose a replacement image…');
          },
        },
        {
          label: 'Edit alt text…',
          icon: menuIcons.convert,
          enabled: true,
          onActivate: () => {
            vscode.postMessage({ type: 'editImageAlt', id: ctx.id });
            announceNav('Edit image alt text…');
          },
        },
        {
          label: 'Resize image…',
          icon: menuIcons.convert,
          enabled: true,
          onActivate: () => {
            vscode.postMessage({ type: 'resizeImage', id: ctx.id });
            announceNav('Resize image…');
          },
        },
      ];
      const entries = resolveInsertEntries(ctx);
      if (entries.length) {
        defs.push({ separator: true, inset: true });
        pushGroupedInsertFlyouts(defs, ctx, entries);
      }
      defs.push({ separator: true });
      defs.push({
        label: 'Delete this image',
        icon: menuIcons.trash,
        del: true,
        enabled: del.enabled,
        reason: del.reason,
        onActivate: () => postConfirmedStructural('deleteImage', ctx.id, 'image'),
      });
      return defs;
    }

    function openImageMenuFor(img, x, y) {
      const ctx = elementCtx(img);
      if (!ctx || ctx.id == null) return false;
      const defs = imageMenuDefs(ctx);
      const interactive = defs.filter((d) => d.onActivate).length;
      const submenuInteractive = defs.reduce((sum, d) => sum + (d.submenu ? d.submenu.filter((s) => s.onActivate).length : 0), 0);
      const hasSubmenus = defs.some((d) => d.submenu);
      const totalInteractive = interactive + submenuInteractive;
      clearHideTimer();
      toolbar.style.display = 'none';
      highlightCell(img);
      ctxMenu.openAt(defs, x, y, {
        ariaLabel: 'Image actions',
        width: hasSubmenus ? 264 : undefined,
        allowSubmenus: hasSubmenus,
        announce:
          'Image actions. ' + totalInteractive + ' command' + (totalInteractive === 1 ? '' : 's') +
          '. Up and Down to choose, Enter to apply, Escape to close.',
        onClose: () => {
          clearCellHighlight();
        },
      });
      return true;
    }

    function openElementMenuFor(el, x, y, leaf) {
      const ctx = elementCtx(el);
      if (!ctx || ctx.id == null) return false;
      const defs = ctx.kind === 'li'
        ? listItemMenuDefs(ctx)
        : compactElementMenuDefs(ctx);
      const interactive = defs.filter((d) => d.onActivate).length;
      const submenuInteractive = defs.reduce((sum, d) => sum + (d.submenu ? d.submenu.filter((s) => s.onActivate).length : 0), 0);
      const totalInteractive = interactive + submenuInteractive;
      const hasSubmenus = defs.some((d) => d.submenu);
      if (!totalInteractive) return false;
      clearHideTimer();
      toolbar.style.display = 'none';
      highlightCell(ctx.structEl);
      const off = leaf ? caretOffset(leaf) : 0;
      ctxMenu.openAt(defs, x, y, {
        ariaLabel: nounForKind(ctx.kind) + ' actions',
        width: hasSubmenus ? 264 : undefined,
        allowSubmenus: hasSubmenus,
        announce:
          nounForKind(ctx.kind) + ' actions. ' + totalInteractive + ' command' + (totalInteractive === 1 ? '' : 's') +
          '. Up and Down to choose, Enter to apply, Escape to close.',
        onClose: (restore) => {
          clearCellHighlight();
          if (restore && leaf && leaf.isConnected) setCaret(leaf, off);
        },
      });
      return true;
    }

    // The menu is a fixed body-level overlay: pointer coords from events on
    // zoomed content must be mapped to page-visual space (see canvas-geom.js).
    function visualXY(anchorEl, x, y) {
      const geom = window.DitaEditorCanvasGeom;
      return geom ? geom.visualPointIn(anchorEl, x, y) : { x: x, y: y };
    }

    document.addEventListener('contextmenu', (e) => {
      const node = e.target;
      const reach = node && node.closest ? node : null;
      const img = reach ? reach.closest('img[data-struct-id][data-struct-kind="image"]') : null;
      if (img) {
        e.preventDefault();
        ctxMenu.close(false);
        const pt = visualXY(img, e.clientX, e.clientY);
        if (openImageMenuFor(img, pt.x, pt.y)) return;
      }
      const cell = reach ? reach.closest('td[data-cell-id], th[data-cell-id]') : null;
      const tr = cell ? cell.closest('tr[data-struct-id][data-struct-kind="row"]') : null;
      if (cell && tr) {
        e.preventDefault();
        ctxMenu.close(false);
        const pt = visualXY(cell, e.clientX, e.clientY);
        openCellMenuFor(tr, cell, pt.x, pt.y, editableTarget(e.target));
        return;
      }
      const sEl = reach ? reach.closest('[data-struct-id]') : null;
      if (sEl) {
        e.preventDefault();
        ctxMenu.close(false);
        const pt = visualXY(sEl, e.clientX, e.clientY);
        if (openElementMenuFor(sEl, pt.x, pt.y, editableTarget(e.target))) return;
      }
      if (ctxMenuOpen) ctxMenu.close(false);
    });

    return {
      close: (restoreFocus) => ctxMenu.close(restoreFocus),
      isOpen: () => ctxMenuOpen,
    };
  }

  window.DitaEditorCanvasContextMenu = {
    installContextMenu: installContextMenu,
  };
})();
