import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assignElementIds } from '../src/cst/element-ids';
import { parse } from '../src/cst/parse';
import { isElement, type ElementNode } from '../src/cst/types';
import { authorizeAttributeMessage } from '../src/host/attribute-authorization';
import {
  applyHorizontalAlignmentToIds,
  type HorizontalAlignment,
} from '../src/host/horizontal-alignment-actions';
import type { AttributeActionContext } from '../src/host/attribute-actions';

const PROVIDER_SOURCE = readFileSync(new URL('../src/host/visual-editor-provider.ts', import.meta.url), 'utf8');

const SOURCE = `<topic id="t">
  <title outputclass="title-keep">Topic title</title>
  <shortdesc>Short description</shortdesc>
  <body>
    <p outputclass="keep ditaeditor-align-left ditaeditor-align-justify">Paragraph</p>
    <ul><li>List item</li></ul>
    <note>Direct <b>rich</b> note</note>
    <note><p>Block note paragraph</p></note>
    <codeblock>Code</codeblock>
    <lines>Lines</lines>
    <cmd>Command</cmd>
    <section><title>Section title</title></section>
    <table><tgroup cols="1"><tbody><row><entry align="right">Cell</entry></row></tbody></tgroup></table>
    <image href="image.png" placement="inline" align="right"/>
  </body>
</topic>`;

function textOf(element: ElementNode): string {
  return element.children.map((child) => (
    child.type === 'text' ? child.newText ?? child.raw : isElement(child) ? textOf(child) : ''
  )).join('');
}

function idsFor(source: string, name: string): string[] {
  const doc = parse(source);
  return [...assignElementIds(doc)]
    .filter(([element]) => element.name === name)
    .map(([, id]) => id);
}

function idForText(source: string, name: string, text: string): string {
  const doc = parse(source);
  for (const [element, id] of assignElementIds(doc)) {
    if (element.name === name && textOf(element).includes(text)) return id;
  }
  throw new Error(`No <${name}> containing ${text}`);
}

function authorize(source: string, message: Record<string, unknown>, structVersion = 3) {
  return authorizeAttributeMessage({
    source,
    message: { baseStructVersion: structVersion, ...message },
    taxonomy: null,
    styles: [],
    structVersion,
  });
}

function makeContext(initialSource = SOURCE) {
  let source = initialSource;
  const applied: string[] = [];
  const pushed: Array<[string | null, number | null]> = [];
  const announced: string[] = [];
  const errors: string[] = [];
  let cleared = 0;
  const ctx: AttributeActionContext = {
    document: { getText: () => source },
    async applyMinimal(next) {
      applied.push(next);
      source = next;
      return true;
    },
    pushBody(focusId, caretOffset) {
      pushed.push([focusId, caretOffset]);
    },
    announce(message) {
      announced.push(message);
    },
    postError(message) {
      errors.push(message);
    },
    clearDiagnostics() {
      cleared += 1;
    },
  };
  return {
    ctx,
    applied,
    pushed,
    announced,
    errors,
    get source() { return source; },
    get cleared() { return cleared; },
  };
}

describe('horizontal alignment authorization', () => {
  test('accepts every eligible content kind, native target, and whole-editable note', () => {
    const eligibleIds = [
      ...idsFor(SOURCE, 'title'),
      ...idsFor(SOURCE, 'shortdesc'),
      ...idsFor(SOURCE, 'p'),
      ...idsFor(SOURCE, 'li'),
      idForText(SOURCE, 'note', 'Direct rich note'),
      ...idsFor(SOURCE, 'codeblock'),
      ...idsFor(SOURCE, 'lines'),
      ...idsFor(SOURCE, 'cmd'),
      ...idsFor(SOURCE, 'entry'),
      ...idsFor(SOURCE, 'image'),
    ];
    const result = authorize(SOURCE, {
      type: 'setHorizontalAlign', ids: eligibleIds, align: 'center',
    });

    expect(result).toEqual({
      ok: true,
      action: { kind: 'horizontalAlign', ids: eligibleIds, align: 'center' },
    });
  });

  test('rejects mixed/block notes, containers, stale/duplicate targets, bad values, and forged fields', () => {
    const paragraph = idForText(SOURCE, 'p', 'Paragraph');
    const blockNote = idForText(SOURCE, 'note', 'Block note paragraph');
    const section = idsFor(SOURCE, 'section')[0];
    const image = idsFor(SOURCE, 'image')[0];
    const refused = [
      { type: 'setHorizontalAlign', ids: [blockNote], align: 'left' },
      { type: 'setHorizontalAlign', ids: [section], align: 'left' },
      { type: 'setHorizontalAlign', ids: [paragraph, section], align: 'left' },
      { type: 'setHorizontalAlign', ids: ['e999'], align: 'left' },
      { type: 'setHorizontalAlign', ids: [paragraph, paragraph], align: 'left' },
      { type: 'setHorizontalAlign', ids: [image], align: 'justify' },
      { type: 'setHorizontalAlign', ids: [paragraph], align: 'evil' },
      { type: 'setHorizontalAlign', ids: [], align: 'left' },
      { type: 'setHorizontalAlign', ids: [paragraph], align: 'left', attrName: 'outputclass' },
    ];
    for (const message of refused) expect(authorize(SOURCE, message).ok).toBe(false);

    expect(authorize(SOURCE, {
      type: 'setHorizontalAlign', ids: [paragraph], align: 'left', baseStructVersion: 2,
    }).ok).toBe(false);
  });
});

