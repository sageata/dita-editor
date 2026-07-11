// Structure command helpers for the persistent DITA Editor command bar.
//
// Loaded before canvas-command-bar.js. Pure helper: no DOM ownership, no VS Code API.
(function () {
  const textMetrics = window.DitaEditorCanvasTextMetrics;
  if (!textMetrics) throw new Error('DitaEditorCanvasTextMetrics must load before canvas-command-structure.js');

  function sourceTextLength(el) {
    return textMetrics.sourceLength(el);
  }

  function isCaretBeforeEnd(current) {
    return !!(
      current &&
      current.isCollapsed === true &&
      typeof current.caretOffset === 'number' &&
      typeof current.textLength === 'number' &&
      current.caretOffset < current.textLength
    );
  }

  function isTextSelection(current) {
    return !!(
      current &&
      current.isCollapsed === false &&
      current.id &&
      typeof current.textLength === 'number'
    );
  }

  function isEditingBeforeEnd(current) {
    return isCaretBeforeEnd(current) || isTextSelection(current);
  }

  function structureTransformFor(op, current) {
    if (!current || !current.id) return null;
    if (current.kind === 'entry') {
      if (op === 'paragraph') return 'entryToParagraph';
      if (op === 'unorderedList') return 'entryToUnorderedList';
      if (op === 'alphabeticList') return 'entryToAlphabeticList';
      if (op === 'orderedList') return 'entryToOrderedList';
      if (op === 'lines') return 'entryToLines';
      if (op === 'note') return 'entryToNote';
      if (op === 'codeblock') return 'entryToCodeblock';
      return null;
    }
    if (current.kind === 'lines') {
      if (op === 'paragraph') return 'linesToParagraph';
      if (op === 'unorderedList') return 'linesToUnorderedList';
      if (op === 'alphabeticList') return 'linesToAlphabeticList';
      if (op === 'orderedList') return 'linesToOrderedList';
      if (op === 'section') return 'linesToSection';
      if (op === 'note') return 'linesToNote';
      if (op === 'codeblock') return 'linesToCodeblock';
      return null;
    }
    if (!isEditingBeforeEnd(current)) return null;
    if (op === 'paragraph' && current.kind === 'li') return 'itemToParagraph';
    if (op === 'section' && current.kind === 'p') return 'paragraphToSection';
    if (op === 'unorderedList') {
      if (current.kind === 'p') return 'paragraphToUnorderedList';
      if (current.kind === 'li') return 'toUnorderedList';
    }
    if (op === 'alphabeticList') {
      if (current.kind === 'p') return 'paragraphToAlphabeticList';
      if (current.kind === 'li') return 'toAlphabeticList';
    }
    if (op === 'orderedList') {
      if (current.kind === 'p') return 'paragraphToOrderedList';
      if (current.kind === 'li') return 'toOrderedList';
    }
    if (op === 'note' && current.kind === 'p') return 'paragraphToNote';
    if (op === 'codeblock' && current.kind === 'p') return 'paragraphToCodeblock';
    return null;
  }

  function structureTransformLabel(op, transform) {
    if (transform === 'itemToParagraph' || transform === 'entryToParagraph') return 'Convert to paragraph';
    if (transform === 'linesToParagraph') return 'Convert to paragraph';
    if (transform === 'toUnorderedList' || transform === 'paragraphToUnorderedList' || transform === 'entryToUnorderedList') return 'Convert to bulleted list';
    if (transform === 'linesToUnorderedList') return 'Convert to bulleted list';
    if (transform === 'toAlphabeticList' || transform === 'paragraphToAlphabeticList' || transform === 'entryToAlphabeticList') return 'Convert to alphabetic list';
    if (transform === 'linesToAlphabeticList') return 'Convert to alphabetic list';
    if (transform === 'toOrderedList' || transform === 'paragraphToOrderedList' || transform === 'entryToOrderedList') return 'Convert to numbered list';
    if (transform === 'linesToOrderedList') return 'Convert to numbered list';
    if (transform === 'entryToLines') return 'Convert to lines';
    if (transform === 'paragraphToSection' || transform === 'linesToSection') return 'Convert to section';
    if (transform === 'paragraphToNote' || transform === 'entryToNote') return 'Convert to note';
    if (transform === 'linesToNote') return 'Convert to note';
    if (transform === 'paragraphToCodeblock' || transform === 'entryToCodeblock') return 'Convert to code block';
    if (transform === 'linesToCodeblock') return 'Convert to code block';
    return 'Convert ' + op;
  }

  function listKindTransformForCurrent(transform, current) {
    if (!current || !current.id) return transform;
    if (current.kind === 'entry') {
      if (transform === 'toAlphabeticList') return 'entryToAlphabeticList';
      return transform === 'toOrderedList' ? 'entryToOrderedList' : 'entryToUnorderedList';
    }
    if (current.kind === 'p') {
      if (transform === 'toAlphabeticList') return 'paragraphToAlphabeticList';
      return transform === 'toOrderedList' ? 'paragraphToOrderedList' : 'paragraphToUnorderedList';
    }
    if (current.kind === 'lines') {
      if (transform === 'toAlphabeticList') return 'linesToAlphabeticList';
      return transform === 'toOrderedList' ? 'linesToOrderedList' : 'linesToUnorderedList';
    }
    return transform;
  }

  function selectedListItemIds(selection) {
    if (!selection) return [];
    if (selection.mode === 'single') {
      return selection.unit === 'block' && selection.kind === 'li' && selection.id != null ? [selection.id] : [];
    }
    if (selection.mode === 'blockRange') {
      if (selection.kind !== 'li') return [];
      return (selection.members || []).map((member) => member.id).filter((id) => id != null);
    }
    if (selection.mode === 'multiSet') {
      const units = selection.units || [];
      if (!units.length) return [];
      const ids = [];
      for (const unit of units) {
        if (!unit || unit.unit !== 'block' || unit.kind !== 'li' || unit.id == null) return [];
        ids.push(unit.id);
      }
      return ids;
    }
    return [];
  }

  function hasMultiListItemSelection(selection) {
    return !!selection &&
      (selection.mode === 'blockRange' || selection.mode === 'multiSet') &&
      selectedListItemIds(selection).length > 0;
  }

  function structIdSelector(id, windowObj) {
    const value = String(id);
    if (windowObj && windowObj.CSS && typeof windowObj.CSS.escape === 'function') {
      return '[data-struct-id="' + windowObj.CSS.escape(value) + '"]';
    }
    return '[data-struct-id="' + value.replace(/"/g, '\\"') + '"]';
  }

  function selectedListTags(document, windowObj, ids) {
    const tags = [];
    for (const id of ids) {
      const el = document.querySelector(structIdSelector(id, windowObj));
      const list = el && el.closest ? el.closest('ul, ol') : null;
      if (list) tags.push(list.tagName.toLowerCase());
    }
    return tags;
  }

  function listStyle(list) {
    if (!list) return null;
    const tag = list.tagName.toLowerCase();
    if (tag === 'ul') return 'unordered';
    const outputclass = list.getAttribute('data-outputclass') || '';
    const className = typeof list.className === 'string' ? list.className : '';
    const tokens = (outputclass + ' ' + className).split(/\s+/).filter(Boolean);
    return tokens.indexOf('lower-alpha') >= 0 ? 'alpha' : 'ordered';
  }

  function selectedListStyles(document, windowObj, ids) {
    const styles = [];
    for (const id of ids) {
      const el = document.querySelector(structIdSelector(id, windowObj));
      const list = el && el.closest ? el.closest('ul, ol') : null;
      const style = listStyle(list);
      if (style) styles.push(style);
    }
    return styles;
  }

  window.DitaEditorCanvasCommandStructure = {
    hasMultiListItemSelection: hasMultiListItemSelection,
    isCaretBeforeEnd: isCaretBeforeEnd,
    isEditingBeforeEnd: isEditingBeforeEnd,
    listKindTransformForCurrent: listKindTransformForCurrent,
    selectedListItemIds: selectedListItemIds,
    selectedListStyles: selectedListStyles,
    selectedListTags: selectedListTags,
    sourceTextLength: sourceTextLength,
    structureTransformFor: structureTransformFor,
    structureTransformLabel: structureTransformLabel,
  };
})();
