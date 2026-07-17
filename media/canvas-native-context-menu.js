// VS Code-native webview context menu state and command execution.
(function () {
  const PREFIX = 'ditaeditor.context.';
  const INSERT_KINDS = [
    'paragraph', 'unorderedList', 'alphabeticList', 'orderedList', 'table',
    'lines', 'note', 'codeblock', 'section',
  ];
  const SHADE = {
    neutral: '#eff1f3', gold: '#f7f0e4', blue: '#e3edf7', white: '#ffffff',
    custom: 'custom', clear: '',
  };
  const VALUE = {
    on: '1', off: '0', default: '', left: 'left', center: 'center', right: 'right',
    justify: 'justify', top: 'top', middle: 'middle', bottom: 'bottom', all: 'all',
    topbot: 'topbot', sides: 'sides', none: 'none',
  };

  function suffix(command) { return command.slice(PREFIX.length); }
  function enabledKey(command) { return 'ditaNativeEnabled.' + suffix(command); }
  function setEnabled(context, command, enabled) { context[enabledKey(command)] = !!enabled; }
  function availability(value) { return value || { enabled: true }; }

  function installNativeContextMenu(opts) {
    const document = opts.document;
    const vscode = opts.vscode;

    function baseContext(type, id, kind) {
      const context = {
        webviewSection: 'ditaEditor',
        preventDefaultContextMenuItems: true,
        ditaNativeSession: opts.getSessionId(),
        ditaNativeStructVersion: opts.getStructVersion(),
        ditaNativeContext: type,
        ditaNativeTargetId: id || '',
        ditaNativeKind: kind || '',
      };
      for (const slot of ['selfBefore', 'selfAfter', 'selfInto', 'cellInto', 'tableAfter', 'figureAfter']) {
        context['ditaNativeHas.' + slot] = false;
        context['ditaNativeTarget.' + slot] = '';
      }
      return context;
    }

    function setInsertSlot(context, slot, id, mode) {
      if (!id) return;
      context['ditaNativeHas.' + slot] = true;
      context['ditaNativeTarget.' + slot] = id;
      for (const kind of INSERT_KINDS) {
        const command = PREFIX + 'insert.' + slot + '.' + kind;
        setEnabled(context, command, availability(opts.insertAvailFor(id, mode, kind)).enabled);
      }
    }

    function listStyle(el) {
      if (!el) return null;
      if (el.tagName.toLowerCase() === 'ul') return 'unordered';
      const tokens = ((el.getAttribute('data-outputclass') || '') + ' ' + (el.className || '')).split(/\s+/);
      return tokens.indexOf('lower-alpha') >= 0 ? 'alpha' : 'ordered';
    }

    function setTransform(context, id, transform, forcedDisabled) {
      const state = opts.transformAvailFor(id, transform);
      setEnabled(context, PREFIX + 'transform.' + transform, !forcedDisabled && state.status === 'ok');
    }

    function decorateElement(el) {
      const id = el.getAttribute('data-struct-id');
      const kind = el.getAttribute('data-struct-kind');
      if (!id || !kind) return;
      const image = kind === 'image';
      const context = baseContext(image ? 'image' : 'element', id, kind);
      const transforms = {
        p: ['paragraphToSection', 'paragraphToUnorderedList', 'paragraphToAlphabeticList', 'paragraphToOrderedList', 'paragraphToNote', 'paragraphToCodeblock', 'paragraphToItem'],
        li: ['itemToParagraph', 'toAlphabeticList', 'toOrderedList', 'toUnorderedList'],
        lines: ['linesToParagraph', 'linesToUnorderedList', 'linesToAlphabeticList', 'linesToOrderedList', 'linesToSection', 'linesToNote', 'linesToCodeblock'],
        ul: ['toAlphabeticList', 'toOrderedList', 'toUnorderedList'],
        ol: ['toAlphabeticList', 'toOrderedList', 'toUnorderedList'],
      };
      const style = (kind === 'li' || kind === 'ul' || kind === 'ol') ? listStyle(kind === 'li' ? el.closest('ul, ol') : el) : null;
      for (const transform of transforms[kind] || []) {
        const forced = (transform === 'toAlphabeticList' && style === 'alpha')
          || (transform === 'toOrderedList' && style === 'ordered')
          || (transform === 'toUnorderedList' && style === 'unordered');
        setTransform(context, id, transform, forced);
      }
      if (kind === 'li') {
        setEnabled(context, PREFIX + 'structural.target.indentItem', availability(opts.availFor(id, 'indentItem')).enabled);
        setEnabled(context, PREFIX + 'structural.target.outdentItem', availability(opts.availFor(id, 'outdentItem')).enabled);
        setInsertSlot(context, 'selfInto', id, 'into');
      }
      if (kind === 'p' || kind === 'li') {
        setInsertSlot(context, 'selfBefore', id, 'before');
        setInsertSlot(context, 'selfAfter', id, 'after');
      }
      const table = el.closest('[data-struct-kind="table"]');
      const tableId = table && table.getAttribute('data-struct-id');
      if (tableId) setInsertSlot(context, tableId === id ? 'selfAfter' : 'tableAfter', tableId, 'after');
      const figure = el.closest('[data-struct-kind="fig"]');
      const figureId = figure && figure.getAttribute('data-struct-id');
      if (figureId) setInsertSlot(context, figureId === id ? 'selfAfter' : 'figureAfter', figureId, 'after');
      const cell = el.closest('td[data-cell-id], th[data-cell-id]');
      const cellId = cell && cell.getAttribute('data-cell-id');
      if (cellId) setInsertSlot(context, 'cellInto', cellId, 'into');
      setEnabled(context, PREFIX + (image ? 'delete.image' : 'delete.' + kind), availability(opts.availFor(id, image ? 'deleteImage' : 'deleteElement')).enabled);
      el.setAttribute('data-vscode-context', JSON.stringify(context));
    }

    function setAttrChoices(context, target, attr, values, current) {
      for (const value of values) {
        setEnabled(context, PREFIX + 'cals.' + target + '.' + attr + '.' + value, (current || '') !== VALUE[value]);
      }
    }

    function decorateCell(cell) {
      const row = cell.closest('tr[data-struct-id][data-struct-kind="row"]');
      const table = cell.closest('table[data-struct-id]');
      if (!row || !table) return;
      const cellId = cell.getAttribute('data-cell-id');
      const rowId = row.getAttribute('data-struct-id');
      const tableId = table.getAttribute('data-struct-id');
      if (!cellId || !rowId || !tableId) return;
      const context = baseContext('cell', cellId, 'entry');
      context.ditaNativeCellId = cellId;
      context.ditaNativeRowId = rowId;
      context.ditaNativeTableId = tableId;
      context.ditaNativeColumnId = opts.columnAnchorId(cell) || '';
      context.ditaNativeInHeader = !!row.closest('thead');
      context.ditaNativeCellMerged = cell.hasAttribute('colspan') || cell.hasAttribute('rowspan');
      const caption = table.querySelector('caption[data-struct-id]');
      context.ditaNativeHasTableTitle = !!caption;
      context.ditaNativeTableTitleId = caption ? caption.getAttribute('data-struct-id') : '';
      const styleState = opts.getStyleState() || {};
      context.ditaNativeSourceHash = String(styleState.sourceHash || '');
      context.ditaNativeTargetToken = String(styleState.targetToken || '');
      for (const transform of ['entryToParagraph', 'entryToUnorderedList', 'entryToAlphabeticList', 'entryToOrderedList', 'entryToLines', 'entryToNote', 'entryToCodeblock']) {
        setTransform(context, cellId, transform, false);
      }
      for (const op of ['addRowBefore', 'addRowAfter', 'promoteRowToHeader', 'demoteRowFromHeader', 'deleteRow']) {
        setEnabled(context, PREFIX + 'structural.row.' + op, availability(opts.availFor(rowId, op)).enabled);
      }
      for (const op of ['addColumnBefore', 'addColumnAfter', 'moveColumnLeft', 'moveColumnRight', 'deleteColumn']) {
        const allowed = !!context.ditaNativeColumnId && availability(opts.availFor(cellId, op)).enabled;
        setEnabled(context, PREFIX + 'structural.column.' + op, allowed);
      }
      setEnabled(context, PREFIX + 'structural.cell.splitCell', availability(opts.availFor(cellId, 'splitCell')).enabled);
      setEnabled(context, PREFIX + 'structural.table.addTableTitle', availability(opts.availFor(tableId, 'addTableTitle')).enabled);
      if (caption) setEnabled(context, PREFIX + 'structural.tableTitle.deleteTitle', availability(opts.availFor(context.ditaNativeTableTitleId, 'deleteTitle')).enabled);
      setEnabled(context, PREFIX + 'structural.table.deleteTable', availability(opts.availFor(tableId, 'deleteTable')).enabled);
      const ids = opts.currentSelectionIds();
      context.ditaNativeSelectionIds = ids;
      context.ditaNativeShowMerge = opts.rangeActionForSelection() === 'cellRectMerge' && ids.length > 1;
      const range = opts.rangeAvailFor('cellRectMerge');
      setEnabled(context, PREFIX + 'range.cellRectMerge', !!(range && range.enabled));
      setAttrChoices(context, 'cell', 'colsep', ['on', 'off', 'default'], cell.getAttribute('data-colsep'));
      setAttrChoices(context, 'cell', 'rowsep', ['on', 'off', 'default'], cell.getAttribute('data-rowsep'));
      setAttrChoices(context, 'row', 'rowsep', ['on', 'off', 'default'], row.getAttribute('data-rowsep'));
      setAttrChoices(context, 'cell', 'align', ['left', 'center', 'right', 'justify', 'default'], cell.getAttribute('data-align'));
      setAttrChoices(context, 'cell', 'valign', ['top', 'middle', 'bottom', 'default'], cell.getAttribute('data-valign'));
      setAttrChoices(context, 'row', 'valign', ['top', 'middle', 'bottom', 'default'], null);
      const frame = /(?:^|\s)frame-([a-z]+)(?:\s|$)/.exec(table.className || '');
      setAttrChoices(context, 'table', 'frame', ['all', 'topbot', 'sides', 'top', 'bottom', 'none', 'default'], frame ? frame[1] : '');
      cell.setAttribute('data-vscode-context', JSON.stringify(context));
    }

    function refresh() {
      const main = document.querySelector('main');
      if (!main) return;
      for (const el of main.querySelectorAll('[data-vscode-context]')) el.removeAttribute('data-vscode-context');
      for (const cell of main.querySelectorAll('td[data-cell-id], th[data-cell-id]')) decorateCell(cell);
      for (const el of main.querySelectorAll('[data-struct-id][data-struct-kind]')) {
        const cell = el.closest('td[data-cell-id], th[data-cell-id]');
        if (cell && el.getAttribute('data-struct-kind') !== 'image') continue;
        decorateElement(el);
      }
    }

    function post(message, context) {
      message.nativeContextSession = context.ditaNativeSession;
      message.baseStructVersion = context.ditaNativeStructVersion;
      vscode.postMessage(message);
    }

    let shadeDialog = null;
    function openCustomShadeDialog(id, context) {
      const previousFocus = document.activeElement;
      if (!shadeDialog) {
        const dialog = document.createElement('dialog');
        dialog.className = 'ditaeditor-color-dialog';
        dialog.setAttribute('aria-labelledby', 'ditaeditor-shade-title');
        dialog.style.cssText = 'width:min(360px,calc(100vw - 32px));border:1px solid #cbd2d9;border-radius:10px;padding:18px;background:#fff;color:#1f2937;font:13px system-ui,sans-serif;box-shadow:0 14px 40px rgb(15 23 42 / 24%);';
        const title = document.createElement('h2');
        title.id = 'ditaeditor-shade-title';
        title.textContent = 'Custom shading color';
        title.style.cssText = 'margin:0 0 12px;font-size:16px;';
        const controls = document.createElement('div');
        controls.style.cssText = 'display:grid;grid-template-columns:48px minmax(0,1fr);gap:8px;align-items:center;';
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = '#ffe8b3';
        picker.setAttribute('aria-label', 'Choose shading color');
        picker.style.cssText = 'width:48px;height:38px;padding:2px;border:1px solid #9ca3af;border-radius:6px;background:#fff;';
        const value = document.createElement('input');
        value.type = 'text';
        value.value = '#ffe8b3';
        value.placeholder = '#RRGGBB';
        value.setAttribute('aria-label', 'Shading hex color');
        value.style.cssText = 'min-width:0;padding:8px;border:1px solid #9ca3af;border-radius:6px;font:13px ui-monospace,monospace;';
        const error = document.createElement('div');
        error.setAttribute('role', 'alert');
        error.style.cssText = 'grid-column:1 / -1;min-height:18px;color:#9c2f2f;font-size:12px;';
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.textContent = 'Apply';
        for (const button of [cancel, apply]) {
          button.style.cssText = 'padding:7px 12px;border:1px solid #9ca3af;border-radius:6px;background:#fff;color:#1f2937;font:600 12px system-ui,sans-serif;cursor:pointer;';
        }
        controls.append(picker, value, error);
        actions.append(cancel, apply);
        dialog.append(title, controls, actions);
        document.body.appendChild(dialog);
        shadeDialog = { dialog: dialog, picker: picker, value: value, error: error, apply: apply, context: null, id: '', previousFocus: null };

        function validate() {
          const valid = /^#[0-9a-f]{6}$/i.test(value.value.trim());
          apply.disabled = !valid;
          apply.setAttribute('aria-disabled', String(!valid));
          error.textContent = valid ? '' : 'Enter a six-digit hex color such as #ffe8b3.';
          if (valid) picker.value = value.value.trim().toLowerCase();
          return valid;
        }
        picker.addEventListener('input', function () {
          value.value = String(picker.value || '').toLowerCase();
          validate();
        });
        value.addEventListener('input', validate);
        cancel.addEventListener('click', function () { dialog.close(); });
        apply.addEventListener('click', function () {
          if (!validate() || !shadeDialog.context) return;
          post({
            type: 'applyShade',
            ids: [shadeDialog.id],
            color: value.value.trim().toLowerCase(),
            sourceHash: shadeDialog.context.ditaNativeSourceHash,
            targetToken: shadeDialog.context.ditaNativeTargetToken,
          }, shadeDialog.context);
          dialog.close();
        });
        dialog.addEventListener('close', function () {
          const focus = shadeDialog && shadeDialog.previousFocus;
          shadeDialog.context = null;
          if (focus && typeof focus.focus === 'function') focus.focus();
        });
      }
      shadeDialog.context = context;
      shadeDialog.id = id;
      shadeDialog.previousFocus = previousFocus;
      shadeDialog.value.value = '#ffe8b3';
      shadeDialog.picker.value = '#ffe8b3';
      shadeDialog.error.textContent = '';
      shadeDialog.apply.disabled = false;
      shadeDialog.apply.setAttribute('aria-disabled', 'false');
      if (typeof shadeDialog.dialog.showModal === 'function') shadeDialog.dialog.showModal();
      else shadeDialog.dialog.setAttribute('open', '');
      if (typeof shadeDialog.value.focus === 'function') shadeDialog.value.focus();
    }

    function execute(command, context) {
      if (typeof command !== 'string' || !command.startsWith(PREFIX) || !context) return false;
      const action = suffix(command);
      if (action.startsWith('transform.')) {
        opts.clearTimer();
        post({ type: 'transform', transform: action.slice(10), id: context.ditaNativeContext === 'cell' ? context.ditaNativeCellId : context.ditaNativeTargetId }, context);
      } else if (action.startsWith('insert.')) {
        const parts = action.split('.');
        const slot = parts[1];
        const kind = parts[2];
        const id = context['ditaNativeTarget.' + slot];
        const into = slot === 'selfInto' || slot === 'cellInto';
        post({ type: 'insert', op: kind, payload: into ? { mode: 'into', containerId: id } : { mode: slot === 'selfBefore' ? 'before' : 'after', refId: id } }, context);
      } else if (action.startsWith('structural.')) {
        opts.clearTimer();
        const parts = action.split('.');
        const target = parts[1];
        const op = parts[2];
        const ids = { target: context.ditaNativeTargetId, row: context.ditaNativeRowId, column: context.ditaNativeColumnId, cell: context.ditaNativeCellId, table: context.ditaNativeTableId, tableTitle: context.ditaNativeTableTitleId };
        const kinds = { target: context.ditaNativeKind, row: 'row', column: 'row', cell: 'entry', table: 'table', tableTitle: 'title' };
        post(Object.assign({ type: 'structural', op: op, id: ids[target] }, opts.withStructuralSuccess(op, kinds[target])), context);
      } else if (action.startsWith('delete.')) {
        opts.clearTimer();
        const kind = action.slice(7);
        const op = kind === 'image' ? 'deleteImage' : 'deleteElement';
        post(Object.assign({ type: 'structural', op: op, id: context.ditaNativeTargetId }, opts.withStructuralSuccess(op, kind)), context);
      } else if (action === 'range.cellRectMerge') {
        post({ type: 'rangeExecute', action: 'cellRectMerge', ids: context.ditaNativeSelectionIds }, context);
      } else if (action.startsWith('image.')) {
        const types = { pick: 'pickImage', alt: 'editImageAlt', resize: 'resizeImage' };
        post({ type: types[action.slice(6)], id: context.ditaNativeTargetId }, context);
      } else if (action.startsWith('clipboard.')) {
        const op = action.slice(10);
        if (op === 'copy') post({ type: 'copyDita', ids: [context.ditaNativeTargetId] }, context);
        else post({ type: 'pasteDita', id: context.ditaNativeTargetId, op: op }, context);
      } else if (action.startsWith('cals.')) {
        const parts = action.split('.');
        const target = parts[1];
        const id = target === 'cell' ? context.ditaNativeCellId : target === 'row' ? context.ditaNativeRowId : context.ditaNativeTableId;
        post({ type: 'setCalsAttr', id: id, attrName: parts[2], attrValue: VALUE[parts[3]] }, context);
      } else if (action.startsWith('shade.')) {
        const parts = action.split('.');
        const id = parts[1] === 'cell' ? context.ditaNativeCellId : context.ditaNativeRowId;
        const color = SHADE[parts[2]];
        if (color === 'custom') {
          openCustomShadeDialog(id, context);
        } else {
          const message = { type: color ? 'applyShade' : 'clearShade', ids: [id], sourceHash: context.ditaNativeSourceHash, targetToken: context.ditaNativeTargetToken };
          if (color) message.color = color;
          post(message, context);
        }
      } else if (action.startsWith('tgroup.grid.')) {
        const value = { all: '1', none: '0', default: '' }[action.slice(12)];
        post({ type: 'setTgroupAttr', id: context.ditaNativeTableId, attrs: [{ name: 'colsep', value: value }, { name: 'rowsep', value: value }] }, context);
      } else return false;
      return true;
    }

    refresh();
    return { refresh: refresh, execute: execute };
  }

  window.DitaEditorCanvasNativeContextMenu = {
    installNativeContextMenu: installNativeContextMenu,
    enabledKey: enabledKey,
  };
})();
