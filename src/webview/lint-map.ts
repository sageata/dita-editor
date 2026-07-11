// UX-7 inline lint surfacing: map dita-quality lint issues (raw char offsets)
// onto the positional element ids the canvas renders, so findings can be
// painted in place instead of living only in the Problems panel.

import { parse } from '../cst/parse';
import { assignElementIds } from '../cst/element-ids';
import type { DitaLintIssue } from '../cst/dita-quality';
import type { ElementNode } from '../cst/types';

export interface CanvasLintItem {
  /** data-struct-id / data-cell-id of the deepest element containing the issue. */
  id: string;
  code: string;
  message: string;
}

export function mapLintToIds(source: string, issues: DitaLintIssue[]): CanvasLintItem[] {
  if (!issues.length) return [];
  let ids: Map<ElementNode, string>;
  try {
    ids = assignElementIds(parse(source)) as Map<ElementNode, string>;
  } catch {
    return [];
  }
  const out: CanvasLintItem[] = [];
  for (const issue of issues) {
    let bestId: string | null = null;
    let bestSize = Number.POSITIVE_INFINITY;
    for (const [el, id] of ids) {
      const size = el.range.end - el.range.start;
      if (el.range.start <= issue.start && el.range.end >= issue.end && size < bestSize) {
        bestId = id;
        bestSize = size;
      }
    }
    if (bestId != null) out.push({ id: bestId, code: issue.code, message: issue.message });
  }
  return out;
}
