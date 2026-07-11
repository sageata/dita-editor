import { describe, expect, test } from 'bun:test';
import {
  applyPersistedShadeToIds,
  createStyleSaveResultReplayCache,
  isValidStyleSaveRequestId,
  managedStyleTargetToken,
  managedStyleSaveIntent,
  runTargetBoundManagedStyleSave,
  runManagedStyleSaveRequest,
  styleSaveResultMessage,
} from '../src/host/managed-style-actions';
import type { AuthorStyleDefinition } from '../src/styles/author-styles';
import type { ManagedStyleTarget } from '../src/host/managed-style-persistence';

describe('managed style host actions', () => {
  test('forwards the exact payload object and displayed source hash without normalization', () => {
    const styles = [{ className: 'dc-cabin-lead', name: 'Cabin lead', target: 'heading' }];

    const intent = managedStyleSaveIntent({
      styles,
      sourceHash: 'exact-displayed-hash',
      targetToken: 'target-a-token',
    });

    expect(intent.styles).toBe(styles);
    expect(intent.displayedSourceHash).toBe('exact-displayed-hash');
    expect(intent.targetToken).toBe('target-a-token');
    expect(managedStyleSaveIntent({ styles }).displayedSourceHash).toBe('');
    expect(managedStyleSaveIntent({ styles }).targetToken).toBe('');
    expect(managedStyleSaveIntent({ styles, sourceHash: 42 }).displayedSourceHash).toBe('');
  });

  test('binds a save to an opaque digest of every resolved target field', () => {
    const target: ManagedStyleTarget = {
      configuredPath: 'styles/managed.css',
      uri: 'file:///workspace/styles/managed.css',
      lexicalPath: '/workspace/styles/managed.css',
      canonicalPath: '/real/workspace/styles/managed.css',
      identity: '/real/workspace/styles/managed.css',
    };
    const token = managedStyleTargetToken(target);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain('/workspace');
    expect(managedStyleTargetToken({ ...target })).toBe(token);
    for (const field of Object.keys(target) as Array<keyof ManagedStyleTarget>) {
      expect(managedStyleTargetToken({ ...target, [field]: `${target[field]}-changed` })).not.toBe(token);
    }
    expect(managedStyleTargetToken(null)).not.toBe(token);
  });

  test('a stale target token refuses before the same-hash target B save is invoked', async () => {
    let saveCalls = 0;
    const outcome = await runTargetBoundManagedStyleSave({
      requestedTargetToken: 'target-a-token',
      currentTargetToken: 'target-b-token',
      mismatchError: 'The style destination changed. Reload before saving.',
      save: async () => {
        saveCalls += 1;
        return {
          ok: true,
          sourceHash: 'same-source-hash',
          acceptedStyles: [],
          acceptedGeneration: 1,
        };
      },
    });

    expect(outcome).toEqual({
      ok: false,
      error: 'The style destination changed. Reload before saving.',
    });
    expect(saveCalls).toBe(0);
  });

  test('builds explicit request-correlated success and failure messages', () => {
    const acceptedStyles: AuthorStyleDefinition[] = [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
    }];
    expect(styleSaveResultMessage('style-save-7', {
      ok: true,
      sourceHash: 'accepted-hash',
      acceptedStyles,
      acceptedGeneration: 7,
    })).toEqual({
      type: 'styleSaveResult',
      requestId: 'style-save-7',
      ok: true,
      sourceHash: 'accepted-hash',
      acceptedStyles,
    });
    expect(styleSaveResultMessage('style-save-8', {
      ok: false,
      error: 'Reload before saving.',
    })).toEqual({
      type: 'styleSaveResult',
      requestId: 'style-save-8',
      ok: false,
      error: 'Reload before saving.',
    });
  });

  test('posts exactly one correlated failure result when the save throws unexpectedly', async () => {
    const messages: unknown[] = [];

    const outcome = await runManagedStyleSaveRequest({
      requestId: 'style-save-9',
      save: async () => { throw new Error('injected failure'); },
      unexpectedError: (error) => `Unexpected: ${String(error)}`,
      post: (message) => { messages.push(message); },
    });

    expect(outcome).toEqual({ ok: false, error: 'Unexpected: Error: injected failure' });
    expect(messages).toEqual([{
      type: 'styleSaveResult',
      requestId: 'style-save-9',
      ok: false,
      error: 'Unexpected: Error: injected failure',
    }]);
  });

  test('replays only exact unacknowledged results and evicts oldest entries at its bound', () => {
    const cache = createStyleSaveResultReplayCache(2);
    const result = (requestId: string) => styleSaveResultMessage(requestId, {
      ok: false,
      error: `failed ${requestId}`,
    });
    cache.remember(result('request-1'));
    cache.remember(result('request-2'));
    cache.remember(result('request-3'));
    const replayed: unknown[] = [];

    expect(cache.replay('request-1', (message) => { replayed.push(message); })).toBe(false);
    expect(cache.replay('request-2', (message) => { replayed.push(message); })).toBe(true);
    expect(cache.acknowledge('request-2')).toBe(true);
    expect(cache.replay('request-2', (message) => { replayed.push(message); })).toBe(false);
    expect(replayed).toEqual([result('request-2')]);
  });

  test('deduplicates pending, completed, and acknowledged request IDs without re-execution', () => {
    const cache = createStyleSaveResultReplayCache(2);
    const replayed: unknown[] = [];
    const post = (message: unknown) => { replayed.push(message); };
    const result = styleSaveResultMessage('frame-a:style-save-1', {
      ok: false,
      error: 'refused',
    });

    expect(cache.begin('frame-a:style-save-1', post)).toBe('started');
    expect(cache.begin('frame-a:style-save-1', post)).toBe('pending');
    cache.remember(result);
    expect(cache.begin('frame-a:style-save-1', post)).toBe('replayed');
    expect(replayed).toEqual([result]);
    expect(cache.acknowledge('frame-a:style-save-1')).toBe(true);
    expect(cache.begin('frame-a:style-save-1', post)).toBe('duplicate');
    expect(replayed).toEqual([result]);
  });

  test('bounds pending request registration and validates the generated ID shape', () => {
    const cache = createStyleSaveResultReplayCache(2);
    const post = () => undefined;

    expect(cache.begin('frame-a:style-save-1', post)).toBe('started');
    expect(cache.begin('frame-b:style-save-1', post)).toBe('started');
    expect(cache.begin('frame-c:style-save-1', post)).toBe('full');
    expect(isValidStyleSaveRequestId('test-style-session:style-save-1')).toBe(true);
    expect(isValidStyleSaveRequestId('3c5f49d8-8693-4b36-96fe-3e593df5a88e:style-save-42')).toBe(true);
    expect(isValidStyleSaveRequestId('')).toBe(false);
    expect(isValidStyleSaveRequestId('style-save-1')).toBe(false);
    expect(isValidStyleSaveRequestId('frame a:style-save-1')).toBe(false);
    expect(isValidStyleSaveRequestId('frame-a:style-save-0')).toBe(false);
    expect(isValidStyleSaveRequestId(`frame-a:style-save-${'9'.repeat(20)}`)).toBe(false);
  });

  test('persists a new shade with the exact displayed hash before applying it to DITA', async () => {
    const newStyle: AuthorStyleDefinition = {
      className: 'dc-shade-ffe8b3',
      name: 'Gold tint',
      target: 'tableCell',
      backgroundColor: '#ffe8b3',
    };
    let acceptedState = {
      styles: [] as AuthorStyleDefinition[],
      sourceHash: 'before-save-hash',
      targetToken: 'target-a-token',
      generation: 0,
    };
    const order: string[] = [];
    let appliedManagedNames: string[] = [];

    const result = await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: newStyle.className,
      styleTarget: 'tableCell',
      displayedSourceHash: 'exact-shade-source-hash',
      targetToken: 'target-a-token',
      newStyle,
    }, {
      getAcceptedState: () => acceptedState,
      persist: async (styles, displayedSourceHash) => {
        order.push('persist');
        expect(displayedSourceHash).toBe('exact-shade-source-hash');
        acceptedState = {
          styles,
          sourceHash: 'accepted-shade-hash',
          targetToken: 'target-a-token',
          generation: 1,
        };
        return {
          ok: true,
          sourceHash: acceptedState.sourceHash,
          acceptedStyles: styles,
          acceptedGeneration: acceptedState.generation,
        };
      },
      applyDita: async ({ managedClassNames }) => {
        order.push('dita');
        appliedManagedNames = managedClassNames;
      },
    });

    expect(result).toBe(true);
    expect(order).toEqual(['persist', 'dita']);
    expect(acceptedState.styles).toContainEqual(newStyle);
    expect(appliedManagedNames).toContain(newStyle.className);
  });

  test('a persistence refusal preserves real DITA bytes and the accepted in-memory style state', async () => {
    const source = '<topic id="t"><body><table><tgroup cols="1"><tbody><row><entry>Meal</entry></row></tbody></tgroup></table></body></topic>';
    let ditaSource = source;
    let ditaApplyCalls = 0;
    const acceptedStyles: AuthorStyleDefinition[] = [{
      className: 'dc-existing',
      name: 'Existing',
      target: 'tableCell',
      backgroundColor: '#ffffff',
    }];
    const acceptedBefore = acceptedStyles.slice();
    const newStyle: AuthorStyleDefinition = {
      className: 'dc-shade-e3edf7',
      name: 'Blue tint',
      target: 'tableCell',
      backgroundColor: '#e3edf7',
    };

    const result = await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: newStyle.className,
      styleTarget: 'tableCell',
      displayedSourceHash: 'stale-displayed-hash',
      targetToken: 'target-a-token',
      newStyle,
    }, {
      getAcceptedState: () => ({
        styles: acceptedStyles,
        sourceHash: 'accepted-before-refusal',
        targetToken: 'target-a-token',
        generation: 0,
      }),
      persist: async () => ({ ok: false, error: 'The stylesheet changed.' }),
      applyDita: async () => {
        ditaApplyCalls += 1;
        ditaSource = 'mutated';
      },
    });

    expect(result).toBe(false);
    expect(ditaApplyCalls).toBe(0);
    expect(ditaSource).toBe(source);
    expect(acceptedStyles).toEqual(acceptedBefore);
  });

  test('existing and clear shades skip CSS persistence and apply DITA exactly once', async () => {
    const existing: AuthorStyleDefinition = {
      className: 'dc-shade-ffffff',
      name: 'White',
      target: 'tableCell',
      backgroundColor: '#ffffff',
    };
    let persistenceCalls = 0;
    const applications: string[] = [];
    const dependencies = {
      getAcceptedState: () => ({
        styles: [existing],
        sourceHash: 'accepted-hash',
        targetToken: 'target-a-token',
        generation: 0,
      }),
      persist: async () => {
        persistenceCalls += 1;
        return {
          ok: true as const,
          sourceHash: 'accepted-hash',
          acceptedStyles: [existing],
          acceptedGeneration: 0,
        };
      },
      applyDita: async ({ className }: { className: string }) => {
        applications.push(className);
      },
    };

    await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: existing.className,
      styleTarget: 'tableCell',
      displayedSourceHash: 'hash',
      targetToken: 'target-a-token',
      newStyle: existing,
    }, dependencies);
    await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: '',
      styleTarget: 'tableCell',
      displayedSourceHash: 'hash',
      targetToken: 'target-a-token',
    }, dependencies);

    expect(persistenceCalls).toBe(0);
    expect(applications).toEqual([existing.className, '']);
  });

  test('an H2 refresh starting after H1 save keeps the newly persisted shade out of DITA', async () => {
    const newStyle: AuthorStyleDefinition = {
      className: 'dc-shade-ffe8b3',
      name: 'Gold tint',
      target: 'tableCell',
      backgroundColor: '#ffe8b3',
    };
    let acceptedState = {
      styles: [] as AuthorStyleDefinition[],
      sourceHash: 'H0',
      targetToken: 'target-a-token',
      generation: 0,
    };
    let ditaApplications = 0;

    const result = await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: newStyle.className,
      styleTarget: 'tableCell',
      displayedSourceHash: 'H0',
      targetToken: 'target-a-token',
      newStyle,
    }, {
      getAcceptedState: () => acceptedState,
      persist: async () => {
        acceptedState = {
          styles: [newStyle],
          sourceHash: 'H1',
          targetToken: 'target-a-token',
          generation: 2,
        };
        return {
          ok: true,
          sourceHash: 'H1',
          acceptedStyles: [newStyle],
          acceptedGeneration: 1,
        };
      },
      applyDita: async () => { ditaApplications += 1; },
    });

    expect(result).toBe(false);
    expect(ditaApplications).toBe(0);
    expect(acceptedState.sourceHash).toBe('H1');
    expect(acceptedState.generation).toBe(2);
  });
});
