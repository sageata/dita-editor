// Read-only paired rendering for Review Changes. The structural diff remains the
// source of truth; this module only projects its aligned blocks into two cells in
// the same DOM row. Because both cells live in one document flow, the webview has
// one vertical scrollbar and cannot drift like two independently-scrolled panes.

import type { Document, ElementNode } from '../cst/types';
import { isElement } from '../cst/types';
import { deriveTableNames, renderFragment } from '../render/to-html';
import {
  diffTopics,
  topicRootChange,
  type BlockChange,
  type ChangeKind,
  type TopicRootChange,
} from './block-diff';

export interface SideBySideResult {
  html: string;
}

interface CompareRow {
  id: string;
  kind: ChangeKind;
  oldEl?: ElementNode;
  newEl?: ElementNode;
  oldAncestors: ElementNode[];
  newAncestors: ElementNode[];
  moveId?: number;
  nestedKinds?: ChangeKind[];
}

interface RenderContext {
  oldTableNames: Map<ElementNode, string>;
  newTableNames: Map<ElementNode, string>;
  idPrefix: string;
}

function rootElement(doc: Document): ElementNode | undefined {
  return doc.children.find((node): node is ElementNode => isElement(node));
}

const TRANSPARENT_CONTAINERS = new Set(['body', 'conbody', 'taskbody', 'refbody', 'section']);

function nestedLeafKinds(change: BlockChange): ChangeKind[] {
  const kinds = new Set<ChangeKind>();
  const visit = (item: BlockChange): void => {
    if (item.kind === 'same') return;
    if (item.kind === 'modified' && item.children && item.children.length > 0) {
      item.children.forEach(visit);
      return;
    }
    kinds.add(item.kind);
  };
  change.children?.forEach(visit);
  return [...kinds];
}

function canFlatten(change: BlockChange): boolean {
  const recursivePair = change.kind === 'modified'
    && change.children !== undefined
    && change.children.length > 0
    && change.oldEl !== undefined
    && change.newEl !== undefined
    && change.oldEl.name === change.newEl.name;
  if (!recursivePair) return false;
  // Only layout-transparent document shells may disappear into aligned child
  // rows. Lists, tables, figures, and other semantic containers stay whole so
  // numbering, captions, header associations, and grouping remain intact;
  // nestedLeafKinds exposes their precise inner change types as badges.
  return TRANSPARENT_CONTAINERS.has(change.newEl!.name);
}

function flattenChanges(
  changes: BlockChange[],
  oldAncestors: ElementNode[],
  newAncestors: ElementNode[],
  sequence: { value: number },
): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const change of changes) {
    if (canFlatten(change)) {
      rows.push(...flattenChanges(
        change.children!,
        [...oldAncestors, change.oldEl!],
        [...newAncestors, change.newEl!],
        sequence,
      ));
      continue;
    }
    sequence.value += 1;
    rows.push({
      id: `comparison-row-${sequence.value}`,
      kind: change.kind,
      oldEl: change.oldEl,
      newEl: change.newEl,
      oldAncestors,
      newAncestors,
      moveId: change.moveId,
      nestedKinds: change.kind === 'modified' && change.children
        ? nestedLeafKinds(change)
        : undefined,
    });
  }
  return rows;
}

function withAncestorShells(
  element: ElementNode,
  ancestors: ElementNode[],
  tableNames: Map<ElementNode, string>,
): ElementNode {
  let wrapped = element;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    wrapped = { ...ancestor, children: [wrapped] };
    const tableName = tableNames.get(ancestor);
    if (tableName !== undefined) tableNames.set(wrapped, tableName);
  }
  return wrapped;
}

