import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parse } from '../src/cst/parse';
import { findElements, walk } from '../src/cst/query';
import { isElement, type ElementNode } from '../src/cst/types';

type CorpusModule = typeof import('./corpus');

const FIXTURE_ROOT = path.resolve(import.meta.dir, 'fixtures/corpus');
const EXPECTED_FILES: string[] = [
  'concept/basic-concept.dita',
  'lexical/comments-entities-quotes.dita',
  'media/image-figure.dita',
  'media/images/example-diagram.svg',
  'performance/large-table.dita',
  'performance/large-topic.dita',
  'reference/basic-reference.dita',
  'tables/mixed-image-table.dita',
  'tables/noncanonical-colspec.dita',
  'tables/ordinary-table.dita',
  'tables/spanned-table.dita',
  'task/steps-task.dita',
  'topic/lists-notes-code-lines.dita',
  'topic/mixed-inline.dita',
];
const EXPECTED_DITA_FILES = EXPECTED_FILES.filter((rel) => rel.endsWith('.dita'));
const EXPECTED_FILE_SET = new Set(EXPECTED_FILES);
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const ALLOWED_SVG_ELEMENTS = ['circle', 'desc', 'line', 'rect', 'svg', 'title'];
const FORBIDDEN_SVG_ELEMENTS = new Set(['foreignobject', 'image', 'script', 'use']);
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_ATTRIBUTE_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['xmlns', 'width', 'height', 'viewBox', 'role', 'aria-labelledby']),
  title: new Set(['id']),
  desc: new Set(['id']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-width']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width']),
};
const DECIMAL_SOURCE = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const DECIMAL_VALUE = new RegExp(`^${DECIMAL_SOURCE}$`);
const VIEWBOX_VALUE = new RegExp(`^${DECIMAL_SOURCE}(?:\\s+${DECIMAL_SOURCE}){3}$`);
const XML_ID_SOURCE = '[A-Za-z_][A-Za-z0-9_.-]*';
const XML_ID_VALUE = new RegExp(`^${XML_ID_SOURCE}$`);
const XML_ID_LIST_VALUE = new RegExp(`^${XML_ID_SOURCE}(?:\\s+${XML_ID_SOURCE})*$`);
const HEX_COLOR_VALUE = /^#[0-9A-Fa-f]{6}$/;
const SVG_ATTRIBUTE_VALUE_RULES: Readonly<Record<string, Readonly<Record<string, RegExp | string>>>> = {
  svg: {
    xmlns: SVG_NAMESPACE,
    width: DECIMAL_VALUE,
    height: DECIMAL_VALUE,
    viewBox: VIEWBOX_VALUE,
    role: 'img',
    'aria-labelledby': XML_ID_LIST_VALUE,
  },
  title: { id: XML_ID_VALUE },
  desc: { id: XML_ID_VALUE },
  rect: {
    x: DECIMAL_VALUE,
    y: DECIMAL_VALUE,
    width: DECIMAL_VALUE,
    height: DECIMAL_VALUE,
    rx: DECIMAL_VALUE,
    fill: HEX_COLOR_VALUE,
    stroke: HEX_COLOR_VALUE,
    'stroke-width': DECIMAL_VALUE,
  },
  line: {
    x1: DECIMAL_VALUE,
    y1: DECIMAL_VALUE,
    x2: DECIMAL_VALUE,
    y2: DECIMAL_VALUE,
    stroke: HEX_COLOR_VALUE,
    'stroke-width': DECIMAL_VALUE,
  },
  circle: {
    cx: DECIMAL_VALUE,
    cy: DECIMAL_VALUE,
    r: DECIMAL_VALUE,
    fill: HEX_COLOR_VALUE,
    stroke: HEX_COLOR_VALUE,
    'stroke-width': DECIMAL_VALUE,
  },
};
type CorpusReferenceElement = 'xref' | 'image';

async function corpusApi(): Promise<CorpusModule> {
  return import('./corpus');
}

