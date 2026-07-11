import { createHash } from 'node:crypto';
import {
  shadeManagedClassNames,
  type AuthorStyleDefinition,
} from '../styles/author-styles';
import type { ManagedStyleTarget } from './managed-style-persistence';

export interface ManagedStyleSaveIntent {
  styles: unknown;
  displayedSourceHash: string;
  targetToken: string;
}

export type ManagedStyleSaveOutcome =
  | {
      ok: true;
      sourceHash: string;
      acceptedStyles: AuthorStyleDefinition[];
      acceptedGeneration: number;
    }
  | { ok: false; error: string };

export type StyleSaveResultMessage =
  | {
      type: 'styleSaveResult';
      requestId: string;
      ok: true;
      sourceHash: string;
      acceptedStyles: AuthorStyleDefinition[];
    }
  | { type: 'styleSaveResult'; requestId: string; ok: false; error: string };

export type StyleSaveRequestDisposition =
  | 'started'
  | 'pending'
  | 'replayed'
  | 'duplicate'
  | 'full';

export type StyleSaveRequestState =
  | 'pending'
  | 'replayable'
  | 'completed'
  | 'unknown';

export interface StyleSaveResultReplayCache {
  begin(
    requestId: string,
    post: (message: StyleSaveResultMessage) => void,
  ): StyleSaveRequestDisposition;
  remember(message: StyleSaveResultMessage): void;
  replay(requestId: string, post: (message: StyleSaveResultMessage) => void): boolean;
  acknowledge(requestId: string): boolean;
  state(requestId: string): StyleSaveRequestState;
}

export function createStyleSaveResultReplayCache(
  limit = 32,
): StyleSaveResultReplayCache {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Style save result replay cache limit must be a positive integer.');
  }

  const pending = new Set<string>();
  const completed = new Map<string, true>();
  const results = new Map<string, StyleSaveResultMessage>();
  return {
    begin(requestId, post) {
      if (pending.has(requestId)) return 'pending';
      const result = results.get(requestId);
      if (result) {
        post(result);
        return 'replayed';
      }
      if (completed.has(requestId)) return 'duplicate';
      if (pending.size >= limit) return 'full';
      pending.add(requestId);
      return 'started';
    },
    remember(message) {
      pending.delete(message.requestId);
      completed.delete(message.requestId);
      completed.set(message.requestId, true);
      results.delete(message.requestId);
      results.set(message.requestId, message);
      while (completed.size > limit) {
        const oldestRequestId = completed.keys().next().value;
        if (oldestRequestId === undefined) break;
        completed.delete(oldestRequestId);
        results.delete(oldestRequestId);
      }
    },
    replay(requestId, post) {
      const message = results.get(requestId);
      if (!message) return false;
      post(message);
      return true;
    },
    acknowledge(requestId) {
      return results.delete(requestId);
    },
    state(requestId) {
      if (pending.has(requestId)) return 'pending';
      if (results.has(requestId)) return 'replayable';
      if (completed.has(requestId)) return 'completed';
      return 'unknown';
    },
  };
}

const STYLE_SAVE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:style-save-[1-9][0-9]{0,15}$/;

export function isValidStyleSaveRequestId(value: unknown): value is string {
  return typeof value === 'string' && STYLE_SAVE_REQUEST_ID.test(value);
}

export function managedStyleSaveIntent(message: {
  styles?: unknown;
  sourceHash?: unknown;
  targetToken?: unknown;
}): ManagedStyleSaveIntent {
  return {
    styles: message.styles,
    displayedSourceHash: typeof message.sourceHash === 'string' ? message.sourceHash : '',
    targetToken: typeof message.targetToken === 'string' ? message.targetToken : '',
  };
}

export function managedStyleTargetToken(target: ManagedStyleTarget | null): string {
  const identity = target === null
    ? null
    : [
        target.configuredPath,
        target.uri,
        target.lexicalPath,
        target.canonicalPath,
        target.identity,
      ];
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

export async function runTargetBoundManagedStyleSave(dependencies: {
  requestedTargetToken: string;
  currentTargetToken: string;
  mismatchError: string;
  save(): Promise<ManagedStyleSaveOutcome>;
}): Promise<ManagedStyleSaveOutcome> {
  if (
    dependencies.requestedTargetToken === '' ||
    dependencies.requestedTargetToken !== dependencies.currentTargetToken
  ) {
    return { ok: false, error: dependencies.mismatchError };
  }
  return dependencies.save();
}

export function styleSaveResultMessage(
  requestId: string,
  outcome: ManagedStyleSaveOutcome,
): StyleSaveResultMessage {
  return outcome.ok
    ? {
        type: 'styleSaveResult',
        requestId,
        ok: true,
        sourceHash: outcome.sourceHash,
        acceptedStyles: outcome.acceptedStyles,
      }
    : { type: 'styleSaveResult', requestId, ok: false, error: outcome.error };
}

export async function runManagedStyleSaveRequest(dependencies: {
  requestId: string;
  save(): Promise<ManagedStyleSaveOutcome>;
  unexpectedError(error: unknown): string;
  post(message: StyleSaveResultMessage): void;
}): Promise<ManagedStyleSaveOutcome> {
  let outcome: ManagedStyleSaveOutcome;
  try {
    outcome = await dependencies.save();
  } catch (error) {
    outcome = { ok: false, error: dependencies.unexpectedError(error) };
  }
  dependencies.post(styleSaveResultMessage(dependencies.requestId, outcome));
  return outcome;
}

export interface PersistedShadeRequest {
  ids: string[];
  className: string;
  styleTarget: 'tableCell' | 'tableRow';
  displayedSourceHash: string;
  targetToken: string;
  newStyle?: AuthorStyleDefinition;
}

export interface AcceptedManagedStyleState {
  styles: AuthorStyleDefinition[];
  sourceHash: string;
  targetToken: string;
  generation: number;
}

export interface PersistedShadeDependencies {
  getAcceptedState(): AcceptedManagedStyleState;
  persist(
    styles: AuthorStyleDefinition[],
    displayedSourceHash: string,
  ): Promise<ManagedStyleSaveOutcome>;
  applyDita(request: {
    ids: string[];
    className: string;
    managedClassNames: string[];
    styleTarget: 'tableCell' | 'tableRow';
  }): Promise<void>;
}

export async function applyPersistedShadeToIds(
  request: PersistedShadeRequest,
  dependencies: PersistedShadeDependencies,
): Promise<boolean> {
  let accepted = dependencies.getAcceptedState();
  if (request.targetToken === '' || request.targetToken !== accepted.targetToken) return false;

  if (
    request.newStyle &&
    !accepted.styles.some((style) => style.className === request.newStyle?.className)
  ) {
    const saved = await dependencies.persist(
      [...accepted.styles, request.newStyle],
      request.displayedSourceHash,
    );
    if (!saved.ok) return false;
    accepted = dependencies.getAcceptedState();
    if (
      accepted.targetToken !== request.targetToken ||
      accepted.sourceHash !== saved.sourceHash ||
      accepted.generation !== saved.acceptedGeneration ||
      JSON.stringify(accepted.styles) !== JSON.stringify(saved.acceptedStyles) ||
      !accepted.styles.some((style) => style.className === request.className)
    ) return false;
  }

  await dependencies.applyDita({
    ids: request.ids,
    className: request.className,
    managedClassNames: shadeManagedClassNames(accepted.styles),
    styleTarget: request.styleTarget,
  });
  return true;
}
