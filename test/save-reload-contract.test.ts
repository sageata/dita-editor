import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { assignElementIds } from '../src/cst/element-ids';
import { minimalEdit } from '../src/cst/edit-bridge';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { applyTransform } from '../src/cst/structural';
import type { ElementNode } from '../src/cst/types';
import { renderEditable } from '../src/render/to-html';

function idOf(source: string, name: string, text?: string): string {
  const doc = parse(source);
  for (const [el, id] of assignElementIds(doc)) {
    if (el.name !== name) continue;
    if (text !== undefined && innerText(el) !== text) continue;
    return id;
  }
  throw new Error(`no <${name}>${text !== undefined ? ` "${text}"` : ''}`);
}

function innerText(el: ElementNode): string {
  return el.children.map((child) => ('raw' in child ? child.raw : '')).join('').trim();
}

function applyProviderStyleSave(previous: string, next: string): string {
  const span = minimalEdit(previous, next);
  if (!span) return previous;
  return previous.slice(0, span.start) + span.text + previous.slice(span.end);
}

describe('visual save/reload contract', () => {
  test('entry transform bytes survive minimal save, parse/serialize reload, and editable rerender', () => {
    const original =
      '<topic id="t"><title>T</title><body>' +
      '<table><tgroup cols="1"><tbody><row><entry>Step one</entry></row></tbody></tgroup></table>' +
      '</body></topic>';
    const transformed = applyTransform(original, {
      transform: 'entryToOrderedList',
      entryId: idOf(original, 'entry', 'Step one'),
      wrapperKind: 'ol',
    }).source;

    const saved = applyProviderStyleSave(original, transformed);

    expect(saved).toBe(transformed);
    expect(serialize(parse(saved))).toBe(saved);
    const htmlAfterReload = renderEditable(parse(saved));
    expect(htmlAfterReload).toContain('<ol class="ol"');
    expect(htmlAfterReload).toContain('<li class="li" contenteditable="true"');
  });

  test('provider source still writes visual changes through VS Code WorkspaceEdit', () => {
    const source = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');

    expect(source).toContain('const span = minimalEdit(previousSource, newSource);');
    expect(source).toContain('const edit = new vscode.WorkspaceEdit();');
    expect(source).toContain('edit.replace(');
    expect(source).toContain('const ok = await vscode.workspace.applyEdit(edit);');
    expect(source).toContain('vscode.workspace.onDidChangeTextDocument');
    expect(source).toContain('this.host.scheduleStatusRefresh();');
  });
});
