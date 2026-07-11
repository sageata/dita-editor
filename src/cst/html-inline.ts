import type { CstNode } from './types';
import { makeElement, makeText } from './edit';
import { decodeEntities, type Mark } from './inline-marks';

type Frame = {
  htmlName: string;
  ditaName: string | null;
  attrs: Array<{ name: string; value: string }>;
  selfClosing: boolean;
  children: CstNode[];
  marks?: Mark[];
  blockBreak?: boolean;
};

const HTML_TO_MARK: Record<string, Mark> = {
  strong: 'b',
  b: 'b',
  em: 'i',
  i: 'i',
  u: 'u',
  s: 'line-through',
  strike: 'line-through',
  del: 'line-through',
  code: 'codeph',
  sub: 'sub',
  sup: 'sup',
};

const VOID_HTML = new Set(['br', 'img', 'input', 'meta', 'link']);
const BLOCKISH_HTML = new Set(['p', 'div', 'li']);
const MARK_ORDER: Mark[] = ['b', 'i', 'u', 'line-through', 'codeph', 'sub', 'sup'];

function pushText(frame: Frame, raw: string): void {
  const decoded = decodeHtmlText(raw);
  if (decoded !== '') frame.children.push(makeText(decoded));
}

function decodeHtmlText(raw: string): string {
  return decodeEntities(raw.replace(/&nbsp;/g, '\u00a0'));
}

function attrValue(attrs: Map<string, string>, name: string): string | undefined {
  return attrs.get(name.toLowerCase());
}

function ditaAttrs(attrs: Map<string, string>, fallback: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  const packed = attrValue(attrs, 'data-attrs');
  if (!packed) return fallback;
  try {
    const parsed = JSON.parse(decodeURIComponent(packed));
    if (!Array.isArray(parsed)) return fallback;
    const out: Array<{ name: string; value: string }> = [];
    for (const item of parsed) {
      if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') return fallback;
      out.push({ name: item.name, value: item.value });
    }
    return out;
  } catch {
    return fallback;
  }
}

function hasClass(attrs: Map<string, string>, name: string): boolean {
  return (attrValue(attrs, 'class') ?? '').split(/\s+/).includes(name);
}

function styleMap(attrs: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const style = attrValue(attrs, 'style');
  if (!style) return out;
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim().toLowerCase();
    if (name !== '') out.set(name, value);
  }
  return out;
}

function addMark(out: Mark[], mark: Mark): void {
  if (!out.includes(mark)) out.push(mark);
}

function styledMarks(attrs: Map<string, string>, base?: Mark): Mark[] {
  const out: Mark[] = [];
  if (base) addMark(out, base);
  const style = styleMap(attrs);
  const weight = style.get('font-weight') ?? '';
  if (weight === 'bold' || /^[6-9]00$/.test(weight)) addMark(out, 'b');
  const fontStyle = style.get('font-style') ?? '';
  if (fontStyle.includes('italic') || fontStyle.includes('oblique')) addMark(out, 'i');
  const deco = [
    style.get('text-decoration') ?? '',
    style.get('text-decoration-line') ?? '',
  ].join(' ');
  if (hasClass(attrs, 'u') || /\bunderline\b/.test(deco)) addMark(out, 'u');
  if (hasClass(attrs, 'line-through') || /\bline-through\b/.test(deco)) addMark(out, 'line-through');
  const vertical = style.get('vertical-align') ?? '';
  if (vertical === 'super') addMark(out, 'sup');
  if (vertical === 'sub') addMark(out, 'sub');
  return MARK_ORDER.filter((mark) => out.includes(mark));
}

function frameWithMarks(htmlName: string, marks: Mark[]): Frame {
  return { htmlName, ditaName: null, attrs: [], selfClosing: false, children: [], marks };
}

function pushSoftBreak(nodes: CstNode[]): void {
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') {
    const text = last.newText !== undefined ? last.newText : decodeEntities(last.raw);
    if (text.endsWith('\n')) return;
  }
  nodes.push(makeText('\n'));
}

function trimTrailingSoftBreak(nodes: CstNode[]): void {
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') {
    const text = last.newText !== undefined ? last.newText : decodeEntities(last.raw);
    if (text === '\n') nodes.pop();
  }
}

function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrText = tag.replace(/^<\/?\s*[^\s/>]+/, '').replace(/\/?\s*>$/, '');
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function tagName(tag: string): string {
  const m = /^<\/?\s*([^\s/>]+)/.exec(tag);
  return (m?.[1] ?? '').toLowerCase();
}

