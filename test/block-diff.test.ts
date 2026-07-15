import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { diffTopics, normalizedText, topicRootChange } from '../src/compare/block-diff';
import type { BlockChange } from '../src/compare/block-diff';
import type { ElementNode } from '../src/cst/types';

function diff(oldSrc: string, newSrc: string): BlockChange[] {
  return diffTopics(parse(oldSrc), parse(newSrc));
}

function kinds(changes: BlockChange[]): string[] {
  return changes.map((c) => c.kind);
}

/** All changes in the tree, depth-first. */
function flatten(changes: BlockChange[]): BlockChange[] {
  const out: BlockChange[] = [];
  const visit = (list: BlockChange[]): void => {
    for (const c of list) {
      out.push(c);
      if (c.children) visit(c.children);
    }
  };
  visit(changes);
  return out;
}

function textOf(el: ElementNode | undefined): string {
  return el ? normalizedText(el) : '';
}

/** The single change whose element (either side) has the given tag name. */
function byName(changes: BlockChange[], name: string): BlockChange {
  const hits = changes.filter((c) => (c.newEl ?? c.oldEl)?.name === name);
  if (hits.length !== 1) throw new Error(`expected one <${name}> change, got ${hits.length}`);
  return hits[0];
}

const XML_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n';

describe('block-diff: identical and reflowed docs', () => {
  test('identical docs (with xml decl + doctype) diff to all same', () => {
    const src =
      XML_HEAD +
      '<topic id="t1">\n' +
      '  <title>Meals</title>\n' +
      '  <body>\n' +
      '    <p>First paragraph.</p>\n' +
      '    <p>Second paragraph.</p>\n' +
      '  </body>\n' +
      '</topic>\n';
    const changes = diff(src, src);
    expect(kinds(changes)).toEqual(['same', 'same']); // title, body
    for (const c of changes) {
      expect(c.newEl).toBeDefined();
      expect(c.children).toBeUndefined();
    }
  });

  test('whitespace-only reflow (same text, new indentation and line breaks) is all same', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>hello world again</p></body></topic>';
    const newSrc =
      '<topic id="t">\n' +
      '  <title>T</title>\n' +
      '  <body>\n' +
      '    <p>hello\n' +
      '      world again</p>\n' +
      '  </body>\n' +
      '</topic>';
    expect(kinds(diff(oldSrc, newSrc))).toEqual(['same', 'same']);
  });
});

describe('block-diff: topic root metadata', () => {
  test('reports root attributes and root type changes outside child alignment', () => {
    const attributes = topicRootChange(
      parse('<topic id="old"><title>T</title></topic>'),
      parse('<topic id="new"><title>T</title></topic>'),
    );
    expect(attributes?.kind).toBe('formatChanged');
    expect(attributes?.label).toBe('Topic metadata changed');

    const type = topicRootChange(
      parse('<topic id="t"><title>T</title></topic>'),
      parse('<concept id="t"><title>T</title></concept>'),
    );
    expect(type?.kind).toBe('modified');
    expect(type?.label).toBe('Topic type changed');
  });

  test('reports an added or deleted topic root, including an otherwise empty topic', () => {
    const added = topicRootChange(parse(''), parse('<topic id="new"/>'));
    expect(added?.kind).toBe('inserted');
    expect(added?.label).toBe('Topic added');
    expect(added?.oldEl).toBeUndefined();
    expect(added?.newEl?.attrs.some((attribute) => attribute.name === 'id' && attribute.value === 'new')).toBe(true);

    const deleted = topicRootChange(parse('<concept id="old"/>'), parse(''));
    expect(deleted?.kind).toBe('deleted');
    expect(deleted?.label).toBe('Topic deleted');
    expect(deleted?.oldEl?.name).toBe('concept');
    expect(deleted?.newEl).toBeUndefined();
  });
});

