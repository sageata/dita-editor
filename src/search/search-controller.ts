// Workspace search orchestration with injected IO (kept vscode-free so the
// cache, capping, and abort behavior are headlessly testable). The host adapts
// vscode.workspace APIs onto SearchIo; the controller owns everything else.

import type { RenderedTextIndex } from './rendered-text';
import { documentTitle, extractRenderedText } from './rendered-text';
import type { TopicSearchMatch } from './topic-search';
import { findMatches, normalizeQuery } from './topic-search';

export interface FileRef {
  /** Stable identity (URI string) — also the cache key. */
  key: string;
  /** Human-readable label (workspace-relative path). */
  label: string;
}

export interface SearchIo {
  listFiles(): Promise<FileRef[]>;
  /** null when the file no longer exists. */
  stat(ref: FileRef): Promise<{ mtime: number; size: number } | null>;
  read(ref: FileRef): Promise<string>;
  /** Text of an open editor document for this file, when one exists. */
  openDocumentText(ref: FileRef): { text: string; version: number } | null;
}

export interface TopicSearchGroup {
  uri: string;
  label: string;
  title: string | null;
  matches: TopicSearchMatch[];
  /** Matches in this file beyond the per-file cap. */
  moreCount: number;
}

export interface TopicSearchOutcome {
  groups: TopicSearchGroup[];
  totalShown: number;
  truncated: boolean;
  parseFailures: number;
  skippedLarge: number;
  fileCount: number;
  tooShort: boolean;
}

export interface TopicSearchController {
  /** Resolves null when a newer search superseded this generation. */
  search(query: string, matchCase: boolean, generation: number): Promise<TopicSearchOutcome | null>;
  clearCache(): void;
}

const MAX_MATCHES_PER_FILE = 50;
const MAX_TOTAL_MATCHES = 500;
/** Files above this size are skipped by search — and, for parity, by replace. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_QUERY_LENGTH = 2;

interface CacheEntry {
  contentKey: string;
  index: RenderedTextIndex | null; // null: content failed to parse
  title: string | null;
}

export function createTopicSearchController(io: SearchIo): TopicSearchController {
  const cache = new Map<string, CacheEntry>();
  let current = 0;

  async function entryFor(ref: FileRef, counters: { parseFailures: number; skippedLarge: number }):
    Promise<CacheEntry | null> {
    const open = io.openDocumentText(ref);
    let contentKey: string;
    let load: () => Promise<string>;
    if (open) {
      if (open.text.length > MAX_FILE_BYTES) {
        counters.skippedLarge += 1;
        return null;
      }
      contentKey = `doc:${open.version}`;
      load = async () => open.text;
    } else {
      const stat = await io.stat(ref);
      if (!stat) return null; // vanished between list and stat
      if (stat.size > MAX_FILE_BYTES) {
        counters.skippedLarge += 1;
        return null;
      }
      contentKey = `disk:${stat.mtime}:${stat.size}`;
      load = () => io.read(ref);
    }
    const cached = cache.get(ref.key);
    if (cached && cached.contentKey === contentKey) return cached;
    let entry: CacheEntry;
    try {
      const source = await load();
      entry = { contentKey, index: extractRenderedText(source), title: documentTitle(source) };
    } catch {
      // Unparseable (or unreadable) content: cached as a failure so every query
      // reports it in the footer without re-reading the bytes each time.
      entry = { contentKey, index: null, title: null };
    }
    cache.set(ref.key, entry);
    return entry;
  }

  return {
    clearCache: () => cache.clear(),

    async search(query, matchCase, generation) {
      current = generation;
      const outcome: TopicSearchOutcome = {
        groups: [],
        totalShown: 0,
        truncated: false,
        parseFailures: 0,
        skippedLarge: 0,
        fileCount: 0,
        tooShort: false,
      };
      if (normalizeQuery(query).length < MIN_QUERY_LENGTH) {
        outcome.tooShort = true;
        return outcome;
      }
      const files = [...(await io.listFiles())].sort((a, b) => a.label.localeCompare(b.label));
      if (current !== generation) return null;
      outcome.fileCount = files.length;
      for (const ref of files) {
        if (current !== generation) return null;
        const remaining = MAX_TOTAL_MATCHES - outcome.totalShown;
        if (remaining <= 0) {
          outcome.truncated = true;
          break;
        }
        const entry = await entryFor(ref, outcome);
        if (current !== generation) return null;
        if (!entry) continue;
        if (!entry.index) {
          outcome.parseFailures += 1;
          continue;
        }
        const { matches, overflow } = findMatches(
          entry.index, query, matchCase, Math.min(MAX_MATCHES_PER_FILE, remaining));
        if (matches.length === 0) continue;
        outcome.groups.push({
          uri: ref.key,
          label: ref.label,
          title: entry.title,
          matches,
          moreCount: overflow,
        });
        outcome.totalShown += matches.length;
      }
      return outcome;
    },
  };
}
