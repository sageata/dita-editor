import { makeElement, makeRawText, markDirty, removeAttrs, setAttr } from '../cst/edit';
import { assignElementIds, findElementById } from '../cst/element-ids';
import { parse } from '../cst/parse';
import { serialize } from '../cst/serialize';
import { childElements } from '../cst/query';
import { leadingWs } from '../cst/tree-edit';
import type { Document, ElementNode } from '../cst/types';
import { applyTransform } from '../cst/structural';
import { indexDocument } from '../commands/validity';
import { planTransform, type TransformType } from '../commands/transform-ops';
import {
  AUTHOR_STYLE_TARGET_LABELS,
  type AuthorStyleTarget,
  isAuthorStyleClassName,
  replaceManagedOutputClass,
} from '../styles/author-styles';
import { transformIntentSpec } from './structural-actions';

export interface StyleActionDocument {
  getText(): string;
}

export interface StyleActionContext {
  document: StyleActionDocument;
  applyMinimal(newSource: string): Promise<boolean>;
  pushBody(focusId: string | null, caretOffset: number | null): void;
  announce(message: string): void;
  postError(message: string): void;
  clearDiagnostics(): void;
  bumpStructVersion?(): void;
}

export async function applyOutputClassStyle(
  ctx: StyleActionContext,
  id: string,
  className: string,
  managedClassNames: string[],
): Promise<void> {
  await applyOutputClassStyleToIds(ctx, [id], className, managedClassNames);
}

export async function applyOutputClassStyleToIds(
  ctx: StyleActionContext,
  ids: string[],
  className: string,
  managedClassNames: string[],
  styleTarget?: string,
): Promise<void> {
  const nextClass = className.trim();
  if (nextClass && !isAuthorStyleClassName(nextClass)) {
    const reason = 'Style class is invalid.';
    ctx.announce(reason);
    ctx.postError(reason);
    return;
  }

  const uniqueIds = [...new Set(ids.filter((value) => typeof value === 'string' && value !== ''))];
  if (!uniqueIds.length) {
    ctx.pushBody(null, null);
    return;
  }

  const prepared = prepareStyleApplication(
    ctx.document.getText(),
    uniqueIds,
    styleTarget,
    nextClass !== '',
  );
  if (prepared.status === 'stale') {
    ctx.pushBody(null, null);
    return;
  }
  if (prepared.status === 'unsupported') {
    const reason = `This element cannot be converted to ${prepared.label}.`;
    ctx.announce(reason);
    ctx.postError(reason);
    return;
  }

  const source = prepared.source;
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    ctx.pushBody(null, null);
    return;
  }

  let changed = prepared.transformed;
  const focusId = uniqueIds.length > 1 ? null : prepared.ids[0] ?? null;
  for (const id of prepared.ids) {
    const el = findElementById(doc, id);
    if (!el) {
      ctx.pushBody(null, null);
      return;
    }

    const current = attr(el, 'outputclass') ?? '';
    const next = replaceManagedOutputClass(current, nextClass, managedClassNames);
    if (next === current.trim()) continue;

    if (next === '') removeAttrs(el, ['outputclass'], source);
    else setAttr(el, 'outputclass', next, source);
    changed = true;
  }

  if (!changed) {
    ctx.pushBody(focusId, null);
    return;
  }

  const ok = await ctx.applyMinimal(serialize(doc));
  if (ok) {
    ctx.clearDiagnostics();
    if (prepared.transformed) ctx.bumpStructVersion?.();
    ctx.pushBody(focusId, null);
    ctx.announce(nextClass ? 'Style applied.' : 'Style cleared.');
  }
}

function attr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

type PreparedStyleApplication =
  | { status: 'ok'; source: string; ids: string[]; transformed: boolean }
  | { status: 'stale' }
  | { status: 'unsupported'; label: string };

