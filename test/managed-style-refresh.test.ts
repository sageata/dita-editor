import { describe, expect, test } from 'bun:test';
import {
  createManagedStyleDocumentRefreshHandler,
  createManagedStyleRefreshCoordinator,
  matchesManagedStyleDocumentTarget,
  reconcileManagedStyleSave,
  sameManagedStyleRefreshSnapshot,
  subscribeManagedStyleRefreshEvents,
  type ManagedStyleRefreshSnapshot,
} from '../src/host/managed-style-refresh';
import {
  inspectManagedAuthorStylesheet,
  planManagedAuthorStylesheetWrite,
  type ManagedStylesInspection,
} from '../src/host/managed-author-stylesheet';
import { inspectAuthorStyleSource } from '../src/host/author-style-source';
import type {
  ManagedStyleDocument,
  ManagedStyleTarget,
} from '../src/host/managed-style-persistence';
import { applyPersistedShadeToIds } from '../src/host/managed-style-actions';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function eventSource<T>() {
  const listeners: Array<(event: T) => void> = [];
  return {
    subscribe(listener: (event: T) => void) {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    emit(event: T) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function settleRefreshes(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('managed style refresh coordinator', () => {
  test('matches the configured lexical document and canonical aliases regardless of extension', async () => {
    const target: ManagedStyleTarget = {
      configuredPath: 'styles/managed.css',
      uri: 'file:///workspace/styles/managed.css',
      lexicalPath: '/workspace/styles/managed.css',
      canonicalPath: '/real/styles/managed.css',
      identity: '/real/styles/managed.css',
    };
    const files = {
      async realpath(value: string): Promise<string> {
        if (value === '/workspace/alias/managed.scss') return '/real/styles/managed.css';
        return value;
      },
    };

    expect(await matchesManagedStyleDocumentTarget(
      { uri: { scheme: 'file', fsPath: '/workspace/styles/managed.css' } },
      target,
      files,
      'linux',
    )).toBe(true);
    expect(await matchesManagedStyleDocumentTarget(
      { uri: { scheme: 'file', fsPath: '/workspace/alias/managed.scss' } },
      target,
      files,
      'linux',
    )).toBe(true);
    expect(await matchesManagedStyleDocumentTarget(
      { uri: { scheme: 'untitled', fsPath: '/workspace/styles/managed.css' } },
      target,
      files,
      'linux',
    )).toBe(false);

    let refreshes = 0;
    const refreshAlias = createManagedStyleDocumentRefreshHandler({
      matches: (document: { uri: { scheme: string; fsPath: string } }) =>
        matchesManagedStyleDocumentTarget(document, target, files, 'linux'),
      request: () => { refreshes++; },
      log: () => undefined,
    });
    const alias = { uri: { scheme: 'file', fsPath: '/workspace/alias/managed.scss' } };
    refreshAlias(alias); // open
    refreshAlias(alias); // change
    refreshAlias(alias); // save
    refreshAlias(alias); // close
    await settleRefreshes();
    expect(refreshes).toBe(4);
  });

  test('publishes only the newest inspection when an older refresh completes last', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const loads = [older.promise, newer.promise];
    const published: string[] = [];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: () => loads.shift()!,
      publish: (value) => { published.push(value); },
      log: () => undefined,
    });

    const olderRefresh = coordinator.refresh();
    const newerRefresh = coordinator.refresh();
    newer.resolve('newer inspection');
    expect(await newerRefresh).toBe(true);
    older.resolve('older inspection');
    expect(await olderRefresh).toBe(false);

    expect(published).toEqual(['newer inspection']);
  });

  test('a direct save publication invalidates an older delayed refresh', async () => {
    const older = deferred<string>();
    const published: string[] = [];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: () => older.promise,
      publish: (value) => { published.push(value); },
      log: () => undefined,
    });

    const olderRefresh = coordinator.refresh();
    expect(await coordinator.refreshWith(async () => 'H1 direct save')).toBe(true);
    older.resolve('H0 delayed refresh');

    expect(await olderRefresh).toBe(false);
    expect(published).toEqual(['H1 direct save']);
  });

  test('a target change during save recovery publishes the latest target and its matching inspection', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const targetA = {
      configuredPath: 'a.css',
      uri: 'file:///workspace/a.css',
      lexicalPath: '/workspace/a.css',
      canonicalPath: '/workspace/a.css',
      identity: '/workspace/a.css',
    };
    const targetB = {
      ...targetA,
      configuredPath: 'b.css',
      uri: 'file:///workspace/b.css',
      lexicalPath: '/workspace/b.css',
      canonicalPath: '/workspace/b.css',
      identity: '/workspace/b.css',
    };
    const H0 = inspectManagedAuthorStylesheet(plan.resultingText);
    const B = { ...H0, sourceHash: 'B-refresh-hash' };
    let current: ManagedStyleRefreshSnapshot = { target: targetA, inspection: H0 };
    let latest: ManagedStyleRefreshSnapshot = { target: targetB, inspection: B };
    const coordinator = createManagedStyleRefreshCoordinator({
      load: async (): Promise<ManagedStyleRefreshSnapshot> => latest,
      publish: (snapshot) => { current = snapshot; },
      log: () => undefined,
    });

    expect(await coordinator.refresh()).toBe(true);
    expect(current).toEqual({ target: targetB, inspection: B });
    latest = {
      target: targetB,
      inspection: { ...B, writable: false, error: 'The save target changed during persistence.' },
    };
    expect(await coordinator.refreshWith(async () => latest)).toBe(true);

    expect(current).toEqual(latest);
    expect(current.target).toBe(targetB);
    expect(current.inspection.sourceHash).toBe('B-refresh-hash');
  });

  test('an own-file watcher may win save reconciliation when it publishes the exact saved snapshot', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const target = {
      configuredPath: 'styles.css',
      uri: 'file:///workspace/styles.css',
      lexicalPath: '/workspace/styles.css',
      canonicalPath: '/workspace/styles.css',
      identity: '/workspace/styles.css',
    };
    const initial: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(null),
    };
    const expected: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(plan.resultingText),
    };
    const reconciliationLoad = deferred<ManagedStyleRefreshSnapshot>();
    const watcherLoad = deferred<ManagedStyleRefreshSnapshot>();
    let current = initial;
    const coordinator = createManagedStyleRefreshCoordinator({
      load: () => watcherLoad.promise,
      publish: (snapshot) => { current = snapshot; },
      log: () => undefined,
    });

    const reconciliation = coordinator.refreshWith(() => reconciliationLoad.promise);
    const watcher = coordinator.refresh();
    reconciliationLoad.resolve(expected);
    watcherLoad.resolve(expected);

    expect(await watcher).toBe(true);
    expect(await reconciliation).toBe(false);
    expect(sameManagedStyleRefreshSnapshot(current, expected)).toBe(true);
  });

  test('save reconciliation succeeds only after the exact persisted snapshot is re-inspected', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const target: ManagedStyleTarget = {
      configuredPath: 'styles.css',
      uri: 'file:///workspace/styles.css',
      lexicalPath: '/workspace/styles.css',
      canonicalPath: '/workspace/styles.css',
      identity: '/workspace/styles.css',
    };
    const saved: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(plan.resultingText),
    };
    let current: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(null),
    };
    let loads = 0;
    const coordinator = createManagedStyleRefreshCoordinator({
      load: async () => saved,
      publish: (snapshot) => { current = snapshot; },
      log: () => undefined,
    });

    const reconciled = await reconcileManagedStyleSave({
      coordinator,
      savedSnapshot: saved,
      loadCurrent: async () => {
        loads += 1;
        return saved;
      },
      getCurrent: () => current,
      changedError: 'The stylesheet changed after persistence.',
    });

    expect(reconciled).toBe(true);
    expect(loads).toBe(1);
    expect(sameManagedStyleRefreshSnapshot(current, saved)).toBe(true);
  });

  test('an already-published H2 is never overwritten by persisted H1 and keeps shade out of DITA', async () => {
    const H1Plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-shade-ffe8b3',
      name: 'Gold tint',
      target: 'tableCell',
      backgroundColor: '#ffe8b3',
    }]);
    const H2Plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-external-blue',
      name: 'External blue',
      target: 'tableCell',
      backgroundColor: '#e3edf7',
    }]);
    if (!H1Plan.ok) throw new Error(H1Plan.reason);
    if (!H2Plan.ok) throw new Error(H2Plan.reason);
    const target: ManagedStyleTarget = {
      configuredPath: 'styles.css',
      uri: 'file:///workspace/styles.css',
      lexicalPath: '/workspace/styles.css',
      canonicalPath: '/workspace/styles.css',
      identity: '/workspace/styles.css',
    };
    const H1: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(H1Plan.resultingText),
    };
    const H2: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(H2Plan.resultingText),
    };
    let current = H2;
    const publishedHashes: string[] = [H2.inspection.sourceHash];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: async () => H2,
      publish: (snapshot) => {
        current = snapshot;
        publishedHashes.push(snapshot.inspection.sourceHash);
      },
      log: () => undefined,
    });

    const reconciled = await reconcileManagedStyleSave({
      coordinator,
      savedSnapshot: H1,
      loadCurrent: async () => H2,
      getCurrent: () => current,
      changedError: 'The stylesheet changed after persistence.',
    });
    let ditaApplications = 0;
    const shadeApplied = await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: 'dc-shade-ffe8b3',
      styleTarget: 'tableCell',
      displayedSourceHash: H1.inspection.sourceHash,
      targetToken: 'target-a-token',
      newStyle: H1.inspection.styles.find((style) => style.className === 'dc-shade-ffe8b3'),
    }, {
      getAcceptedState: () => ({
        styles: current.inspection.styles,
        sourceHash: current.inspection.sourceHash,
        targetToken: 'target-a-token',
        generation: coordinator.generation(),
      }),
      persist: async () => reconciled
        ? {
            ok: true,
            sourceHash: H1.inspection.sourceHash,
            acceptedStyles: H1.inspection.styles,
            acceptedGeneration: 1,
          }
        : { ok: false, error: 'Reconciliation was superseded.' },
      applyDita: async () => { ditaApplications += 1; },
    });

    expect(reconciled).toBe(false);
    expect(shadeApplied).toBe(false);
    expect(ditaApplications).toBe(0);
    expect(current.inspection.sourceHash).toBe(H2.inspection.sourceHash);
    expect(publishedHashes).not.toContain(H1.inspection.sourceHash);
  });

  test('H2 starting during reconciliation supersedes H1 and keeps shade out of DITA', async () => {
    const H1Plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-shade-ffe8b3',
      name: 'Gold tint',
      target: 'tableCell',
      backgroundColor: '#ffe8b3',
    }]);
    const H2Plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-external-blue',
      name: 'External blue',
      target: 'tableCell',
      backgroundColor: '#e3edf7',
    }]);
    if (!H1Plan.ok) throw new Error(H1Plan.reason);
    if (!H2Plan.ok) throw new Error(H2Plan.reason);
    const target: ManagedStyleTarget = {
      configuredPath: 'styles.css',
      uri: 'file:///workspace/styles.css',
      lexicalPath: '/workspace/styles.css',
      canonicalPath: '/workspace/styles.css',
      identity: '/workspace/styles.css',
    };
    const H1: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(H1Plan.resultingText),
    };
    const H2: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(H2Plan.resultingText),
    };
    const reconciliationLoad = deferred<ManagedStyleRefreshSnapshot>();
    const watcherLoad = deferred<ManagedStyleRefreshSnapshot>();
    let current: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(null),
    };
    const publishedHashes: string[] = [];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: () => watcherLoad.promise,
      publish: (snapshot) => {
        current = snapshot;
        publishedHashes.push(snapshot.inspection.sourceHash);
      },
      log: () => undefined,
    });

    const reconciliation = reconcileManagedStyleSave({
      coordinator,
      savedSnapshot: H1,
      loadCurrent: () => reconciliationLoad.promise,
      getCurrent: () => current,
      changedError: 'The stylesheet changed after persistence.',
    });
    const watcher = coordinator.refresh();
    reconciliationLoad.resolve(H1);
    watcherLoad.resolve(H2);
    expect(await watcher).toBe(true);
    const reconciled = await reconciliation;

    let ditaApplications = 0;
    const shadeApplied = await applyPersistedShadeToIds({
      ids: ['entry-1'],
      className: 'dc-shade-ffe8b3',
      styleTarget: 'tableCell',
      displayedSourceHash: H1.inspection.sourceHash,
      targetToken: 'target-a-token',
      newStyle: H1.inspection.styles.find((style) => style.className === 'dc-shade-ffe8b3'),
    }, {
      getAcceptedState: () => ({
        styles: current.inspection.styles,
        sourceHash: current.inspection.sourceHash,
        targetToken: 'target-a-token',
        generation: coordinator.generation(),
      }),
      persist: async () => reconciled
        ? {
            ok: true,
            sourceHash: H1.inspection.sourceHash,
            acceptedStyles: H1.inspection.styles,
            acceptedGeneration: 1,
          }
        : { ok: false, error: 'Reconciliation was superseded.' },
      applyDita: async () => { ditaApplications += 1; },
    });

    expect(reconciled).toBe(false);
    expect(shadeApplied).toBe(false);
    expect(ditaApplications).toBe(0);
    expect(current.inspection.sourceHash).toBe(H2.inspection.sourceHash);
    expect(publishedHashes).toEqual([H2.inspection.sourceHash]);
  });

  test('a newest failed inspection is logged and permanently supersedes an older load', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const loads = [older.promise, newer.promise];
    const published: string[] = [];
    const logs: string[] = [];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: () => loads.shift()!,
      publish: (value) => { published.push(value); },
      log: (message) => { logs.push(message); },
    });

    const olderRefresh = coordinator.refresh();
    const newerRefresh = coordinator.refresh();
    newer.reject(new Error('newest inspection failed'));
    expect(await newerRefresh).toBe(false);
    older.resolve('older inspection');
    expect(await olderRefresh).toBe(false);

    expect(published).toEqual([]);
    expect(logs).toEqual(['Managed stylesheet refresh failed: Error: newest inspection failed']);
  });

  test('publishes target, exact-byte, and refusal changes even when parsed styles stay equal', async () => {
    const plan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    if (!plan.ok) throw new Error(plan.reason);
    const target = {
      configuredPath: 'styles/managed.css',
      uri: 'file:///workspace/styles/managed.css',
      lexicalPath: '/workspace/styles/managed.css',
      canonicalPath: '/real/workspace/styles/managed.css',
      identity: '/real/workspace/styles/managed.css',
    };
    const initial: ManagedStyleRefreshSnapshot = {
      target,
      inspection: inspectManagedAuthorStylesheet(plan.resultingText),
    };
    const changes: ManagedStyleRefreshSnapshot[] = [
      {
        target,
        inspection: inspectManagedAuthorStylesheet(`/* preserved prefix */\n${plan.resultingText}`),
      },
      {
        target,
        inspection: {
          ...inspectManagedAuthorStylesheet(plan.resultingText),
          writable: false,
          error: 'The source is temporarily refused.',
        },
      },
      {
        target: {
          ...target,
          configuredPath: './styles/managed.css',
          lexicalPath: '/workspace/./styles/managed.css',
        },
        inspection: inspectManagedAuthorStylesheet(plan.resultingText),
      },
    ];
    let current = initial;
    const published: ManagedStyleRefreshSnapshot[] = [];
    const coordinator = createManagedStyleRefreshCoordinator({
      load: async () => changes.shift()!,
      publish: (next) => {
        if (sameManagedStyleRefreshSnapshot(current, next)) return;
        current = next;
        published.push(next);
      },
      log: () => undefined,
    });

    await coordinator.refresh();
    await coordinator.refresh();
    await coordinator.refresh();

    expect(published).toHaveLength(3);
    expect(published[0].inspection.styles).toEqual(initial.inspection.styles);
    expect(published[0].inspection.sourceHash).not.toBe(initial.inspection.sourceHash);
    expect(published[1].inspection.error).toContain('refused');
    expect(published[2].target?.configuredPath).toBe('./styles/managed.css');
  });

  test('routes watcher and open/change/save/close events through the matching refresh path', async () => {
    const fileChanged = eventSource<string>();
    const fileCreated = eventSource<string>();
    const fileDeleted = eventSource<string>();
    const documentChanged = eventSource<{ document: { id: string } }>();
    const documentOpened = eventSource<{ id: string }>();
    const documentSaved = eventSource<{ id: string }>();
    const documentClosed = eventSource<{ id: string }>();
    const requested: string[] = [];
    const onDocument = createManagedStyleDocumentRefreshHandler({
      matches: async (document: { id: string }) => document.id === 'managed',
      request: () => { requested.push('document'); },
      log: () => undefined,
    });

    const subscriptions = subscribeManagedStyleRefreshEvents({
      file: {
        onDidChange: fileChanged.subscribe,
        onDidCreate: fileCreated.subscribe,
        onDidDelete: fileDeleted.subscribe,
      },
      document: {
        onDidChange: documentChanged.subscribe,
        onDidOpen: documentOpened.subscribe,
        onDidSave: documentSaved.subscribe,
        onDidClose: documentClosed.subscribe,
      },
    }, () => { requested.push('file'); }, onDocument);

    fileChanged.emit('changed');
    fileCreated.emit('created');
    fileDeleted.emit('deleted');
    documentChanged.emit({ document: { id: 'managed' } });
    documentOpened.emit({ id: 'managed' });
    documentSaved.emit({ id: 'managed' });
    documentClosed.emit({ id: 'managed' });
    documentOpened.emit({ id: 'unrelated' });
    await Promise.resolve();
    await Promise.resolve();

    expect(subscriptions).toHaveLength(7);
    expect(requested).toEqual([
      'file', 'file', 'file',
      'document', 'document', 'document', 'document',
    ]);
  });

  test('an unresolved local document identity logs and requests a full fail-closed inspection', async () => {
    const requested: string[] = [];
    const logs: string[] = [];
    const onDocument = createManagedStyleDocumentRefreshHandler({
      matches: async () => { throw new Error('injected realpath failure'); },
      request: () => { requested.push('full inspection'); },
      log: (message) => { logs.push(message); },
    });

    onDocument({ fsPath: '/workspace/possible-extensionless-alias' });
    await settleRefreshes();

    expect(requested).toEqual(['full inspection']);
    expect(logs).toEqual([
      'Managed stylesheet document identity check failed: Error: injected realpath failure',
    ]);
  });

  test('publishes clean-to-dirty-to-saved document transitions and dedupes equivalent open/close states', async () => {
    const initialPlan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Cabin lead',
      target: 'heading',
      color: '#123456',
    }]);
    const savedPlan = planManagedAuthorStylesheetWrite(null, [{
      className: 'dc-cabin-lead',
      name: 'Updated cabin lead',
      target: 'heading',
      color: '#654321',
    }]);
    if (!initialPlan.ok) throw new Error(initialPlan.reason);
    if (!savedPlan.ok) throw new Error(savedPlan.reason);
    const target: ManagedStyleTarget = {
      configuredPath: 'styles/managed.css',
      uri: 'file:///workspace/styles/managed.css',
      lexicalPath: '/workspace/styles/managed.css',
      canonicalPath: '/real/workspace/styles/managed.css',
      identity: '/real/workspace/styles/managed.css',
    };
    let diskSource = initialPlan.resultingText;
    let documents: ManagedStyleDocument[] = [];
    const inspectionDependencies = {
      files: {
        lstat: async () => ({
          mode: 0o100644,
          dev: 1,
          ino: 2,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
        readFile: async () => Buffer.from(diskSource, 'utf8'),
      },
      listDocuments: () => documents,
      resolveDocumentIdentity: async () => target.identity,
      platform: process.platform,
      log: () => undefined,
    };
    let current: ManagedStyleRefreshSnapshot = {
      target,
      inspection: await inspectAuthorStyleSource(target, inspectionDependencies),
    };
    const published: ManagedStylesInspection[] = [];
    let loads = 0;
    const coordinator = createManagedStyleRefreshCoordinator({
      load: async (): Promise<ManagedStyleRefreshSnapshot> => {
        loads += 1;
        return {
          target,
          inspection: await inspectAuthorStyleSource(target, inspectionDependencies),
        };
      },
      publish: (next) => {
        if (sameManagedStyleRefreshSnapshot(current, next)) return;
        current = next;
        published.push(next.inspection);
      },
      log: () => undefined,
    });
    const matches = async (document: ManagedStyleDocument) => document.fsPath === target.lexicalPath;
    const onDocument = createManagedStyleDocumentRefreshHandler({
      matches,
      request: coordinator.request,
      log: () => undefined,
    });
    const changed = eventSource<{ document: ManagedStyleDocument }>();
    const opened = eventSource<ManagedStyleDocument>();
    const saved = eventSource<ManagedStyleDocument>();
    const closed = eventSource<ManagedStyleDocument>();
    subscribeManagedStyleRefreshEvents({
      document: {
        onDidChange: changed.subscribe,
        onDidOpen: opened.subscribe,
        onDidSave: saved.subscribe,
        onDidClose: closed.subscribe,
      },
    }, coordinator.request, onDocument);

    const generation = {};
    documents = [{
      uri: target.uri,
      scheme: 'file',
      fsPath: target.lexicalPath,
      version: 1,
      dirty: false,
      generation,
      text: diskSource,
    }];
    opened.emit(documents[0]);
    await settleRefreshes();
    expect(published).toHaveLength(0);

    documents = [{
      ...documents[0],
      version: 2,
      dirty: true,
      text: `${savedPlan.resultingText}\n/* unsaved */`,
    }];
    changed.emit({ document: documents[0] });
    await settleRefreshes();
    expect(published.at(-1)).toMatchObject({ writable: false });
    expect(published.at(-1)?.error).toContain('unsaved changes');

    diskSource = savedPlan.resultingText;
    documents = [{
      ...documents[0],
      version: 3,
      dirty: false,
      text: savedPlan.resultingText,
    }];
    saved.emit(documents[0]);
    await settleRefreshes();
    expect(published.at(-1)).toMatchObject({ writable: true, sourceText: savedPlan.resultingText });

    const closedDocument = documents[0];
    documents = [];
    closed.emit(closedDocument);
    await settleRefreshes();

    expect(loads).toBe(4);
    expect(published).toHaveLength(2);
  });
});
