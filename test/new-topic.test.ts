// New-topic scaffold: a freshly created empty .dita is invalid (a topic requires a
// <title>); the host scaffolds this skeleton so the file opens with all required fields.
// Tests parse REAL DITA with the production parser; the skeleton must round-trip
// byte-identical (so a scaffolded file saves with no extra diff).

import { test, expect, describe } from 'bun:test';
import { parse } from '../src/cst/parse';
import { serialize } from '../src/cst/serialize';
import { indexDocument } from '../src/commands/validity';
import { canDeleteElement } from '../src/cst/structural';
import { newTopicSkeleton, topicIdFromPath, titleFromPath } from '../src/cst/new-topic';

describe('newTopicSkeleton', () => {
  test('is a valid topic with the required <title> + <body> and round-trips byte-identical', () => {
    const s = newTopicSkeleton('/x/y/addressing-guests.dita');
    // byte-stable: parsing then serializing returns the exact same source.
    expect(serialize(parse(s))).toBe(s);
    expect(s).toContain('<!DOCTYPE topic PUBLIC');
    expect(s).toContain('id="addressing-guests"');
    expect(s).toContain('<title>addressing-guests</title>');
    expect(s).toContain('<body>');
    expect(s).toContain('<p></p>');
  });

  test('its required <title> is correctly recognised as non-deletable (topic title)', () => {
    const idx = indexDocument(newTopicSkeleton('/x/note.dita'));
    let titleEl = null;
    for (const [, el] of idx.byId) if (el.name === 'title') { titleEl = el; break; }
    expect(titleEl).not.toBeNull();
    const check = canDeleteElement(titleEl!, titleEl!.parent ?? null);
    expect(check.canDelete).toBe(false); // a topic's title is required
  });

  test('topicIdFromPath sanitizes to a valid NCName', () => {
    expect(topicIdFromPath('/a/addressing-guests.dita')).toBe('addressing-guests');
    expect(topicIdFromPath('/a/01-intro.dita')).toBe('t-01-intro'); // must not start with a digit
    expect(topicIdFromPath('/a/my file (v2)!.dita')).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    expect(topicIdFromPath('/a/.dita')).toBe('t-'); // empty stem still yields a usable prefix
  });

  test('titleFromPath uses the file stem, falling back to Untitled', () => {
    expect(titleFromPath('/a/getting-started.dita')).toBe('getting-started');
    expect(titleFromPath('/a/.dita')).toBe('Untitled');
  });

  test('escapes XML-special characters in the seeded title', () => {
    const s = newTopicSkeleton('/a/A & B.dita');
    expect(s).toContain('<title>A &amp; B</title>');
    expect(serialize(parse(s))).toBe(s);
  });
});