describe('block-diff: paragraph edits', () => {
  const body3 = (mid: string): string =>
    '<topic id="t"><title>T</title><body>' +
    '<p>alpha</p><p>' + mid + '</p><p>charlie</p>' +
    '</body></topic>';

  test('edited paragraph text yields one textOnly modified pair; neighbors stay same', () => {
    const changes = diff(body3('bravo'), body3('bravo edited'));
    expect(kinds(changes)).toEqual(['same', 'modified']); // title, body
    const body = changes[1];
    expect(body.children).toBeDefined();
    expect(kinds(body.children!)).toEqual(['same', 'modified', 'same']);
    const edited = body.children![1];
    expect(edited.textOnly).toBe(true);
    expect(edited.oldEl!.name).toBe('p');
    expect(edited.newEl!.name).toBe('p');
  });

  test('added paragraph is inserted; others same', () => {
    const oldSrc = '<topic id="t"><title>T</title><body><p>alpha</p><p>bravo</p></body></topic>';
    const newSrc =
      '<topic id="t"><title>T</title><body><p>alpha</p><p>new one</p><p>bravo</p></body></topic>';
    const changes = diff(oldSrc, newSrc);
    const body = byName(changes, 'body');
    expect(body.kind).toBe('modified');
    expect(kinds(body.children!)).toEqual(['same', 'inserted', 'same']);
    expect(body.children![1].newEl).toBeDefined();
    expect(body.children![1].oldEl).toBeUndefined();
  });

  test('removed paragraph is deleted; others same', () => {
    const oldSrc =
      '<topic id="t"><title>T</title><body><p>alpha</p><p>doomed</p><p>bravo</p></body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body><p>alpha</p><p>bravo</p></body></topic>';
    const changes = diff(oldSrc, newSrc);
    const body = byName(changes, 'body');
    expect(body.kind).toBe('modified');
    expect(kinds(body.children!)).toEqual(['same', 'deleted', 'same']);
    expect(body.children![1].oldEl).toBeDefined();
    expect(body.children![1].newEl).toBeUndefined();
  });
});

describe('block-diff: lists', () => {
  test('li added inside a ul: ul is modified with only that li inserted', () => {
    const oldSrc =
      '<topic id="t"><title>T</title><body><ul><li>one</li><li>two</li></ul></body></topic>';
    const newSrc =
      '<topic id="t"><title>T</title><body>' +
      '<ul><li>one</li><li>brand new</li><li>two</li></ul>' +
      '</body></topic>';
    const changes = diff(oldSrc, newSrc);
    const body = byName(changes, 'body');
    const ul = byName(body.children!, 'ul');
    expect(ul.kind).toBe('modified');
    expect(kinds(ul.children!)).toEqual(['same', 'inserted', 'same']);
    expect(ul.children![1].newEl!.name).toBe('li');
  });
});

