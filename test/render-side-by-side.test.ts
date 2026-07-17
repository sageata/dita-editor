import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { renderSideBySide } from '../src/compare/render-side-by-side';
import { planReviewReverts } from '../src/compare/revert-change';

function compare(oldSource: string, newSource: string): string {
  return renderSideBySide(parse(oldSource), parse(newSource)).html;
}

describe('renderSideBySide', () => {
  test('renders an edited block as one aligned earlier/newer row', () => {
    const html = compare(
      '<topic id="t"><title>T</title><body><p>Old wording</p></body></topic>',
      '<topic id="t"><title>T</title><body><p>New wording</p></body></topic>',
    );

    expect(html).toContain('class="redline-compare-row redline-compare-row-modified"');
    expect(html).toContain('data-redline-change');
    expect(html).toContain('data-redline-side="old"');
    expect(html).toContain('data-redline-side="new"');
    expect(html).toContain('aria-label="Earlier version"');
    expect(html).toContain('aria-label="Newer version"');
    expect(html).toContain('<p class="p">Old wording</p>');
    expect(html).toContain('<p class="p">New wording</p>');
    expect(html).toContain('<article role="article" class="nested0 topic"><div class="body">');
  });

  test('renders an opaque revert action only for an eligible working-copy row', () => {
    const earlier = '<topic><body><p>Earlier wording</p></body></topic>';
    const newer = '<topic><body><p>Newer wording</p></body></topic>';
    const plan = planReviewReverts(earlier, newer)[0];
    const html = renderSideBySide(parse(earlier), parse(newer), {
      revertActions: new Map([[plan.key, { token: 'opaque-token', label: plan.label }]]),
    }).html;

    expect(html).toContain('data-redline-action="revertChange"');
    expect(html).toContain('data-redline-revert-token="opaque-token"');
    expect(html).toContain('aria-label="Restore changed &lt;p&gt; from Earlier"');
    expect(html).not.toContain('Earlier wording</button>');
  });

  test('renders insertions and deletions against explicit empty placeholders', () => {
    const html = compare(
      '<topic id="t"><title>T</title><body><p>Delete me</p><p>Keep</p></body></topic>',
      '<topic id="t"><title>T</title><body><p>Keep</p><p>Insert me</p></body></topic>',
    );

    expect(html).toContain('redline-compare-row-deleted');
    expect(html).toContain('redline-compare-row-inserted');
    expect(html).toContain('Deleted');
    expect(html).toContain('Inserted');
    expect(html).toContain('redline-compare-placeholder');
    expect(html).toContain('Delete me');
    expect(html).toContain('Insert me');
  });

  test('surfaces semantic change kinds nested inside lists and tables', () => {
    const html = compare(
      '<topic><body><ul><li>One</li><li>Three</li></ul>'
        + '<table><tgroup cols="1"><tbody><row><entry>Delete row</entry></row><row><entry>Keep row</entry></row></tbody></tgroup></table>'
        + '</body></topic>',
      '<topic><body><ul><li>One</li><li>Two</li><li>Three</li></ul>'
        + '<table><tgroup cols="1"><tbody><row><entry>Keep row</entry></row></tbody></tgroup></table>'
        + '</body></topic>',
    );

    expect(html).toContain('redline-compare-row-modified');
    expect(html).toContain('Inserted');
    expect(html).toContain('Deleted');
    expect(html).toContain('Two');
    expect(html).toContain('Delete row');
  });

  test('keeps direct-text list edits visible instead of flattening an empty child diff', () => {
    const html = compare(
      '<topic><body><ol><li>One</li><li>Two old</li><li>Three</li></ol></body></topic>',
      '<topic><body><ol><li>One</li><li>Two new</li><li>Three</li></ol></body></topic>',
    );

    expect(html).toContain('redline-compare-row-modified');
    expect(html).toContain('Two old');
    expect(html).toContain('Two new');
    expect(html).toContain('data-redline-change');
    expect(html.match(/<ol/g)?.length).toBe(2);
    expect(html.match(/<li/g)?.length).toBe(6);
  });

  test('keeps a structurally changed table whole with its caption, columns, and headers', () => {
    const table = (rows: string) => '<table><title>Crew table</title><tgroup cols="2">'
      + '<colspec colname="c1" colwidth="1*"/><colspec colname="c2" colwidth="2*"/>'
      + '<thead><row><entry>Role</entry><entry>Count</entry></row></thead>'
      + `<tbody>${rows}</tbody></tgroup></table>`;
    const row = (role: string, count: string) => `<row><entry>${role}</entry><entry>${count}</entry></row>`;
    const html = compare(
      `<topic><body>${table(row('Pilot', '2'))}</body></topic>`,
      `<topic><body>${table(row('Pilot', '2') + row('Cabin crew', '8'))}</body></topic>`,
    );

    expect(html.match(/<table/g)?.length).toBe(2);
    expect(html.match(/<caption/g)?.length).toBe(2);
    expect(html.match(/<col /g)?.length).toBe(4);
    expect(html).toContain('Inserted');
    expect(html).toContain('Cabin crew');
    expect(html.match(/headers="/g)?.length).toBeGreaterThan(0);
  });

  test('renders topic root metadata as its own aligned change row', () => {
    const html = compare(
      '<topic id="old" outputclass="before"><title>T</title><body><p>Same</p></body></topic>',
      '<topic id="new" outputclass="after"><title>T</title><body><p>Same</p></body></topic>',
    );

    expect(html).toContain('id="comparison-root-metadata"');
    expect(html).toContain('Topic metadata changed');
    expect(html).toContain('<q>old</q>');
    expect(html).toContain('<q>new</q>');
    expect(html).toContain('data-redline-change');
  });

  test('renders an empty added topic as an explicit inserted root row', () => {
    const html = compare('', '<topic id="new"/>');

    expect(html).toContain('id="comparison-root-metadata"');
    expect(html).toContain('redline-compare-row-inserted');
    expect(html).toContain('Topic added');
    expect(html).toContain('<q>new</q>');
    expect(html).toContain('No earlier content');
    expect(html).toContain('data-redline-change');
  });

  test('marks formatting and moved content with distinct row kinds', () => {
    const html = compare(
      '<topic id="t"><title>T</title><body><p outputclass="old">Restyle</p><p>Move me</p><p>Stay</p></body></topic>',
      '<topic id="t"><title>T</title><body><p outputclass="new">Restyle</p><p>Stay</p><p>Move me</p></body></topic>',
    );

    expect(html).toContain('redline-compare-row-formatChanged');
    expect(html).toContain('Formatting changed');
    expect(html).toContain('redline-compare-row-movedFrom');
    expect(html).toContain('redline-compare-row-movedTo');
    expect(html).toContain('Moved from here');
    expect(html).toContain('Moved here');
  });

  test('collapses the middle of long unchanged runs while keeping context rows', () => {
    const paras = (changed: string) =>
      `<topic id="t"><title>T</title><body>`
      + '<p>One</p><p>Two</p><p>Three</p><p>Four</p>'
      + `<p>${changed}</p>`
      + '<p>Six</p><p>Seven</p><p>Eight</p><p>Nine</p>'
      + '</body></topic>';
    const html = compare(paras('Old'), paras('New'));

    expect(html).toContain('data-redline-unchanged-group="unchanged-1"');
    expect(html).toContain('data-redline-expand="unchanged-1"');
    expect(html).toContain('hidden data-redline-unchanged-rows="unchanged-1"');
    expect(html).toMatch(/[2-9] unchanged sections/);
  });

  test('keeps real tables, image hrefs, and workspace-style class hooks on both sides', () => {
    const topic = (cell: string, width: string) =>
      '<topic id="t"><title>T</title><body>'
      + '<fig outputclass="hero"><image href="images/diagram.svg" placement="break"><alt>Diagram</alt></image></fig>'
      + `<table><tgroup cols="1"><colspec colname="c1" colwidth="${width}"/><tbody><row><entry>${cell}</entry></row></tbody></tgroup></table>`
      + '</body></topic>';
    const html = compare(topic('Old cell', '1*'), topic('New cell', '2*'));

    expect(html.match(/<table/g)?.length).toBe(2);
    expect(html.match(/src="images\/diagram\.svg"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('class="fig fignone hero"');
    expect(html).toContain('Old cell');
    expect(html).toContain('New cell');
  });

  test('names titleless tables and namespaces every header id across rows and sides', () => {
    const table = (label: string) =>
      '<table><tgroup cols="1"><colspec colname="c1"/>'
      + `<thead><row><entry>Header ${label}</entry></row></thead>`
      + `<tbody><row><entry>Cell ${label}</entry></row></tbody></tgroup></table>`;
    const topic = (first: string, second: string) =>
      `<topic id="t"><title>Named topic</title><body>${table(first)}${table(second)}</body></topic>`;
    const html = compare(topic('old one', 'old two'), topic('new one', 'new two'));
    const ids = [...html.matchAll(/id="(dch-[^"]+)"/g)].map((match) => match[1]);
    const headers = [...html.matchAll(/headers="([^"]+)"/g)]
      .flatMap((match) => match[1].split(' '));

    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(headers.every((header) => ids.includes(header))).toBe(true);
    expect(html.match(/aria-label="Named topic, table 1"/g)?.length).toBe(2);
    expect(html.match(/aria-label="Named topic, table 2"/g)?.length).toBe(2);
  });
});
