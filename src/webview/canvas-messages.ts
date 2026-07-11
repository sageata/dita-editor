import type { InsertKind, TableShape } from '../commands/insert-ops';
import type { RangeActionType, RangeRejectCode } from '../commands/range-ops';

export type RangeSelectionKind = 'blockRange' | 'cellRect' | 'multiSet';

export interface RangeSelectionPayload {
  kind: RangeSelectionKind;
  ids: string[];
  anchorId: string | null;
  focusId: string | null;
}

export interface RangeActionAvailability {
  action: RangeActionType;
  enabled: boolean;
  code?: RangeRejectCode | 'unsupported-prespanned';
  reason?: string;
}

export interface RangeAvailabilityMessage {
  type: 'rangeAvailability';
  forIds: string[];
  actions: RangeActionAvailability[];
}

export type InsertPayload =
  | { mode: 'after'; refId: string; table?: TableShape }
  | { mode: 'before'; refId: string; table?: TableShape }
  | { mode: 'into'; containerId: string; table?: TableShape };

export interface InsertAvailability {
  kind: InsertKind;
  enabled: boolean;
  reason?: string;
}

export interface InsertMapEntry {
  before: InsertAvailability[];
  after: InsertAvailability[];
  into: InsertAvailability[];
}

export interface InsertMapMessage {
  type: 'insertMap';
  insertMap: Record<string, InsertMapEntry>;
}

export interface AnnounceMessage {
  type: 'announce';
  message: string;
}

export interface CanvasMessage {
  type?: string;
  id?: string;
  text?: string;
  html?: string;
  op?: string;
  prefix?: string;
  suffix?: string;
  prefixHtml?: string;
  suffixHtml?: string;
  prevId?: string;
  merged?: string;
  mergedHtml?: string;
  boundary?: number;
  blocks?: string[];
  caret?: number;
  /** moveBefore/moveAfter: the same-parent sibling to move next to. */
  refId?: string;
  caretOffset?: number;
  before?: string;
  mid?: string;
  after?: string;
  attrName?: string;
  attrValue?: string;
  selection?: RangeSelectionPayload;
  action?: string;
  ids?: string[];
  values?: unknown[];
  payload?: InsertPayload;
  transform?: string;
  baseStructVersion?: number;
  announceOnSuccess?: string;
  className?: string;
  color?: string;
  /** clearStyle only; applyStyle targets are derived from the registered class. */
  styleTarget?: string;
  attrs?: unknown[];
  widths?: number[];
  styles?: unknown;
  sourceHash?: string;
  targetToken?: string;
  requestId?: string;
  silent?: boolean;
  /** navTopic: open the previous (-1) / next (+1) sibling .dita topic. */
  delta?: number;
}

export const AUTHORIZED_ATTRIBUTE_MESSAGE_TYPES = [
  'setTaxonomyAttr',
  'setExistingPropertyAttr',
  'setCalsAttr',
  'setCalsAttrMulti',
  'setTgroupAttr',
  'applyStyle',
  'clearStyle',
  'applyShade',
  'clearShade',
] as const;

export type AuthorizedAttributeMessageType = typeof AUTHORIZED_ATTRIBUTE_MESSAGE_TYPES[number];
const AUTHORIZED_ATTRIBUTE_MESSAGE_TYPE_SET = new Set<string>(AUTHORIZED_ATTRIBUTE_MESSAGE_TYPES);

export function isAuthorizedAttributeMessageType(value: unknown): value is AuthorizedAttributeMessageType {
  return typeof value === 'string' && AUTHORIZED_ATTRIBUTE_MESSAGE_TYPE_SET.has(value);
}

export type HostHistoryCommand = 'undo' | 'redo' | 'editor.action.webvieweditor.showFind';

const RANGE_ACTION_TYPES = new Set<RangeActionType>([
  'rangeDelete',
  'cellRectMerge',
  'cellClear',
  'cellTextReplace',
]);

export function historyCommandForOp(op: unknown): HostHistoryCommand | null {
  if (op === 'undo') return 'undo';
  if (op === 'redo') return 'redo';
  if (op === 'find') return 'editor.action.webvieweditor.showFind';
  return null;
}

export function isRangeActionType(action: unknown): action is RangeActionType {
  return typeof action === 'string' && RANGE_ACTION_TYPES.has(action as RangeActionType);
}