describe('block-diff: tables', () => {
  const table = (rows: string, colwidth: string): string =>
    '<topic id="t"><title>T</title><body>' +
    '<table><tgroup cols="2">' +
    '<colspec colname="c1" colnum="1" colwidth="' + colwidth + '"/>' +
    '<colspec colname="c2" colnum="2" colwidth="1*"/>' +
    '<tbody>' + rows + '</tbody>' +
    '</tgroup></table>' +
    '</body></topic>';
  const row = (a: string, b: string): string => '<row><entry>' + a + '</entry><entry>' + b + '</entry></row>';

  function tbodyOf(changes: BlockChange[]): BlockChange {
    const body = byName(changes, 'body');
    const tbl = byName(body.children!, 'table');
    expect(tbl.kind).toBe('modified');
    const tgroup = byName(tbl.children!, 'tgroup');
    expect(tgroup.kind).toBe('modified');
    return byName(tgroup.children!, 'tbody');
  }

  test('row deleted from tbody: only that row is deleted', () => {
    const oldSrc = table(row('a', 'b') + row('c', 'd') + row('e', 'f'), '1*');
    const newSrc = table(row('a', 'b') + row('e', 'f'), '1*');
    const tbody = tbodyOf(diff(oldSrc, newSrc));
    expect(tbody.kind).toBe('modified');
    expect(kinds(tbody.children!)).toEqual(['same', 'deleted', 'same']);
    expect(tbody.children![1].oldEl!.name).toBe('row');
  });

  test('colspec colwidth changed with identical cell text: table surfaces as formatChanged through body', () => {
    const oldSrc = table(row('a', 'b'), '1*');
    const newSrc = table(row('a', 'b'), '2*');
    // Content keys match everywhere; the deep fingerprint difference recurses
    // through body and stops at the table (coarse formatChanged leaf).
    const changes = diff(oldSrc, newSrc);
    const body = byName(changes, 'body');
    expect(body.kind).toBe('modified');
    const tbl = byName(body.children!, 'table');
    expect(tbl.kind).toBe('formatChanged');
    expect(tbl.oldEl).toBeDefined();
    expect(tbl.newEl).toBeDefined();
    expect(tbl.children).toBeUndefined();
  });

  test('entry-level outputclass change with identical text: table is formatChanged (coarse)', () => {
    const oldSrc = table(row('a', 'b'), '1*');
    const newSrc = table('<row><entry outputclass="hl">a</entry><entry>b</entry></row>', '1*');
    const changes = diff(oldSrc, newSrc);
    const body = byName(changes, 'body');
    expect(body.kind).toBe('modified');
    const tbl = byName(body.children!, 'table');
    expect(tbl.kind).toBe('formatChanged');
    expect(tbl.children).toBeUndefined();
  });

  test('entry edited in a row with equal entry counts: row recurses positionally', () => {
    const oldSrc = table(row('a', 'b') + row('c', 'd'), '1*');
    const newSrc = table(row('a', 'b') + row('c', 'd edited'), '1*');
    const tbody = tbodyOf(diff(oldSrc, newSrc));
    expect(kinds(tbody.children!)).toEqual(['same', 'modified']);
    const changedRow = tbody.children![1];
    expect(kinds(changedRow.children!)).toEqual(['same', 'modified']);
    const entry = changedRow.children![1];
    expect(entry.oldEl!.name).toBe('entry');
    expect(entry.textOnly).toBe(true);
  });

  test('cell with block children recurses to the changed paragraph inside', () => {
    const oldSrc = table('<row><entry><p>alpha one</p></entry><entry><p>keep</p></entry></row>', '1*');
    const newSrc = table('<row><entry><p>alpha two</p></entry><entry><p>keep</p></entry></row>', '1*');
    const tbody = tbodyOf(diff(oldSrc, newSrc));
    const changedRow = tbody.children![0];
    expect(kinds(changedRow.children!)).toEqual(['modified', 'same']);
    const entry = changedRow.children![0];
    expect(entry.children).toBeDefined(); // block-only cell recurses
    expect(kinds(entry.children!)).toEqual(['modified']);
    expect(entry.children![0].newEl!.name).toBe('p');
    expect(entry.children![0].textOnly).toBe(true);
  });

  test('row with differing entry counts stays a plain modified leaf', () => {
    const oldSrc = table(row('a', 'b'), '1*');
    const newSrc = table('<row><entry>a</entry><entry>b</entry><entry>c</entry></row>', '1*');
    const tbody = tbodyOf(diff(oldSrc, newSrc));
    expect(kinds(tbody.children!)).toEqual(['modified']);
    expect(tbody.children![0].children).toBeUndefined();
    expect(tbody.children![0].textOnly).toBeUndefined();
  });
});

describe('block-diff: attribute-only changes', () => {
  test('outputclass added to a p with identical text: formatChanged', () => {
    const oldSrc = '<topic id="t"><p>hello</p><p>other</p></topic>';
    const newSrc = '<topic id="t"><p outputclass="highlight">hello</p><p>other</p></topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['formatChanged', 'same']);
    expect(changes[0].oldEl!.name).toBe('p');
    expect(changes[0].newEl!.attrs.some((a) => a.name === 'outputclass')).toBe(true);
  });

  test('outputclass added to a p nested under body pinpoints: body modified, only that p formatChanged', () => {
    const oldSrc =
      '<topic id="t"><title>T</title><body><p>alpha</p><p>bravo</p><p>charlie</p></body></topic>';
    const newSrc =
      '<topic id="t"><title>T</title><body>' +
      '<p>alpha</p><p outputclass="highlight">bravo</p><p>charlie</p>' +
      '</body></topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['same', 'modified']); // title, body
    const body = changes[1];
    expect(kinds(body.children!)).toEqual(['same', 'formatChanged', 'same']);
    const styled = body.children![1];
    expect(styled.oldEl!.name).toBe('p');
    expect(styled.newEl!.attrs.some((a) => a.name === 'outputclass')).toBe(true);
  });

  test('outputclass on an li two levels down pinpoints through body and ul', () => {
    const oldSrc =
      '<topic id="t"><title>T</title><body><ul><li>one</li><li>two</li></ul></body></topic>';
    const newSrc =
      '<topic id="t"><title>T</title><body>' +
      '<ul><li>one</li><li outputclass="hl">two</li></ul>' +
      '</body></topic>';
    const body = byName(diff(oldSrc, newSrc), 'body');
    expect(body.kind).toBe('modified');
    const ul = byName(body.children!, 'ul');
    expect(ul.kind).toBe('modified');
    expect(kinds(ul.children!)).toEqual(['same', 'formatChanged']);
  });
});

