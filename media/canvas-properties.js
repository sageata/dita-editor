// File-level properties panel for the DITA Editor canvas.
//
// Loaded before canvas.js. This module owns the browser-side panel DOM only;
// the host remains authoritative for docProps and for setAttr application.
(function () {
  const DEFAULT_PANEL_WIDTH = 308;
  const MIN_PANEL_WIDTH = 240;
  const MAX_PANEL_WIDTH = 560;
  const MIN_EDITOR_WIDTH = 320;
  const BASE_EDITOR_WIDTH = 1040;
  const TOP_CHROME_FALLBACK = 72;
  const PANEL_TOP_INSET = 18;
  const RESIZE_HIT_WIDTH = 8;
  const COLLAPSED_RAIL_WIDTH = 36;

  const BASE_KNOWN_PROP_ATTRS = new Set([
    'platform',
    'product',
    'props',
    'otherprops',
    'audience',
    'status',
    'rev',
    'id',
    'manual-topic-id',
    'source-document',
    'source-section',
    'source-revision',
    'source-lineage',
  ]);

  function installPropertiesPanel(options) {
    const document = options.document;
    const win = options.window || window;
    const vscode = options.vscode;
    const fontFamily = options.fontFamily;
    const getDocProps = options.getDocProps;
    const getStructVersion = options.getStructVersion || function () { return 0; };
    let taxonomy = options.taxonomy && options.taxonomy.version === 1 ? options.taxonomy : null;
    let taxonomyFields = taxonomy && Array.isArray(taxonomy.fields) ? taxonomy.fields : [];
    let taxonomyAttrNames = new Set(taxonomyFields.map((field) => field && field.attribute).filter(Boolean));
    let taxonomySignature = JSON.stringify(taxonomy);
    const propMain = document.querySelector('main');
    let topChromeHeight = TOP_CHROME_FALLBACK;
    let panelWidth = DEFAULT_PANEL_WIDTH;
    let dragStartX = 0;
    let dragStartWidth = DEFAULT_PANEL_WIDTH;
    let dragging = false;
    let collapsed = false;
    const openTaxonomyCombos = new Set();

    const propPanel = document.createElement('aside');
    propPanel.id = 'ditaeditor-properties-panel';
    propPanel.setAttribute('aria-label', 'Properties');
    propPanel.className = 'prop-panel';
    propPanel.style.cssText =
      'position:fixed;left:0;top:0;bottom:0;width:308px;box-sizing:border-box;z-index:74;overflow:hidden;' +
      'display:flex;flex-direction:column;' +
      'background:#fafafa;border-right:1px solid #ececec;padding:90px 0 0;font-family:' + fontFamily + ';';
    propPanel.style.top = '0px';
    propPanel.style.width = DEFAULT_PANEL_WIDTH + 'px';
    propPanel.style.paddingTop = TOP_CHROME_FALLBACK + PANEL_TOP_INSET + 'px';
    document.body.appendChild(propPanel);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'prop-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'Resize properties panel');
    resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-valuemin', String(MIN_PANEL_WIDTH));
    resizeHandle.tabIndex = 0;
    resizeHandle.style.cssText =
      'position:fixed;top:var(--ditaeditor-toolbar-height,72px);bottom:0;left:304px;width:8px;z-index:76;box-sizing:border-box;' +
      'cursor:col-resize;background:linear-gradient(to right,transparent 0 3px,#e1e1e1 3px 4px,transparent 4px);';
    resizeHandle.style.top = TOP_CHROME_FALLBACK + 'px';
    document.body.appendChild(resizeHandle);

    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'prop-toggle-btn';
    hideButton.textContent = '‹';
    hideButton.title = 'Hide properties';
    hideButton.setAttribute('aria-label', 'Hide properties');
    hideButton.setAttribute('aria-controls', 'ditaeditor-properties-panel');
    hideButton.setAttribute('aria-expanded', 'true');
    hideButton.style.cssText =
      'width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;flex:none;' +
      'border:1px solid transparent;border-radius:6px;background:transparent;color:#737373;cursor:pointer;' +
      'font:600 18px/1 ' + fontFamily + ';padding:0;';

    const showButton = document.createElement('button');
    showButton.type = 'button';
    showButton.className = 'prop-show-button';
    showButton.textContent = '›';
    showButton.title = 'Show properties';
    showButton.setAttribute('aria-label', 'Show properties');
    showButton.setAttribute('aria-controls', 'ditaeditor-properties-panel');
    showButton.setAttribute('aria-expanded', 'false');
    showButton.style.cssText =
      'position:fixed;left:0;top:var(--ditaeditor-toolbar-height,72px);bottom:0;width:36px;box-sizing:border-box;z-index:74;display:none;' +
      'align-items:flex-start;justify-content:center;padding-top:12px;border:0;border-right:1px solid #ececec;' +
      'background:#fafafa;color:#737373;cursor:pointer;font:600 20px/1 ' + fontFamily + ';';
    showButton.style.top = TOP_CHROME_FALLBACK + 'px';
    showButton.style.display = 'none';
    document.body.appendChild(showButton);

    function measureTopChromeHeight() {
      const cmdBar = document.querySelector('.cmd-bar');
      if (!cmdBar) return TOP_CHROME_FALLBACK;
      const rect = typeof cmdBar.getBoundingClientRect === 'function' ? cmdBar.getBoundingClientRect() : null;
      const rectHeight = rect && typeof rect.top === 'number' && typeof rect.bottom === 'number'
        ? rect.bottom - rect.top
        : 0;
      const offsetHeight = typeof cmdBar.offsetHeight === 'number' ? cmdBar.offsetHeight : 0;
      return Math.max(1, Math.ceil(rectHeight || offsetHeight || TOP_CHROME_FALLBACK));
    }

    function maxPanelWidth() {
      const viewportWidth = typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : 0;
      if (!viewportWidth) return MAX_PANEL_WIDTH;
      return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportWidth - MIN_EDITOR_WIDTH));
    }

    function clampPanelWidth(width) {
      return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth(), Math.round(width)));
    }

    function pixelValue(value) {
      const n = Number.parseFloat(String(value || ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    // Mirrors canvas-styles.js: the page style's Content width control publishes
    // --dc-page-content-width, which the inline width math must honor. Guarded
    // because headless fake DOMs stub or omit getComputedStyle.
    function baseEditorWidth() {
      try {
        if (win && typeof win.getComputedStyle === 'function' && document.body) {
          const computed = win.getComputedStyle(document.body);
          if (computed && typeof computed.getPropertyValue === 'function') {
            const w = Number.parseFloat(String(computed.getPropertyValue('--dc-page-content-width') || ''));
            if (Number.isFinite(w) && w >= 480 && w <= 1600) return Math.round(w);
          }
        }
      } catch (err) {
        // Fall through to the fixed base width.
      }
      return BASE_EDITOR_WIDTH;
    }

    function reserveEditorInset(side, width) {
      if (!propMain) return;
      if (side === 'left') propMain.style.paddingLeft = width + 'px';
      else propMain.style.paddingRight = width + 'px';
      const left = pixelValue(propMain.style.paddingLeft);
      const right = pixelValue(propMain.style.paddingRight);
      const editorWidth = baseEditorWidth() + left + right;
      propMain.style.minWidth = editorWidth + 'px';
      propMain.style.maxWidth = editorWidth + 'px';
    }

    function notifyLayoutChange() {
      if (typeof win.dispatchEvent === 'function' && typeof win.Event === 'function') {
        win.dispatchEvent(new win.Event('ditaeditor:layoutchange'));
      } else if (typeof win.dispatch === 'function') {
        win.dispatch('ditaeditor:layoutchange', {});
      }
    }

    function applyTopChromeHeight() {
      topChromeHeight = measureTopChromeHeight();
      propPanel.style.paddingTop = topChromeHeight + PANEL_TOP_INSET + 'px';
      resizeHandle.style.top = topChromeHeight + 'px';
      showButton.style.top = topChromeHeight + 'px';
    }

    function applyPanelWidth(width) {
      panelWidth = clampPanelWidth(width);
      propPanel.style.width = panelWidth + 'px';
      if (!collapsed) reserveEditorInset('left', panelWidth);
      resizeHandle.style.left = panelWidth - RESIZE_HIT_WIDTH / 2 + 'px';
      resizeHandle.setAttribute('aria-valuemax', String(maxPanelWidth()));
      resizeHandle.setAttribute('aria-valuenow', String(panelWidth));
      notifyLayoutChange();
    }

    function setCollapsed(nextCollapsed) {
      collapsed = !!nextCollapsed;
      if (collapsed) {
        stopResize();
        propPanel.style.display = 'none';
        propPanel.setAttribute('aria-hidden', 'true');
        resizeHandle.style.display = 'none';
        showButton.style.display = 'inline-flex';
        showButton.setAttribute('aria-expanded', 'false');
        hideButton.setAttribute('aria-expanded', 'false');
        reserveEditorInset('left', COLLAPSED_RAIL_WIDTH);
        notifyLayoutChange();
        return;
      }

      propPanel.style.display = 'flex';
      propPanel.setAttribute('aria-hidden', 'false');
      resizeHandle.style.display = 'block';
      showButton.style.display = 'none';
      showButton.setAttribute('aria-expanded', 'true');
      hideButton.setAttribute('aria-expanded', 'true');
      applyPanelWidth(panelWidth);
    }

    function eventClientX(event) {
      return typeof event.clientX === 'number' ? event.clientX : null;
    }

    function stopResize() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('prop-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      win.removeEventListener('pointermove', onResizeMove);
      win.removeEventListener('pointerup', stopResize);
      win.removeEventListener('blur', stopResize);
    }

    function onResizeMove(event) {
      if (!dragging) return;
      const clientX = eventClientX(event);
      if (clientX == null) return;
      if (event.preventDefault) event.preventDefault();
      applyPanelWidth(dragStartWidth + clientX - dragStartX);
    }

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      const clientX = eventClientX(event);
      if (clientX == null) return;
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      dragging = true;
      dragStartX = clientX;
      dragStartWidth = panelWidth;
      document.body.classList.add('prop-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      win.addEventListener('pointermove', onResizeMove);
      win.addEventListener('pointerup', stopResize);
      win.addEventListener('blur', stopResize);
    });

    resizeHandle.addEventListener('keydown', (event) => {
      let next = null;
      const step = event.shiftKey ? 48 : 16;
      if (event.key === 'ArrowLeft') next = panelWidth - step;
      else if (event.key === 'ArrowRight') next = panelWidth + step;
      else if (event.key === 'Home') next = MIN_PANEL_WIDTH;
      else if (event.key === 'End') next = maxPanelWidth();
      if (next == null) return;
      if (event.preventDefault) event.preventDefault();
      applyPanelWidth(next);
    });

    hideButton.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      setCollapsed(true);
    });

    showButton.addEventListener('click', (event) => {
      if (event.preventDefault) event.preventDefault();
      setCollapsed(false);
    });

    win.addEventListener('resize', () => {
      applyTopChromeHeight();
      applyPanelWidth(panelWidth);
    });

    document.addEventListener('pointerdown', (event) => {
      const target = event && event.target;
      for (const controller of Array.from(openTaxonomyCombos)) {
        if (!controller.combo || !controller.combo.isConnected) {
          openTaxonomyCombos.delete(controller);
          continue;
        }
        if (controller.combo.contains(target)) continue;
        controller.close();
      }
    }, true);

    applyTopChromeHeight();
    setCollapsed(true);

    function propSectionLabel(text) {
      const d = document.createElement('div');
      d.textContent = text;
      d.style.cssText =
        'font-weight:600;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#a3a3a3;margin:22px 0 11px;';
      return d;
    }

    function propRow(structId, attrName, label, value, mono) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #efefef;';
      const lab = document.createElement('span');
      lab.textContent = label;
      lab.style.cssText = 'font-size:12.5px;color:#737373;flex:none;';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.setAttribute('aria-label', label);
      input.placeholder = '—';
      input.className = 'prop-field';
      input.style.cssText =
        'flex:1;min-width:0;text-align:right;border:1px solid transparent;border-radius:6px;padding:3px 7px;' +
        'background:transparent;color:#3f3f3f;font:' + (mono ? '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' : '12.5px ' + fontFamily) + ';';
      const commit = () => {
        const next = input.value.trim();
        if (next === (value || '')) return;
        vscode.postMessage({
          type: 'setExistingPropertyAttr', id: structId, attrName: attrName,
          attrValue: next, baseStructVersion: getStructVersion(),
        });
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { input.value = value || ''; input.blur(); }
      });
      input.addEventListener('change', commit);
      row.append(lab, input);
      return row;
    }

    function clearElement(node) {
      node.textContent = '';
    }

    function attrTokens(value) {
      return String(value || '').split(/\s+/).map((token) => token.trim()).filter(Boolean);
    }

    function uniqueTokens(values) {
      const seen = new Set();
      const out = [];
      for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out;
    }

    function optionsForField(field) {
      const raw = field.options || [];
      return Array.isArray(raw)
        ? raw.map((item) => {
          if (item && typeof item === 'object') {
            return {
              value: String(item.value || ''),
              label: String(item.label || item.value || ''),
            };
          }
          return { value: String(item), label: String(item) };
        }).filter((item) => item.value)
        : [];
    }

    function optionByValue(options) {
      const map = new Map();
      for (const option of options) map.set(option.value, option);
      return map;
    }

    function displayOption(option) {
      if (!option) return '';
      return option.label || option.value;
    }

    function taxonomyShell(field) {
      const row = document.createElement('div');
      row.className = 'taxonomy-field';
      row.setAttribute('data-taxonomy-field', field.attribute);

      const head = document.createElement('div');
      head.className = 'taxonomy-field-head';
      const lab = document.createElement('label');
      lab.textContent = field.label;
      lab.className = 'taxonomy-label';
      head.appendChild(lab);

      const body = document.createElement('div');
      body.className = 'taxonomy-field-body';
      row.append(head, body);
      return { row, body };
    }

    function postTaxonomyAttr(rootId, attrName, attrValue) {
      vscode.postMessage({
        type: 'setTaxonomyAttr', id: rootId, attrName: attrName,
        attrValue: attrValue, baseStructVersion: getStructVersion(),
      });
    }

    function postExistingAttr(rootId, attrName, attrValue) {
      vscode.postMessage({
        type: 'setExistingPropertyAttr', id: rootId, attrName: attrName,
        attrValue: attrValue, baseStructVersion: getStructVersion(),
      });
    }

    function taxonomyTextField(rootId, field, value) {
      const shell = taxonomyShell(field);
      const input = document.createElement('input');
      input.type = field.input === 'date' ? 'date' : field.input === 'number' ? 'number' : 'text';
      input.value = value || '';
      input.className = 'taxonomy-input';
      input.setAttribute('aria-label', field.label);
      const commit = () => {
        const next = input.value.trim();
        if (next === (value || '')) return;
        postTaxonomyAttr(rootId, field.attribute, next);
      };
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          if (event.preventDefault) event.preventDefault();
          if (typeof input.blur === 'function') input.blur();
          else commit();
        } else if (event.key === 'Escape') {
          input.value = value || '';
          if (typeof input.blur === 'function') input.blur();
        }
      });
      input.addEventListener('change', commit);
      shell.body.appendChild(input);
      return shell.row;
    }

    function taxonomySingleSelect(rootId, field, value) {
      const shell = taxonomyShell(field);
      const select = document.createElement('select');
      select.className = 'taxonomy-input taxonomy-select';
      select.setAttribute('aria-label', field.label);
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Select';
      select.appendChild(empty);
      const options = optionsForField(field);
      const map = optionByValue(options);
      const selectedValue = value || '';
      if (selectedValue && !map.has(selectedValue)) options.unshift({ value: selectedValue, label: selectedValue });
      for (const option of options) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = displayOption(option);
        select.appendChild(opt);
      }
      select.value = selectedValue;
      select.addEventListener('keydown', (event) => event.stopPropagation());
      select.addEventListener('change', () => {
        const next = String(select.value || '').trim();
        if (next === selectedValue) return;
        postTaxonomyAttr(rootId, field.attribute, next);
      });
      shell.body.appendChild(select);
      return shell.row;
    }

    function taxonomyMultiSelect(rootId, field, value) {
      const shell = taxonomyShell(field);
      const options = optionsForField(field);
      const optionsByValue = optionByValue(options);
      let selected = uniqueTokens(attrTokens(value));
      let open = false;

      const chips = document.createElement('div');
      chips.className = 'taxonomy-chips';
      const combo = document.createElement('div');
      combo.className = 'taxonomy-combo';
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'taxonomy-input taxonomy-search';
      search.placeholder = 'Search values';
      search.setAttribute('aria-label', field.label + ' search');
      search.setAttribute('role', 'combobox');
      search.setAttribute('aria-expanded', 'false');
      const listId = 'taxonomy-options-' + field.attribute;
      search.setAttribute('aria-controls', listId);
      const list = document.createElement('div');
      list.id = listId;
      list.className = 'taxonomy-options';
      list.setAttribute('role', 'listbox');
      combo.append(search, list);
      shell.body.append(chips, combo);
      const controller = {
        combo: combo,
        close: () => {
          if (!open) return;
          open = false;
          search.value = '';
          openTaxonomyCombos.delete(controller);
          renderOptions();
        },
      };

      const commit = () => {
        const next = selected.join(' ');
        postTaxonomyAttr(rootId, field.attribute, next);
      };

      const renderChips = () => {
        clearElement(chips);
        if (!selected.length) {
          const empty = document.createElement('span');
          empty.className = 'taxonomy-empty';
          empty.textContent = 'None selected';
          chips.appendChild(empty);
          return;
        }
        for (const token of selected) {
          const option = optionsByValue.get(token) || { value: token, label: token };
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'taxonomy-chip';
          chip.setAttribute('aria-label', 'Remove ' + field.label + ' ' + displayOption(option));
          chip.setAttribute('data-taxonomy-chip', token);
          chip.textContent = displayOption(option) + ' x';
          chip.addEventListener('click', (event) => {
            if (event.preventDefault) event.preventDefault();
            event.stopPropagation();
            selected = selected.filter((item) => item !== token);
            commit();
            render();
          });
          chips.appendChild(chip);
        }
      };

      const renderOptions = () => {
        clearElement(list);
        search.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) return;
        const selectedSet = new Set(selected);
        const query = search.value.trim().toLowerCase();
        const matches = options.filter((option) => {
          if (selectedSet.has(option.value)) return false;
          if (!query) return true;
          return option.value.toLowerCase().includes(query) ||
            option.label.toLowerCase().includes(query);
        }).slice(0, 12);
        if (!matches.length) {
          const empty = document.createElement('div');
          empty.className = 'taxonomy-no-options';
          empty.textContent = 'No matches';
          list.appendChild(empty);
          return;
        }
        for (const option of matches) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'taxonomy-option';
          button.setAttribute('role', 'option');
          button.setAttribute('data-taxonomy-option', option.value);
          button.textContent = displayOption(option);
          button.addEventListener('click', (event) => {
            if (event.preventDefault) event.preventDefault();
            event.stopPropagation();
            selected = uniqueTokens([...selected, option.value]);
            search.value = '';
            commit();
            render();
            search.focus();
          });
          list.appendChild(button);
        }
      };

      const render = () => {
        renderChips();
        renderOptions();
      };

      search.addEventListener('focus', () => {
        open = true;
        openTaxonomyCombos.add(controller);
        renderOptions();
      });
      search.addEventListener('input', () => {
        open = true;
        openTaxonomyCombos.add(controller);
        renderOptions();
      });
      search.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          open = false;
          search.value = '';
          openTaxonomyCombos.delete(controller);
          renderOptions();
        }
      });

      render();
      return shell.row;
    }

    function taxonomyField(rootId, field, valueOf) {
      const value = valueOf(field.attribute);
      if (field.input === 'multi-select') return taxonomyMultiSelect(rootId, field, value);
      if (field.input === 'single-select') return taxonomySingleSelect(rootId, field, value);
      return taxonomyTextField(rootId, field, value);
    }

    function appendTaxonomyPanel(body, rootId, valueOf) {
      if (!taxonomyFields.length) return;
      let activeGroup = '';
      for (const field of taxonomyFields) {
        if (!field || !field.attribute) continue;
        const group = field.group || 'Metadata';
        if (group !== activeGroup) {
          activeGroup = group;
          body.appendChild(propSectionLabel(activeGroup));
        }
        body.appendChild(taxonomyField(rootId, field, valueOf));
      }
    }

    // Frame G ("Full editor") header: title + a count of set attributes + the hide-panel button.
    function buildPropHead(setCount, totalCount) {
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:9px;padding:14px 18px 12px;flex:none;';
      const title = document.createElement('span');
      title.textContent = 'Properties';
      title.style.cssText = 'font-weight:650;font-size:13px;color:#363636;';
      head.appendChild(title);
      if (totalCount > 0) {
        const badge = document.createElement('span');
        badge.textContent = String(setCount);
        badge.title = setCount + ' of ' + totalCount + ' attributes set';
        badge.style.cssText =
          'font-size:11px;font-weight:600;color:#767676;background:#ececec;border-radius:99px;padding:2px 8px;';
        head.appendChild(badge);
      }
      hideButton.style.marginLeft = 'auto';
      head.appendChild(hideButton);
      return head;
    }

    // Real "N of M set / Clear all" footer (Frame G's "N filters active / Clear all", grounded in
    // this panel's actual attribute/taxonomy values rather than an invented filter concept).
    function buildPropFoot(rootId, setEntries, totalCount) {
      const foot = document.createElement('div');
      foot.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid #ececec;flex:none;';
      const label = document.createElement('span');
      label.textContent = setEntries.length + ' of ' + totalCount + ' set';
      label.style.cssText = 'font-size:12px;color:#8a8a8a;';
      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.className = 'prop-clear-all';
      clearAll.textContent = 'Clear all';
      clearAll.disabled = !setEntries.length;
      clearAll.setAttribute('aria-disabled', setEntries.length ? 'false' : 'true');
      clearAll.style.cssText =
        'margin-left:auto;border:0;background:transparent;border-radius:6px;padding:3px 6px;' +
        'font:500 12px ' + fontFamily + ';color:' + (setEntries.length ? '#4a4a4a' : '#c4c4c4') + ';' +
        'cursor:' + (setEntries.length ? 'pointer' : 'not-allowed') + ';';
      clearAll.addEventListener('click', (event) => {
        if (event.preventDefault) event.preventDefault();
        if (!setEntries.length) return;
        for (const entry of setEntries) {
          if (entry.family === 'taxonomy') postTaxonomyAttr(rootId, entry.name, '');
          else postExistingAttr(rootId, entry.name, '');
        }
      });
      foot.append(label, clearAll);
      return foot;
    }

    function buildPropPanel() {
      const docProps = getDocProps();
      clearElement(propPanel);

      if (!docProps || docProps.id == null) {
        propPanel.appendChild(buildPropHead(0, 0));
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:0 18px 16px;';
        const empty = document.createElement('div');
        empty.textContent = 'Metadata is unavailable (the file may be mid-edit or invalid).';
        empty.style.cssText = 'font-size:12.5px;color:#9a9a9a;line-height:1.5;';
        body.appendChild(empty);
        propPanel.appendChild(body);
        return;
      }

      const rootId = docProps.id;
      const attrs = docProps.attrs || [];
      const valueOf = (name) => {
        const a = attrs.find((x) => x.name === name);
        return a ? a.value : '';
      };
      const others = attrs.filter((a) => !BASE_KNOWN_PROP_ATTRS.has(a.name) && !taxonomyAttrNames.has(a.name));

      const setAttrNames = [];
      for (const field of taxonomyFields) {
        if (field && field.attribute && String(valueOf(field.attribute) || '').trim()) {
          setAttrNames.push({ name: field.attribute, family: 'taxonomy' });
        }
      }
      for (const a of others) {
        if (String(a.value || '').trim()) setAttrNames.push({ name: a.name, family: 'existing' });
      }
      const totalCount = taxonomyFields.length + others.length;

      propPanel.appendChild(buildPropHead(setAttrNames.length, totalCount));

      const body = document.createElement('div');
      body.className = 'prop-panel-scroll';
      body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:0 18px 16px;';
      appendTaxonomyPanel(body, rootId, valueOf);
      if (others.length) {
        body.appendChild(propSectionLabel('Other'));
        for (const a of others) body.appendChild(propRow(rootId, a.name, a.name, a.value, false));
      }
      propPanel.appendChild(body);

      propPanel.appendChild(buildPropFoot(rootId, setAttrNames, totalCount));
    }

    function refresh() {
      if (propPanel.contains(document.activeElement)) return;
      buildPropPanel();
    }

    function setTaxonomy(next) {
      const normalized = next && next.version === 1 && Array.isArray(next.fields) ? next : null;
      const signature = JSON.stringify(normalized);
      if (signature === taxonomySignature) return false;
      taxonomy = normalized;
      taxonomyFields = taxonomy ? taxonomy.fields : [];
      taxonomyAttrNames = new Set(taxonomyFields.map((field) => field && field.attribute).filter(Boolean));
      taxonomySignature = signature;
      // A schema change may remove or redefine the focused field. Rebuild now;
      // equivalent schemas returned above and preserve the focused editor.
      buildPropPanel();
      return true;
    }

    refresh();
    return {
      refresh: refresh,
      setTaxonomy: setTaxonomy,
      panel: propPanel,
      resizeHandle: resizeHandle,
      hideButton: hideButton,
      showButton: showButton,
    };
  }

  window.DitaEditorCanvasProperties = { installPropertiesPanel: installPropertiesPanel };
})();
