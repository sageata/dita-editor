import { childElements } from '../cst/query';
import { parse } from '../cst/parse';
import type { ElementNode } from '../cst/types';
import { diffTopics, type BlockChange } from './block-diff';

export interface ReviewRevertPlan {
  key: string;
  label: string;
  start: number;
  end: number;
  expected: string;
  replacement: string;
}

export interface ReviewRevertPresentation {
  token: string;
  label: string;
}

const TRANSPARENT_CONTAINERS = new Set(['body', 'conbody', 'taskbody', 'refbody', 'section']);

export function reviewChangeKey(change: BlockChange): string {
  const oldRange = change.oldEl
    ? `${change.oldEl.range.start}-${change.oldEl.range.end}`
    : '-';
  const newRange = change.newEl
    ? `${change.newEl.range.start}-${change.newEl.range.end}`
    : '-';
  return `${change.kind}:${oldRange}:${newRange}`;
}

function canFlatten(change: BlockChange): boolean {
  return change.kind === 'modified'
    && change.children !== undefined
    && change.children.length > 0
    && change.oldEl !== undefined
    && change.newEl !== undefined
    && change.oldEl.name === change.newEl.name
    && TRANSPARENT_CONTAINERS.has(change.newEl.name);
}

function elementLabel(change: BlockChange): string {
  const name = change.newEl?.name ?? change.oldEl?.name ?? 'element';
  switch (change.kind) {
    case 'inserted': return `Remove inserted <${name}>`;
    case 'deleted': return `Restore deleted <${name}>`;
    case 'formatChanged': return `Restore formatting of <${name}>`;
    default: return `Restore changed <${name}>`;
  }
}

function elementSiblings(parent: ElementNode | undefined): ElementNode[] {
  return parent ? childElements(parent) : [];
}

function removalRange(element: ElementNode, parent: ElementNode | undefined): { start: number; end: number } {
  const siblings = elementSiblings(parent);
  const index = siblings.indexOf(element);
  if (index >= 0 && index + 1 < siblings.length) {
    return { start: element.range.start, end: siblings[index + 1].range.start };
  }
  if (index > 0) {
    return { start: siblings[index - 1].range.end, end: element.range.end };
  }
  return { start: element.range.start, end: element.range.end };
}

function deletedReplacement(oldSource: string, element: ElementNode, parent: ElementNode | undefined): string {
  const siblings = elementSiblings(parent);
  const index = siblings.indexOf(element);
  if (index >= 0 && index + 1 < siblings.length) {
    return oldSource.slice(element.range.start, siblings[index + 1].range.start);
  }
  if (index > 0) {
    return oldSource.slice(siblings[index - 1].range.end, element.range.end);
  }
  return oldSource.slice(element.range.start, element.range.end);
}

function nearestInsertionOffset(
  changes: readonly BlockChange[],
  index: number,
  newParent: ElementNode | undefined,
): number | undefined {
  for (let cursor = index + 1; cursor < changes.length; cursor += 1) {
    const candidate = changes[cursor];
    if (candidate.oldEl && candidate.newEl) return candidate.newEl.range.start;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = changes[cursor];
    if (candidate.oldEl && candidate.newEl) return candidate.newEl.range.end;
  }
  return newParent?.closeTagRange?.start ?? newParent?.openTagRange.end;
}

function visitChanges(
  changes: readonly BlockChange[],
  oldParent: ElementNode | undefined,
  newParent: ElementNode | undefined,
  oldSource: string,
  newSource: string,
  plans: ReviewRevertPlan[],
): void {
  changes.forEach((change, index) => {
    if (change.kind === 'same' || change.kind === 'movedFrom' || change.kind === 'movedTo') return;
    if (canFlatten(change)) {
      visitChanges(
        change.children!,
        change.oldEl,
        change.newEl,
        oldSource,
        newSource,
        plans,
      );
      return;
    }

    if (change.kind === 'inserted' && change.newEl) {
      const range = removalRange(change.newEl, newParent);
      plans.push({
        key: reviewChangeKey(change),
        label: elementLabel(change),
        start: range.start,
        end: range.end,
        expected: newSource.slice(range.start, range.end),
        replacement: '',
      });
      return;
    }

    if (change.kind === 'deleted' && change.oldEl) {
      const offset = nearestInsertionOffset(changes, index, newParent);
      if (offset === undefined) return;
      plans.push({
        key: reviewChangeKey(change),
        label: elementLabel(change),
        start: offset,
        end: offset,
        expected: '',
        replacement: deletedReplacement(oldSource, change.oldEl, oldParent),
      });
      return;
    }

    if ((change.kind === 'modified' || change.kind === 'formatChanged') && change.oldEl && change.newEl) {
      plans.push({
        key: reviewChangeKey(change),
        label: elementLabel(change),
        start: change.newEl.range.start,
        end: change.newEl.range.end,
        expected: newSource.slice(change.newEl.range.start, change.newEl.range.end),
        replacement: oldSource.slice(change.oldEl.range.start, change.oldEl.range.end),
      });
    }
  });
}

/**
 * Plan one byte-safe edit for each side-by-side row that can be restored without
 * guessing. Root metadata and moves are intentionally omitted.
 */
export function planReviewReverts(oldSource: string, newSource: string): ReviewRevertPlan[] {
  const oldDocument = parse(oldSource);
  const newDocument = parse(newSource);
  const oldRoot = oldDocument.children.find((node): node is ElementNode => node.type === 'element');
  const newRoot = newDocument.children.find((node): node is ElementNode => node.type === 'element');
  const plans: ReviewRevertPlan[] = [];
  visitChanges(diffTopics(oldDocument, newDocument), oldRoot, newRoot, oldSource, newSource, plans);
  return plans;
}
