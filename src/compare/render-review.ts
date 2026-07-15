import { parse } from '../cst/parse';
import { renderRedline, type RedlineOptions, type RedlineResult } from './render-redline';
import { renderSideBySide, type SideBySideResult } from './render-side-by-side';

export interface RenderedReviewDocuments {
  inline: RedlineResult;
  sideBySide: SideBySideResult;
}

/** Parse the exact selected source strings once, then feed the same documents
 *  to both Review layouts. This is the pure integration seam used by the host. */
export function renderReviewDocuments(
  oldSource: string,
  newSource: string,
  options?: RedlineOptions,
): RenderedReviewDocuments {
  const oldDocument = parse(oldSource);
  const newDocument = parse(newSource);
  return {
    inline: renderRedline(oldDocument, newDocument, options),
    sideBySide: renderSideBySide(oldDocument, newDocument),
  };
}
