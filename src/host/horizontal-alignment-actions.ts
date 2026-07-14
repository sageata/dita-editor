import { removeAttrs, setAttr } from '../cst/edit';
import { findElementById } from '../cst/element-ids';
import { parse } from '../cst/parse';
import { serialize } from '../cst/serialize';
import { editableElementIds } from '../cst/text-targets';
import type { Document, ElementNode } from '../cst/types';
import type { AttributeActionContext } from './attribute-actions';

export const HORIZONTAL_ALIGNMENT_VALUES = ['', 'left', 'center', 'right', 'justify'] as const;
export type HorizontalAlignment = typeof HORIZONTAL_ALIGNMENT_VALUES[number];

export const MANAGED_ALIGNMENT_CLASS_NAMES = [
  'ditaeditor-align-left',
  'ditaeditor-align-center',
  'ditaeditor-align-right',
  'ditaeditor-align-justify',
] as const;

const MANAGED_ALIGNMENT_CLASSES = new Set<string>(MANAGED_ALIGNMENT_CLASS_NAMES);
const CONTENT_ELEMENT_NAMES = new Set([
  'title',
  'shortdesc',
  'p',
  'li',
  'codeblock',
  'lines',
  'cmd',
]);

export function isHorizontalAlignment(value: unknown): value is HorizontalAlignment {
  return typeof value === 'string' && (HORIZONTAL_ALIGNMENT_VALUES as readonly string[]).includes(value);
}

export function isHorizontalAlignmentElement(
  element: ElementNode,
  wholeEditableElements: ReadonlySet<ElementNode>,
): boolean {
  if (element.name === 'entry' || element.name === 'image') return true;
  if (element.name === 'note') return wholeEditableElements.has(element);
  return CONTENT_ELEMENT_NAMES.has(element.name);
}

export function wholeEditableElementSet(doc: Document): ReadonlySet<ElementNode> {
  return new Set(editableElementIds(doc).keys());
}

function attr(element: ElementNode, name: string): string {
  return element.attrs.find((candidate) => candidate.name === name)?.value ?? '';
}

function managedClassFor(align: HorizontalAlignment): string {
  return align === '' ? '' : `ditaeditor-align-${align}`;
}

function alignedOutputClass(current: string, align: HorizontalAlignment): string {
  const kept = current.split(/\s+/u).filter((token) => token !== '' && !MANAGED_ALIGNMENT_CLASSES.has(token));
  const next = managedClassFor(align);
  if (next) kept.push(next);
  return kept.join(' ');
}

function setElementAttrs(
  element: ElementNode,
  updates: ReadonlyArray<{ name: string; value: string }>,
  source: string,
): void {
  const existing = updates
    .filter((update) => element.attrs.some((candidate) => candidate.name === update.name))
    .sort((left, right) => {
      const leftStart = element.attrs.find((candidate) => candidate.name === left.name)?.valueRange.start ?? -1;
      const rightStart = element.attrs.find((candidate) => candidate.name === right.name)?.valueRange.start ?? -1;
      return rightStart - leftStart;
    });
  const absent = updates.filter((update) => !element.attrs.some((candidate) => candidate.name === update.name));
  for (const update of [...existing, ...absent]) setAttr(element, update.name, update.value, source);
}

function rejectAction(ctx: AttributeActionContext, reason: string): void {
  ctx.announce(reason);
  ctx.postError(reason);
  ctx.pushBody(null, null);
}

/**
 * Apply one horizontal alignment intent to a heterogeneous target set.
 *
 * Every target is resolved and validated before the first CST mutation. The
 * resulting source is serialized once and written through one applyMinimal
 * call, so mixed selections are all-or-nothing and create one canvas undo unit.
 */
export async function applyHorizontalAlignmentToIds(
  ctx: AttributeActionContext,
  ids: string[],
  align: HorizontalAlignment,
): Promise<void> {
  if (!isHorizontalAlignment(align)) {
    rejectAction(ctx, 'The horizontal alignment value is not supported.');
    return;
  }
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) {
    rejectAction(ctx, 'The horizontal alignment targets are invalid.');
    return;
  }

  const source = ctx.document.getText();
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    rejectAction(ctx, 'The current DITA document could not be parsed.');
    return;
  }

  const elements = ids.map((id) => findElementById(doc, id));
  if (!elements.every((element): element is ElementNode => element !== undefined)) {
    rejectAction(ctx, 'One or more horizontal alignment targets are stale.');
    return;
  }
  const wholeEditable = wholeEditableElementSet(doc);
  if (!elements.every((element) => isHorizontalAlignmentElement(element, wholeEditable))) {
    rejectAction(ctx, 'Horizontal alignment is not supported for one or more selected elements.');
    return;
  }
  if (align === 'justify' && elements.some((element) => element.name === 'image')) {
    rejectAction(ctx, 'Images cannot use justified alignment.');
    return;
  }

  let changed = false;
  for (const element of elements) {
    if (element.name === 'entry') {
      const current = attr(element, 'align');
      if (current === align) continue;
      if (align === '') removeAttrs(element, ['align'], source);
      else setAttr(element, 'align', align, source);
      changed = true;
      continue;
    }

    if (element.name === 'image') {
      const currentAlign = attr(element, 'align');
      if (align === '') {
        if (currentAlign === '') continue;
        removeAttrs(element, ['align'], source);
        changed = true;
        continue;
      }
      const currentPlacement = attr(element, 'placement');
      const updates: Array<{ name: string; value: string }> = [];
      if (currentPlacement !== 'break') updates.push({ name: 'placement', value: 'break' });
      if (currentAlign !== align) updates.push({ name: 'align', value: align });
      if (updates.length > 0) {
        setElementAttrs(element, updates, source);
        changed = true;
      }
      continue;
    }

    const current = attr(element, 'outputclass');
    const next = alignedOutputClass(current, align);
    if (next === current.trim()) continue;
    if (next === '') removeAttrs(element, ['outputclass'], source);
    else setAttr(element, 'outputclass', next, source);
    changed = true;
  }

  const focusId = ids.length === 1 ? ids[0] : null;
  if (!changed) {
    ctx.pushBody(focusId, null);
    ctx.announce('Horizontal alignment unchanged.');
    return;
  }

  const ok = await ctx.applyMinimal(serialize(doc));
  if (!ok) return;
  ctx.clearDiagnostics();
  ctx.pushBody(focusId, null);
  const targetCount = ids.length;
  ctx.announce(
    align === ''
      ? `Horizontal alignment cleared on ${targetCount} element${targetCount === 1 ? '' : 's'}.`
      : `Horizontal alignment set to ${align} on ${targetCount} element${targetCount === 1 ? '' : 's'}.`,
  );
}
