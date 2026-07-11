import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import type { ElementNode } from '../src/cst/types';
import { applyOutputClassStyleToIds } from '../src/host/style-actions';

function idsFor(src: string, names: string[]): string[] {
  const doc = parse(src);
  const byNode = assignElementIds(doc);
  const out: string[] = [];
  const visit = (node: ElementNode): void => {
    if (names.includes(node.name)) {
      const id = byNode.get(node);
      if (id) out.push(id);
    }
    for (const child of node.children) {
      if (child.type === 'element') visit(child);
    }
  };
  for (const child of doc.children) {
    if (child.type === 'element') visit(child);
  }
  return out;
}

describe('style actions', () => {
  test('applies a managed outputclass to multiple selected elements', async () => {
    const src = '<topic id="t"><title outputclass="old dc-heading-gold">T</title><body><p outputclass="keep">A</p><p>B</p></body></topic>';
    let source = src;
    const ids = idsFor(src, ['title', 'p']);
    const pushes: Array<[string | null, number | null]> = [];

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: (focusId, caretOffset) => {
        pushes.push([focusId, caretOffset]);
      },
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
    }, ids, 'dc-heading-compact', ['dc-heading-gold', 'dc-heading-compact']);

    expect(source).toBe(
      '<topic id="t"><title outputclass="old dc-heading-compact">T</title><body><p outputclass="keep dc-heading-compact">A</p><p outputclass="dc-heading-compact">B</p></body></topic>',
    );
    expect(pushes).toEqual([[null, null]]);
  });

  test('clears only managed outputclass tokens', async () => {
    const src = '<topic id="t"><body><p outputclass="keep dc-heading-gold">A</p></body></topic>';
    let source = src;
    const [id] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
    }, [id], '', ['dc-heading-gold']);

    expect(source).toBe('<topic id="t"><body><p outputclass="keep">A</p></body></topic>');
  });

  test('repaints the canvas when applying a style already present in the source', async () => {
    const src = '<topic id="t"><title outputclass="dc-heading-compact">T</title></topic>';
    const [id] = idsFor(src, ['title']);
    const pushes: Array<{ focusId: string | null; caretOffset: number | null }> = [];
    let applied = false;

    await applyOutputClassStyleToIds({
      document: { getText: () => src },
      applyMinimal: async () => {
        applied = true;
        return true;
      },
      pushBody: (focusId, caretOffset) => {
        pushes.push({ focusId, caretOffset });
      },
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
    }, [id], 'dc-heading-compact', ['dc-heading-gold', 'dc-heading-compact']);

    expect(applied).toBe(false);
    expect(pushes).toEqual([{ focusId: id, caretOffset: null }]);
  });

  test('converts direct cell content to the selected style target before applying outputclass', async () => {
    const src = '<table><tgroup cols="1"><tbody><row><entry>Lead text</entry></row></tbody></tgroup></table>';
    let source = src;
    let bumps = 0;
    const [entryId] = idsFor(src, ['entry']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => {
        bumps += 1;
      },
    }, [entryId], 'dc-body-lead', ['dc-body-lead'], 'body');

    expect(source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry><p outputclass="dc-body-lead">Lead text</p></entry></row></tbody></tgroup></table>',
    );
    expect(bumps).toBe(1);
  });

  test('applies list styles to the transformed list instead of the first list item', async () => {
    const src = '<body><p>Item text</p></body>';
    let source = src;
    const [paragraphId] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [paragraphId], 'dc-list-spacious', ['dc-list-spacious'], 'list');

    expect(source).toBe(`<body><ul outputclass="dc-list-spacious">
  <li>Item text</li>
</ul></body>`);
  });

  test('applies note styles to the transformed note wrapper', async () => {
    const src = '<body><p>Note text</p></body>';
    let source = src;
    const [paragraphId] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [paragraphId], 'dc-note-panel', ['dc-note-panel'], 'note');

    expect(source).toBe(`<body><note outputclass="dc-note-panel">
  <p>Note text</p>
</note></body>`);
  });

  test('converts a body paragraph to a section title for heading styles', async () => {
    const src = '<body><p>Heading text</p></body>';
    let source = src;
    let bumps = 0;
    const [paragraphId] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => {
        bumps += 1;
      },
    }, [paragraphId], 'dc-heading-gold', ['dc-heading-gold'], 'heading');

    expect(source).toBe(`<body><section>
  <title outputclass="dc-heading-gold">Heading text</title>
</section></body>`);
    expect(bumps).toBe(1);
  });

  test('converts the first paragraph in an untitled section to a heading title', async () => {
    const src = '<body><section><p>Heading text</p><p>Body text</p></section></body>';
    let source = src;
    const [paragraphId] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [paragraphId], 'dc-heading-gold', ['dc-heading-gold'], 'heading');

    expect(source).toBe(
      '<body><section><title outputclass="dc-heading-gold">Heading text</title><p>Body text</p></section></body>',
    );
  });

  test('converts an optional section title to a paragraph for body styles', async () => {
    const src = '<body><section><title outputclass="dc-heading-gold">Economy</title></section><ul><li>Next</li></ul></body>';
    let source = src;
    let bumps = 0;
    const [titleId] = idsFor(src, ['title']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => {
        bumps += 1;
      },
    }, [titleId], 'dc-body-lead', ['dc-heading-gold', 'dc-body-lead'], 'body');

    expect(source).toBe('<body><p outputclass="dc-body-lead">Economy</p><ul><li>Next</li></ul></body>');
    expect(bumps).toBe(1);
  });

  test('refuses incompatible style targets instead of applying them to the wrong element', async () => {
    const src = '<body><p>Body text</p></body>';
    let source = src;
    const announced: string[] = [];
    const errors: string[] = [];
    const pushes: Array<[string | null, number | null]> = [];
    const [paragraphId] = idsFor(src, ['p']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: (focusId, caretOffset) => {
        pushes.push([focusId, caretOffset]);
      },
      announce: (message) => announced.push(message),
      postError: (message) => errors.push(message),
      clearDiagnostics: () => undefined,
    }, [paragraphId], 'dc-table-ruled', ['dc-table-ruled'], 'table');

    expect(source).toBe(src);
    expect(announced).toEqual(['This element cannot be converted to table.']);
    expect(errors).toEqual(announced);
    expect(pushes).toEqual([]);
  });

  test('applies an ancestor tableCell style to the enclosing entry from a deep descendant', async () => {
    const src = '<table><tgroup cols="1"><tbody><row><entry><ul><li>Deep item</li></ul></entry></row></tbody></tgroup></table>';
    let source = src;
    const [liId] = idsFor(src, ['li']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [liId], 'dc-cell-shade', ['dc-cell-shade'], 'tableCell');

    expect(source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry outputclass="dc-cell-shade"><ul><li>Deep item</li></ul></entry></row></tbody></tgroup></table>',
    );
  });

  test('clears an ancestor tableCell style from the enclosing entry from a deep descendant', async () => {
    const src = '<table><tgroup cols="1"><tbody><row><entry outputclass="dc-cell-shade"><ul><li>Deep item</li></ul></entry></row></tbody></tgroup></table>';
    let source = src;
    const [liId] = idsFor(src, ['li']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [liId], '', ['dc-cell-shade'], 'tableCell');

    expect(source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry><ul><li>Deep item</li></ul></entry></row></tbody></tgroup></table>',
    );
  });

  test('applies an ancestor table style to the enclosing table from a nested cell', async () => {
    const src = '<table><tgroup cols="1"><tbody><row><entry>Cell</entry></row></tbody></tgroup></table>';
    let source = src;
    const [entryId] = idsFor(src, ['entry']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [entryId], 'dc-table-ruled', ['dc-table-ruled'], 'table');

    expect(source).toBe(
      '<table outputclass="dc-table-ruled"><tgroup cols="1"><tbody><row><entry>Cell</entry></row></tbody></tgroup></table>',
    );
  });

  test('clears an ancestor table style from the enclosing table from a nested cell', async () => {
    const src = '<table outputclass="dc-table-ruled"><tgroup cols="1"><tbody><row><entry>Cell</entry></row></tbody></tgroup></table>';
    let source = src;
    const [entryId] = idsFor(src, ['entry']);

    await applyOutputClassStyleToIds({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
      bumpStructVersion: () => undefined,
    }, [entryId], '', ['dc-table-ruled'], 'table');

    expect(source).toBe(
      '<table><tgroup cols="1"><tbody><row><entry>Cell</entry></row></tbody></tgroup></table>',
    );
  });
});