function renderedElement(
  element: ElementNode | undefined,
  ancestors: ElementNode[],
  tableNames: Map<ElementNode, string>,
  tableHeaderIdPrefix: string,
): string {
  if (!element) return '';
  return renderFragment([withAncestorShells(element, ancestors, tableNames)], {
    tableNames,
    tableHeaderIdPrefix,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kindLabel(kind: ChangeKind, side: 'old' | 'new'): string {
  switch (kind) {
    case 'inserted': return side === 'new' ? 'Inserted' : '';
    case 'deleted': return side === 'old' ? 'Deleted' : '';
    case 'modified': return 'Changed';
    case 'formatChanged': return 'Formatting changed';
    case 'movedFrom': return side === 'old' ? 'Moved from here' : '';
    case 'movedTo': return side === 'new' ? 'Moved here' : '';
    case 'same': return '';
  }
}

function placeholder(label: string): string {
  return `<div class="redline-compare-placeholder" aria-label="${escapeHtml(label)}"></div>`;
}

function renderCell(row: CompareRow, side: 'old' | 'new', context: RenderContext): string {
  const element = side === 'old' ? row.oldEl : row.newEl;
  const ancestors = side === 'old' ? row.oldAncestors : row.newAncestors;
  const tableNames = side === 'old' ? context.oldTableNames : context.newTableNames;
  const labelKinds = row.nestedKinds && row.nestedKinds.length > 0
    ? row.nestedKinds
    : [row.kind];
  const labels = [...new Set(labelKinds.map((kind) => kindLabel(kind, side)).filter(Boolean))];
  const content = element
    ? renderedElement(element, ancestors, tableNames, `dch-${context.idPrefix}${row.id}-${side}-`)
    : placeholder(side === 'old' ? 'No earlier content' : 'No newer content');
  const badge = labels
    .map((label) => `<span class="redline-compare-change-label">${escapeHtml(label)}</span>`)
    .join('');
  const accessibleSide = side === 'old' ? 'Earlier version' : 'Newer version';
  return `<div class="redline-compare-cell" data-redline-side="${side}" aria-label="${accessibleSide}">${badge}${content}</div>`;
}

function renderRow(row: CompareRow, context: RenderContext): string {
  const changed = row.kind === 'same' ? '' : ' data-redline-change tabindex="-1"';
  const move = row.moveId === undefined ? '' : ` data-redline-move="${row.moveId}"`;
  return `<div id="${context.idPrefix}${row.id}" class="redline-compare-row redline-compare-row-${row.kind}"${changed}${move}>`
    + renderCell(row, 'old', context)
    + renderCell(row, 'new', context)
    + '</div>';
}

function renderUnchangedGroup(rows: CompareRow[], groupId: string, context: RenderContext): string {
  const count = rows.length;
  return `<section class="redline-compare-unchanged" data-redline-unchanged-group="${groupId}">`
    + `<button type="button" class="redline-compare-expand" data-redline-expand="${groupId}" aria-expanded="false">`
    + `${count} unchanged section${count === 1 ? '' : 's'}</button>`
    + `<div class="redline-compare-group-rows" hidden data-redline-unchanged-rows="${groupId}">`
    + rows.map((row) => renderRow(row, context)).join('')
    + '</div></section>';
}

function renderRowsWithCollapsedContext(rows: CompareRow[], context: RenderContext): string {
  let html = '';
  let groupSequence = 0;
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== 'same') {
      html += renderRow(rows[index], context);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < rows.length && rows[end].kind === 'same') end += 1;
    const run = rows.slice(index, end);
    const keepAtStart = index > 0 ? 1 : 0;
    const keepAtEnd = end < rows.length ? 1 : 0;
    const collapsedEnd = run.length - keepAtEnd;
    const collapsed = run.slice(keepAtStart, collapsedEnd);

    if (keepAtStart) html += renderRow(run[0], context);
    if (collapsed.length > 0) {
      groupSequence += 1;
      html += renderUnchangedGroup(collapsed, `${context.idPrefix}unchanged-${groupSequence}`, context);
    }
    if (keepAtEnd) html += renderRow(run[run.length - 1], context);
    index = end;
  }
  return html;
}

function rootSummary(element: ElementNode): string {
  const attrs = element.attrs.map((attribute) =>
    `<span><code>${escapeHtml(attribute.name)}</code>=<q>${escapeHtml(attribute.value)}</q></span>`
  ).join('');
  return `<div class="redline-root-metadata"><strong>&lt;${escapeHtml(element.name)}&gt;</strong>${attrs}</div>`;
}

function renderRootChange(change: TopicRootChange, idPrefix: string): string {
  const cell = (side: 'old' | 'new', element: ElementNode | undefined): string => {
    const accessibleSide = side === 'old' ? 'Earlier version' : 'Newer version';
    const showLabel = change.kind === 'modified'
      || change.kind === 'formatChanged'
      || (change.kind === 'inserted' && side === 'new')
      || (change.kind === 'deleted' && side === 'old');
    const content = element
      ? rootSummary(element)
      : placeholder(side === 'old' ? 'No earlier content' : 'No newer content');
    return `<div class="redline-compare-cell" data-redline-side="${side}" aria-label="${accessibleSide}">`
      + `${showLabel ? `<span class="redline-compare-change-label">${change.label}</span>` : ''}${content}</div>`;
  };
  return `<div id="${idPrefix}comparison-root-metadata" class="redline-compare-row redline-compare-row-${change.kind}" data-redline-change tabindex="-1">`
    + cell('old', change.oldEl)
    + cell('new', change.newEl)
    + '</div>';
}

export function renderSideBySide(
  oldDoc: Document,
  newDoc: Document,
  options: { idPrefix?: string } = {},
): SideBySideResult {
  const changes = diffTopics(oldDoc, newDoc);
  const oldRoot = rootElement(oldDoc);
  const newRoot = rootElement(newDoc);
  const context: RenderContext = {
    oldTableNames: deriveTableNames(oldDoc),
    newTableNames: deriveTableNames(newDoc),
    idPrefix: options.idPrefix ?? '',
  };
  const rows = flattenChanges(
    changes,
    oldRoot ? [oldRoot] : [],
    newRoot ? [newRoot] : [],
    { value: 0 },
  );
  const header = '<div class="redline-compare-header">'
    + '<span>Earlier</span><span>Newer</span></div>';
  const rootRow = topicRootChange(oldDoc, newDoc);
  return {
    html: `<div class="redline-side-by-side" data-redline-comparison>${header}`
      + `${rootRow ? renderRootChange(rootRow, context.idPrefix) : ''}${renderRowsWithCollapsedContext(rows, context)}</div>`,
  };
}