describe('block-diff: similarity pairing', () => {
  test('reworded paragraph pairs across an interposed same-tag block', () => {
    // Cursor pairing alone would pair the reworded paragraph with the brand-new
    // one interposed before it; similarity reassigns it to its real counterpart.
    const oldSrc =
      '<topic id="t"><p>The quick brown fox jumps over the lazy dog</p></topic>';
    const newSrc =
      '<topic id="t">' +
      '<p>Totally new content appears in this revision</p>' +
      '<p>The quick brown fox leaps over the lazy dog</p>' +
      '</topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['modified', 'inserted']);
    expect(textOf(changes[0].oldEl)).toBe('The quick brown fox jumps over the lazy dog');
    expect(textOf(changes[0].newEl)).toBe('The quick brown fox leaps over the lazy dog');
    expect(textOf(changes[1].newEl)).toBe('Totally new content appears in this revision');
  });

  test('crossed 2x2 gap pairs by similarity score, not position', () => {
    const oldSrc =
      '<topic id="t">' +
      '<p>Alpha crew briefing checklist items</p>' +
      '<p>Beverage service galley preparation steps</p>' +
      '</topic>';
    const newSrc =
      '<topic id="t">' +
      '<p>Beverage service galley preparation steps updated now</p>' +
      '<p>Alpha crew briefing checklist items revised today</p>' +
      '</topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['modified', 'modified']);
    expect(textOf(changes[0].oldEl)).toBe('Alpha crew briefing checklist items');
    expect(textOf(changes[0].newEl)).toBe('Alpha crew briefing checklist items revised today');
    expect(textOf(changes[1].oldEl)).toBe('Beverage service galley preparation steps');
    expect(textOf(changes[1].newEl)).toBe('Beverage service galley preparation steps updated now');
  });

  test('equal similarity scores break ties deterministically by (oldIndex, newIndex)', () => {
    // All four candidate pairs share the same word-set Dice score; the greedy
    // assignment must resolve (0,0) then (1,1) — never the crossed pairing.
    const oldSrc = '<topic id="t"><p>red green blue</p><p>blue green red</p></topic>';
    const newSrc = '<topic id="t"><p>red green blue extra</p><p>extra blue green red</p></topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['modified', 'modified']);
    expect(textOf(changes[0].oldEl)).toBe('red green blue');
    expect(textOf(changes[0].newEl)).toBe('red green blue extra');
    expect(textOf(changes[1].oldEl)).toBe('blue green red');
    expect(textOf(changes[1].newEl)).toBe('extra blue green red');
  });

  test('paired set stays a superset of pure cursor pairing (only assignment changes)', () => {
    // Cursor pairing over this gap pairs ALL six blocks positionally
    // (A<->C2, B<->X, C<->A2). Similarity reassigns A<->A2 and C<->C2 and the
    // leftover cursor phase must still pair B<->X: every element cursor pairing
    // would pair remains paired — nothing degrades to pure deleted/inserted.
    const oldSrc =
      '<topic id="t">' +
      '<p>alpha bravo charlie delta</p>' +
      '<p>mike november oscar</p>' +
      '<p>echo foxtrot golf hotel</p>' +
      '</topic>';
    const newSrc =
      '<topic id="t">' +
      '<p>echo foxtrot golf hotel extra</p>' +
      '<p>zulu yankee xray</p>' +
      '<p>alpha bravo charlie delta added</p>' +
      '</topic>';
    const changes = diff(oldSrc, newSrc);
    expect(kinds(changes)).toEqual(['modified', 'modified', 'modified']);
    expect(changes.filter((c) => c.kind === 'deleted' || c.kind === 'inserted')).toEqual([]);
    // Assignment actually changed vs cursor pairing:
    expect(textOf(changes[0].oldEl)).toBe('alpha bravo charlie delta');
    expect(textOf(changes[0].newEl)).toBe('alpha bravo charlie delta added');
    expect(textOf(changes[2].oldEl)).toBe('echo foxtrot golf hotel');
    expect(textOf(changes[2].newEl)).toBe('echo foxtrot golf hotel extra');
    // The low-similarity leftover still pairs via the cursor phase:
    expect(textOf(changes[1].oldEl)).toBe('mike november oscar');
    expect(textOf(changes[1].newEl)).toBe('zulu yankee xray');
  });

  test('beyond the candidate-pair guard, pairing falls back to cursor order verbatim', () => {
    // 41x41 same-tag candidates = 1681 > 1600: similarity is skipped even though
    // it would pair block i with block 40-i; positional cursor pairing wins.
    const count = 41;
    const oldPs = Array.from({ length: count }, (_, i) => `<p>w${i}a w${i}b w${i}c</p>`).join('');
    const newPs = Array.from(
      { length: count },
      (_, i) => `<p>w${count - 1 - i}a w${count - 1 - i}b w${count - 1 - i}c zz</p>`,
    ).join('');
    const changes = diff(`<topic id="t">${oldPs}</topic>`, `<topic id="t">${newPs}</topic>`);
    expect(changes.filter((c) => c.kind === 'modified').length).toBe(count);
    expect(textOf(changes[0].oldEl)).toBe('w0a w0b w0c');
    expect(textOf(changes[0].newEl)).toBe('w40a w40b w40c zz'); // NOT the similar w0 block
  });
});