function prepareStyleApplication(
  source: string,
  ids: string[],
  styleTarget: string | undefined,
  apply = true,
): PreparedStyleApplication {
  const target = authorStyleTarget(styleTarget);
  if (!target || target === 'all' || ids.length !== 1) {
    return { status: 'ok', source, ids, transformed: false };
  }

  let idx;
  try {
    idx = indexDocument(source);
  } catch {
    return { status: 'ok', source, ids, transformed: false };
  }
  const id = ids[0];
  const el = idx.byId.get(id);
  if (!el) return { status: 'stale' };

  const existing = closestStyleTarget(el, target);
  if (existing) {
    const existingId = idForElement(idx.byId, existing);
    return existingId
      ? { status: 'ok', source, ids: [existingId], transformed: false }
      : { status: 'stale' };
  }

  // Clearing must never create or convert structure — it only strips a managed
  // class from an existing ancestor of the target kind. When no such ancestor
  // exists, fall back to the original id so the strip harmlessly no-ops.
  if (!apply) {
    return { status: 'ok', source, ids, transformed: false };
  }

  if (target === 'heading') {
    return prepareHeadingStyleApplication(source, id, el);
  }
  if (target === 'body' && el.name === 'title') {
    return prepareTitleToParagraphStyleApplication(source, id, el);
  }

  const transform = transformForTarget(target, el);
  if (!transform) return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS[target].toLowerCase() };

  const intent = planTransform(transform, { id }, idx);
  if (intent.status !== 'ok') {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS[target].toLowerCase() };
  }

  let result;
  try {
    result = applyTransform(source, transformIntentSpec(intent, id));
  } catch {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS[target].toLowerCase() };
  }

  const nextIdx = indexDocument(result.source);
  const focused = result.focusId ? nextIdx.byId.get(result.focusId) : undefined;
  const targetEl = focused ? closestStyleTarget(focused, target) : undefined;
  const targetId = targetEl ? idForElement(nextIdx.byId, targetEl) : result.focusId;
  return targetId
    ? { status: 'ok', source: result.source, ids: [targetId], transformed: true }
    : { status: 'stale' };
}

function prepareHeadingStyleApplication(
  source: string,
  id: string,
  indexedEl: ElementNode,
): PreparedStyleApplication {
  if (indexedEl.name !== 'p') {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS.heading.toLowerCase() };
  }

  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    return { status: 'stale' };
  }
  const p = findElementById(doc, id);
  if (!p || p.name !== 'p') return { status: 'stale' };

  const title = paragraphToHeadingTitle(p);
  if (!title) {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS.heading.toLowerCase() };
  }

  const targetId = assignElementIds(doc).get(title);
  return targetId
    ? { status: 'ok', source: serialize(doc), ids: [targetId], transformed: true }
    : { status: 'stale' };
}

function paragraphToHeadingTitle(p: ElementNode): ElementNode | null {
  const parent = p.parent;
  if (!parent) return null;

  if (parent.name === 'section') {
    const elements = childElements(parent);
    if (elements.some((child) => child.name === 'title')) return null;
    if (elements[0] !== p) return null;
    return replaceChildWithTitle(parent, p);
  }

  if (!['body', 'conbody', 'refbody'].includes(parent.name)) return null;

  const idx = parent.children.indexOf(p);
  if (idx < 0) return null;
  const lead = leadingWs(parent.children, idx);
  const title = makeElement('title', [], p.children.slice());
  const section = makeElement('section', [], [
    makeRawText(`${lead}  `),
    title,
    makeRawText(lead),
  ]);
  parent.children[idx] = section;
  section.parent = parent;
  markDirty(parent);
  return title;
}

function replaceChildWithTitle(parent: ElementNode, p: ElementNode): ElementNode | null {
  const idx = parent.children.indexOf(p);
  if (idx < 0) return null;
  const title = makeElement('title', [], p.children.slice());
  parent.children[idx] = title;
  title.parent = parent;
  markDirty(parent);
  return title;
}

function prepareTitleToParagraphStyleApplication(
  source: string,
  id: string,
  indexedEl: ElementNode,
): PreparedStyleApplication {
  if (indexedEl.name !== 'title') {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS.body.toLowerCase() };
  }

  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    return { status: 'stale' };
  }
  const title = findElementById(doc, id);
  if (!title || title.name !== 'title') return { status: 'stale' };

  const paragraph = optionalSectionTitleToParagraph(title);
  if (!paragraph) {
    return { status: 'unsupported', label: AUTHOR_STYLE_TARGET_LABELS.body.toLowerCase() };
  }

  const targetId = assignElementIds(doc).get(paragraph);
  return targetId
    ? { status: 'ok', source: serialize(doc), ids: [targetId], transformed: true }
    : { status: 'stale' };
}

