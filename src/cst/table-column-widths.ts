import { setAttr } from './edit';
import { findElementById } from './element-ids';
import { parse } from './parse';
import { childrenNamed, firstChildNamed } from './query';
import { serialize } from './serialize';
import type { ElementNode } from './types';

const MIN_RATIO = 0.05;

function attrOf(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function normalizeColumnWidthRatios(widths: number[]): number[] {
  if (widths.length < 2) throw new Error('a resizable table must have at least two columns');
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) {
    throw new Error('column widths must be positive finite numbers');
  }

  const total = widths.reduce((sum, width) => sum + width, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('column width total must be positive');

  // Keep the readable DITA convention: an unmodified N-column table is N values of `1*`.
  const scale = widths.length / total;
  return widths.map((width) => Math.max(MIN_RATIO, width * scale));
}

export function formatColumnWidthRatio(value: number): string {
  const rounded = Math.max(MIN_RATIO, Math.round(value * 1000) / 1000);
  const text = rounded.toFixed(3).replace(/\.?0+$/, '');
  return `${text}*`;
}

export function applyTableColumnWidths(source: string, tableId: string, widths: number[]): string {
  const doc = parse(source);
  const table = findElementById(doc, tableId);
  if (!table) throw new Error(`table target not found: ${tableId}`);
  if (table.name !== 'table') throw new Error(`column width target is <${table.name}>, not <table>`);

  const tgroup = firstChildNamed(table, 'tgroup');
  if (!tgroup) throw new Error('table has no tgroup');

  const colspecs = childrenNamed(tgroup, 'colspec');
  if (colspecs.length < 2) throw new Error('table must have at least two colspecs');
  if (widths.length !== colspecs.length) {
    throw new Error(`column width count ${widths.length} does not match colspec count ${colspecs.length}`);
  }

  const next = normalizeColumnWidthRatios(widths).map(formatColumnWidthRatio);
  let changed = false;
  colspecs.forEach((colspec, index) => {
    const value = next[index];
    if (attrOf(colspec, 'colwidth') === value) return;
    setAttr(colspec, 'colwidth', value, doc.source);
    changed = true;
  });

  return changed ? serialize(doc) : source;
}