describe('block-diff: structure rewrites with identical visible text', () => {
  test('cell text turned into a list (same visible text) is modified, never formatChanged', () => {
    // Mirrors the live report: an entry transformed from plain text into
    // <ul><li>…</li></ul> whose concatenated text is byte-identical. The old
    // rule fingerprinted this as formatChanged (invisible inside merged
    // tables); a rewritten tag tree must surface as a content modification.
    const table = (cell: string): string =>
      '<topic id="t"><title>T</title><body><table><tgroup cols="2">' +
      '<colspec colname="c1" colnum="1" colwidth="1*"/><colspec colname="c2" colnum="2" colwidth="1*"/>' +
      '<tbody><row><entry>keep</entry><entry>' + cell + '</entry></row>' +
      '<row><entry>other</entry><entry>row</entry></row></tbody>' +
      '</tgroup></table></body></topic>';
    const changes = diff(
      table('Galley operator Cabin appearance'),
      table('<ul><li>Galley operator </li><li>Cabin appearance</li></ul>'),
    );
    const flat = flatten(changes);
    expect(flat.some((c) => c.kind === 'formatChanged')).toBe(false);
    const entries = flat.filter((c) => c.kind === 'modified' && (c.newEl ?? c.oldEl)?.name === 'entry');
    expect(entries.length).toBe(1);
    expect(entries[0].oldEl).toBeDefined();
    expect(entries[0].newEl).toBeDefined();
    expect(textOf(entries[0].newEl)).toBe('Galley operator Cabin appearance');
  });

  test('paragraph gaining inline markup (same text) is modified, attr-only delta stays formatChanged', () => {
    const structural = diff(
      '<topic id="t"><p>alpha bravo</p><p>anchor</p></topic>',
      '<topic id="t"><p><b>alpha</b> bravo</p><p>anchor</p></topic>',
    );
    expect(kinds(structural)).toEqual(['modified', 'same']);
    const attrOnly = diff(
      '<topic id="t"><p>alpha bravo</p><p>anchor</p></topic>',
      '<topic id="t"><p outputclass="hl">alpha bravo</p><p>anchor</p></topic>',
    );
    expect(kinds(attrOnly)).toEqual(['formatChanged', 'same']);
  });
});