describe('horizontal alignment provider contract', () => {
  test('refuses the legacy unversioned image message and resyncs instead of mutating', () => {
    const refusalStart = PROVIDER_SOURCE.indexOf("if (msg && msg.type === 'setImageAlign')");
    const authorizedStart = PROVIDER_SOURCE.indexOf('if (msg && isAuthorizedAttributeMessageType', refusalStart);
    const refusal = PROVIDER_SOURCE.slice(refusalStart, authorizedStart);

    expect(refusalStart).toBeGreaterThan(-1);
    expect(refusal).toContain('refuseAttributeMessage(msg.type, reason)');
    expect(refusal).toContain('pushBody(null, null)');
    expect(PROVIDER_SOURCE).not.toContain('.then(() => applyImageAlignment(');
  });
});

describe('horizontal alignment persistence', () => {
  test('applies heterogeneous content, cell, and image alignment in one write', async () => {
    const fixture = makeContext();
    const paragraph = idForText(SOURCE, 'p', 'Paragraph');
    const entry = idsFor(SOURCE, 'entry')[0];
    const image = idsFor(SOURCE, 'image')[0];

    await applyHorizontalAlignmentToIds(fixture.ctx, [paragraph, entry, image], 'center');

    expect(fixture.applied).toHaveLength(1);
    expect(fixture.source).toContain('<p outputclass="keep ditaeditor-align-center">Paragraph</p>');
    expect(fixture.source).toContain('<entry align="center">Cell</entry>');
    expect(fixture.source).toContain('<image href="image.png" placement="break" align="center"/>');
    expect(() => parse(fixture.source)).not.toThrow();
    expect(fixture.cleared).toBe(1);
    expect(fixture.pushed).toEqual([[null, null]]);
  });

  test('Default removes only managed/native alignment and preserves image placement', async () => {
    const fixture = makeContext();
    const paragraph = idForText(SOURCE, 'p', 'Paragraph');
    const entry = idsFor(SOURCE, 'entry')[0];
    const image = idsFor(SOURCE, 'image')[0];

    await applyHorizontalAlignmentToIds(fixture.ctx, [paragraph, entry, image], '');

    expect(fixture.applied).toHaveLength(1);
    expect(fixture.source).toContain('<p outputclass="keep">Paragraph</p>');
    expect(fixture.source).toContain('<entry>Cell</entry>');
    expect(fixture.source).toContain('<image href="image.png" placement="inline"/>');
    expect(() => parse(fixture.source)).not.toThrow();
  });

  test('reapplying image alignment repairs inline placement', async () => {
    const fixture = makeContext();
    const image = idsFor(SOURCE, 'image')[0];

    await applyHorizontalAlignmentToIds(fixture.ctx, [image], 'right');

    expect(fixture.applied).toHaveLength(1);
    expect(fixture.source).toContain('<image href="image.png" placement="break" align="right"/>');
  });

  test('defensive execution validation prevents partial writes', async () => {
    const fixture = makeContext();
    const paragraph = idForText(SOURCE, 'p', 'Paragraph');
    const section = idsFor(SOURCE, 'section')[0];

    await applyHorizontalAlignmentToIds(fixture.ctx, [paragraph, section], 'right');

    expect(fixture.applied).toEqual([]);
    expect(fixture.source).toBe(SOURCE);
    expect(fixture.errors).toEqual(['Horizontal alignment is not supported for one or more selected elements.']);
    expect(fixture.pushed).toEqual([[null, null]]);
  });

  test('rejects image justify and duplicate/stale ids without writing', async () => {
    const image = idsFor(SOURCE, 'image')[0];
    const cases: Array<{ ids: string[]; align: HorizontalAlignment }> = [
      { ids: [image], align: 'justify' },
      { ids: [image, image], align: 'left' },
      { ids: ['e999'], align: 'left' },
    ];
    for (const candidate of cases) {
      const fixture = makeContext();
      await applyHorizontalAlignmentToIds(fixture.ctx, candidate.ids, candidate.align);
      expect(fixture.applied).toEqual([]);
      expect(fixture.source).toBe(SOURCE);
      expect(fixture.errors).toHaveLength(1);
    }
  });
});
