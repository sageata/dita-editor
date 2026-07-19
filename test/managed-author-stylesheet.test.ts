import { describe, expect, test } from 'bun:test';
import {
  AUTHOR_STYLESHEET_PREAMBLE,
  MANAGED_STYLES_END,
  MANAGED_STYLES_START,
  MANAGED_STYLES_VERSION,
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
} from '../src/host/managed-author-stylesheet';
import {
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

function versioned(body: string, delimiter = '\n'): string {
  return `${MANAGED_STYLES_VERSION}${delimiter}${body}`;
}

describe('inspectManagedAuthorStylesheet', () => {
  test('missing source has no author styles and remains initializable', () => {
    const inspection = inspectManagedAuthorStylesheet(null);

    expect(inspection.kind).toBe('missing');
    expect(inspection.styles).toEqual([]);
    expect(inspection.sourceText).toBe('');
    expect(inspection.renderCssText).toBe('');
    expect(inspection.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inspection.writable).toBe(true);
    expect(inspection.error).toBeUndefined();
  });

  test('a canonical marked source renders only its project-owned definitions', () => {
    const body = serializeAuthorStyles([CUSTOM_STYLE]);
    const source = marked(versioned(body, '\r\n'), '\r\n', '\ufeff/* developer prefix */\r\n', '\r\n/* suffix */\r\n');

    const inspection = inspectManagedAuthorStylesheet(source);

    expect(inspection.kind).toBe('marked');
    expect(inspection.styles).toEqual([CUSTOM_STYLE]);
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

  test('a versionless marked region with legacy table output remains writable for migration', () => {
    const tableStyle: AuthorStyleDefinition = {
      className: 'dc-table-ruled',
      name: 'Ruled table',
      target: 'table',
      borderColor: '#b40404',
      borderWidth: '5px',
    };
    const structuralBlock =
      '/* DITAEDITOR_AUTHOR_STYLE {"className":"dc-default-table-singleCol","name":"Single-column table","target":"table","isDefault":true,"structuralVariant":"singleCol","width":"100%"} */\n' +
      'body.ditaeditor-canvas table.table colgroup col:where(:only-child),\n' +
      'table.table colgroup col:where(:only-child) {\n  width: 100%;\n}\n\n';
    const legacyBody = serializeAuthorStyles([tableStyle])
      .replace('  border-collapse: separate;\n  border-spacing: 0;\n', '')
      .replace(
        '  border-top: 5px solid #b40404;\n  border-bottom: 1px solid #b40404;\n}',
        '  border-top: 5px solid #b40404;\n  border-bottom: 1px solid #b40404;\n  border-collapse: collapse;\n}',
      )
      .replace('/* DITAEDITOR_AUTHOR_STYLE ', structuralBlock + '/* DITAEDITOR_AUTHOR_STYLE ');
    const source = marked(legacyBody);

    const inspection = inspectManagedAuthorStylesheet(source);
    expect(inspection.kind).toBe('legacy-marked');
    expect(inspection.styles).toEqual([tableStyle]);
    expect(inspection.writable).toBe(true);

    const plan = planManagedAuthorStylesheetWrite(source, inspection.styles);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.migrated).toBe(true);
    expect(plan.resultingText).toContain(MANAGED_STYLES_VERSION);
    expect(plan.resultingText).toContain('border-collapse: separate;');
    expect(plan.resultingText).not.toContain('dc-default-table-singleCol');
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
    const body = versioned(serializeAuthorStyles([CUSTOM_STYLE]));

    const plan = planManagedAuthorStylesheetWrite(null, [CUSTOM_STYLE]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.expectedSourceHash).toBeNull();
    expect(plan.startOffset).toBe(AUTHOR_STYLESHEET_PREAMBLE.length + MANAGED_STYLES_START.length + 1);
    expect(plan.endOffset).toBe(plan.startOffset + body.length);
    expect(plan.replacement).toBe(body);
    expect(plan.resultingText).toBe(
      `${AUTHOR_STYLESHEET_PREAMBLE}${MANAGED_STYLES_START}\n${body}${MANAGED_STYLES_END}`,
    );
    expect(plan.resultingText).toContain('project @import rules');
    expect(plan.resultingText).toContain('standard outputclass values');
    expect(plan.migrated).toBe(false);
    expect(plan.create).toBe(true);
  });

  test('explicit initialization creates an empty repository-owned contract without presets', () => {
    const plan = planManagedAuthorStylesheetWrite(null, []);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.create).toBe(true);
    expect(plan.resultingText).toBe(
      `${AUTHOR_STYLESHEET_PREAMBLE}${MANAGED_STYLES_START}\n${MANAGED_STYLES_VERSION}\n${serializeAuthorStyles([])}${MANAGED_STYLES_END}`,
    );
    expect(plan.resultingText).not.toContain('/* DITAEDITOR_AUTHOR_STYLE {');

    const inspection = inspectManagedAuthorStylesheet(plan.resultingText);
    expect(inspection.kind).toBe('marked');
    expect(inspection.styles).toEqual([]);
    expect(inspection.writable).toBe(true);
  });

  test('marked replacement preserves every byte outside the body including BOM and CRLF', () => {
    const oldBody = versioned(serializeAuthorStyles([CUSTOM_STYLE]), '\r\n');
    const prefix = '\ufeff/* developer prefix */\r\n';
    const suffix = '\r\n/* developer suffix */\r\n';
    const source = marked(oldBody, '\r\n', prefix, suffix);
    const nextStyle = { ...CUSTOM_STYLE, name: 'Updated cabin lead' };
    const replacement = versioned(serializeAuthorStyles([nextStyle]), '\r\n');

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
    expect(plan.resultingText).toBe(marked(versioned(serializeAuthorStyles([CUSTOM_STYLE]))));
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
    // Every panel-editable field must clear the strict save allowlist: a field
    // added to the model but not here refuses the whole save with a banner
    // ("contains unsupported field") — the exact live regression borderWidth hit.
    expect(planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-gold-left',
      name: 'Gold left rail',
      target: 'table',
      borderColor: '#b08747',
      borderEdge: 'left',
      borderWidth: '4px',
    }]).ok).toBe(true);
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