describe('block-diff: moved blocks', () => {
  const sectionsDoc = (alphaExtra: string, betaExtra: string): string =>
    '<topic id="t"><title>T</title><body>' +
    '<section><title>Alpha</title>' +
    '<p>Alpha anchor keeps aircraft doors armed correctly</p>' + alphaExtra +
    '</section>' +
    '<section><title>Beta</title>' +
    '<p>Beta covers galley trolley stowage procedures fully</p>' + betaExtra +
    '</section>' +
    '</body></topic>';

  test('relocated identical paragraph becomes movedFrom + movedTo with a shared moveId', () => {
    const moved = '<p>Moved cabin crew announcement text</p>';
    const flat = flatten(diff(sectionsDoc(moved, ''), sectionsDoc('', moved)));
    const from = flat.filter((c) => c.kind === 'movedFrom');
    const to = flat.filter((c) => c.kind === 'movedTo');
    expect(from.length).toBe(1);
    expect(to.length).toBe(1);
    expect(from[0].oldEl).toBeDefined();
    expect(from[0].newEl).toBeUndefined();
    expect(to[0].newEl).toBeDefined();
    expect(to[0].oldEl).toBeUndefined();
    expect(textOf(from[0].oldEl)).toBe('Moved cabin crew announcement text');
    expect(textOf(to[0].newEl)).toBe('Moved cabin crew announcement text');
    expect(from[0].moveId).toBeDefined();
    expect(from[0].moveId).toBe(to[0].moveId!);
    // The relocated block never also shows up as a plain delete/insert.
    expect(flat.some((c) => c.kind === 'deleted' && textOf(c.oldEl).includes('Moved'))).toBe(false);
    expect(flat.some((c) => c.kind === 'inserted' && textOf(c.newEl).includes('Moved'))).toBe(false);
  });

  test('text-identical blocks with differing attributes do NOT move-pair', () => {
    const flat = flatten(diff(
      sectionsDoc('<p>Moved cabin crew announcement text</p>', ''),
      sectionsDoc('', '<p outputclass="hl">Moved cabin crew announcement text</p>'),
    ));
    expect(flat.some((c) => c.kind === 'movedFrom' || c.kind === 'movedTo')).toBe(false);
    const deleted = flat.filter((c) => c.kind === 'deleted');
    const inserted = flat.filter((c) => c.kind === 'inserted');
    expect(deleted.length).toBe(1);
    expect(inserted.length).toBe(1);
    expect(textOf(deleted[0].oldEl)).toBe('Moved cabin crew announcement text');
    expect(inserted[0].newEl!.attrs.some((a) => a.name === 'outputclass')).toBe(true);
    expect(deleted[0].moveId).toBeUndefined();
    expect(inserted[0].moveId).toBeUndefined();
  });

  test('empty paragraphs never move-pair', () => {
    const flat = flatten(diff(sectionsDoc('<p></p>', ''), sectionsDoc('', '<p></p>')));
    expect(flat.some((c) => c.kind === 'movedFrom' || c.kind === 'movedTo')).toBe(false);
    expect(flat.filter((c) => c.kind === 'deleted').length).toBe(1);
    expect(flat.filter((c) => c.kind === 'inserted').length).toBe(1);
  });
});

