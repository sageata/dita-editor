// Message contract between the Search DITA Topics webview view and the host.
// Kept free of vscode imports so the protocol is headlessly checkable.

import type { TopicSearchGroup } from '../search/search-controller';

export type TopicSearchClientMessage =
  | { type: 'searchReady' }
  | { type: 'search'; query: string; matchCase: boolean; generation: number }
  | {
      type: 'openMatch';
      uri: string;
      sourceStart: number;
      sourceEnd: number;
      /** Rendered text of the match, for the in-canvas highlight handoff. */
      renderedText: string;
      matchCase: boolean;
    }
  | { type: 'refreshSearch' }
  | {
      type: 'replaceMatch';
      uri: string;
      sourceStart: number;
      sourceEnd: number;
      /** Rendered text the match had at search time — re-verified against the
       *  current source before any edit is applied. */
      renderedText: string;
      replacement: string;
    }
  | { type: 'replaceAll'; query: string; matchCase: boolean; replacement: string };

export interface TopicSearchResultsMessage {
  type: 'searchResults';
  generation: number;
  groups: TopicSearchGroup[];
  totalShown: number;
  truncated: boolean;
  parseFailures: number;
  skippedLarge: number;
  fileCount: number;
  tooShort: boolean;
}

export interface TopicReplaceSummary {
  replaced: number;
  /** Files that received at least one edit. */
  fileCount: number;
  /** Matches skipped because their source span crosses markup. */
  skippedStyled: number;
  /** True when the file changed since the search and nothing was replaced. */
  stale: boolean;
}

export type TopicSearchHostMessage =
  | { type: 'searchBusy'; generation: number }
  | TopicSearchResultsMessage
  | { type: 'searchUnavailable'; reason: string }
  | { type: 'focusSearchInput' }
  | ({ type: 'replaceDone' } & TopicReplaceSummary);
