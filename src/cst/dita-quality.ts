import { computeGrid, isGridValid } from './table-grid';
import { parse } from './parse';
import { walk } from './query';
import type { CstNode, ElementNode, TextNode } from './types';
import { isElement } from './types';

export type DitaLintCode = 'raw-prose-newline' | 'literal-bullet' | 'invalid-table-grid';

export interface DitaLintIssue {
  code: DitaLintCode;
  message: string;
  element: string;
  start: number;
  end: number;
}

const PROSE_TEXT_ELEMENTS = new Set(['p', 'li', 'entry', 'title', 'shortdesc', 'cmd']);
const LINE_PRESERVING_ELEMENTS = new Set(['lines', 'codeblock', 'pre', 'msgblock', 'screen']);
const BLOCK_ELEMENTS = new Set([
  'topic', 'concept', 'task', 'reference',
  'body', 'conbody', 'taskbody', 'refbody',
  'section', 'note', 'fig',
  'p', 'ul', 'ol', 'li',
  'table', 'tgroup', 'thead', 'tbody', 'row', 'entry',
  'lines', 'codeblock', 'pre', 'msgblock', 'screen',
]);

function attr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function isLinePreserving(el: ElementNode | null | undefined): boolean {
  let cur: ElementNode | null | undefined = el;
  while (cur) {
    if (LINE_PRESERVING_ELEMENTS.has(cur.name) || attr(cur, 'xml:space') === 'preserve') return true;
    cur = cur.parent;
  }
  return false;
}

function stripSourceFormattingEdges(text: string): string {
  return text
    .replace(/^[ \t\r\n]*\r?\n[ \t\r\n]*/, '')
    .replace(/[ \t\r\n]*\r?\n[ \t\r\n]*$/, '');
}

function hasRawInternalNewline(text: string): boolean {
  return stripSourceFormattingEdges(text).includes('\n');
}

function issue(code: DitaLintCode, message: string, el: ElementNode, rangeNode: CstNode): DitaLintIssue {
  return { code, message, element: el.name, start: rangeNode.range.start, end: rangeNode.range.end };
}

function closestProseParent(node: TextNode): ElementNode | null {
  let cur = node.parent;
  while (cur) {
    if (PROSE_TEXT_ELEMENTS.has(cur.name)) return cur;
    if (LINE_PRESERVING_ELEMENTS.has(cur.name)) return null;
    cur = cur.parent;
  }
  return null;
}

export function lintDitaSource(source: string): DitaLintIssue[] {
  const doc = parse(source);
  const issues: DitaLintIssue[] = [];

  for (const node of walk(doc.children)) {
    if (node.type === 'text') {
      const prose = closestProseParent(node);
      if (prose && !isLinePreserving(prose)) {
        if (hasRawInternalNewline(node.raw)) {
          issues.push(issue(
            'raw-prose-newline',
            `Raw line breaks inside <${prose.name}> are source formatting; use <lines> for authored breaks.`,
            prose,
            node,
          ));
        }
        if (node.raw.includes('•')) {
          issues.push(issue(
            'literal-bullet',
            `Literal bullet characters inside <${prose.name}> should be authored as a DITA list.`,
            prose,
            node,
          ));
        }
      }
      continue;
    }

    if (isElement(node) && node.name === 'tgroup') {
      const grid = computeGrid(node);
      if (!isGridValid(grid)) {
        issues.push(issue(
          'invalid-table-grid',
          'CALS table grid does not match tgroup columns, row entries, or spans.',
          node,
          node,
        ));
      }
    }
  }

  return issues;
}

function openTag(el: ElementNode, source: string): string {
  return source.slice(el.openTagRange.start, el.openTagRange.end);
}

function closeTag(el: ElementNode, source: string): string {
  if (!el.closeTagRange) return `</${el.name}>`;
  return source.slice(el.closeTagRange.start, el.closeTagRange.end);
}

function rawNode(node: CstNode, source: string): string {
  return source.slice(node.range.start, node.range.end);
}

function normalizeText(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ');
}

function isInlineContentNode(node: CstNode): boolean {
  return node.type === 'text' || (isElement(node) && !BLOCK_ELEMENTS.has(node.name));
}

function hasOnlyInlineContent(el: ElementNode): boolean {
  return el.children.length === 0 || el.children.every(isInlineContentNode);
}

function formatInline(node: CstNode, source: string): string {
  if (node.type === 'text') return normalizeText(node.raw);
  if (!isElement(node)) return rawNode(node, source);
  if (node.selfClosing) return openTag(node, source);
  return openTag(node, source) + node.children.map((child) => formatInline(child, source)).join('').trim() + closeTag(node, source);
}

function formatElement(el: ElementNode, source: string, level: number): string {
  const indent = '  '.repeat(level);
  const open = openTag(el, source);
  if (el.selfClosing) return `${indent}${open}\n`;

  if (isLinePreserving(el)) {
    return `${indent}${open}${el.children.map((child) => rawNode(child, source)).join('')}${closeTag(el, source)}\n`;
  }

  if (hasOnlyInlineContent(el)) {
    const inner = el.children.map((child) => formatInline(child, source)).join('').trim();
    return `${indent}${open}${inner}${closeTag(el, source)}\n`;
  }

  const body = el.children
    .map((child) => formatNode(child, source, level + 1))
    .filter((part) => part.trim() !== '')
    .join('');
  return `${indent}${open}\n${body}${indent}${closeTag(el, source)}\n`;
}

function formatNode(node: CstNode, source: string, level: number): string {
  if (isElement(node)) return formatElement(node, source, level);
  if (node.type === 'text') return node.raw.trim() === '' ? '' : `${'  '.repeat(level)}${normalizeText(node.raw).trim()}\n`;
  return `${'  '.repeat(level)}${rawNode(node, source).trim()}\n`;
}

export function formatDitaSource(source: string): string {
  const doc = parse(source);
  return doc.children
    .map((node) => formatNode(node, source, 0))
    .filter((part) => part.trim() !== '')
    .join('');
}