function requireRealDirectoryRoot(root: string): string {
  const resolved = path.resolve(root);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`public corpus root is not a real directory: ${resolved}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`public corpus root is not a real directory: ${resolved}`);
  }
  return resolved;
}

function allRelativeFiles(root: string): string[] {
  const resolvedRoot = requireRealDirectoryRoot(root);
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files.push(path.relative(resolvedRoot, abs).split(path.sep).join('/'));
      else {
        const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
        throw new Error(`public corpus contains unsupported filesystem entry: ${rel}`);
      }
    }
  };
  visit(root);
  return files.sort();
}

function sourceAt(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, rel), 'utf8');
}

function rootName(source: string): string {
  for (const node of walk(parse(source).children)) {
    if (isElement(node)) return node.name;
  }
  throw new Error('fixture has no root element');
}

function elementCount(source: string): number {
  let count = 0;
  for (const node of walk(parse(source).children)) if (isElement(node)) count++;
  return count;
}

function attrValue(element: ElementNode | undefined, name: string): string | undefined {
  return element?.attrs.find((attr) => attr.name === name)?.value;
}

function localHrefSyntaxError(href: string): string | undefined {
  if (!href.trim()) return 'href is empty';
  if (href !== href.trim()) return 'href has surrounding whitespace';
  if (WINDOWS_DRIVE_PATH.test(href)) return 'Windows drive path is not relative';
  if (href.startsWith('\\\\')) return 'Windows UNC path is not relative';
  if (href.startsWith('//')) return 'protocol-relative URL is not local';
  if (href.startsWith('/')) return 'POSIX absolute path is not relative';
  if (URI_SCHEME.test(href)) return 'URI scheme is not local';
  if (href.includes('\\')) return 'backslash path is not a portable relative href';
  if (href.includes('#')) return 'fragment href semantics are not part of the public fixture contract';
  if (href.includes('?')) return 'query href semantics are not part of the public fixture contract';
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function requireUnlinkedTargetPath(root: string, target: string): void {
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      const rel = path.relative(root, current).split(path.sep).join('/');
      throw new Error(`href target path contains linked filesystem entry: ${rel}`);
    }
  }
}

function canonicalPublicPathError(rel: string): string | undefined {
  return EXPECTED_FILE_SET.has(rel) ? undefined : `not an exact canonical public inventory path: ${rel}`;
}

function resolvePublicHref(
  sourceAbs: string,
  href: string,
  element: CorpusReferenceElement,
  corpusRoot: string = FIXTURE_ROOT,
): { abs: string; rel: string } {
  const resolvedRoot = requireRealDirectoryRoot(corpusRoot);
  const syntaxError = localHrefSyntaxError(href);
  if (syntaxError) throw new Error(`${syntaxError}: ${JSON.stringify(href)}`);

  const abs = path.resolve(path.dirname(sourceAbs), href);
  const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
  if (!isInside(resolvedRoot, abs)) {
    throw new Error(`href resolves outside public corpus: ${JSON.stringify(href)}`);
  }
  if (!fs.existsSync(abs)) throw new Error(`href target does not exist: ${JSON.stringify(href)}`);
  requireUnlinkedTargetPath(resolvedRoot, abs);
  const realRoot = fs.realpathSync(resolvedRoot);
  const realTarget = fs.realpathSync(abs);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`href target physically resolves outside public corpus: ${JSON.stringify(href)}`);
  }
  if (!fs.lstatSync(abs).isFile()) throw new Error(`href target is not a regular file: ${JSON.stringify(href)}`);
  if (resolvedRoot === FIXTURE_ROOT) {
    const canonicalError = canonicalPublicPathError(rel);
    if (canonicalError) throw new Error(canonicalError);
  }
  const extension = path.extname(abs).toLowerCase();
  if (element === 'image' && !IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`image href target has no recognized image extension: ${JSON.stringify(href)}`);
  }
  if (element === 'xref' && extension !== '.dita') {
    throw new Error(`xref target must be a .dita file: ${JSON.stringify(href)}`);
  }
  return { abs, rel };
}

function inspectSvg(source: string): { elementNames: string[]; errors: string[] } {
  const errors: string[] = [];
  if (/<!DOCTYPE\b/i.test(source)) errors.push('DOCTYPE is forbidden');
  if (/<!ENTITY\b/i.test(source)) errors.push('ENTITY is forbidden');

  let doc;
  try {
    doc = parse(source);
  } catch (error) {
    errors.push(`SVG parse error: ${String(error)}`);
    return { elementNames: [], errors };
  }

  const nodes = [...walk(doc.children)];
  for (const node of nodes) {
    if (node.type === 'doctype' && !errors.includes('DOCTYPE is forbidden')) {
      errors.push('DOCTYPE is forbidden');
    }
    if (node.type === 'pi') errors.push(`non-XML processing instruction is forbidden: ${node.target}`);
  }

  const topElements = doc.children.filter(isElement);
  if (topElements.length !== 1) errors.push(`SVG must have exactly one top-level element; found ${topElements.length}`);
  const root = topElements.length === 1 ? topElements[0] : undefined;
  if (root?.name !== 'svg') errors.push('top-level SVG root must be case-sensitive <svg>');

  const xmlDeclarations = nodes.filter((node) => node.type === 'xmldecl');
  if (xmlDeclarations.length > 1) {
    errors.push(`at most one XML declaration is allowed; found ${xmlDeclarations.length}`);
  }
  for (const declaration of xmlDeclarations) {
    const raw = source.slice(declaration.range.start, declaration.range.end);
    if (
      declaration.parent !== null ||
      declaration.range.start !== 0 ||
      !/^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>$/.test(raw)
    ) {
      errors.push(`invalid XML declaration outside SVG root: ${raw}`);
    }
  }

  for (const node of doc.children) {
    if (node === root) continue;
    if (node.type === 'text') {
      if (node.raw.trim()) errors.push('non-whitespace text is forbidden outside the SVG root');
      continue;
    }
    if (node.type === 'comment') continue;
    if (node.type === 'xmldecl') continue;
    if (node.type === 'element') errors.push(`unexpected top-level element outside SVG root: ${node.name}`);
    else if (node.type !== 'doctype' && node.type !== 'pi') errors.push(`unexpected top-level ${node.type} node`);
  }
  const elements = nodes.filter(isElement);
  const elementNames = elements.map((element) => element.name.toLowerCase());
  const distinct = [...new Set(elementNames)].sort();
  const exactSvgElements = elements.filter((element) => element.name === 'svg');
  if (exactSvgElements.length !== 1) {
    errors.push(`SVG must contain exactly one case-sensitive <svg> element; found ${exactSvgElements.length}`);
  }
  const namespaceAttrs = root?.attrs.filter((attr) => attr.name === 'xmlns') ?? [];
  if (namespaceAttrs.length !== 1 || namespaceAttrs[0]?.value !== SVG_NAMESPACE) {
    errors.push('top-level SVG root must declare exactly one canonical xmlns');
  }
  for (const required of ALLOWED_SVG_ELEMENTS) {
    if (!distinct.includes(required)) errors.push(`missing required SVG element: ${required}`);
  }
  for (const element of elements) {
    const normalizedName = element.name.toLowerCase();
    if (FORBIDDEN_SVG_ELEMENTS.has(normalizedName)) errors.push(`forbidden SVG element: ${normalizedName}`);
    if (!ALLOWED_SVG_ELEMENTS.includes(element.name)) errors.push(`unexpected SVG element: ${element.name}`);
  }

  for (const element of elements) {
    const name = element.name.toLowerCase();
    const allowedAttrs = SVG_ATTRIBUTE_ALLOWLIST[name];
    const valueRules = SVG_ATTRIBUTE_VALUE_RULES[name];
    for (const attr of element.attrs) {
      if (!allowedAttrs?.has(attr.name)) errors.push(`unexpected SVG attribute: ${name}@${attr.name}`);
      if (/&(?:#\d+|#x[0-9a-f]+|[a-z_][\w.-]*);/i.test(attr.value)) {
        errors.push(`entity reference is forbidden in ${name}@${attr.name}`);
      }
      const valueRule = valueRules?.[attr.name];
      if (valueRule === undefined) errors.push(`no safe SVG value grammar for ${name}@${attr.name}`);
      else if (typeof valueRule === 'string' ? attr.value !== valueRule : !valueRule.test(attr.value)) {
        errors.push(`unsafe SVG attribute value for ${name}@${attr.name}: ${attr.value}`);
      }
      if (name === 'svg' && attr.name === 'xmlns' && attr.value === SVG_NAMESPACE) continue;
      if (/url\s*\(/i.test(attr.value)) errors.push(`url(...) is forbidden in ${name}@${attr.name}`);
      if (/javascript:/i.test(attr.value)) errors.push(`javascript: is forbidden in ${name}@${attr.name}`);
      if (/data:/i.test(attr.value)) errors.push(`data: is forbidden in ${name}@${attr.name}`);
      if (/\/\//.test(attr.value)) errors.push(`protocol-relative resource is forbidden in ${name}@${attr.name}`);
      if (/[a-z][a-z0-9+.-]*:/i.test(attr.value)) errors.push(`URI scheme is forbidden in ${name}@${attr.name}`);
    }
  }

  return { elementNames, errors };
}

describe('portable public corpus helper contract', () => {
  test('exports one portable default root and one trimmed environment override', async () => {
    const {
      PUBLIC_CORPUS_DIR,
      resolveCorpusDir,
      usesExternalCorpus,
    } = await corpusApi();

    expect(PUBLIC_CORPUS_DIR).toBe(FIXTURE_ROOT);
    expect(path.isAbsolute(PUBLIC_CORPUS_DIR)).toBe(true);
    expect(resolveCorpusDir({})).toBe(FIXTURE_ROOT);
    expect(resolveCorpusDir({ DITAEDITOR_CORPUS_DIR: '   ' })).toBe(FIXTURE_ROOT);
    expect(resolveCorpusDir({ DITAEDITOR_CORPUS_DIR: '  test/fixtures/corpus  ' })).toBe(
      path.resolve('test/fixtures/corpus'),
    );
    expect(usesExternalCorpus({})).toBe(false);
    expect(usesExternalCorpus({ DITAEDITOR_CORPUS_DIR: '\t' })).toBe(false);
    expect(usesExternalCorpus({ DITAEDITOR_CORPUS_DIR: FIXTURE_ROOT })).toBe(true);
  });

  test('missing roots throw a diagnostic containing the resolved path', async () => {
    const { listCorpusPaths, loadCorpusFiles } = await corpusApi();
    const missing = path.resolve(import.meta.dir, 'fixtures/absent-public-corpus');
    expect(() => listCorpusPaths(missing)).toThrow(missing);
    expect(() => loadCorpusFiles(missing)).toThrow(missing);
  });

  test('lists and loads the complete committed DITA inventory deterministically', async () => {
    const { listCorpusPaths, loadCorpusFiles } = await corpusApi();
    const paths = listCorpusPaths();
    expect(paths.map((abs) => path.relative(FIXTURE_ROOT, abs).split(path.sep).join('/'))).toEqual(
      EXPECTED_DITA_FILES,
    );
    expect(paths.every(path.isAbsolute)).toBe(true);

    const files = loadCorpusFiles();
    expect(files.map((file) => file.rel)).toEqual(EXPECTED_DITA_FILES);
    expect(files.map((file) => file.abs)).toEqual(paths);
    for (const file of files) {
      expect(file.source).toBe(fs.readFileSync(file.abs, 'utf8'));
    }
  });
});

describe('committed public corpus coverage contract', () => {
  test('has the exact fixture inventory, including the original SVG asset', () => {
    expect(allRelativeFiles(FIXTURE_ROOT)).toEqual(EXPECTED_FILES);
  });

  test('exercises topic, concept, task, and reference roots', () => {
    expect([
      rootName(sourceAt('topic/mixed-inline.dita')),
      rootName(sourceAt('concept/basic-concept.dita')),
      rootName(sourceAt('task/steps-task.dita')),
      rootName(sourceAt('reference/basic-reference.dita')),
    ]).toEqual(['topic', 'concept', 'task', 'reference']);
  });

  test('specialized concept and reference fixtures contain their required body elements', () => {
    const concept = parse(sourceAt('concept/basic-concept.dita'));
    const reference = parse(sourceAt('reference/basic-reference.dita'));
    expect(findElements(concept, 'conbody')).toHaveLength(1);
    expect(findElements(reference, 'refbody')).toHaveLength(1);
  });

  test('every xref and image href is a local relative reference to a committed regular file', () => {
    const checked: Array<{ sourceRel: string; element: 'xref' | 'image'; targetRel: string }> = [];
    for (const sourceRel of EXPECTED_DITA_FILES) {
      const sourceAbs = path.join(FIXTURE_ROOT, sourceRel);
      const doc = parse(sourceAt(sourceRel));
      for (const element of ['xref', 'image'] as const) {
        for (const node of findElements(doc, element)) {
          const href = node.attrs.find((attr) => attr.name === 'href')?.value;
          if (href === undefined) throw new Error(`${sourceRel} <${element}> has no href`);
          const target = resolvePublicHref(sourceAbs, href, element);
          checked.push({ sourceRel, element, targetRel: target.rel });
        }
      }
    }

    expect(checked.some((ref) => ref.element === 'xref')).toBe(true);
    expect(checked.some((ref) => ref.element === 'image')).toBe(true);
    expect(
      checked.find((ref) => ref.sourceRel === 'topic/mixed-inline.dita' && ref.element === 'xref')?.targetRel,
    ).toBe('concept/basic-concept.dita');
  });

  test('local href syntax guard rejects remote, absolute, query, fragment, drive, UNC, and empty references', () => {
    const rejected = [
      '',
      '   ',
      'https://example.invalid/file.dita',
      'data:image/svg+xml;base64,AAAA',
      '//example.invalid/file.dita',
      '/tmp/file.dita',
      'C:\\private\\file.dita',
      '\\\\server\\share\\file.dita',
      '../concept/basic-concept.dita#missing-id',
      '../concept/basic-concept.dita?view=full',
    ];
    for (const href of rejected) expect(localHrefSyntaxError(href)).toBeDefined();
    expect(localHrefSyntaxError('../concept/basic-concept.dita')).toBeUndefined();
  });

  test('local href resolver rejects corpus escapes, missing targets, and directories', () => {
    const sourceAbs = path.join(FIXTURE_ROOT, 'topic/mixed-inline.dita');
    expect(() => resolvePublicHref(sourceAbs, '../../../outside.dita', 'xref')).toThrow(/outside public corpus/);
    expect(() => resolvePublicHref(sourceAbs, 'missing.dita', 'xref')).toThrow(/does not exist/);
    expect(() => resolvePublicHref(sourceAbs, '..', 'xref')).toThrow(/not a regular file/);
  });

  test('reference target semantics reject DITA images and non-DITA xrefs', () => {
    const sourceAbs = path.join(FIXTURE_ROOT, 'topic/mixed-inline.dita');
    expect(() => resolvePublicHref(sourceAbs, '../concept/basic-concept.dita', 'image')).toThrow(
      /recognized image extension/,
    );
    expect(() => resolvePublicHref(sourceAbs, '../media/images/example-diagram.svg', 'xref')).toThrow(
      /must be a \.dita file/,
    );
  });

  test('default public references require exact canonical inventory paths', () => {
    const sourceAbs = path.join(FIXTURE_ROOT, 'topic/mixed-inline.dita');
    const wrongCaseRel = 'concept/Basic-Concept.dita';
    expect(canonicalPublicPathError(wrongCaseRel)).toContain('not an exact canonical public inventory path');
    expect(() => resolvePublicHref(sourceAbs, `../${wrongCaseRel}`, 'xref')).toThrow(
      /does not exist|not an exact canonical public inventory path/,
    );
  });

  test('inventory and href resolution reject linked roots and intermediate directory escapes', () => {
    const temp = fs.mkdtempSync(path.join(tmpdir(), 'ditaeditor-public-corpus-'));
    try {
      const corpusRoot = path.join(temp, 'corpus');
      const topicDir = path.join(corpusRoot, 'topic');
      const insideDir = path.join(corpusRoot, 'inside');
      const outsideDir = path.join(temp, 'outside');
      const sourceAbs = path.join(topicDir, 'source.dita');
      const insideFile = path.join(insideDir, 'inside.dita');
      const outsideFile = path.join(outsideDir, 'outside.dita');
      const linkedDir = path.join(corpusRoot, 'linked');
      const linkedInsideDir = path.join(corpusRoot, 'linked-inside');
      const linkedRoot = path.join(temp, 'linked-corpus-root');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.mkdirSync(topicDir, { recursive: true });
      fs.mkdirSync(insideDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(sourceAbs, '<topic/>', 'utf8');
      fs.writeFileSync(insideFile, '<topic/>', 'utf8');
      fs.writeFileSync(outsideFile, '<topic/>', 'utf8');
      fs.symlinkSync(outsideDir, linkedDir, linkType);
      fs.symlinkSync(insideDir, linkedInsideDir, linkType);
      fs.symlinkSync(corpusRoot, linkedRoot, linkType);

      expect(() => allRelativeFiles(corpusRoot)).toThrow(/unsupported filesystem entry: linked/);
      expect(() => allRelativeFiles(linkedRoot)).toThrow(/root is not a real directory/);
      expect(() => allRelativeFiles(sourceAbs)).toThrow(/root is not a real directory/);
      expect(() => resolvePublicHref(sourceAbs, 'topic/source.dita', 'xref', linkedRoot)).toThrow(
        /root is not a real directory/,
      );
      expect(() => resolvePublicHref(sourceAbs, '../linked/outside.dita', 'xref', corpusRoot)).toThrow(
        /linked filesystem entry/,
      );
      expect(() => resolvePublicHref(sourceAbs, '../linked-inside/inside.dita', 'xref', corpusRoot)).toThrow(
        /linked filesystem entry/,
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  test('exercises mixed inline markup plus nested lists, note, codeblock, and lines', () => {
    const inline = parse(sourceAt('topic/mixed-inline.dita'));
    for (const name of ['b', 'i', 'u', 'line-through', 'sub', 'sup', 'codeph', 'ph', 'xref']) {
      expect(findElements(inline, name).length).toBeGreaterThan(0);
    }

    const blocks = parse(sourceAt('topic/lists-notes-code-lines.dita'));
    const nestedOrderedList = findElements(blocks, 'ol').find((orderedList) => {
      let ancestor = orderedList.parent;
      while (ancestor) {
        if (ancestor.name === 'ul') return true;
        ancestor = ancestor.parent;
      }
      return false;
    });
    expect(nestedOrderedList).toBeDefined();
    for (const name of ['note', 'codeblock', 'lines']) {
      expect(findElements(blocks, name).length).toBeGreaterThan(0);
    }
  });

  test('exercises authored image alt text and an original local SVG', () => {
    const imageTopic = parse(sourceAt('media/image-figure.dita'));
    const image = findElements(imageTopic, 'image')[0];
    expect(attrValue(image, 'href')).toBe('images/example-diagram.svg');
    expect(findElements(imageTopic, 'alt').some((alt) => alt.parent === image)).toBe(true);

    const svg = sourceAt('media/images/example-diagram.svg');
    const inspection = inspectSvg(svg);
    const privateBrand = ['eti', 'had'].join('');
    expect(svg).not.toMatch(new RegExp(`logo|${privateBrand}|airways`, 'i'));
    expect(inspection.errors).toEqual([]);
    expect([...new Set(inspection.elementNames)].sort()).toEqual(ALLOWED_SVG_ELEMENTS);
    for (const forbidden of ['image', 'use', 'foreignobject', 'script']) {
      expect(inspection.elementNames).not.toContain(forbidden);
    }
  });

  test('parsed SVG contract rejects embedded, copied, and active content', () => {
    const externalValues = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect fill="url(https://example.invalid/a.svg)"/>` +
      '<line stroke="//example.invalid/line"/><circle fill="data:image/png;base64,AAAA"/></svg>',
    ).errors;
    expect(externalValues.some((error) => error.includes('url(...)'))).toBe(true);
    expect(externalValues.some((error) => error.includes('URI scheme'))).toBe(true);
    expect(externalValues.some((error) => error.includes('protocol-relative'))).toBe(true);
    expect(externalValues.some((error) => error.includes('data:'))).toBe(true);

    const declarationErrors = inspectSvg(
      `<!DOCTYPE svg [<!ENTITY ext SYSTEM "https://example.invalid/ext">]>` +
      `<svg xmlns="${SVG_NAMESPACE}"><title>&ext;</title><desc/><rect/><line/><circle/></svg>`,
    ).errors;
    expect(declarationErrors).toContain('DOCTYPE is forbidden');
    expect(declarationErrors).toContain('ENTITY is forbidden');

    const commentedGeometry = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><!-- <rect/><circle/> --><line/></svg>`,
    ).errors;
    expect(commentedGeometry).toContain('missing required SVG element: rect');
    expect(commentedGeometry).toContain('missing required SVG element: circle');

    const activeContent = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}" onload="run()"><title/><desc/><rect/><line/><circle/><script/></svg>`,
    ).errors;
    expect(activeContent).toContain('unexpected SVG attribute: svg@onload');
    expect(activeContent).toContain('forbidden SVG element: script');

    const processingInstruction = inspectSvg(
      `<?audit mode="active"?><svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect/><line/><circle/></svg>`,
    ).errors;
    expect(processingInstruction.some((error) => error.includes('processing instruction'))).toBe(true);
  });

  test('parsed SVG root and value grammars reject entity, CSS, namespace, case, and root attacks', () => {
    const safeGeometry = `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect/><line/><circle/></svg>`;
    expect(inspectSvg(`<?xml version="1.0" encoding="UTF-8"?>${safeGeometry}`).errors).toEqual([]);

    const numericEntity = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect fill="&#x75;rl(//host/a.svg)"/>` +
      '<line/><circle/></svg>',
    ).errors;
    expect(numericEntity.some((error) => error.includes('entity reference'))).toBe(true);

    const cssEscape = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect fill="\\75 rl(//host/a.svg)"/>` +
      '<line/><circle/></svg>',
    ).errors;
    expect(cssEscape.some((error) => error.includes('unsafe SVG attribute value for rect@fill'))).toBe(true);

    const missingNamespace = inspectSvg('<svg><title/><desc/><rect/><line/><circle/></svg>').errors;
    expect(missingNamespace).toContain('top-level SVG root must declare exactly one canonical xmlns');

    const upperCaseRoot = inspectSvg(
      `<SVG xmlns="${SVG_NAMESPACE}"><title/><desc/><rect/><line/><circle/></SVG>`,
    ).errors;
    expect(upperCaseRoot).toContain('top-level SVG root must be case-sensitive <svg>');

    const multipleRoots = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><title/><desc/><rect/><line/><circle/></svg>` +
      `<svg xmlns="${SVG_NAMESPACE}"/>`,
    ).errors;
    expect(multipleRoots.some((error) => error.includes('exactly one top-level element'))).toBe(true);

    const duplicateNamespace = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}" xmlns="${SVG_NAMESPACE}"><title/><desc/><rect/><line/><circle/></svg>`,
    ).errors;
    expect(duplicateNamespace).toContain('top-level SVG root must declare exactly one canonical xmlns');

    const nestedDeclaration = inspectSvg(
      `<svg xmlns="${SVG_NAMESPACE}"><?xml version="1.0"?><title/><desc/><rect/><line/><circle/></svg>`,
    ).errors;
    expect(nestedDeclaration.some((error) => error.includes('invalid XML declaration outside SVG root'))).toBe(true);

    const invalidDeclaration = inspectSvg(`<?xml version="1.1"?>${safeGeometry}`).errors;
    expect(invalidDeclaration.some((error) => error.includes('invalid XML declaration outside SVG root'))).toBe(true);
  });

  test('exercises ordinary, dense, horizontal, vertical, image-bearing, and noncanonical CALS tables', () => {
    const ordinary = parse(sourceAt('tables/ordinary-table.dita'));
    const ordinaryTgroup = findElements(ordinary, 'tgroup')[0];
    const ordinaryEntries = findElements(ordinary, 'entry');
    expect(ordinaryTgroup?.parent?.name).toBe('table');
    expect(ordinaryEntries.length).toBeGreaterThanOrEqual(6);
    expect(
      ordinaryEntries.some((entry) => ['namest', 'nameend', 'morerows'].some((name) => attrValue(entry, name) !== undefined)),
    ).toBe(false);

    const spanned = parse(sourceAt('tables/spanned-table.dita'));
    const spannedTgroup = findElements(spanned, 'tgroup')[0];
    const spannedEntries = findElements(spanned, 'entry');
    expect(spannedTgroup?.parent?.name).toBe('table');
    expect(
      spannedEntries.some((entry) => attrValue(entry, 'namest') !== undefined && attrValue(entry, 'nameend') !== undefined),
    ).toBe(true);
    expect(spannedEntries.some((entry) => attrValue(entry, 'morerows') !== undefined)).toBe(true);

    const mixedImage = parse(sourceAt('tables/mixed-image-table.dita'));
    const mixedImageTgroup = findElements(mixedImage, 'tgroup')[0];
    const mixedImageEntry = findElements(mixedImage, 'entry').find(
      (entry) =>
        entry.children.some((child) => child.type === 'text' && child.raw.trim().length > 0) &&
        entry.children.some((child) => isElement(child) && child.name === 'image'),
    );
    expect(mixedImageTgroup?.parent?.name).toBe('table');
    expect(mixedImageEntry).toBeDefined();

    const noncanonicalSource = sourceAt('tables/noncanonical-colspec.dita');
    const noncanonical = parse(noncanonicalSource);
    const noncanonicalTgroup = findElements(noncanonical, 'tgroup')[0];
    const detailsColspec = findElements(noncanonical, 'colspec').find(
      (colspec) => attrValue(colspec, 'colname') === 'details',
    );
    expect(noncanonicalTgroup?.parent?.name).toBe('table');
    expect(attrValue(detailsColspec, 'colwidth')).toBe('3*');
    expect(detailsColspec?.attrs.find((attr) => attr.name === 'colname')?.quote).toBe("'");
    expect(noncanonicalSource).toContain("colname='details'");
    expect(noncanonicalSource).toContain('colwidth="3*"');

    const dense = parse(sourceAt('performance/large-table.dita'));
    const denseTgroup = findElements(dense, 'tgroup')[0];
    expect(denseTgroup?.parent?.name).toBe('table');
    expect(findElements(dense, 'entry')).toHaveLength(72);
  });

  test('exercises comments, entities, alternate quote styles, and non-default indentation', () => {
    const lexical = sourceAt('lexical/comments-entities-quotes.dita');
    const lexicalDoc = parse(lexical);
    const topic = findElements(lexicalDoc, 'topic')[0];
    const comments = [...walk(lexicalDoc.children)].filter((node) => node.type === 'comment');
    expect(topic).toBeDefined();
    expect(findElements(lexicalDoc, 'p')).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect(topic?.attrs.find((attr) => attr.name === 'id')?.quote).toBe("'");
    expect(topic?.attrs.find((attr) => attr.name === 'outputclass')?.quote).toBe('"');
    expect(lexical).toContain('<!-- lexical preservation marker -->');
    expect(lexical).toContain('&amp;');
    expect(lexical).toContain('&#x2014;');
    expect(lexical).toMatch(/\bid='[^']+'/);
    expect(lexical).toMatch(/\boutputclass="[^"]+"/);
    expect(lexical).toContain('\n    <body>\n        <p>');
  });

  test('keeps deterministic performance shapes bounded and reviewable', () => {
    const largeTopic = sourceAt('performance/large-topic.dita');
    const largeTable = sourceAt('performance/large-table.dita');
    const topicBytes = Buffer.byteLength(largeTopic, 'utf8');
    const tableBytes = Buffer.byteLength(largeTable, 'utf8');

    expect(topicBytes).toBeGreaterThanOrEqual(2_500);
    expect(topicBytes).toBeLessThanOrEqual(15_000);
    expect(elementCount(largeTopic)).toBeGreaterThanOrEqual(60);
    expect(elementCount(largeTopic)).toBeLessThanOrEqual(180);
    expect(tableBytes).toBeGreaterThanOrEqual(3_000);
    expect(tableBytes).toBeLessThanOrEqual(15_000);
    expect(elementCount(largeTable)).toBeGreaterThanOrEqual(90);
    expect(elementCount(largeTable)).toBeLessThanOrEqual(220);
    expect(findElements(parse(largeTable), 'entry')).toHaveLength(72);
  });
});
