import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;

  constructor(readonly nodeValue: string) {}

  get length(): number {
    return this.nodeValue.length;
  }

  get textContent(): string {
    return this.nodeValue;
  }
}

class FakeElement {
  readonly nodeType = 1;
  parentElement: FakeElement | null = null;
  previousElementSibling: FakeElement | null = null;
  nextElementSibling: FakeElement | null = null;
  children: FakeElement[] = [];
  childNodes: Array<FakeElement | FakeText> = [];
  private ownTextContent = '';
  innerHTML = '';
  tagName: string;
  private readonly attrs = new Map<string, string>();

  constructor(attrs: Record<string, string> = {}, tagName = 'p') {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  get textContent(): string {
    return this.childNodes.length
      ? this.childNodes.map((child) => child.textContent).join('')
      : this.ownTextContent;
  }

  set textContent(value: string) {
    this.ownTextContent = value;
    this.childNodes = [];
    this.children = [];
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    child.parentElement = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement) this.children.push(child);
    return child;
  }

  closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector === '[data-edit-id]') return this.attrs.has('data-edit-id');
    if (selector === '[data-struct-id]') return this.attrs.has('data-struct-id');
    if (selector === '[data-struct-id][data-struct-kind="row"]') {
      return this.attrs.has('data-struct-id') && this.attrs.get('data-struct-kind') === 'row';
    }
    if (selector === '[data-edit-run]') return this.attrs.has('data-edit-run');
    if (selector === '[data-edit-id][contenteditable]') {
      return this.attrs.has('data-edit-id') && this.attrs.has('contenteditable');
    }
    if (selector === 'td, th') return this.tagName === 'TD' || this.tagName === 'TH';
    if (selector === 'table') return this.tagName === 'TABLE';
    if (selector === 'li[data-struct-id][data-struct-kind="li"]') {
      return this.tagName === 'LI' && this.attrs.has('data-struct-id') && this.attrs.get('data-struct-kind') === 'li';
    }
    return false;
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {
    // Test double: focus side effects are covered by posted messages here.
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  caretOffset = 0;
  selectionRange: unknown = null;
  lastCaretStart: { node: unknown; offset: number } | null = null;

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  createRange(): {
    selectNodeContents(): void;
    setEnd(_node: unknown, offset: number): void;
    setStart(node: unknown, offset: number): void;
    collapse(_toStart?: boolean): void;
    toString(): string;
  } {
    let end = this.caretOffset;
    return {
      selectNodeContents: () => undefined,
      setEnd: (_node: unknown, offset: number) => {
        end = offset;
      },
      setStart: (node: unknown, offset: number) => {
        this.lastCaretStart = { node, offset };
      },
      collapse: () => undefined,
      toString: () => 'x'.repeat(end),
    };
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  createElement(_tag: string): { innerHTML: string; childNodes: unknown[]; children: unknown[]; appendChild(fragment: unknown): void } {
    return {
      innerHTML: '',
      childNodes: [],
      children: [],
      appendChild(fragment: unknown) {
        this.innerHTML =
          fragment && typeof fragment === 'object' && '__html' in fragment
            ? String((fragment as { __html: unknown }).__html)
            : '';
      },
    };
  }
}

function installEditing(doc: FakeDocument, posted: unknown[]) {
  const utilsSource = readFileSync(new URL('../media/canvas-editing-utils.js', import.meta.url), 'utf8');
  const metricsSource = readFileSync(new URL('../media/canvas-text-metrics.js', import.meta.url), 'utf8');
  const pasteSource = readFileSync(new URL('../media/canvas-editing-paste.js', import.meta.url), 'utf8');
  const keysSource = readFileSync(new URL('../media/canvas-editing-keys.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../media/canvas-editing.js', import.meta.url), 'utf8');
  expect(utilsSource).not.toContain('acquireVsCodeApi');
  expect(pasteSource).not.toContain('acquireVsCodeApi');
  expect(keysSource).not.toContain('acquireVsCodeApi');
  expect(source).not.toContain('acquireVsCodeApi');
  const win = {} as {
    DitaEditorCanvasTextMetrics: unknown;
    DitaEditorCanvasEditingUtils: unknown;
    DitaEditorCanvasEditingPaste: unknown;
    DitaEditorCanvasEditingKeys: unknown;
    DitaEditorCanvasEditing: {
      installCanvasEditing(opts: Record<string, unknown>): unknown;
    };
  };
  new Function('window', metricsSource)(win);
  new Function('window', 'document', utilsSource)(win, doc);
  new Function('window', 'document', pasteSource)(win, doc);
  new Function('window', 'document', keysSource)(win, doc);
  new Function('window', 'document', source)(win, doc);

  return win.DitaEditorCanvasEditing.installCanvasEditing({
    document: doc,
    window: {
      getSelection: () =>
        doc.selectionRange
          ? {
              rangeCount: 1,
              isCollapsed:
                typeof doc.selectionRange === 'object' &&
                doc.selectionRange !== null &&
                '__isCollapsed' in doc.selectionRange
                  ? Boolean((doc.selectionRange as { __isCollapsed: unknown }).__isCollapsed)
                  : true,
              getRangeAt: () => doc.selectionRange,
              removeAllRanges: () => undefined,
              addRange: () => undefined,
            }
          : {
              rangeCount: 1,
              isCollapsed: true,
              getRangeAt: () => ({
                cloneRange: () => ({ endContainer: {}, endOffset: doc.caretOffset }),
              }),
              removeAllRanges: () => undefined,
              addRange: () => undefined,
            },
    },
    vscode: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    },
    getStructVersion: () => 7,
    getRerendering: () => false,
    getSelection: () => null,
    debounceMs: 1,
  });
}

