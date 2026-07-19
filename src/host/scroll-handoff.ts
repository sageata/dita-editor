import { structuralIds, tableCellIds } from '../cst/element-ids';
import { parse } from '../cst/parse';
import type { ElementNode } from '../cst/types';

/** Optional exact-match payload riding on an anchor: the canvas re-finds the
 *  nth occurrence of the rendered text inside the anchored element in its own
 *  DOM (occurrence-count instead of offsets, so host/webview whitespace
 *  normalization can never drift a position) and selects it. A miss falls back
 *  silently to the element-level scroll. */
export interface ScrollAnchorHighlight {
  text: string;
  occurrence: number;
  matchCase: boolean;
}

export interface ScrollAnchor {
  id: string;
  highlight?: ScrollAnchorHighlight;
}

export type ScrollAnchorResult =
  | { ok: true; anchor: ScrollAnchor }
  | { ok: false; reason: string };

export type ScrollOffsetResult =
  | { ok: true; offset: number }
  | { ok: false; reason: string };

interface AddressableElement {
  id: string;
  element: ElementNode;
}

function addressableElements(source: string):
  | { ok: true; elements: AddressableElement[] }
  | { ok: false; reason: string } {
  try {
    const document = parse(source);
    const elements: AddressableElement[] = [];
    for (const [element, descriptor] of structuralIds(document)) {
      elements.push({ id: descriptor.id, element });
    }
    for (const [element, id] of tableCellIds(document)) {
      elements.push({ id, element });
    }
    return { ok: true, elements };
  } catch (error) {
    return {
      ok: false,
      reason: `the current DITA source could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function elementSpan(candidate: AddressableElement): number {
  return candidate.element.range.end - candidate.element.range.start;
}

function isInterElementWhitespace(source: string, offset: number): boolean {
  if (offset >= source.length || !/\s/.test(source[offset])) return false;
  const textStart = source.lastIndexOf('>', offset - 1) + 1;
  const nextTag = source.indexOf('<', offset);
  const textEnd = nextTag === -1 ? source.length : nextTag;
  return textStart <= offset && offset < textEnd && source.slice(textStart, textEnd).trim() === '';
}

export function openingTagOffsetForAnchor(source: string, id: string): ScrollOffsetResult {
  const addressable = addressableElements(source);
  if (!addressable.ok) return addressable;
  const match = addressable.elements.find((candidate) => candidate.id === id);
  if (!match) {
    return {
      ok: false,
      reason: `scroll anchor ${id} is not present in the current DITA document`,
    };
  }
  return { ok: true, offset: match.element.openTagRange.start };
}

export type ScrollRangeResult =
  | { ok: true; range: { start: number; end: number } }
  | { ok: false; reason: string };

/** Full source range of an addressable element, for occurrence counting. */
export function elementRangeForAnchor(source: string, id: string): ScrollRangeResult {
  const addressable = addressableElements(source);
  if (!addressable.ok) return addressable;
  const match = addressable.elements.find((candidate) => candidate.id === id);
  if (!match) {
    return {
      ok: false,
      reason: `scroll anchor ${id} is not present in the current DITA document`,
    };
  }
  return { ok: true, range: { start: match.element.range.start, end: match.element.range.end } };
}

export function anchorAtSourceOffset(source: string, offset: number): ScrollAnchorResult {
  const addressable = addressableElements(source);
  if (!addressable.ok) return addressable;
  if (addressable.elements.length === 0) {
    return { ok: false, reason: 'the current DITA document has no addressable visual elements' };
  }

  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  if (!isInterElementWhitespace(source, boundedOffset)) {
    const containing = addressable.elements
      .filter(({ element }) => element.range.start <= boundedOffset && boundedOffset < element.range.end)
      .sort((left, right) => elementSpan(left) - elementSpan(right))[0];
    if (containing) return { ok: true, anchor: { id: containing.id } };
  }

  const next = addressable.elements
    .filter(({ element }) => element.range.start >= boundedOffset)
    .sort((left, right) =>
      left.element.range.start - right.element.range.start || elementSpan(left) - elementSpan(right))[0];
  if (next) return { ok: true, anchor: { id: next.id } };

  const previous = addressable.elements
    .filter(({ element }) => element.range.end <= boundedOffset)
    .sort((left, right) =>
      right.element.range.end - left.element.range.end || elementSpan(left) - elementSpan(right))[0];
  if (previous) return { ok: true, anchor: { id: previous.id } };

  return { ok: false, reason: 'no visual element could be mapped from the current source position' };
}

/** The three ways a scroll anchor can reach a visual editor, decided purely so
 *  the host wrapper stays thin. A VISIBLE panel gets a direct postMessage (its
 *  webview is live; navready will not re-fire). A HIDDEN panel is queued then
 *  revealed — retainContextWhenHidden is false, so revealing reloads the webview
 *  and the navready handshake consumes the queue. With NO panel the anchor is
 *  queued and the caller must open the editor. */
export interface ScrollAnchorPanel {
  visible: boolean;
  postScrollToAnchor(anchor: ScrollAnchor): void;
  reveal(): void;
}

export type ScrollAnchorDelivery = 'posted' | 'revealed' | 'queued';

export function deliverScrollAnchor(
  panel: ScrollAnchorPanel | null,
  anchor: ScrollAnchor,
  queue: (anchor: ScrollAnchor) => void,
): ScrollAnchorDelivery {
  if (panel && panel.visible) {
    panel.postScrollToAnchor(anchor);
    panel.reveal();
    return 'posted';
  }
  queue(anchor);
  if (panel) {
    panel.reveal();
    return 'revealed';
  }
  return 'queued';
}

export interface ScrollHandoffStore {
  rememberVisualAnchor(uri: string, anchor: ScrollAnchor): void;
  latestVisualAnchor(uri: string): ScrollAnchor | null;
  forgetVisualAnchor(uri: string): void;
  queueVisualRestore(uri: string, anchor: ScrollAnchor): void;
  consumeVisualRestore(uri: string): ScrollAnchor | null;
}

export function createScrollHandoffStore(): ScrollHandoffStore {
  const latestVisualAnchors = new Map<string, ScrollAnchor>();
  const pendingVisualRestores = new Map<string, ScrollAnchor>();
  return {
    rememberVisualAnchor(uri, anchor) {
      latestVisualAnchors.set(uri, anchor);
    },
    latestVisualAnchor(uri) {
      return latestVisualAnchors.get(uri) ?? null;
    },
    forgetVisualAnchor(uri) {
      latestVisualAnchors.delete(uri);
    },
    queueVisualRestore(uri, anchor) {
      pendingVisualRestores.set(uri, anchor);
    },
    consumeVisualRestore(uri) {
      const anchor = pendingVisualRestores.get(uri) ?? null;
      pendingVisualRestores.delete(uri);
      return anchor;
    },
  };
}
