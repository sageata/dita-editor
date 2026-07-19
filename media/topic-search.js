// Search DITA Topics — webview view client (IX-5).
//
// Thin rendering shell over the host's search controller: posts debounced
// {type:'search'} messages with a generation token, renders the host's grouped
// results, and posts {type:'openMatch'} when a result is activated. All result
// strings are file-derived: rendering goes through createElement/textContent
// only (no HTML string assignment) so hostile topic text stays inert.
(function () {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('topic-search-input');
  const caseBtn = document.getElementById('topic-search-case');
  const status = document.getElementById('topic-search-status');
  const results = document.getElementById('topic-search-results');
  const toggleBtn = document.getElementById('topic-search-toggle-replace');
  const replaceRow = document.getElementById('topic-search-replace-row');
  const replaceInput = document.getElementById('topic-search-replace-input');
  const replaceAllBtn = document.getElementById('topic-search-replace-all');
  if (!input || !caseBtn || !status || !results || !toggleBtn || !replaceRow || !replaceInput || !replaceAllBtn) return;

  const DEBOUNCE_MS = 200;
  const restored = vscode.getState() || {};
  let matchCase = restored.matchCase === true;
  let replaceOpen = restored.replaceOpen === true;
  let generation = 0;
  let debounceTimer = null;

  if (typeof restored.query === 'string') input.value = restored.query;
  if (typeof restored.replaceText === 'string') replaceInput.value = restored.replaceText;
  syncCaseButton();
  syncReplaceRow();

  function syncCaseButton() {
    caseBtn.setAttribute('aria-pressed', matchCase ? 'true' : 'false');
    if (matchCase) caseBtn.classList.add('active');
    else caseBtn.classList.remove('active');
  }

  function syncReplaceRow() {
    toggleBtn.setAttribute('aria-expanded', replaceOpen ? 'true' : 'false');
    toggleBtn.textContent = replaceOpen ? '▾' : '▸';
    if (replaceOpen) {
      replaceRow.removeAttribute('hidden');
      document.body.classList.add('replace-open');
    } else {
      replaceRow.setAttribute('hidden', '');
      document.body.classList.remove('replace-open');
    }
  }

  function persist() {
    vscode.setState({
      query: input.value || '',
      matchCase: matchCase,
      replaceOpen: replaceOpen,
      replaceText: replaceInput.value || '',
    });
  }

  function postSearch() {
    generation += 1;
    vscode.postMessage({
      type: 'search',
      query: input.value || '',
      matchCase: matchCase,
      generation: generation,
    });
  }

  function scheduleSearch() {
    persist();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      postSearch();
    }, DEBOUNCE_MS);
  }

  function searchNow() {
    persist();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    postSearch();
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function clearResults() {
    results.textContent = '';
  }

  function matchRows() {
    return results.querySelectorAll('[data-match-row]');
  }

  function moveFocus(row, delta) {
    const rows = matchRows();
    const index = rows.indexOf ? rows.indexOf(row) : Array.prototype.indexOf.call(rows, row);
    const next = rows[index + delta];
    if (next && next.focus) next.focus();
  }

  function openMatch(group, match) {
    vscode.postMessage({
      type: 'openMatch',
      uri: group.uri,
      sourceStart: match.sourceStart,
      sourceEnd: match.sourceEnd,
      renderedText: match.matchText,
      matchCase: matchCase,
    });
  }

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    for (const token of className.split(' ')) {
      if (token) el.classList.add(token);
    }
    el.textContent = text;
    return el;
  }

  function renderGroup(group) {
    const container = document.createElement('div');
    container.className = 'group';
    const header = document.createElement('div');
    header.className = 'group-header';
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-expanded', 'true');
    header.tabIndex = 0;
    // Native-search header anatomy: twisty, file icon, file name, dimmed
    // directory path, count badge at the right.
    const slash = group.label.lastIndexOf('/');
    const fileName = slash < 0 ? group.label : group.label.slice(slash + 1);
    const dirPath = slash < 0 ? '' : group.label.slice(0, slash);
    header.append(
      span('twisty', '▾'),
      span('file-icon', ''),
      span('group-label', fileName),
    );
    if (dirPath !== '') header.append(span('group-path', dirPath));
    header.append(span('group-count', String(group.matches.length + group.moreCount)));
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'group-matches';
    list.setAttribute('role', 'group');
    for (const match of group.matches) {
      const row = document.createElement('div');
      row.className = 'match-row';
      row.setAttribute('data-match-row', 'true');
      row.setAttribute('role', 'treeitem');
      row.tabIndex = 0;
      row.append(
        span('ctx', match.snippetBefore),
        span('match', match.matchText),
        span('ctx', match.snippetAfter),
      );
      // Hover action, native-search style: replace just this match with the
      // current replacement text. Propagation must stop or the row click
      // underneath would also open the match.
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'row-action replace-action';
      action.classList.add('row-action');
      action.classList.add('replace-action');
      action.title = 'Replace match';
      action.setAttribute('aria-label', 'Replace match');
      action.appendChild(span('icon-mask icon-replace', ''));
      action.addEventListener('click', function (event) {
        if (event && event.stopPropagation) event.stopPropagation();
        vscode.postMessage({
          type: 'replaceMatch',
          uri: group.uri,
          sourceStart: match.sourceStart,
          sourceEnd: match.sourceEnd,
          renderedText: match.matchText,
          replacement: replaceInput.value || '',
        });
      });
      row.appendChild(action);
      row.addEventListener('click', function () {
        openMatch(group, match);
      });
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          openMatch(group, match);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveFocus(row, 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(row, -1);
        }
      });
      list.appendChild(row);
    }
    if (group.moreCount > 0) {
      list.appendChild(span('more-note', group.moreCount + ' more in this file — open it and use in-topic find'));
    }
    container.appendChild(list);
    header.addEventListener('click', function () {
      const collapsed = container.classList.contains('collapsed');
      if (collapsed) container.classList.remove('collapsed');
      else container.classList.add('collapsed');
      header.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
      const twisty = header.querySelector('.twisty');
      if (twisty) twisty.textContent = collapsed ? '▾' : '▸';
    });
    return container;
  }

  function statusLine(msg) {
    if (msg.tooShort) return 'Type at least 2 characters to search.';
    if (msg.totalShown === 0) return 'No results.';
    const files = msg.groups.length;
    const parts = [
      msg.totalShown + (msg.totalShown === 1 ? ' result' : ' results') +
        ' in ' + files + ' of ' + msg.fileCount + (msg.fileCount === 1 ? ' file' : ' files'),
    ];
    if (msg.truncated) parts.push('stopped after ' + msg.totalShown + ' matches — refine your search');
    if (msg.parseFailures > 0) {
      parts.push(msg.parseFailures + (msg.parseFailures === 1 ? ' file' : ' files') + ' could not be parsed');
    }
    if (msg.skippedLarge > 0) {
      parts.push(msg.skippedLarge + ' large ' + (msg.skippedLarge === 1 ? 'file' : 'files') + ' skipped');
    }
    return parts.join(' · ');
  }

  function renderResults(msg) {
    if (msg.generation !== generation) return; // stale search overtaken by typing
    clearResults();
    for (const group of msg.groups) results.appendChild(renderGroup(group));
    setStatus(statusLine(msg));
  }

  input.addEventListener('input', scheduleSearch);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchNow();
    } else if (event.key === 'ArrowDown') {
      const rows = matchRows();
      if (rows.length > 0 && rows[0].focus) {
        event.preventDefault();
        rows[0].focus();
      }
    }
  });
  caseBtn.addEventListener('click', function () {
    matchCase = !matchCase;
    syncCaseButton();
    persist();
    if ((input.value || '') !== '') postSearch();
  });
  toggleBtn.addEventListener('click', function () {
    replaceOpen = !replaceOpen;
    syncReplaceRow();
    persist();
    if (replaceOpen && replaceInput.focus) replaceInput.focus();
  });
  replaceInput.addEventListener('input', persist);
  replaceAllBtn.addEventListener('click', function () {
    if ((input.value || '') === '') return;
    vscode.postMessage({
      type: 'replaceAll',
      query: input.value,
      matchCase: matchCase,
      replacement: replaceInput.value || '',
    });
  });

  function plural(count, singular, pluralForm) {
    return count + ' ' + (count === 1 ? singular : pluralForm);
  }

  function replaceLine(msg) {
    if (msg.stale) return 'The file changed since this search — results refreshed.';
    const skipped = msg.skippedStyled > 0
      ? ' ' + plural(msg.skippedStyled, 'styled match', 'styled matches') + ' skipped.'
      : '';
    if (msg.replaced === 0) return 'No matches replaced.' + skipped;
    return 'Replaced ' + plural(msg.replaced, 'occurrence', 'occurrences') +
      ' in ' + plural(msg.fileCount, 'file', 'files') + '.' + skipped;
  }

  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.type === 'searchResults') {
      renderResults(msg);
    } else if (msg.type === 'searchBusy') {
      if (msg.generation === generation) setStatus('Searching…');
    } else if (msg.type === 'searchUnavailable') {
      clearResults();
      setStatus(msg.reason || 'Topic search is unavailable.');
    } else if (msg.type === 'focusSearchInput') {
      if (input.focus) input.focus();
      if (input.select) input.select();
    } else if (msg.type === 'replaceDone') {
      setStatus(replaceLine(msg));
    }
  });

  vscode.postMessage({ type: 'searchReady' });
  if ((input.value || '') !== '') postSearch();
})();