describe('block-diff: wide-container positional guard', () => {
  test('more than 200 children aligns positionally and still isolates the edit', () => {
    const paras = (edited: string): string =>
      Array.from({ length: 201 }, (_, i) => '<p>' + (i === 5 ? edited : 'para ' + i) + '</p>').join('');
    const oldSrc = '<topic id="t"><title>T</title><body>' + paras('para 5') + '</body></topic>';
    const newSrc = '<topic id="t"><title>T</title><body>' + paras('para five edited') + '</body></topic>';
    const body = byName(diff(oldSrc, newSrc), 'body');
    expect(body.kind).toBe('modified');
    expect(body.children!.length).toBe(201);
    expect(body.children!.filter((c) => c.kind === 'modified').length).toBe(1);
    expect(body.children![5].kind).toBe('modified');
    expect(body.children![5].textOnly).toBe(true);
  });

  test('a sparse insertion before more than 200 children does not shift every pair', () => {
    const paras = Array.from({ length: 201 }, (_, i) => `<p>para ${i}</p>`).join('');
    const oldSrc = `<topic id="t"><title>T</title><body>${paras}</body></topic>`;
    const newSrc = `<topic id="t"><title>T</title><body><p>inserted first</p>${paras}</body></topic>`;
    const body = byName(diff(oldSrc, newSrc), 'body');

    expect(body.children?.filter((change) => change.kind === 'inserted').length).toBe(1);
    expect(body.children?.filter((change) => change.kind === 'same').length).toBe(201);
    expect(body.children?.filter((change) => change.kind === 'modified').length).toBe(0);
  });

  test('multiple sparse edits in a wide container keep exact blocks aligned', () => {
    const paragraphs = Array.from({ length: 401 }, (_, index) => `<p>para ${index}</p>`);
    const oldSrc = `<topic id="t"><body>${paragraphs.join('')}</body></topic>`;
    const inserted = [...paragraphs];
    inserted.splice(100, 0, '<p>insert A</p>');
    inserted.splice(302, 0, '<p>insert B</p>');
    const insertedBody = byName(diff(
      oldSrc,
      `<topic id="t"><body>${inserted.join('')}</body></topic>`,
    ), 'body');

    expect(insertedBody.children?.filter((change) => change.kind === 'same').length).toBe(401);
    expect(insertedBody.children?.filter((change) => change.kind === 'inserted').length).toBe(2);
    expect(insertedBody.children?.filter((change) => change.kind === 'modified').length).toBe(0);

    const removed = paragraphs.filter((_, index) => index !== 100 && index !== 300);
    const removedBody = byName(diff(
      oldSrc,
      `<topic id="t"><body>${removed.join('')}</body></topic>`,
    ), 'body');
    expect(removedBody.children?.filter((change) => change.kind === 'same').length).toBe(399);
    expect(removedBody.children?.filter((change) => change.kind === 'deleted').length).toBe(2);
    expect(removedBody.children?.filter((change) => change.kind === 'modified').length).toBe(0);

    const mixed = paragraphs.filter((_, index) => index !== 100);
    mixed.splice(301, 0, '<p>insert replacement</p>');
    const mixedBody = byName(diff(
      oldSrc,
      `<topic id="t"><body>${mixed.join('')}</body></topic>`,
    ), 'body');
    expect(mixedBody.children?.filter((change) => change.kind === 'same').length).toBe(400);
    expect(mixedBody.children?.filter((change) => change.kind === 'deleted').length).toBe(1);
    expect(mixedBody.children?.filter((change) => change.kind === 'inserted').length).toBe(1);
    expect(mixedBody.children?.filter((change) => change.kind === 'modified').length).toBe(0);
  });

  test('multiple sparse insertions align wide repeated-content sequences', () => {
    const paragraphs = Array.from(
      { length: 401 },
      (_, index) => `<p>repeat ${index % 2 === 0 ? 'A' : 'B'}</p>`,
    );
    const inserted = [...paragraphs];
    inserted.splice(100, 0, '<p>insert X</p>');
    inserted.splice(302, 0, '<p>insert Y</p>');
    const body = byName(diff(
      `<topic><body>${paragraphs.join('')}</body></topic>`,
      `<topic><body>${inserted.join('')}</body></topic>`,
    ), 'body');

    expect(body.children?.filter((change) => change.kind === 'same').length).toBe(401);
    expect(body.children?.filter((change) => change.kind === 'inserted').length).toBe(2);
    expect(body.children?.filter((change) => change.kind === 'modified').length).toBe(0);

    const mixed = paragraphs.filter((_, index) => index !== 100);
    mixed.splice(300, 0, '<p>insert Z</p>');
    const mixedBody = byName(diff(
      `<topic><body>${paragraphs.join('')}</body></topic>`,
      `<topic><body>${mixed.join('')}</body></topic>`,
    ), 'body');
    expect(mixedBody.children?.filter((change) => change.kind === 'same').length).toBe(400);
    expect(mixedBody.children?.filter((change) => change.kind === 'deleted').length).toBe(1);
    expect(mixedBody.children?.filter((change) => change.kind === 'inserted').length).toBe(1);
    expect(mixedBody.children?.filter((change) => change.kind === 'modified').length).toBe(0);
  });
});
