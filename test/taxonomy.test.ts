import { describe, expect, test } from 'bun:test';
import {
  TAXONOMY_LIMITS,
  escapeJsonForHtml,
  loadTaxonomyFile,
  parseTaxonomyJson,
  type TaxonomyConfig,
} from '../src/config/taxonomy';

const VALID: TaxonomyConfig = {
  version: 1,
  fields: [
    { attribute: 'owner', label: 'Owner', input: 'text', group: 'Governance' },
    { attribute: 'count', label: 'Count', input: 'number' },
    { attribute: 'effective-date', label: 'Effective date', input: 'date' },
    {
      attribute: 'status',
      label: 'Status',
      input: 'single-select',
      options: [{ value: 'draft', label: 'Draft' }],
    },
    {
      attribute: 'cabin',
      label: 'Cabin',
      input: 'multi-select',
      options: [{ value: 'J', label: 'Business' }, { value: 'Y', label: 'Economy' }],
    },
  ],
};

function source(value: unknown = VALID): string {
  return JSON.stringify(value);
}

describe('parseTaxonomyJson', () => {
  test('normalizes the exact version 1 contract', () => {
    expect(parseTaxonomyJson(source({ ...VALID, ignored: true }))).toEqual(VALID);
  });

  test('rejects invalid roots, versions, fields, labels, inputs, and duplicates', () => {
    const cases: unknown[] = [
      null,
      [],
      {},
      { version: 2, fields: [] },
      { version: 1, fields: {} },
      { version: 1, fields: [null] },
      { version: 1, fields: [{ attribute: 'owner', label: '', input: 'text' }] },
      { version: 1, fields: [{ attribute: 'owner', label: 'Owner', input: 'unknown' }] },
      { version: 1, fields: [VALID.fields[0], { ...VALID.fields[0] }] },
    ];
    for (const value of cases) expect(() => parseTaxonomyJson(source(value))).toThrow();
  });

  test('accepts only the namespace-free ASCII NCName subset and rejects xml-reserved names', () => {
    const rejected = ['1name', 'a:b', 'a::b', 'xmlns', 'XML', 'xml-lang', 'xmlThing', 'with space', 'é'];
    for (const attribute of rejected) {
      expect(() => parseTaxonomyJson(source({
        version: 1,
        fields: [{ attribute, label: 'X', input: 'text' }],
      }))).toThrow();
    }
    expect(parseTaxonomyJson(source({
      version: 1,
      fields: [{ attribute: '_safe.name-1', label: 'Safe', input: 'text' }],
    })).fields[0].attribute).toBe('_safe.name-1');
  });

  test('requires unique non-empty select options and forbids options on non-select fields', () => {
    const cases = [
      { attribute: 'x', label: 'X', input: 'single-select' },
      { attribute: 'x', label: 'X', input: 'multi-select', options: [] },
      { attribute: 'x', label: 'X', input: 'single-select', options: [{ value: '', label: 'Empty' }] },
      { attribute: 'x', label: 'X', input: 'single-select', options: [{ value: 'a', label: '' }] },
      { attribute: 'x', label: 'X', input: 'single-select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }] },
      { attribute: 'x', label: 'X', input: 'multi-select', options: [{ value: 'has space', label: 'No' }] },
      { attribute: 'x', label: 'X', input: 'text', options: [] },
    ];
    for (const field of cases) {
      expect(() => parseTaxonomyJson(source({ version: 1, fields: [field] }))).toThrow();
    }
  });

  test('rejects isolated surrogates, XML controls, and Unicode noncharacters in every string', () => {
    const rejected = ['bad\ud800', 'bad\u0000', 'bad\u000b', 'bad\ufdd0', 'bad\ufffe', 'bad\u{1ffff}'];
    for (const label of rejected) {
      expect(() => parseTaxonomyJson(source({
        version: 1,
        fields: [{ attribute: 'x', label, input: 'text' }],
      }))).toThrow();
    }
    expect(parseTaxonomyJson(source({
      version: 1,
      fields: [{ attribute: 'x', label: 'Supplementary \u{1f642}', input: 'text' }],
    })).fields[0].label).toContain('🙂');
  });

  test('enforces byte, field, option, total-option, and string limits', () => {
    expect(() => parseTaxonomyJson(' '.repeat(TAXONOMY_LIMITS.maxBytes + 1))).toThrow();
    expect(() => parseTaxonomyJson(source({
      version: 1,
      fields: Array.from({ length: TAXONOMY_LIMITS.maxFields + 1 }, (_, index) => ({
        attribute: `f${index}`,
        label: 'F',
        input: 'text',
      })),
    }))).toThrow();
    expect(() => parseTaxonomyJson(source({
      version: 1,
      fields: [{
        attribute: 'x',
        label: 'X',
        input: 'single-select',
        options: Array.from({ length: TAXONOMY_LIMITS.maxOptionsPerField + 1 }, (_, index) => ({ value: `v${index}`, label: 'V' })),
      }],
    }))).toThrow();
    expect(() => parseTaxonomyJson(source({
      version: 1,
      fields: [{ attribute: 'x', label: 'x'.repeat(TAXONOMY_LIMITS.maxStringCodeUnits + 1), input: 'text' }],
    }))).toThrow();
  });
});

describe('loadTaxonomyFile', () => {
  test('strictly decodes and returns a valid file', async () => {
    const result = await loadTaxonomyFile({
      configuredPath: 'config/taxonomy.json',
      uri: { toString: () => 'file:///config/taxonomy.json' } as never,
      readFile: async () => new TextEncoder().encode(source()),
      log: () => { throw new Error('valid input must not log'); },
    });
    expect(result).toEqual(VALID);
  });

  test('logs exactly once and rejects read, UTF-8, size, JSON, and schema failures', async () => {
    const readers = [
      async () => { throw new Error('read failed'); },
      async () => Uint8Array.from([0xc3, 0x28]),
      async () => new Uint8Array(TAXONOMY_LIMITS.maxBytes + 1),
      async () => new TextEncoder().encode('{'),
      async () => new TextEncoder().encode(source({ version: 2, fields: [] })),
    ];
    for (const readFile of readers) {
      const logs: string[] = [];
      expect(await loadTaxonomyFile({
        configuredPath: 'config/taxonomy.json',
        uri: {} as never,
        readFile,
        log: (message) => logs.push(message),
      })).toBeNull();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toStartWith('[taxonomy] config/taxonomy.json: ');
    }
  });

  test('empty configuration bypasses reads and logs', async () => {
    let reads = 0;
    const logs: string[] = [];
    expect(await loadTaxonomyFile({
      configuredPath: '',
      uri: {} as never,
      readFile: async () => { reads++; return new Uint8Array(); },
      log: (message) => logs.push(message),
    })).toBeNull();
    expect(reads).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe('escapeJsonForHtml', () => {
  test('round-trips hostile strings without literal HTML-significant code points', () => {
    const hostile: TaxonomyConfig = {
      version: 1,
      fields: [{ attribute: 'x', label: '</ScRiPt><img onerror=x>&\u2028\u2029', input: 'text' }],
    };
    const escaped = escapeJsonForHtml(hostile);
    expect(escaped).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(JSON.parse(escaped)).toEqual(hostile);
    expect(escapeJsonForHtml(null)).toBe('null');
  });
});
