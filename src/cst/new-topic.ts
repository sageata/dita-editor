// Pure builder for a brand-new DITA topic skeleton.
//
// A freshly created .dita file is empty, which is INVALID DITA (a topic requires a
// <title>) and so cannot be edited in the visual canvas. The host scaffolds this
// skeleton into any empty .dita on open so the file starts with all required fields:
// the mandatory <title> plus a <body> holding one empty <p> to type into.
//
// Byte-stable by construction: serialize(parse(skeleton)) === skeleton (covered by
// test/new-topic.test.ts), so opening a scaffolded file and saving writes no further
// diff and the corpus round-trip invariant is preserved.

/** Base file name (no directory, no extension) of an fs path, '/'- or '\\'-separated. */
function stem(fsPath: string): string {
  const base = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

/** Derive a valid XML NCName id from a file path's base name. A topic @id must be an
 *  NCName (letters/digits/`-`/`_`/`.`, starting with a letter or underscore), so the
 *  file stem is sanitized and prefixed with `t-` when it would otherwise start with a
 *  digit or be empty. */
export function topicIdFromPath(fsPath: string): string {
  let id = stem(fsPath)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!id || !/^[A-Za-z_]/.test(id)) id = 't-' + id;
  return id;
}

/** Human title seeded from the file name (the author renames it immediately in-canvas). */
export function titleFromPath(fsPath: string): string {
  return stem(fsPath) || 'Untitled';
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A minimal VALID `<topic>` skeleton (XML decl + DOCTYPE + required title + body/p),
 *  with @id and title text seeded from the file name. */
export function newTopicSkeleton(fsPath: string): string {
  const id = topicIdFromPath(fsPath);
  const title = escapeXmlText(titleFromPath(fsPath));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n' +
    `<topic id="${id}">\n` +
    `  <title>${title}</title>\n` +
    '  <body>\n' +
    '    <p></p>\n' +
    '  </body>\n' +
    '</topic>\n'
  );
}