function optionalSectionTitleToParagraph(title: ElementNode): ElementNode | null {
  const section = title.parent;
  if (!section || section.name !== 'section') return null;

  const paragraph = makeElement('p', [], title.children.slice());
  const elementChildren = childElements(section);
  if (elementChildren.length === 1 && elementChildren[0] === title) {
    const parent = section.parent;
    if (!parent || !['body', 'conbody', 'refbody', 'section', 'li', 'entry'].includes(parent.name)) {
      return null;
    }
    const idx = parent.children.indexOf(section);
    if (idx < 0) return null;
    parent.children[idx] = paragraph;
    paragraph.parent = parent;
    markDirty(parent);
    return paragraph;
  }

  const idx = section.children.indexOf(title);
  if (idx < 0) return null;
  section.children[idx] = paragraph;
  paragraph.parent = section;
  markDirty(section);
  return paragraph;
}

function authorStyleTarget(value: string | undefined): AuthorStyleTarget | null {
  if (!value) return null;
  return Object.prototype.hasOwnProperty.call(AUTHOR_STYLE_TARGET_LABELS, value)
    ? value as AuthorStyleTarget
    : null;
}

function idForElement(byId: Map<string, ElementNode>, target: ElementNode): string | null {
  for (const [id, el] of byId) {
    if (el === target) return id;
  }
  return null;
}

function closestStyleTarget(el: ElementNode, target: AuthorStyleTarget): ElementNode | null {
  if (target === 'all') return el;
  if (target === 'title') return el.name === 'title' ? el : null;
  if (target === 'heading') return el.name === 'title' ? el : null;
  if (target === 'body') return el.name === 'p' ? el : null;
  if (target === 'shortdesc') return el.name === 'shortdesc' ? el : null;
  if (target === 'listItem') return el.name === 'li' ? el : null;
  if (target === 'image') return el.name === 'image' ? el : null;
  if (target === 'code') return el.name === 'codeblock' || el.name === 'codeph' ? el : null;
  if (target === 'lines') return el.name === 'lines' ? el : null;

  if (target === 'tableHeadCell' || target === 'tableBodyCell') {
    // Resolve to the nearest enclosing entry, then classify it by whether its own
    // table section is a thead or tbody (CALS: entry < row < thead|tbody < tgroup < table).
    const wantHead = target === 'tableHeadCell';
    for (let cur: ElementNode | null | undefined = el; cur; cur = cur.parent) {
      if (cur.name !== 'entry') continue;
      for (let anc: ElementNode | null | undefined = cur.parent; anc; anc = anc.parent) {
        if (anc.name === 'thead') return wantHead ? cur : null;
        if (anc.name === 'tbody') return wantHead ? null : cur;
        if (anc.name === 'table') break; // left the entry's own section without a match
      }
      return null; // an entry with no thead/tbody section — cannot classify
    }
    return null;
  }

  const namesByTarget: Partial<Record<AuthorStyleTarget, string[]>> = {
    section: ['section'],
    list: ['ul', 'ol'],
    table: ['table'],
    tableRow: ['row'],
    tableCell: ['entry'],
    figure: ['fig'],
    note: ['note'],
  };
  const names = namesByTarget[target];
  if (!names) return null;
  for (let cur: ElementNode | null | undefined = el; cur; cur = cur.parent) {
    if (names.includes(cur.name)) return cur;
  }
  return null;
}

function transformForTarget(target: AuthorStyleTarget, el: ElementNode): TransformType | null {
  if (target === 'body') {
    if (el.name === 'entry') return 'entryToParagraph';
    if (el.name === 'li') return 'itemToParagraph';
    if (el.name === 'lines') return 'linesToParagraph';
    return null;
  }
  if (target === 'list' || target === 'listItem') {
    if (el.name === 'p') return 'paragraphToUnorderedList';
    if (el.name === 'entry') return 'entryToUnorderedList';
    if (el.name === 'lines') return 'linesToUnorderedList';
    return null;
  }
  if (target === 'section') {
    if (el.name === 'p') return 'paragraphToSection';
    if (el.name === 'lines') return 'linesToSection';
    return null;
  }
  if (target === 'note') {
    if (el.name === 'p') return 'paragraphToNote';
    if (el.name === 'entry') return 'entryToNote';
    if (el.name === 'lines') return 'linesToNote';
    return null;
  }
  if (target === 'code') {
    if (el.name === 'p') return 'paragraphToCodeblock';
    if (el.name === 'entry') return 'entryToCodeblock';
    if (el.name === 'lines') return 'linesToCodeblock';
    return null;
  }
  if (target === 'lines') {
    if (el.name === 'entry') return 'entryToLines';
    return null;
  }
  return null;
}
