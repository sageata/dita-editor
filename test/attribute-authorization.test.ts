import { describe, expect, test } from 'bun:test';
import {
  authorizeAttributeMessage,
  type AttributeAuthorizationResult,
} from '../src/host/attribute-authorization';
import type { TaxonomyConfig } from '../src/config/taxonomy';
import type { AuthorStyleDefinition } from '../src/styles/author-styles';
import { applyElementAttribute } from '../src/host/attribute-actions';
import { parse } from '../src/cst/parse';
import { withoutNativeContextTransportMetadata } from '../src/host/native-context-routing';

const SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="root" legacy="old" cabin="Y legacy-cabin">
  <title>Title</title>
  <body>
    <p outputclass="keep dc-body">Text</p>
    <table frame="all"><tgroup cols="1"><tbody><row><entry>Cell</entry></row></tbody></tgroup></table>
  </body>
</topic>`;

const TAXONOMY: TaxonomyConfig = {
  version: 1,
  fields: [
    { attribute: 'cabin', label: 'Cabin', input: 'multi-select', options: [
      { value: 'Y', label: 'Economy' },
      { value: 'J', label: 'Business' },
    ] },
    { attribute: 'effective-date', label: 'Effective date', input: 'date' },
    { attribute: 'sequence', label: 'Sequence', input: 'number' },
    { attribute: 'owner', label: 'Owner', input: 'text' },
  ],
};

const STYLES: AuthorStyleDefinition[] = [
  { className: 'dc-default-body', name: 'Base body', target: 'body', isDefault: true },
  { className: 'dc-body', name: 'Body', target: 'body' },
  { className: 'dc-table', name: 'Table', target: 'table' },
  { className: 'dc-row-highlight', name: 'Row highlight', target: 'tableRow' },
];

function authorize(message: Record<string, unknown>): AttributeAuthorizationResult {
  return authorizeAttributeMessage({
    source: SOURCE,
    message: { baseStructVersion: 0, ...message },
    taxonomy: TAXONOMY,
    styles: STYLES,
    structVersion: 0,
  });
}

function accepted(message: Record<string, unknown>) {
  const result = authorize(message);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
}

function refused(message: Record<string, unknown>) {
  const result = authorize(message);
  expect(result.ok).toBe(false);
}

describe('attribute authorization', () => {
  test('accepts a native CALS payload after verified transport metadata is removed', () => {
    const message = withoutNativeContextTransportMetadata({
      type: 'setCalsAttr',
      id: 'e4',
      attrName: 'frame',
      attrValue: 'sides',
      baseStructVersion: 0,
      nativeContextSession: 'session-a',
    });
    const result = authorizeAttributeMessage({
      source: SOURCE,
      message,
      taxonomy: TAXONOMY,
      styles: STYLES,
      structVersion: 0,
    });
    expect(result).toEqual({
      ok: true,
      action: { kind: 'element', ids: ['e4'], attrName: 'frame', attrValue: 'sides' },
    });
  });

  test('permits current-root taxonomy edits and preserves removable legacy multi-select tokens', () => {
    expect(accepted({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'cabin', attrValue: 'J legacy-cabin' })).toEqual({
      kind: 'element', ids: ['e0'], attrName: 'cabin', attrValue: 'J legacy-cabin',
    });
    expect(accepted({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'owner', attrValue: 'A😀' }).kind).toBe('element');
    expect(accepted({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'effective-date', attrValue: '2026-07-10' }).kind).toBe('element');
    expect(accepted({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'sequence', attrValue: '12.5' }).kind).toBe('element');
  });

  test('valid supplementary Unicode survives authorized apply and reparse', async () => {
    const action = accepted({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'owner', attrValue: 'A😀' });
    if (action.kind !== 'element') throw new Error('expected element action');
    let source = SOURCE;
    await applyElementAttribute({
      document: { getText: () => source },
      applyMinimal: async (next) => {
        source = next;
        return true;
      },
      pushBody: () => undefined,
      announce: () => undefined,
      postError: () => undefined,
      clearDiagnostics: () => undefined,
    }, action.ids[0], action.attrName, action.attrValue);
    expect(() => parse(source)).not.toThrow();
    expect(source).toContain('owner="A😀"');
  });

  test('refuses taxonomy cross-family names, wrong targets, invalid values, and new unknown tokens', () => {
    refused({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'legacy', attrValue: 'x' });
    refused({ type: 'setTaxonomyAttr', id: 'e1', attrName: 'owner', attrValue: 'x' });
    refused({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'cabin', attrValue: 'Y forged' });
    refused({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'effective-date', attrValue: '2026-02-31' });
    refused({ type: 'setTaxonomyAttr', id: 'e0', attrName: 'sequence', attrValue: 'NaN' });
    refused({ type: 'setTaxonomyAttr', id: 'e0', ids: ['e0'], attrName: 'owner', attrValue: 'x' });
  });

  test('edits only an existing non-taxonomy root property and never creates an absent one', () => {
    expect(accepted({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'legacy', attrValue: 'new' })).toEqual({
      kind: 'element', ids: ['e0'], attrName: 'legacy', attrValue: 'new',
    });
    refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'absent', attrValue: 'new' });
    refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'cabin', attrValue: 'J' });
    refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'xmlns', attrValue: 'x' });
    refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'xmlThing', attrValue: 'x' });
    refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'a:b', attrValue: 'x' });
  });

  test('enforces the CALS target/name/value matrix for single and multi actions', () => {
    expect(accepted({ type: 'setCalsAttr', id: 'e4', attrName: 'frame', attrValue: 'sides' }).kind).toBe('element');
    expect(accepted({ type: 'setCalsAttr', id: 'e7', attrName: 'rowsep', attrValue: '1' }).kind).toBe('element');
    expect(accepted({ type: 'setCalsAttrMulti', ids: ['e8'], attrName: 'align', attrValue: 'center' }).kind).toBe('element');
    refused({ type: 'setCalsAttr', id: 'e3', attrName: 'frame', attrValue: 'all' });
    refused({ type: 'setCalsAttr', id: 'e7', attrName: 'frame', attrValue: 'all' });
    refused({ type: 'setCalsAttr', id: 'e8', attrName: 'align', attrValue: 'evil' });
    refused({ type: 'setCalsAttrMulti', ids: ['e7', 'e8'], attrName: 'rowsep', attrValue: '1' });
  });

  test('allows only the closed tgroup operation reached through a real table', () => {
    expect(accepted({
      type: 'setTgroupAttr', id: 'e4',
      attrs: [{ name: 'colsep', value: '1' }, { name: 'rowsep', value: '' }],
    }).kind).toBe('tgroup');
    refused({ type: 'setTgroupAttr', id: 'e4', attrs: [{ name: 'frame', value: 'all' }] });
    refused({ type: 'setTgroupAttr', id: 'e3', attrs: [{ name: 'colsep', value: '1' }] });
    refused({ type: 'setTgroupAttr', id: 'e4', attrs: [{ name: 'colsep', value: '2' }] });
    refused({ type: 'setTgroupAttr', id: 'e4', attrs: [{ name: 'colsep', value: '1', attrName: 'frame' }] });
  });

  test('derives style target and managed classes from the current inspected styles', () => {
    expect(accepted({ type: 'applyStyle', ids: ['e3'], className: 'dc-body' })).toEqual({
      kind: 'style', ids: ['e3'], className: 'dc-body', styleTarget: 'body',
      managedClassNames: ['dc-body', 'dc-table', 'dc-row-highlight'],
    });
    expect(accepted({ type: 'clearStyle', ids: ['e3'], styleTarget: 'body' })).toEqual({
      kind: 'style', ids: ['e3'], className: '', styleTarget: 'body', managedClassNames: ['dc-body'],
    });
    refused({ type: 'applyStyle', ids: ['e3'], className: 'dc-missing' });
    refused({ type: 'applyStyle', ids: ['e3'], className: 'dc-default-body' });
    refused({ type: 'applyStyle', ids: ['e3'], className: 'dc-body', styleTarget: 'table' });
    refused({ type: 'applyStyle', ids: ['e3'], className: 'dc-body', managedClassNames: ['keep'] });
    refused({ type: 'clearStyle', ids: ['e3'], styleTarget: 'table' });
  });

  test('derives shade target, label, and removable set from real row/entry targets', () => {
    expect(accepted({ type: 'applyShade', ids: ['e8'], color: '#eff1f3', sourceHash: 'abc', targetToken: 'def' })).toEqual({
      kind: 'shade', ids: ['e8'], color: '#eff1f3', styleTarget: 'tableCell',
      label: 'Neutral', managedClassNames: ['dc-cell-shaded', 'dc-row-highlight'],
    });
    expect(accepted({ type: 'clearShade', ids: ['e7'], sourceHash: 'abc', targetToken: 'def' })).toMatchObject({
      kind: 'shade', ids: ['e7'], color: '', styleTarget: 'tableRow', label: 'Shaded row',
    });
    refused({ type: 'applyShade', ids: ['e7', 'e8'], color: '#eff1f3' });
    refused({ type: 'applyShade', ids: ['e3'], color: '#eff1f3' });
    refused({ type: 'applyShade', ids: ['e8'], color: '#EFF1F3' });
    refused({ type: 'applyShade', ids: ['e8'], color: '#eff1f3', label: 'Forged' });
    refused({ type: 'applyShade', ids: ['e8'], color: '#eff1f3', className: 'forged' });
    refused({ type: 'applyShade', ids: ['e8'], color: '#eff1f3', attrName: 'frame' });
    refused({ type: 'clearShade', ids: ['e8'], color: '#eff1f3' });
  });

  test('rejects forbidden XML strings and stale ids before any action is returned', () => {
    for (const bad of ['\0', '\u0001', '\ud800', '\ufdd0', '\ufffe']) {
      refused({ type: 'setExistingPropertyAttr', id: 'e0', attrName: 'legacy', attrValue: bad });
    }
    refused({ type: 'setCalsAttr', id: 'e999', attrName: 'frame', attrValue: 'all' });
    refused({ type: 'applyStyle', ids: ['e3\0'], className: 'dc-body' });
  });

  test('rejects a recycled same-kind positional id from an older render generation', () => {
    const result = authorizeAttributeMessage({
      source: SOURCE.replace('<row><entry>Cell</entry></row>', '<row><entry>Replacement</entry></row>'),
      message: {
        type: 'setCalsAttr', id: 'e7', attrName: 'rowsep', attrValue: '1', baseStructVersion: 4,
      },
      taxonomy: TAXONOMY,
      styles: STYLES,
      structVersion: 5,
    });
    expect(result).toEqual({ ok: false, reason: 'The attribute request was created from a stale render.' });
  });
});