describe('canvas-editing', () => {
  test('structural success helper preserves extras and covers toolbar structural operations', () => {
    const editing = installEditing(new FakeDocument(), []) as {
      structuralSuccessMessage(op: string, kind: string): string | null;
      withStructuralSuccess(op: string, kind: string, extra?: Record<string, unknown>): Record<string, unknown>;
    };

    expect(editing.structuralSuccessMessage('addColumnAfter', 'row')).toBe('Column added.');
    expect(editing.structuralSuccessMessage('deleteColumn', 'row')).toBe('Column deleted.');
    expect(editing.structuralSuccessMessage('mergeRight', 'row')).toBe('Cells merged.');
    expect(editing.structuralSuccessMessage('splitCell', 'row')).toBe('Cell split.');
    expect(editing.structuralSuccessMessage('pasteBlocks', 'p')).toBe('Content pasted.');
    expect(editing.withStructuralSuccess('deleteElement', 'note', { caret: 3 })).toEqual({
      caret: 3,
      announceOnSuccess: 'Note deleted.',
    });
  });

  test('setCaret restores a linear text offset through inline elements', () => {
    const doc = new FakeDocument();
    const editing = installEditing(doc, []) as {
      setCaret(el: FakeElement, offset: number): void;
    };
    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      contenteditable: 'true',
    });
    const bold = paragraph.appendChild(new FakeElement({}, 'strong'));
    paragraph.childNodes.unshift(new FakeText('foo '));
    const boldText = bold.appendChild(new FakeText('bar'));
    paragraph.appendChild(new FakeText(' baz'));

    editing.setCaret(paragraph, 7);

    expect(doc.lastCaretStart).toEqual({ node: boldText, offset: 3 });
  });

  test('setCaret skips render-only conref chip labels when restoring source offsets', () => {
    const doc = new FakeDocument();
    const editing = installEditing(doc, []) as {
      setCaret(el: FakeElement, offset: number): void;
    };
    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      contenteditable: 'true',
    });
    paragraph.appendChild(new FakeText('a '));
    const chip = paragraph.appendChild(new FakeElement({ 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' }, 'span'));
    chip.appendChild(new FakeText('reuse.dita#r/x'));
    const after = paragraph.appendChild(new FakeText(' b'));

    editing.setCaret(paragraph, 4);

    expect(doc.lastCaretStart).toEqual({ node: after, offset: 2 });
  });

  test('caretOffset treats render-only conref chip labels as zero length', () => {
    const doc = new FakeDocument();
    const editing = installEditing(doc, []) as {
      caretOffset(el: FakeElement): number;
    };
    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      contenteditable: 'true',
    });
    paragraph.appendChild(new FakeText('a '));
    const chip = paragraph.appendChild(new FakeElement({ 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' }, 'span'));
    chip.appendChild(new FakeText('reuse.dita#r/x'));
    const after = paragraph.appendChild(new FakeText(' b'));
    doc.selectionRange = {
      endContainer: after,
      endOffset: 1,
    };

    expect(editing.caretOffset(paragraph)).toBe(3);
  });

  test('selected block paste parser accepts single rich or plain blocks', () => {
    const editing = installEditing(new FakeDocument(), []) as {
      selectedBlockPasteBlocksFromClipboard(e: Record<string, unknown>): string[];
    };

    expect(
      editing.selectedBlockPasteBlocksFromClipboard({
        clipboardData: {
          getData: (type: string) => (type === 'text/html' ? '<p><strong>Only</strong></p>' : 'ignored'),
        },
      }),
    ).toEqual(['<strong>Only</strong>']);
    expect(
      editing.selectedBlockPasteBlocksFromClipboard({
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'Only & <' : ''),
        },
      }),
    ).toEqual(['Only &amp; &lt;']);
  });

  test('beforeinput inputType matrix leaves text mutation to the browser input event', async () => {
    const inputTypes = [
      'insertText',
      'insertReplacementText',
      'deleteContentBackward',
      'deleteContentForward',
      'insertFromPaste',
      'historyUndo',
      'formatBold',
    ];

    for (const inputType of inputTypes) {
      const doc = new FakeDocument();
      const posted: unknown[] = [];
      installEditing(doc, posted);
      const paragraph = new FakeElement({
        'data-edit-id': 'e1',
        'data-struct-id': 'e1',
        'data-struct-kind': 'p',
        contenteditable: 'true',
      });
      paragraph.textContent = `after ${inputType}`;
      let prevented = false;

      for (const listener of doc.listeners.get('beforeinput') ?? []) {
        listener({
          inputType,
          target: paragraph,
          preventDefault: () => {
            prevented = true;
          },
        });
      }

      expect(prevented).toBe(false);
      expect(posted).toEqual([]);

      for (const listener of doc.listeners.get('input') ?? []) listener({ inputType, target: paragraph });
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(posted).toEqual([{ type: 'edit', id: 'e1', text: `after ${inputType}` }]);
    }
  });

  test('IME composition defers input commits and prevents structural Enter while composing', async () => {
    const doc = new FakeDocument();
    doc.caretOffset = 2;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'draft';

    for (const listener of doc.listeners.get('compositionstart') ?? []) listener({ target: paragraph });
    paragraph.textContent = 'composing';
    for (const listener of doc.listeners.get('beforeinput') ?? []) {
      listener({ inputType: 'insertCompositionText', isComposing: true, target: paragraph });
    }
    for (const listener of doc.listeners.get('input') ?? []) {
      listener({ inputType: 'insertCompositionText', isComposing: true, target: paragraph });
    }

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        isComposing: true,
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(false);
    expect(posted).toEqual([]);

    paragraph.textContent = 'committed';
    for (const listener of doc.listeners.get('compositionend') ?? []) listener({ target: paragraph });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(posted).toEqual([{ type: 'edit', id: 'e1', text: 'committed' }]);
  });

  test('dead keys and Process keys are ignored by structural key handling', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'text';

    for (const key of ['Dead', 'Process']) {
      let prevented = false;
      for (const listener of doc.listeners.get('keydown') ?? []) {
        listener({
          key,
          target: paragraph,
          preventDefault: () => {
            prevented = true;
          },
        });
      }
      expect(prevented).toBe(false);
      expect(posted).toEqual([]);
    }
  });

  test('Enter split posts a host-confirmed success announcement for keyboard-origin structural edits', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 2;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'abcd';
    let prevented = false;

    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'split',
        id: 'e1',
        baseStructVersion: 7,
        prefix: 'ab',
        suffix: 'cd',
        announceOnSuccess: 'Paragraph split.',
      },
    ]);
  });

  test('Enter split in inline-rich prose posts HTML fragments instead of flattened text', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 7;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-inline-html': 'true',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Lead bold tail';
    paragraph.innerHTML = 'Lead <strong>bold</strong> tail';
    doc.selectionRange = richSplitRange(paragraph, 'Lead <strong>bo</strong>', '<strong>ld</strong> tail', doc.caretOffset);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'split',
        id: 'e1',
        baseStructVersion: 7,
        prefixHtml: 'Lead <strong>bo</strong>',
        suffixHtml: '<strong>ld</strong> tail',
        announceOnSuccess: 'Paragraph split.',
      },
    ]);
  });

  test('Enter split replaces selected plain text instead of preserving it before the split', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Hello selected tail';
    doc.selectionRange = plainSelectionRange(paragraph, 'Hello '.length, 'Hello selected'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'split',
        id: 'e1',
        baseStructVersion: 7,
        prefix: 'Hello ',
        suffix: ' tail',
        announceOnSuccess: 'Paragraph split.',
      },
    ]);
  });

  test('Enter split in selected rich prose preserves surrounding markup and removes selection', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-inline-html': 'true',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Lead old tail';
    paragraph.innerHTML = 'Lead <strong>old</strong> tail';
    doc.selectionRange = richSelectionRange(paragraph, 'Lead ', ' tail', 'Lead '.length, 'Lead old'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'split',
        id: 'e1',
        baseStructVersion: 7,
        prefixHtml: 'Lead ',
        suffixHtml: ' tail',
        announceOnSuccess: 'Paragraph split.',
      },
    ]);
  });

  test('Shift+Enter in a paragraph requests semantic lines instead of a raw text newline', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Hello tail';
    doc.selectionRange = editableMutationRange(paragraph, 'Hello '.length, 'Hello '.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        shiftKey: true,
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(paragraph.getAttribute('data-preserve-lines')).toBeNull();
    expect(posted).toEqual([{ type: 'lineBreak', id: 'e1', text: 'Hello \ntail', caretOffset: 7 }]);
  });

  test('Shift+Enter in a table cell requests semantic lines instead of adding a row', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const cell = new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
      contenteditable: 'true',
    }, 'td');
    cell.textContent = 'Cell text';
    doc.selectionRange = editableMutationRange(cell, 'Cell'.length, 'Cell'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        shiftKey: true,
        target: cell,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(cell.getAttribute('data-preserve-lines')).toBeNull();
    expect(posted).toEqual([{ type: 'lineBreak', id: 'e2', text: 'Cell\n text', caretOffset: 5 }]);
  });

  test('Enter in a table cell creates a same-cell line break instead of adding a row', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const cell = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
      contenteditable: 'true',
    }, 'td');
    cell.textContent = 'Title text';
    doc.selectionRange = editableMutationRange(cell, 'Title'.length, 'Title'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: cell,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([{ type: 'lineBreak', id: 'e1', text: 'Title\n text', caretOffset: 6 }]);
  });

  test('Enter at the end of a lines leaf inside a cell list item adds a new list item', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 13;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const cell = new FakeElement({ 'data-cell-id': 'c1' }, 'td');
    const list = new FakeElement({ 'data-struct-id': 'u1', 'data-struct-kind': 'ul' }, 'ul');
    const item = new FakeElement({ 'data-struct-id': 'li1', 'data-struct-kind': 'li' }, 'li');
    const lines = new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'e2',
      'data-struct-kind': 'lines',
      contenteditable: 'true',
    }, 'pre');
    cell.appendChild(list);
    list.appendChild(item);
    item.appendChild(lines);
    lines.appendChild(new FakeText('The crew rest\n'));

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: lines,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      { type: 'edit', id: 'e2', text: 'The crew rest\n' },
      { type: 'structural', op: 'addItemAfter', id: 'li1', baseStructVersion: 7, announceOnSuccess: 'Item added.' },
    ]);
  });

  test('Enter mid-text in a lines leaf inside a cell list item keeps the literal line break', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const cell = new FakeElement({ 'data-cell-id': 'c1' }, 'td');
    const item = new FakeElement({ 'data-struct-id': 'li1', 'data-struct-kind': 'li' }, 'li');
    const lines = new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'e2',
      'data-struct-kind': 'lines',
      contenteditable: 'true',
    }, 'pre');
    cell.appendChild(item);
    item.appendChild(lines);
    const textNode = new FakeText('The crew rest');
    lines.appendChild(textNode);
    const range = editableMutationRange(lines, 'The'.length, 'The'.length) as unknown as Record<string, unknown>;
    range.endContainer = textNode; // offsetWithin resolves the true linear offset
    doc.selectionRange = range;

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: lines,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([{ type: 'lineBreak', id: 'e2', text: 'The\n crew rest', caretOffset: 4 }]);
  });

  test('Enter in a plain list item inside a table cell splits the item instead of line-breaking', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 2;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const cell = new FakeElement({ 'data-cell-id': 'c1' }, 'td');
    const item = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'li',
      contenteditable: 'true',
    }, 'li');
    cell.appendChild(item);
    item.textContent = 'abcd';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: item,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'split',
        id: 'e1',
        baseStructVersion: 7,
        prefix: 'ab',
        suffix: 'cd',
        announceOnSuccess: 'Item split.',
      },
    ]);
  });

  test('Enter in an existing lines block restores the caret on the new line', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const lines = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'lines',
      contenteditable: 'true',
    }, 'pre');
    lines.textContent = 'FirstSecond';
    doc.selectionRange = editableMutationRange(lines, 'First'.length, 'First'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: lines,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([{ type: 'lineBreak', id: 'e1', text: 'First\nSecond', caretOffset: 6 }]);
  });

  test('Tab from the last table cell is left for document-order navigation', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const cell = table.appendChild(new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
      contenteditable: 'true',
    }, 'td'));
    cell.textContent = 'Last cell';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        target: cell,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  test('Shift+Tab from the first table cell is left for document-order navigation', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const cell = table.appendChild(new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
      contenteditable: 'true',
    }, 'td'));
    cell.textContent = 'First cell';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        shiftKey: true,
        target: cell,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  test('Tab from a paragraph inside the last table cell is left for document-order navigation', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const row = table.appendChild(new FakeElement({
      'data-struct-id': 'r1',
      'data-struct-kind': 'row',
    }, 'tr'));
    const cell = row.appendChild(new FakeElement({}, 'td'));
    const paragraph = cell.appendChild(new FakeElement({
      'data-edit-id': 'p1',
      'data-struct-id': 'p1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    }));
    paragraph.textContent = 'Nested cell';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  test('Tab in a cell list item indents instead of moving to the next cell', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 4;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const row = table.appendChild(new FakeElement({ 'data-struct-id': 'r1', 'data-struct-kind': 'row' }, 'tr'));
    const cell = row.appendChild(new FakeElement({ 'data-cell-id': 'c1' }, 'td'));
    // A next cell exists, so plain cell navigation WOULD have succeeded here.
    row.appendChild(new FakeElement({ 'data-edit-id': 'e9', contenteditable: 'true' }, 'td'));
    const list = cell.appendChild(new FakeElement({ 'data-struct-id': 'u1', 'data-struct-kind': 'ul' }, 'ul'));
    const item = list.appendChild(new FakeElement({ 'data-struct-id': 'li1', 'data-struct-kind': 'li' }, 'li'));
    const lines = item.appendChild(new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'e2',
      'data-struct-kind': 'lines',
      contenteditable: 'true',
    }, 'pre'));
    lines.appendChild(new FakeText('The crew rest'));

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        target: lines,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      { type: 'edit', id: 'e2', text: 'The crew rest' },
      { type: 'structural', op: 'indentItem', id: 'li1', baseStructVersion: 7, caret: 4, announceOnSuccess: 'Item indented.' },
    ]);
  });

  test('Shift+Tab in a cell list item outdents instead of moving to the previous cell', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const row = table.appendChild(new FakeElement({ 'data-struct-id': 'r1', 'data-struct-kind': 'row' }, 'tr'));
    row.appendChild(new FakeElement({ 'data-edit-id': 'e9', contenteditable: 'true' }, 'td'));
    const cell = row.appendChild(new FakeElement({ 'data-cell-id': 'c1' }, 'td'));
    const list = cell.appendChild(new FakeElement({ 'data-struct-id': 'u1', 'data-struct-kind': 'ul' }, 'ul'));
    const item = list.appendChild(new FakeElement({ 'data-struct-id': 'li1', 'data-struct-kind': 'li' }, 'li'));
    const lines = item.appendChild(new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'e2',
      'data-struct-kind': 'lines',
      contenteditable: 'true',
    }, 'pre'));
    lines.appendChild(new FakeText('The crew rest'));

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        shiftKey: true,
        target: lines,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      { type: 'edit', id: 'e2', text: 'The crew rest' },
      { type: 'structural', op: 'outdentItem', id: 'li1', baseStructVersion: 7, caret: 0, announceOnSuccess: 'Item outdented.' },
    ]);
  });

  test('Tab in a list item outside a table still indents through the li ancestor', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 2;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const list = new FakeElement({ 'data-struct-id': 'u1', 'data-struct-kind': 'ul' }, 'ul');
    const item = list.appendChild(new FakeElement({
      'data-edit-id': 'li1',
      'data-edit-run': 'true',
      'data-struct-id': 'li1',
      'data-struct-kind': 'li',
      contenteditable: 'true',
    }, 'li'));
    item.appendChild(new FakeText('Item text'));

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        target: item,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      { type: 'edit', id: 'li1', text: 'Item text' },
      { type: 'structural', op: 'indentItem', id: 'li1', baseStructVersion: 7, caret: 2, announceOnSuccess: 'Item indented.' },
    ]);
  });

  test('Tab in a plain table cell still moves to the next cell', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const table = new FakeElement({}, 'table');
    const row = table.appendChild(new FakeElement({ 'data-struct-id': 'r1', 'data-struct-kind': 'row' }, 'tr'));
    const first = row.appendChild(new FakeElement({
      'data-edit-id': 'e1',
      contenteditable: 'true',
    }, 'td'));
    first.appendChild(new FakeText('A'));
    row.appendChild(new FakeElement({ 'data-edit-id': 'e2', contenteditable: 'true' }, 'td'));

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Tab',
        target: first,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([{ type: 'edit', id: 'e1', text: 'A' }]);
  });

  test('Enter on an empty list item exits the list through the host transform path', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const item = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'li',
      contenteditable: 'true',
    }, 'li');
    item.textContent = '';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        target: item,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      { type: 'edit', id: 'e1', text: '' },
      { type: 'transform', transform: 'itemToParagraph', id: 'e1' },
    ]);
  });

  test('rich paste into a plain paragraph commits HTML instead of flattened text', async () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Rich';
    paragraph.innerHTML = '<strong>Rich</strong>';

    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        target: paragraph,
        clipboardData: {
          getData: (type: string) => (type === 'text/html' ? '<strong>Rich</strong>' : 'Rich'),
        },
      });
    }

    expect(paragraph.getAttribute('data-inline-html')).toBe('true');

    for (const listener of doc.listeners.get('input') ?? []) {
      listener({ target: paragraph });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(posted).toEqual([{ type: 'edit', id: 'e1', text: 'Rich', html: '<strong>Rich</strong>' }]);
  });

  test('multi-block paste posts a structural paste instead of flattening to inline text', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 6;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Hello tail';
    doc.selectionRange = plainSelectionRange(paragraph, doc.caretOffset, doc.caretOffset);

    let prevented = false;
    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        target: paragraph,
        clipboardData: {
          getData: (type: string) =>
            type === 'text/html' ? '<p>First</p><p><strong>Second</strong></p>' : 'First\nSecond',
        },
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(paragraph.getAttribute('data-inline-html')).toBeNull();
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'pasteBlocks',
        id: 'e1',
        baseStructVersion: 7,
        prefix: 'Hello ',
        suffix: 'tail',
        blocks: ['First', '<strong>Second</strong>'],
        announceOnSuccess: 'Content pasted.',
      },
    ]);
  });

  test('multi-block paste replaces selected text instead of requiring a collapsed caret', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Hello selected tail';
    doc.selectionRange = plainSelectionRange(paragraph, 'Hello '.length, 'Hello selected'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        target: paragraph,
        clipboardData: {
          getData: (type: string) => (type === 'text/html' ? '<p>First</p><p>Second</p>' : 'First\nSecond'),
        },
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'pasteBlocks',
        id: 'e1',
        baseStructVersion: 7,
        prefix: 'Hello ',
        suffix: ' tail',
        blocks: ['First', 'Second'],
        announceOnSuccess: 'Content pasted.',
      },
    ]);
  });

  test('multi-block paste in selected rich prose posts rich prefix and suffix fragments', () => {
    const doc = new FakeDocument();
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-inline-html': 'true',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'Lead old tail';
    paragraph.innerHTML = 'Lead <strong>old</strong> tail';
    doc.selectionRange = richSelectionRange(paragraph, 'Lead ', ' tail', 'Lead '.length, 'Lead old'.length);

    let prevented = false;
    for (const listener of doc.listeners.get('paste') ?? []) {
      listener({
        target: paragraph,
        clipboardData: {
          getData: (type: string) => (type === 'text/html' ? '<p><em>First</em></p><p>Second</p>' : 'First\nSecond'),
        },
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'pasteBlocks',
        id: 'e1',
        baseStructVersion: 7,
        prefixHtml: 'Lead ',
        suffixHtml: ' tail',
        blocks: ['<em>First</em>', 'Second'],
        announceOnSuccess: 'Content pasted.',
      },
    ]);
  });

  test('Backspace joins a paragraph into a preceding inline-rich note without flattening markup', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const previous = new FakeElement({
      'data-edit-id': 'e1',
      'data-inline-html': 'true',
      'data-struct-id': 'e1',
      'data-struct-kind': 'note',
      contenteditable: 'true',
    });
    previous.appendChild(new FakeText('Lead bold'));
    previous.innerHTML = 'Lead <strong>bold</strong>';

    const paragraph = new FakeElement({
      'data-edit-id': 'e2',
      'data-inline-html': 'true',
      'data-struct-id': 'e2',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.textContent = 'tail';
    paragraph.innerHTML = '<em>tail</em>';
    paragraph.previousElementSibling = previous;

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Backspace',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'edit',
        id: 'e2',
        text: 'tail',
        html: '<em>tail</em>',
      },
      {
        type: 'structural',
        op: 'join',
        id: 'e2',
        baseStructVersion: 7,
        prevId: 'e1',
        boundary: 'Lead bold'.length,
        mergedHtml: 'Lead <strong>bold</strong><em>tail</em>',
        announceOnSuccess: 'Paragraphs joined.',
      },
    ]);
  });

  test('Backspace in an empty command without a compatible predecessor does not post an undefined delete', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);
    const command = new FakeElement({
      'data-edit-id': 'e2',
      'data-struct-id': 'e2',
      'data-struct-kind': 'cmd',
      contenteditable: 'true',
    });
    command.textContent = '';

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({ key: 'Backspace', target: command, preventDefault: () => { prevented = true; } });
    }

    expect(prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  test('Backspace at the sole item of a list targets the paragraph before the list wrapper', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 0;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const previous = new FakeElement({
      'data-edit-id': 'e1', 'data-struct-id': 'e1', 'data-struct-kind': 'p', contenteditable: 'true',
    });
    previous.textContent = 'Lead';
    const list = new FakeElement({ 'data-struct-id': 'e2', 'data-struct-kind': 'ul' }, 'ul');
    list.previousElementSibling = previous;
    const item = new FakeElement({
      'data-edit-id': 'e3', 'data-struct-id': 'e3', 'data-struct-kind': 'li', contenteditable: 'true',
    }, 'li');
    item.textContent = 'Tail';
    list.appendChild(item);

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({ key: 'Backspace', target: item, preventDefault: () => { prevented = true; } });
    }

    expect(prevented).toBe(true);
    expect(posted.at(-1)).toMatchObject({ type: 'structural', op: 'join', id: 'e3', prevId: 'e1' });
  });

  test('Delete join at source end ignores render-only conref chip length', () => {
    const doc = new FakeDocument();
    doc.caretOffset = 4;
    const posted: unknown[] = [];
    installEditing(doc, posted);

    const paragraph = new FakeElement({
      'data-edit-id': 'e1',
      'data-inline-html': 'true',
      'data-struct-id': 'e1',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    paragraph.appendChild(new FakeText('a '));
    const chip = paragraph.appendChild(new FakeElement({ 'data-dita': 'ph', 'data-conref': 'reuse.dita#r/x' }, 'span'));
    chip.appendChild(new FakeText('reuse.dita#r/x'));
    paragraph.appendChild(new FakeText(' b'));
    paragraph.innerHTML = 'a <span data-dita="ph" data-conref="reuse.dita#r/x">reuse.dita#r/x</span> b';

    const next = new FakeElement({
      'data-edit-id': 'e2',
      'data-inline-html': 'true',
      'data-struct-id': 'e2',
      'data-struct-kind': 'p',
      contenteditable: 'true',
    });
    next.textContent = 'next';
    next.innerHTML = '<em>next</em>';
    paragraph.nextElementSibling = next;

    let prevented = false;
    for (const listener of doc.listeners.get('keydown') ?? []) {
      listener({
        key: 'Delete',
        target: paragraph,
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    expect(paragraph.textContent.length).toBeGreaterThan(4);
    expect(prevented).toBe(true);
    expect(posted).toEqual([
      {
        type: 'structural',
        op: 'join',
        id: 'e2',
        baseStructVersion: 7,
        prevId: 'e1',
        boundary: 4,
        mergedHtml: 'a <span data-dita="ph" data-conref="reuse.dita#r/x">reuse.dita#r/x</span> b<em>next</em>',
        announceOnSuccess: 'Paragraphs joined.',
      },
    ]);
  });
});

function richSplitRange(target: FakeElement, prefixHtml: string, suffixHtml: string, caret: number) {
  return richSelectionRange(target, prefixHtml, suffixHtml, caret, caret);
}

function richSelectionRange(target: FakeElement, prefixHtml: string, suffixHtml: string, start: number, end: number) {
  const makeClone = () => {
    let side: 'prefix' | 'suffix' = 'prefix';
    return {
      endContainer: {},
      endOffset: end,
      selectNodeContents: () => undefined,
      setEnd: () => {
        side = 'prefix';
      },
      setStart: () => {
        side = 'suffix';
      },
      cloneContents: () => ({ __html: side === 'prefix' ? prefixHtml : suffixHtml }),
    };
  };
  return {
    __isCollapsed: start === end,
    commonAncestorContainer: target,
    startContainer: {},
    startOffset: start,
    endContainer: {},
    endOffset: end,
    setStart: () => undefined,
    cloneContents: () => ({ __html: '' }),
    cloneRange: makeClone,
  };
}

function plainSelectionRange(target: FakeElement, start: number, end: number) {
  return {
    __isCollapsed: start === end,
    commonAncestorContainer: target,
    startContainer: {},
    startOffset: start,
    endContainer: {},
    endOffset: end,
    cloneRange: () => ({
      endContainer: {},
      endOffset: end,
    }),
  };
}

function editableMutationRange(target: FakeElement, start: number, end: number) {
  let inserted = '';
  return {
    __isCollapsed: start === end,
    commonAncestorContainer: target,
    startContainer: {},
    startOffset: start,
    endContainer: {},
    endOffset: end,
    deleteContents: () => {
      target.textContent = target.textContent.slice(0, start) + target.textContent.slice(end);
    },
    insertNode: (node: { nodeValue?: string }) => {
      inserted = node.nodeValue ?? '';
      target.textContent = target.textContent.slice(0, start) + inserted + target.textContent.slice(start);
      target.innerHTML = target.textContent;
    },
    setStartAfter: () => undefined,
    collapse: () => undefined,
    cloneRange: () => ({
      endContainer: {},
      endOffset: start + inserted.length,
    }),
  };
}