function frameForStart(tag: string): Frame | null {
  const htmlName = tagName(tag);
  if (!htmlName) return null;
  if (htmlName === 'br') return { htmlName, ditaName: null, attrs: [], selfClosing: true, children: [makeText('\n')] };
  const attrs = parseAttrs(tag);
  if (htmlName === 'img') {
    const href = attrValue(attrs, 'data-href') ?? attrValue(attrs, 'href') ?? attrValue(attrs, 'src') ?? '';
    return {
      htmlName,
      ditaName: 'image',
      attrs: ditaAttrs(attrs, [{ name: 'href', value: stripCacheBust(href) }]),
      selfClosing: true,
      children: [],
    };
  }
  if (htmlName === 'a' && (attrValue(attrs, 'data-dita') === 'xref' || hasClass(attrs, 'xref'))) {
    const href = attrValue(attrs, 'data-href') ?? attrValue(attrs, 'href') ?? '';
    return { htmlName, ditaName: 'xref', attrs: ditaAttrs(attrs, [{ name: 'href', value: href }]), selfClosing: false, children: [] };
  }
  if (htmlName === 'span' && attrValue(attrs, 'data-dita') === 'ph') {
    const conref = attrValue(attrs, 'data-conref');
    return {
      htmlName,
      ditaName: 'ph',
      attrs: ditaAttrs(attrs, conref ? [{ name: 'conref', value: conref }] : []),
      selfClosing: !!conref,
      children: [],
    };
  }
  const mark = HTML_TO_MARK[htmlName];
  const marks = styledMarks(attrs, mark);
  if (marks.length > 0) return frameWithMarks(htmlName, marks);
  return { htmlName, ditaName: null, attrs: [], selfClosing: false, children: [], blockBreak: BLOCKISH_HTML.has(htmlName) };
}

function stripCacheBust(value: string): string {
  const i = value.indexOf('?v=');
  return i === -1 ? value : value.slice(0, i);
}

function closeFrame(stack: Frame[], htmlName: string): void {
  let idx = stack.length - 1;
  while (idx > 0 && stack[idx].htmlName !== htmlName) idx--;
  if (idx <= 0) return;
  while (stack.length - 1 >= idx) {
    const frame = stack.pop()!;
    appendFrame(stack[stack.length - 1], frame);
    if (frame.htmlName === htmlName) return;
  }
}

function appendFrame(parent: Frame, frame: Frame): void {
  if (frame.marks && frame.marks.length > 0) {
    if (frame.children.length === 0) return;
    let nodes = frame.children;
    for (let i = frame.marks.length - 1; i >= 0; i--) {
      nodes = [makeElement(frame.marks[i], [], nodes)];
    }
    parent.children.push(...nodes);
  } else if (frame.ditaName) {
    if (frame.selfClosing) parent.children.push(makeElement(frame.ditaName, frame.attrs, [], true));
    else if (frame.children.length > 0) parent.children.push(makeElement(frame.ditaName, frame.attrs, frame.children));
    else if (frame.ditaName === 'xref' && frame.attrs.length > 0) parent.children.push(makeElement(frame.ditaName, frame.attrs, [], true));
  } else if (frame.blockBreak) {
    if (frame.children.length === 0) return;
    if (parent.children.length > 0) pushSoftBreak(parent.children);
    parent.children.push(...frame.children);
    pushSoftBreak(parent.children);
  } else {
    parent.children.push(...frame.children);
  }
}

export function htmlInlineToCst(html: string): CstNode[] {
  const root: Frame = { htmlName: '#root', ditaName: null, attrs: [], selfClosing: false, children: [] };
  const stack: Frame[] = [root];
  const re = /<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const token = m[0];
    const parent = stack[stack.length - 1];
    if (token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      pushText(parent, token);
      continue;
    }
    if (/^<\//.test(token)) {
      closeFrame(stack, tagName(token));
      continue;
    }
    const frame = frameForStart(token);
    if (!frame) continue;
    if (frame.htmlName === 'br') {
      parent.children.push(...frame.children);
      continue;
    }
    const syntaxSelfClosing = /\/\s*>$/.test(token) || VOID_HTML.has(frame.htmlName);
    if (syntaxSelfClosing) appendFrame(parent, frame);
    else stack.push(frame);
  }
  while (stack.length > 1) appendFrame(stack[stack.length - 2], stack.pop()!);
  trimTrailingSoftBreak(root.children);
  return root.children;
}
