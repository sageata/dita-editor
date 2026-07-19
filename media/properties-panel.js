// File-level properties panel engine, hosted in the native Properties view
// (Secondary Side Bar). This module owns the panel DOM only; the host remains
// authoritative for docProps and for setAttr application. Ported from the
// in-canvas overlay: layout/resize/collapse chrome is gone (the view IS the
// container), data still arrives exclusively through the injected getDocProps
// and taxonomy, and ops post the same message shapes as before. Colors come
// from --vscode-* variables so the panel follows the workbench theme.
(function () {
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

  const C = {
    muted: 'var(--vscode-descriptionForeground, #737373)',
    faint: 'var(--vscode-disabledForeground, #c4c4c4)',
    border: 'var(--vscode-panel-border, rgba(128, 128, 128, 0.25))',
    inputText: 'var(--vscode-input-foreground, #3f3f3f)',
    badgeBg: 'var(--vscode-badge-background, #ececec)',
    badgeText: 'var(--vscode-badge-foreground, #767676)',
    headerBg: 'var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.12))',
    headerText: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground, #363636))',
    btn2Bg: 'var(--vscode-button-secondaryBackground, #e4e4e4)',
    btn2Fg: 'var(--vscode-button-secondaryForeground, #3f3f3f)',
    mono: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
  };

  function installPropertiesPanel(options) {
    const document = options.document;
    const vscode = options.vscode;
    const fontFamily = options.fontFamily;
    const container = options.container || document.body;
    const getDocProps = options.getDocProps;
    const getStructVersion = options.getStructVersion || function () { return 0; };
    let taxonomy = options.taxonomy && options.taxonomy.version === 1 ? options.taxonomy : null;
    let taxonomyFields = taxonomy && Array.isArray(taxonomy.fields) ? taxonomy.fields : [];
    let taxonomyAttrNames = new Set(taxonomyFields.map((field) => field && field.attribute).filter(Boolean));
    let taxonomySignature = JSON.stringify(taxonomy);
    const openTaxonomyCombos = new Set();

    const propPanel = document.createElement('aside');
    propPanel.id = 'ditaeditor-properties-panel';
    propPanel.setAttribute('aria-label', 'Properties');
    propPanel.className = 'prop-panel';
    propPanel.style.cssText =
      'display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;overflow:hidden;' +
      'font-family:' + fontFamily + ';';
    container.appendChild(propPanel);

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

    // Native sidebar section header: a flat full-width strip with a chevron.
    function propSectionLabel(text) {
      const d = document.createElement('div');
      d.style.cssText =
        'display:flex;align-items:center;gap:6px;min-height:22px;padding:0 8px;margin:8px 0 4px;' +
        'background:' + C.headerBg + ';color:' + C.headerText + ';font-weight:700;font-size:11px;text-transform:uppercase;';
      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '▾';
      chevron.style.cssText = 'flex:none;font-size:10px;';
      const label = document.createElement('span');
      label.textContent = text;
      label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      d.append(chevron, label);
      return d;
    }

    function propRow(structId, attrName, label, value, mono) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px;padding:1px 8px 1px 16px;';
      const lab = document.createElement('span');
      lab.textContent = label;
      lab.style.cssText = 'font-size:13px;color:' + C.muted + ';flex:none;';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.setAttribute('aria-label', label);
      input.placeholder = '—';
      input.className = 'prop-field';
      input.style.cssText =
        'flex:1;min-width:0;text-align:right;border:1px solid transparent;border-radius:2px;padding:2px 6px;' +
        'background:transparent;color:' + C.inputText + ';font:' + (mono ? '12px ' + C.mono : '13px ' + fontFamily) + ';';
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
          chip.textContent = displayOption(option) + ' ×';
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

    // The view's native title bar already says "Properties"; the head only
    // carries the set-attribute count badge.
    function buildPropHead(setCount, totalCount) {
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px 0;flex:none;';
      if (totalCount > 0) {
        const badge = document.createElement('span');
        badge.textContent = setCount + ' of ' + totalCount + ' attributes set';
        badge.title = setCount + ' of ' + totalCount + ' attributes set';
        badge.style.cssText =
          'font-size:11px;font-weight:400;line-height:16px;color:' + C.badgeText + ';background:' + C.badgeBg + ';border-radius:11px;padding:1px 6px;';
        head.appendChild(badge);
      }
      return head;
    }

    // Real "N of M set / Clear all" footer grounded in this panel's actual
    // attribute/taxonomy values.
    function buildPropFoot(rootId, setEntries, totalCount) {
      const foot = document.createElement('div');
      foot.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid ' + C.border + ';flex:none;';
      const label = document.createElement('span');
      label.textContent = setEntries.length + ' of ' + totalCount + ' set';
      label.style.cssText = 'font-size:11px;color:' + C.muted + ';';
      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.className = 'prop-clear-all';
      clearAll.textContent = 'Clear all';
      clearAll.disabled = !setEntries.length;
      clearAll.setAttribute('aria-disabled', setEntries.length ? 'false' : 'true');
      clearAll.style.cssText =
        'margin-left:auto;border:0;border-radius:2px;padding:2px 11px;' +
        'background:' + (setEntries.length ? C.btn2Bg : 'transparent') + ';' +
        'font:13px/1.4 ' + fontFamily + ';color:' + (setEntries.length ? C.btn2Fg : C.faint) + ';' +
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
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px 8px 16px;';
        const empty = document.createElement('div');
        empty.textContent = 'Metadata is unavailable (the file may be mid-edit or invalid).';
        empty.style.cssText = 'font-size:13px;color:' + C.muted + ';line-height:1.5;';
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
      body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:0 0 16px;';
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
    };
  }

  window.DitaEditorPropertiesPanel = { installPropertiesPanel: installPropertiesPanel };
})();
