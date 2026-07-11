import { describe, expect, test } from 'bun:test';
import {
  MANAGED_STYLES_END,
  MANAGED_STYLES_START,
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
} from '../src/host/managed-author-stylesheet';
import {
  DEFAULT_AUTHOR_STYLES,
  serializeAuthorStyles,
  type AuthorStyleDefinition,
} from '../src/styles/author-styles';

const CUSTOM_STYLE: AuthorStyleDefinition = {
  className: 'dc-cabin-lead',
  name: 'Cabin lead',
  target: 'heading',
  color: '#123456',
};

function marked(body: string, delimiter = '\n', prefix = '', suffix = ''): string {
  return `${prefix}${MANAGED_STYLES_START}${delimiter}${body}${MANAGED_STYLES_END}${suffix}`;
}

describe('inspectManagedAuthorStylesheet', () => {
  test('missing source renders built-in neutral styles and remains writable', () => {
    const inspection = inspectManagedAuthorStylesheet(null);

    expect(inspection.kind).toBe('missing');
    expect(inspection.styles).toEqual(DEFAULT_AUTHOR_STYLES);
    expect(inspection.sourceText).toBe('');
    expect(inspection.renderCssText).toBe(serializeAuthorStyles(DEFAULT_AUTHOR_STYLES));
    expect(inspection.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inspection.writable).toBe(true);
    expect(inspection.error).toBeUndefined();
  });

  test('a canonical marked source renders complete bytes and merges shipped base styles only after validation', () => {
    const body = serializeAuthorStyles([CUSTOM_STYLE]);
    const source = marked(body, '\r\n', '\ufeff/* developer prefix */\r\n', '\r\n/* suffix */\r\n');

    const inspection = inspectManagedAuthorStylesheet(source);

    expect(inspection.kind).toBe('marked');
    expect(inspection.styles.find((style) => style.className === CUSTOM_STYLE.className)).toEqual(CUSTOM_STYLE);
    expect(inspection.styles.some((style) => style.className === 'dc-default-tableHeadCell')).toBe(true);
    expect(inspection.sourceText).toBe(source);
    expect(inspection.renderCssText).toBe(source);
    expect(inspection.writable).toBe(true);
    expect(inspection.error).toBeUndefined();
  });

  test('an unmarked canonical legacy stylesheet remains visible and writable for migration', () => {
    const source = serializeAuthorStyles([CUSTOM_STYLE]);

    const inspection = inspectManagedAuthorStylesheet(source);

    expect(inspection.kind).toBe('legacy-canonical');
    expect(inspection.styles.find((style) => style.className === CUSTOM_STYLE.className)).toEqual(CUSTOM_STYLE);
    expect(inspection.sourceText).toBe(source);
    expect(inspection.renderCssText).toBe(source);
    expect(inspection.writable).toBe(true);
  });

  test('legacy metadata written before slash escaping remains readable and migratable', () => {
    const style = { ...CUSTOM_STYLE, name: 'Cabin / lead' };
    const source = serializeAuthorStyles([style])
      .split('\n')
      .map((line) => line.startsWith('/* DITAEDITOR_AUTHOR_STYLE ') ? line.replace(/\\\//g, '/') : line)
      .join('\n');

    const inspection = inspectManagedAuthorStylesheet(source);

    expect(inspection.kind).toBe('legacy-canonical');
    expect(inspection.styles.find((entry) => entry.className === style.className)?.name).toBe(style.name);
    expect(inspection.renderCssText).toBe(source);
    expect(inspection.writable).toBe(true);
  });

  test('refuses malformed, unknown, duplicated, incomplete, reversed, and unmarked noncanonical content', () => {
    const body = serializeAuthorStyles([CUSTOM_STYLE]);
    const cases = [
      marked(`${body}/* unknown */\n`),
      marked(body.replace('DITAEDITOR_AUTHOR_STYLE {', 'DITAEDITOR_AUTHOR_STYLE {broken')),
      `${MANAGED_STYLES_START}\n${body}${MANAGED_STYLES_START}\n${body}${MANAGED_STYLES_END}`,
      `${MANAGED_STYLES_START}\n${body}`,
      `${MANAGED_STYLES_END}${MANAGED_STYLES_START}\n${body}`,
      `/* developer CSS */\n${body}`,
      '',
    ];

    for (const source of cases) {
      const inspection = inspectManagedAuthorStylesheet(source);
      expect(inspection.kind).toBe('refused');
      expect(inspection.sourceText).toBe(source);
      expect(inspection.renderCssText).toBe(source);
      expect(inspection.writable).toBe(false);
      expect(inspection.error?.length).toBeGreaterThan(20);
    }
  });
});

describe('planManagedAuthorStylesheetWrite', () => {
  test('a missing file creates one canonical LF-delimited managed region', () => {
    const body = serializeAuthorStyles([CUSTOM_STYLE]);

    const plan = planManagedAuthorStylesheetWrite(null, [CUSTOM_STYLE]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.expectedSourceHash).toBeNull();
    expect(plan.startOffset).toBe(MANAGED_STYLES_START.length + 1);
    expect(plan.endOffset).toBe(plan.startOffset + body.length);
    expect(plan.replacement).toBe(body);
    expect(plan.resultingText).toBe(`${MANAGED_STYLES_START}\n${body}${MANAGED_STYLES_END}`);
    expect(plan.migrated).toBe(false);
    expect(plan.create).toBe(true);
  });

  test('marked replacement preserves every byte outside the body including BOM and CRLF', () => {
    const oldBody = serializeAuthorStyles([CUSTOM_STYLE]);
    const prefix = '\ufeff/* developer prefix */\r\n';
    const suffix = '\r\n/* developer suffix */\r\n';
    const source = marked(oldBody, '\r\n', prefix, suffix);
    const nextStyle = { ...CUSTOM_STYLE, name: 'Updated cabin lead' };
    const replacement = serializeAuthorStyles([nextStyle]);

    const plan = planManagedAuthorStylesheetWrite(source, [nextStyle]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const expectedStart = prefix.length + MANAGED_STYLES_START.length + 2;
    expect(plan.startOffset).toBe(expectedStart);
    expect(plan.endOffset).toBe(expectedStart + oldBody.length);
    expect(plan.replacement).toBe(replacement);
    expect(plan.resultingText.slice(0, plan.startOffset)).toBe(source.slice(0, plan.startOffset));
    expect(plan.resultingText.slice(plan.startOffset + replacement.length)).toBe(source.slice(plan.endOffset));
    expect(plan.resultingText).toBe(source.slice(0, plan.startOffset) + replacement + source.slice(plan.endOffset));
    expect(plan.expectedSourceHash).toBe(inspectManagedAuthorStylesheet(source).sourceHash);
    expect(plan.migrated).toBe(false);
    expect(plan.create).toBe(false);
  });

  test('a canonical legacy file migrates to the safe marked layout on its next write', () => {
    const legacy = serializeAuthorStyles([{ ...CUSTOM_STYLE, name: 'Cabin / lead' }])
      .split('\n')
      .map((line) => line.startsWith('/* DITAEDITOR_AUTHOR_STYLE ') ? line.replace(/\\\//g, '/') : line)
      .join('\n');

    const plan = planManagedAuthorStylesheetWrite(legacy, [CUSTOM_STYLE]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.expectedSourceHash).toBe(inspectManagedAuthorStylesheet(legacy).sourceHash);
    expect(plan.startOffset).toBe(0);
    expect(plan.endOffset).toBe(legacy.length);
    expect(plan.replacement).toBe(plan.resultingText);
    expect(plan.resultingText).toBe(marked(serializeAuthorStyles([CUSTOM_STYLE])));
    expect(plan.migrated).toBe(true);
    expect(plan.create).toBe(false);
  });

  test('strict payload validation refuses the whole write instead of dropping or altering entries', () => {
    const invalidPayloads: unknown[] = [
      null,
      {},
      [null],
      [{ className: 'dc-one', target: 'body' }],
      [{ ...CUSTOM_STYLE, extra: 'not-authoritative' }],
      [{ ...CUSTOM_STYLE, name: ` ${CUSTOM_STYLE.name}` }],
      [{ ...CUSTOM_STYLE, color: '' }],
      [{ ...CUSTOM_STYLE, color: 42 }],
      [{ ...CUSTOM_STYLE, name: `Cabin \ud800` }],
      [{ ...CUSTOM_STYLE, color: `#123456\udc00` }],
      [CUSTOM_STYLE, { ...CUSTOM_STYLE }],
      [{ className: 'dc-default-heading', name: 'Base heading', target: 'heading', isDefault: true }],
      [new (class Style { className = 'dc-one'; name = 'One'; target = 'body'; })()],
    ];

    for (const payload of invalidPayloads) {
      const plan = planManagedAuthorStylesheetWrite(null, payload);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason.length).toBeGreaterThan(10);
    }
    expect(planManagedAuthorStylesheetWrite(null, []).ok).toBe(true);
    expect(planManagedAuthorStylesheetWrite(null, [{ ...CUSTOM_STYLE, name: 'Cabin 👩‍✈️' }]).ok).toBe(true);
  });

  test('adversarial names round-trip through create, inspect, save, and rendered CSS', () => {
    const name = 'Cabin */ /* DITAEDITOR_MANAGED_STYLES_START */\r\n' +
      '/* DITAEDITOR_MANAGED_STYLES_END */ / \\ \' " .fake { color: red; }';
    const style = { ...CUSTOM_STYLE, name };

    const created = planManagedAuthorStylesheetWrite(null, [style]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.resultingText.match(new RegExp(MANAGED_STYLES_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(1);
    expect(created.resultingText.match(new RegExp(MANAGED_STYLES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(1);
    expect(created.resultingText).not.toContain(`"name":"${name}`);

    const inspection = inspectManagedAuthorStylesheet(created.resultingText);
    expect(inspection.kind).toBe('marked');
    expect(inspection.styles.find((entry) => entry.className === style.className)?.name).toBe(name);
    expect(inspection.renderCssText).toBe(created.resultingText);

    const saved = planManagedAuthorStylesheetWrite(created.resultingText, inspection.styles);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(inspectManagedAuthorStylesheet(saved.resultingText).styles
      .find((entry) => entry.className === style.className)?.name).toBe(name);
  });
});
