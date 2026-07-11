import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertPublicSmokeEvidence,
  createEvidenceEnvelope,
  hashDirectoryInventory,
  sha256File,
  inspectExplicitLocalBinary,
  PUBLIC_SCENARIO_IDS,
  RESTRICTED_PUBLIC_SCENARIO_IDS,
  COEXISTENCE_SCENARIO_IDS,
  PRIVATE_SCENARIO_IDS,
  finalizeOwnerEvidence,
  finalizeOwnerEvidenceFiles,
  writeFinalOwnerHandoff,
  finalizeMutableWorkingCopies,
  parseVsixSmokeArgs,
  preparePublicWorkspace,
  snapshotMutableWorkingCopies,
  validateExplicitLocalBinary,
  validateBoundPublicEvidence,
// @ts-expect-error executable ESM smoke module intentionally has no generated declaration
} from '../scripts/run-vsix-smoke.mjs';
// @ts-expect-error executable ESM smoke modules intentionally have no generated declarations
import { assertNoCoexistenceCollisions } from '../scripts/run-coexistence-smoke.mjs';
// @ts-expect-error executable ESM smoke modules intentionally have no generated declarations
import { assertPrivateSmokeEvidence, preparePrivateConsumerWorkspace } from '../scripts/run-private-consumer-smoke.mjs';
import {
  assertPinnedVersionRecord,
  downloadAndVerifyPinnedArchive,
  freezeVersion,
  resolveCurrentStable,
  verifyPinnedArchive,
// @ts-expect-error executable ESM smoke module intentionally has no generated declaration
} from '../scripts/resolve-vscode-versions.mjs';

const publicEvidence = {
  schemaVersion: 1,
  channel: 'stable',
  selectedPin: 'minimum',
  source: {
    kind: 'official-exact-version-download',
    updateServiceUrl: 'https://update.code.visualstudio.com/1.90.0/darwin-universal/stable',
    version: '1.90.0',
    commit: 'commit-190',
    platform: 'darwin-universal',
    architecture: 'universal',
    providerSha256: 'a'.repeat(64),
    localArchiveSha256: null,
    integrityBoundary: 'provider-sha256',
  },
  extension: { id: 'paul-razvan-sarbu.dita-editor', installed: true, activated: true },
  launchArguments: ['--user-data-dir=/tmp/u', '--extensions-dir=/tmp/e'],
  isolated: { userData: true, extensions: true, workspace: true, artifacts: true },
  assertions: {
    neutralDefaults: true,
    orderedFolderStyles: true,
    unsafePathRefusedAndLogged: true,
    restrictedModeReadOnly: true,
    validTaxonomy: true,
    taxonomyTransitionsNoStaleFields: true,
    hostileLabelsTextOnly: true,
    firstSaveCreatedManagedFile: true,
    markedFileSentinelsPreserved: true,
    noncanonicalFileUnchanged: true,
    ditaSaveReload: true,
    developerStylesheetsUnchanged: true,
    outputChannelCaptured: true,
  },
  visualEvidence: [{ kind: 'screenshot', path: 'installed-webview.png' }],
};
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('installed VSIX smoke policy', () => {
  test('prepares reproducible neutral, A/B, unsafe, hostile, and byte-sentinel inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'public-smoke-fixtures-'));
    try {
      const layout = { workspaceDir: join(root, 'workspace') };
      const prepared = await preparePublicWorkspace(layout);
      const sentinel = await Bun.file(join(prepared.folderA, 'css', 'managed-sentinel.css')).bytes();
      expect([...sentinel.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(sentinel)).toContain('\r\n/* DITAEDITOR_MANAGED_STYLES_START */\r\n');
      expect(prepared.fixturePaths.map((path: string) => path.split('/').at(-1))).toContain('taxonomy-hostile.json');
      const unsafe = JSON.parse(await Bun.file(join(prepared.folderA, '.vscode', 'settings.unsafe.json')).text());
      expect(unsafe['ditaeditor.visual.contentStylesheets'][0]).toBe('../escape.css');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cryptographically binds the candidate, logs, fixtures, CSS, visuals, and observed scenarios', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bound-evidence-'));
    try {
      const candidate = join(root, 'candidate.vsix');
      const log = join(root, 'run.log');
      const fixture = join(root, 'fixture.dita');
      const css = join(root, 'developer.css');
      const visual = join(root, 'installed.png');
      const extractedRoot = join(root, 'extracted');
      await mkdir(extractedRoot, { recursive: true });
      await Promise.all([
        writeFile(candidate, 'candidate-bytes'),
        writeFile(log, 'installed and launched'),
        writeFile(fixture, '<topic id="fixture"/>'),
        writeFile(css, '.topic { color: black; }'),
        writeFile(visual, VALID_PNG),
        writeFile(join(extractedRoot, 'package.json'), '{"name":"candidate"}'),
      ]);
      const extracted = await hashDirectoryInventory(extractedRoot);
      const envelope = await createEvidenceEnvelope({
        runId: 'run-2026-07-11-0001',
        status: 'owner-observed',
        runType: 'public-normal', restricted: false,
        candidate: { path: candidate, extractedRoot, extractedInventorySha256: extracted.sha256 },
        vscode: { pin: 'current-stable', version: '1.128.0', commit: 'f'.repeat(40) },
        launch: {
          args: ['--user-data-dir=/tmp/u', '--extensions-dir=/tmp/e', '--disable-workspace-trust'],
          isolation: { userDataDir: '/tmp/u', extensionsDir: '/tmp/e', workspaceDir: '/tmp/w' },
        },
        logs: [{ path: log }],
        workspaceFixtures: [{ path: fixture }],
        developerCss: [{ path: css, beforeSha256: null, afterSha256: null }],
        visuals: [{ path: visual, kind: 'screenshot' }],
        scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })),
      });
      const syntheticOptions = { candidateVsixPath: candidate, skipVersionArchiveBinding: true, skipMutableBinding: true };
      await expect(validateBoundPublicEvidence(envelope, syntheticOptions)).resolves.toBeTruthy();
      await expect(validateBoundPublicEvidence(envelope, { candidateVsixPath: candidate, selectedPin: 'minimum' })).rejects.toThrow('selected VS Code pin mismatch');
      await expect(validateBoundPublicEvidence({
        ...envelope,
        candidate: { ...envelope.candidate, sha256: '0'.repeat(64) },
      }, syntheticOptions)).rejects.toThrow();
      await writeFile(fixture, 'tampered fixture');
      await expect(createEvidenceEnvelope({ ...envelope, binding: undefined })).rejects.toThrow('immutable hash changed');
      await writeFile(fixture, '<topic id="fixture"/>');
      await rm(visual);
      await expect(validateBoundPublicEvidence(envelope, syntheticOptions)).rejects.toThrow('visual');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects missing, extra, empty, and unbound scenario evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenario-set-'));
    try {
      const candidate = join(root, 'candidate.vsix');
      const extractedRoot = join(root, 'extracted');
      const log = join(root, 'run.log');
      const fixture = join(root, 'fixture.dita');
      const css = join(root, 'developer.css');
      const visual = join(root, 'observed.png');
      await mkdir(extractedRoot, { recursive: true });
      await Promise.all([writeFile(candidate, 'candidate'), writeFile(join(extractedRoot, 'x'), 'x'), writeFile(log, 'log'), writeFile(fixture, 'fixture'), writeFile(css, 'css'), writeFile(visual, VALID_PNG)]);
      const inventory = await hashDirectoryInventory(extractedRoot);
      const base = await createEvidenceEnvelope({
        runId: 'scenario-set', status: 'owner-observed', runType: 'public-normal', restricted: false,
        candidate: { path: candidate, extractedRoot, extractedInventorySha256: inventory.sha256 },
        vscode: { pin: 'current-stable', version: '1.128.0', commit: 'f'.repeat(40) },
        launch: { args: ['--user-data-dir=/tmp/u', '--extensions-dir=/tmp/e', '--disable-workspace-trust'], isolation: { userDataDir: '/tmp/u', extensionsDir: '/tmp/e', workspaceDir: '/tmp/w' } },
        logs: [{ path: log }], workspaceFixtures: [{ path: fixture }], developerCss: [{ path: css }], visuals: [{ path: visual, kind: 'screenshot' }],
        scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })),
      });
      const rebound = (evidence: any) => createEvidenceEnvelope({ ...evidence, binding: undefined });
      const validationOptions = { candidateVsixPath: candidate, skipVersionArchiveBinding: true, skipMutableBinding: true };
      await expect(validateBoundPublicEvidence(await rebound({ ...base, scenarios: base.scenarios.slice(1) }), validationOptions)).rejects.toThrow('exactly');
      await expect(validateBoundPublicEvidence(await rebound({ ...base, scenarios: [...base.scenarios, { id: 'extra', status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] }] }), validationOptions)).rejects.toThrow('exactly');
      await expect(validateBoundPublicEvidence(await rebound({ ...base, scenarios: base.scenarios.map((s: any, i: number) => i ? s : { ...s, artifactPaths: [] }) }), validationOptions)).rejects.toThrow('no bound artifact');
      await expect(validateBoundPublicEvidence(await rebound({ ...base, scenarios: base.scenarios.map((s: any, i: number) => i ? s : { ...s, artifactPaths: [join(root, 'other.png')] }) }), validationOptions)).rejects.toThrow('unbound');
      const restricted = await createEvidenceEnvelope({
        ...base, binding: undefined, runType: 'public-restricted', restricted: true,
        launch: { ...base.launch, args: base.launch.args.filter((arg: string) => arg !== '--disable-workspace-trust') },
        scenarios: RESTRICTED_PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })),
      });
      await expect(validateBoundPublicEvidence(restricted, validationOptions)).resolves.toBeTruthy();
      await expect(validateBoundPublicEvidence(await rebound({ ...restricted, restricted: false }), validationOptions)).rejects.toThrow('restricted launch');
      await writeFile(visual, 'renamed garbage');
      const garbage = await createEvidenceEnvelope({ ...restricted, binding: undefined, visuals: [{ path: visual, kind: 'screenshot' }] });
      await expect(validateBoundPublicEvidence(garbage, validationOptions)).rejects.toThrow('PNG structure');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('preserves before-state while accepting declared mutations, deletion, and managed-region-only edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutable-evidence-'));
    try {
      const sentinel = join(root, 'sentinel.css');
      const taxonomy = join(root, 'taxonomy.json');
      const refused = join(root, 'refused.css');
      await writeFile(sentinel, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PREFIX\r\n/* DITAEDITOR_MANAGED_STYLES_START */\r\nOLD\r\n/* DITAEDITOR_MANAGED_STYLES_END */\r\nSUFFIX')]));
      await writeFile(taxonomy, '{}');
      await writeFile(refused, 'UNCHANGED');
      const draft = await snapshotMutableWorkingCopies([
        { label: 'sentinel.css', path: sentinel, allowedActions: ['modify'], expectedTransitions: ['managed-save'], invariant: 'managed-region-only' },
        { label: 'taxonomy.json', path: taxonomy, allowedActions: ['delete'], expectedTransitions: ['deleted'], invariant: 'any-change' },
        { label: 'refused.css', path: refused, allowedActions: ['unchanged'], expectedTransitions: ['refused-save'], invariant: 'byte-identical' },
      ], join(root, 'before'));
      await writeFile(sentinel, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PREFIX\r\n/* DITAEDITOR_MANAGED_STYLES_START */\r\nNEW\r\n/* DITAEDITOR_MANAGED_STYLES_END */\r\nSUFFIX')]));
      await rm(taxonomy);
      const finalized = await finalizeMutableWorkingCopies(draft, [
        { path: sentinel, action: 'modify', transitions: ['managed-save'] },
        { path: taxonomy, action: 'delete', transitions: ['deleted'] },
        { path: refused, action: 'unchanged', transitions: ['refused-save'] },
      ]);
      expect(finalized.find((entry: any) => entry.path === resolve(taxonomy))?.afterExists).toBe(false);
      await writeFile(refused, 'TAMPERED');
      await expect(finalizeMutableWorkingCopies(draft, [
        { path: sentinel, action: 'modify', transitions: ['managed-save'] },
        { path: taxonomy, action: 'delete', transitions: ['deleted'] },
        { path: refused, action: 'unchanged', transitions: ['refused-save'] },
      ])).rejects.toThrow('byte-identical');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('finalizes all four run types with exact mutation gating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finalizer-run-types-'));
    try {
      const candidate = join(root, 'candidate.vsix'); const extractedRoot = join(root, 'extracted');
      const log = join(root, 'log'); const fixture = join(root, 'fixture'); const css = join(root, 'css'); const visual = join(root, 'proof.png'); const mutable = join(root, 'mutable');
      const companion = join(root, 'companion.vsix'); const companionRoot = join(root, 'companion-extracted');
      await Promise.all([mkdir(extractedRoot), mkdir(companionRoot)]); await Promise.all([writeFile(candidate, 'c'), writeFile(join(extractedRoot, 'x'), 'x'), writeFile(companion, 'companion'), writeFile(join(companionRoot, 'x'), 'companion-x'), writeFile(log, 'l'), writeFile(fixture, 'f'), writeFile(css, 'c'), writeFile(visual, VALID_PNG), writeFile(mutable, 'm')]);
      const inventory = await hashDirectoryInventory(extractedRoot);
      const companionInventory = await hashDirectoryInventory(companionRoot);
      const mutableDraft = await snapshotMutableWorkingCopies([{ label: 'mutable', path: mutable, allowedActions: ['unchanged'], expectedTransitions: ['checked'], invariant: 'byte-identical' }], join(root, 'before'));
      const common = { runId: 'finalizer', status: 'pending-owner-observation', candidate: { path: candidate, extractedRoot, extractedInventorySha256: inventory.sha256 }, vscode: { pin: 'current-stable', version: '1.128.0', commit: 'f'.repeat(40) }, logs: [{ path: log }], workspaceFixtures: [{ path: fixture }], developerCss: [{ path: css }], visuals: [] };
      for (const [runType, ids, needsMutations] of [
        ['public-normal', PUBLIC_SCENARIO_IDS, true], ['private', PRIVATE_SCENARIO_IDS, true],
        ['public-restricted', RESTRICTED_PUBLIC_SCENARIO_IDS, false], ['coexistence', COEXISTENCE_SCENARIO_IDS, false],
      ] as const) {
        const draft = await createEvidenceEnvelope({
          ...common,
          runType,
          restricted: runType === 'public-restricted',
          launch: { args: runType === 'public-normal' ? ['--disable-workspace-trust'] : [], isolation: { userDataDir: '/u', extensionsDir: '/e', workspaceDir: '/w' } },
          scenarios: ids.map((id: string) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })),
          ...(needsMutations ? { mutableWorkingCopies: mutableDraft } : {}),
          ...(runType === 'coexistence' ? { companion: { path: companion, sha256: await sha256File(companion), extractedRoot: companionRoot, extractedInventorySha256: companionInventory.sha256 } } : {}),
          ...(runType === 'private' ? { packagePrivacy: { logPath: log, findings: [] }, protectedPrivateCss: [{ path: css, beforeSha256: await sha256File(css), afterSha256: await sha256File(css) }] } : {}),
        });
        const observations = { visuals: [{ path: visual, kind: 'screenshot' }], scenarios: ids.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })), ...(needsMutations ? { mutations: [{ path: mutable, action: 'unchanged', transitions: ['checked'] }] } : {}) };
        const finalized = await finalizeOwnerEvidence(draft, observations, { skipVersionArchiveBinding: true });
        expect(Boolean(finalized.mutableWorkingCopies)).toBe(needsMutations);
        if (!needsMutations) await expect(finalizeOwnerEvidence(draft, { ...observations, mutations: [{ path: mutable }] }, { skipVersionArchiveBinding: true })).rejects.toThrow('forbids');
        else await expect(finalizeOwnerEvidence(draft, { ...observations, mutations: undefined }, { skipVersionArchiveBinding: true })).rejects.toThrow('requires');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('rejects draft tamper before applying owner observations and binds final handoff state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finalizer-tamper-'));
    try {
      const candidate = join(root, 'candidate.vsix'); const extractedRoot = join(root, 'extracted'); const log = join(root, 'install.log');
      const fixture = join(root, 'fixture.dita'); const css = join(root, 'developer.css'); const mutable = join(root, 'mutable.dita'); const visual = join(root, 'proof.png');
      await mkdir(extractedRoot); await Promise.all([writeFile(candidate, 'candidate'), writeFile(join(extractedRoot, 'x'), 'x'), writeFile(log, 'log'), writeFile(fixture, 'fixture'), writeFile(css, 'css'), writeFile(mutable, 'before'), writeFile(visual, VALID_PNG)]);
      const inventory = await hashDirectoryInventory(extractedRoot);
      const mutableDraft = await snapshotMutableWorkingCopies([{ label: 'mutable', path: mutable, allowedActions: ['unchanged'], expectedTransitions: ['checked'], invariant: 'byte-identical' }], join(root, 'before'));
      const evidencePath = join(root, 'evidence.json');
      const draft = await createEvidenceEnvelope({ runId: 'tamper', status: 'pending-owner-observation', runType: 'public-normal', restricted: false, candidate: { path: candidate, extractedRoot, extractedInventorySha256: inventory.sha256 }, vscode: { pin: 'current-stable', version: '1.128.0', commit: 'f'.repeat(40) }, launch: { args: ['--disable-workspace-trust'], isolation: { userDataDir: '/u', extensionsDir: '/e', workspaceDir: '/w', artifactDir: root } }, logs: [{ path: log }], workspaceFixtures: [{ path: fixture }], mutableWorkingCopies: mutableDraft, developerCss: [{ path: css }], visuals: [], scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })) });
      await writeFile(evidencePath, `${JSON.stringify(draft, null, 2)}\n`);
      await writeFile(join(root, 'handoff.json'), `${JSON.stringify({ status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: draft.binding.sha256 }, null, 2)}\n`);
      const observations = { visuals: [{ path: visual, kind: 'screenshot' }], scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })), mutations: [{ path: mutable, action: 'unchanged', transitions: ['checked'] }] };
      for (const tampered of [
        { ...draft, runType: 'private' },
        { ...draft, vscode: { ...draft.vscode, pin: 'minimum' } },
        { ...draft, logs: [] },
        { ...draft, workspaceFixtures: [] },
        { ...draft, developerCss: [] },
        { ...draft, mutableWorkingCopies: [{ ...draft.mutableWorkingCopies[0], allowedActions: [] }] },
        { ...draft, mutableWorkingCopies: [{ ...draft.mutableWorkingCopies[0], beforeSha256: '0'.repeat(64) }] },
        { ...draft, scenarios: draft.scenarios.slice(1) },
      ]) await expect(finalizeOwnerEvidence(tampered, observations, { skipVersionArchiveBinding: true })).rejects.toThrow('binding');
      for (const malformed of [
        { ...draft, logs: [] },
        { ...draft, workspaceFixtures: [] },
        { ...draft, developerCss: [] },
        { ...draft, mutableWorkingCopies: [{ ...draft.mutableWorkingCopies[0], allowedActions: [] }] },
        { ...draft, mutableWorkingCopies: [{ ...draft.mutableWorkingCopies[0], beforeSha256: '0'.repeat(64) }] },
        { ...draft, scenarios: draft.scenarios.slice(1) },
        { ...draft, status: 'owner-observed' },
      ]) {
        const rebound = await createEvidenceEnvelope({ ...malformed, binding: undefined });
        await writeFile(join(root, 'handoff.json'), `${JSON.stringify({ status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: rebound.binding.sha256 }, null, 2)}\n`);
        await expect(finalizeOwnerEvidence(rebound, observations, { skipVersionArchiveBinding: true })).rejects.toThrow();
      }
      await writeFile(join(root, 'handoff.json'), `${JSON.stringify({ status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: draft.binding.sha256 }, null, 2)}\n`);
      const finalized = await finalizeOwnerEvidence(draft, observations, { skipVersionArchiveBinding: true });
      await writeFinalOwnerHandoff(evidencePath, finalized);
      await writeFile(evidencePath, `${JSON.stringify(finalized, null, 2)}\n`);
      await expect(validateBoundPublicEvidence(finalized, { candidateVsixPath: candidate, skipVersionArchiveBinding: true })).resolves.toBeTruthy();
      const handoff = JSON.parse(await readFile(join(root, 'handoff.final.json'), 'utf8'));
      expect(handoff.evidenceBindingSha256).toBe(finalized.binding.sha256);
      await writeFile(join(root, 'handoff.final.json'), `${JSON.stringify({ ...handoff, evidenceBindingSha256: '0'.repeat(64) }, null, 2)}\n`);
      await expect(validateBoundPublicEvidence(finalized, { candidateVsixPath: candidate, skipVersionArchiveBinding: true })).rejects.toThrow('final handoff');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('keeps pending artifacts intact after invalid owner evidence and accepts a corrected retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finalizer-transaction-'));
    try {
      const candidate = join(root, 'candidate.vsix'); const extractedRoot = join(root, 'extracted'); const log = join(root, 'install.log');
      const fixture = join(root, 'fixture.dita'); const css = join(root, 'developer.css'); const mutable = join(root, 'mutable.dita'); const visual = join(root, 'proof.png');
      await mkdir(extractedRoot); await Promise.all([writeFile(candidate, 'candidate'), writeFile(join(extractedRoot, 'x'), 'x'), writeFile(log, 'log'), writeFile(fixture, 'fixture'), writeFile(css, 'css'), writeFile(mutable, 'before'), writeFile(visual, VALID_PNG)]);
      const inventory = await hashDirectoryInventory(extractedRoot);
      const mutableDraft = await snapshotMutableWorkingCopies([{ label: 'mutable', path: mutable, allowedActions: ['unchanged'], expectedTransitions: ['checked'], invariant: 'byte-identical' }], join(root, 'before'));
      const evidencePath = join(root, 'evidence.json'); const handoffPath = join(root, 'handoff.json');
      const draft = await createEvidenceEnvelope({ runId: 'transaction', status: 'pending-owner-observation', runType: 'public-normal', restricted: false, candidate: { path: candidate, extractedRoot, extractedInventorySha256: inventory.sha256 }, vscode: { pin: 'current-stable', version: '1.128.0', commit: 'f'.repeat(40) }, launch: { args: ['--disable-workspace-trust'], isolation: { userDataDir: '/u', extensionsDir: '/e', workspaceDir: '/w', artifactDir: root } }, logs: [{ path: log }], workspaceFixtures: [{ path: fixture }], mutableWorkingCopies: mutableDraft, developerCss: [{ path: css }], visuals: [], scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })) });
      await writeFile(evidencePath, `${JSON.stringify(draft, null, 2)}\n`);
      await writeFile(handoffPath, `${JSON.stringify({ status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: draft.binding.sha256 }, null, 2)}\n`);
      const pendingEvidenceBytes = await readFile(evidencePath); const pendingHandoffBytes = await readFile(handoffPath);
      const observations = { visuals: [{ path: visual, kind: 'screenshot' }], scenarios: PUBLIC_SCENARIO_IDS.map((id: string) => ({ id, status: 'observed', observedBy: 'owner-ui', artifactPaths: [visual] })), mutations: [{ path: mutable, action: 'unchanged', transitions: ['checked'] }] };
      await expect(finalizeOwnerEvidenceFiles(evidencePath, { ...observations, scenarios: observations.scenarios.slice(1) }, { candidateVsixPath: candidate, skipVersionArchiveBinding: true })).rejects.toThrow('exactly');
      expect(await readFile(evidencePath)).toEqual(pendingEvidenceBytes);
      expect(await readFile(handoffPath)).toEqual(pendingHandoffBytes);
      expect(await readFile(evidencePath, 'utf8')).toContain('pending-owner-observation');
      const finalized = await finalizeOwnerEvidenceFiles(evidencePath, observations, { candidateVsixPath: candidate, skipVersionArchiveBinding: true });
      expect(finalized.status).toBe('owner-observed');
      expect(JSON.parse(await readFile(join(root, 'handoff.final.json'), 'utf8')).evidenceBindingSha256).toBe(finalized.binding.sha256);
      await expect(validateBoundPublicEvidence(finalized, { candidateVsixPath: candidate, skipVersionArchiveBinding: true })).resolves.toBeTruthy();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('requires an existing VSIX and an exact supported pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vsix-args-'));
    try {
      const path = join(root, 'candidate.vsix');
      await writeFile(path, 'candidate');
      expect(parseVsixSmokeArgs([path, '--vscode-version', 'minimum']).vsixPath).toBe(path);
      expect(() => parseVsixSmokeArgs([join(root, 'missing.vsix'), '--vscode-version', 'minimum'])).toThrow('does not exist');
      expect(() => parseVsixSmokeArgs([path, '--vscode-version', 'latest'])).toThrow('minimum or current-stable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('binds an explicit local binary to exact selected product identity and bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-code-bin-'));
    const executable = join(root, 'code');
    const record = { version: '1.128.0', commit: 'f'.repeat(40) };
    try {
      await writeFile(executable, `#!/bin/sh\nprintf '1.128.0\\n${'f'.repeat(40)}\\narm64\\n'\n`);
      await chmod(executable, 0o755);
      const identity = await inspectExplicitLocalBinary(executable, record);
      await expect(validateExplicitLocalBinary(identity, record)).resolves.toBeTruthy();
      await writeFile(executable, `${await Bun.file(executable).text()}# tamper\n`);
      await chmod(executable, 0o755);
      await expect(validateExplicitLocalBinary(identity, record)).rejects.toThrow('path/hash');
      await expect(inspectExplicitLocalBinary(executable, { ...record, version: '1.90.0' })).rejects.toThrow('does not match');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('checks a macOS app through its CLI wrapper instead of launching the GUI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-code-app-'));
    const executable = join(root, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
    const cli = join(root, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code');
    const record = { version: '1.90.0', commit: '8'.repeat(40) };
    try {
      await Promise.all([mkdir(resolve(executable, '..'), { recursive: true }), mkdir(resolve(cli, '..'), { recursive: true })]);
      await writeFile(executable, '#!/bin/sh\nexit 91\n');
      await writeFile(cli, `#!/bin/sh\nprintf '1.90.0\\n${'8'.repeat(40)}\\narm64\\n'\n`);
      await Promise.all([chmod(executable, 0o755), chmod(cli, 0o755)]);
      await expect(inspectExplicitLocalBinary(executable, record)).resolves.toMatchObject({
        version: record.version,
        commit: record.commit,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('rejects source launches, install/activation failures, missing scenarios, and missing visuals', () => {
    expect(() => assertPublicSmokeEvidence(publicEvidence)).not.toThrow();
    for (const bad of [
      { ...publicEvidence, launchArguments: ['--extensionDevelopmentPath=/source'] },
      { ...publicEvidence, extension: { ...publicEvidence.extension, installed: false } },
      { ...publicEvidence, assertions: { ...publicEvidence.assertions, ditaSaveReload: false } },
      { ...publicEvidence, assertions: { ...publicEvidence.assertions, taxonomyTransitionsNoStaleFields: false } },
      { ...publicEvidence, assertions: { ...publicEvidence.assertions, unsafePathRefusedAndLogged: false } },
      { ...publicEvidence, assertions: { ...publicEvidence.assertions, developerStylesheetsUnchanged: false } },
      { ...publicEvidence, visualEvidence: [] },
      { ...publicEvidence, channel: 'insiders' },
      { ...publicEvidence, source: { ...publicEvidence.source, integrityBoundary: 'local-archive-sha256' } },
    ]) expect(() => assertPublicSmokeEvidence(bad)).toThrow();
  });
});

describe('coexistence and private consumer policy', () => {
  const ours = {
    activationEvents: ['onStartupFinished'],
    contributes: {
      commands: [{ command: 'ours.open' }],
      configuration: { properties: { 'ours.setting': {} } },
      languages: [{ id: 'dita' }],
      customEditors: [{ viewType: 'ours.visual', priority: 'default', selector: [{ filenamePattern: '*.dita' }] }],
    },
  };
  const companion = {
    activationEvents: ['onLanguage:dita'],
    contributes: {
      commands: [{ command: 'other.open' }],
      configuration: { properties: { 'other.setting': {} } },
      customEditors: [],
    },
  };

  test('rejects every overlapping contribution and activation failures', () => {
    expect(() => assertNoCoexistenceCollisions(ours, companion)).not.toThrow();
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, activationEvents: ['onStartupFinished'] })).not.toThrow();
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, contributes: { commands: [{ command: 'ours.open' }] } })).toThrow('command');
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, contributes: { configuration: { properties: { 'ours.setting': {} } } } })).toThrow('setting');
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, contributes: { settings: ['ours.setting'] } })).toThrow('setting');
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, contributes: { customEditors: [{ viewType: 'ours.visual', priority: 'default', selector: [{ filenamePattern: '*.dita' }] }] } })).toThrow('custom editor');
    expect(() => assertNoCoexistenceCollisions(ours, { ...companion, contributes: { languages: [{ id: 'dita' }] } })).toThrow('language');
    const oursWithView = { ...ours, contributes: { ...ours.contributes, views: { explorer: [{ id: 'ours.view' }] } } };
    expect(() => assertNoCoexistenceCollisions(oursWithView, { ...companion, contributes: { views: { explorer: [{ id: 'ours.view' }] } } })).toThrow('view');
  });

  test('rejects private settings/taxonomy loss, source checkout use, CSS drift, and package leaks', () => {
    const evidence = {
      extensionInstalled: true,
      extensionActivated: true,
      launchArguments: ['--user-data-dir=/tmp/private'],
      configuredAppearance: true,
      configuredTaxonomy: true,
      unknownValueRemovable: true,
      managedSaveReload: true,
      developerStylesheetsUnchanged: true,
      privatePackageScanFindings: [],
    };
    expect(() => assertPrivateSmokeEvidence(evidence)).not.toThrow();
    for (const field of ['configuredAppearance', 'configuredTaxonomy', 'unknownValueRemovable', 'managedSaveReload', 'developerStylesheetsUnchanged'] as const) {
      expect(() => assertPrivateSmokeEvidence({ ...evidence, [field]: false })).toThrow();
    }
    expect(() => assertPrivateSmokeEvidence({ ...evidence, launchArguments: ['--extensionDevelopmentPath=/source'] })).toThrow('source checkout');
    expect(() => assertPrivateSmokeEvidence({ ...evidence, privatePackageScanFindings: ['private path'] })).toThrow('private data');
  });

  test('maps commented legacy private settings into a fresh DITA Editor workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditaeditor-private-adapter-'));
    const privateRoot = join(root, 'private');
    const workspaceDir = join(root, 'isolated');
    try {
      await Promise.all([
        mkdir(join(privateRoot, '.vscode'), { recursive: true }),
        mkdir(join(privateRoot, '.ditacraft'), { recursive: true }),
        mkdir(join(privateRoot, 'css'), { recursive: true }),
        mkdir(join(privateRoot, 'src', 'dita'), { recursive: true }),
        mkdir(workspaceDir, { recursive: true }),
      ]);
      await writeFile(join(privateRoot, '.vscode', 'settings.json'), `{
        // Real VS Code settings are JSON with comments.
        "ditacraft.visual.contentStylesheets": ["css/base.css", "css/project.css"],
        "ditacraft.visual.managedAuthorStylesheet": "css/ditacraft-author-styles.css",
        "ditacraft.visual.taxonomyFile": ".ditacraft/taxonomy.json",
      }\n`);
      await Promise.all([
        writeFile(join(privateRoot, '.ditacraft', 'taxonomy.json'), '{"fields":[]}\n'),
        writeFile(join(privateRoot, 'css', 'base.css'), 'body { color: black; }\n'),
        writeFile(join(privateRoot, 'css', 'project.css'), 'p { margin: 0; }\n'),
        writeFile(join(privateRoot, 'css', 'ditacraft-author-styles.css'), '/* legacy managed CSS must not be copied */\n'),
        writeFile(join(privateRoot, 'src', 'dita', 'topic.dita'), '<topic id="t"><title>T</title><body><p>P</p></body></topic>\n'),
      ]);

      const prepared = await preparePrivateConsumerWorkspace({ workspaceDir }, privateRoot);
      const settings = JSON.parse(await readFile(prepared.settingsPath, 'utf8'));
      expect(settings).toMatchObject({
        'ditaeditor.visual.contentStylesheets': ['css/base.css', 'css/project.css'],
        'ditaeditor.visual.managedAuthorStylesheet': 'css/ditaeditor-author-styles.css',
        'ditaeditor.visual.taxonomyFile': '.ditaeditor/taxonomy.json',
        'workbench.editorAssociations': { '*.dita': 'ditaeditor.visual' },
      });
      expect(await readFile(join(prepared.workspaceRoot, 'css', 'base.css'), 'utf8')).toBe('body { color: black; }\n');
      expect(await readFile(join(prepared.workspaceRoot, 'css', 'project.css'), 'utf8')).toBe('p { margin: 0; }\n');
      expect(existsSync(prepared.managedCssPath)).toBe(false);
      expect(existsSync(join(prepared.workspaceRoot, 'css', 'ditacraft-author-styles.css'))).toBe(false);
      expect(prepared.mutableSpecs.find((entry: { label: string }) => entry.label === 'private-managed.css')).toMatchObject({
        path: prepared.managedCssPath,
        allowedActions: ['create'],
        expectedTransitions: ['managed-save-reload'],
        invariant: 'created',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('official VS Code version pin policy', () => {
  test('uses the stable release list even when latest endpoint is phased', async () => {
    const resolved = await resolveCurrentStable({
      fetchJson: async () => ['1.128.0', '1.127.0'],
      inspectExactVersion: async (version: string) => ({ version, commit: 'fc3def' }),
      inspectLatest: async () => ({ version: '1.127.0', commit: 'old' }),
    });
    expect(resolved).toEqual({ version: '1.128.0', commit: 'fc3def' });
  });

  test('rejects exact-version absence, commit mismatch, and archive hash mismatch', async () => {
    await expect(resolveCurrentStable({
      fetchJson: async () => ['1.128.0'],
      inspectExactVersion: async () => null,
    })).rejects.toThrow('exact-version');
    expect(() => assertPinnedVersionRecord({ channel: 'stable', version: '1.128.0', commit: 'wrong', platforms: [] }, { version: '1.128.0', commit: 'expected' })).toThrow('commit');
    const complete = JSON.parse(await Bun.file(join(import.meta.dir, 'vscode-version.json')).text()).currentStable;
    expect(() => assertPinnedVersionRecord({ ...complete, platforms: complete.platforms.slice(0, 6) })).toThrow('complete supported platform');
    expect(() => assertPinnedVersionRecord({ ...complete, platforms: [...complete.platforms.slice(0, 6), complete.platforms[0]] })).toThrow('duplicate');
    const root = await mkdtemp(join(tmpdir(), 'archive-hash-'));
    try {
      const archive = join(root, 'code.zip');
      await writeFile(archive, 'archive');
      await expect(verifyPinnedArchive(archive, '0'.repeat(64))).rejects.toThrow('hash');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('verifies downloaded provider bytes and labels local fallback honestly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'downloaded-archive-'));
    const bytes = new TextEncoder().encode('official archive bytes');
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const response = () => Promise.resolve(new Response(bytes));
    try {
      const provider = await downloadAndVerifyPinnedArchive({ resolvedArchiveUrl: 'https://official.test/code.zip', providerSha256: sha256 }, join(root, 'provider.zip'), response);
      expect(provider.checksumSource).toBe('provider-x-sha256-verified-bytes');
      expect(provider.providerSignature).toBe(false);
      const local = await downloadAndVerifyPinnedArchive({ resolvedArchiveUrl: 'https://official.test/code.zip', providerSha256: null, localArchiveSha256: sha256 }, join(root, 'local.zip'), response);
      expect(local.checksumSource).toBe('locally-computed-archive-sha256');
      expect(local.providerSignature).toBe(false);
      await expect(downloadAndVerifyPinnedArchive({ resolvedArchiveUrl: 'https://official.test/code.zip', providerSha256: '0'.repeat(64) }, join(root, 'bad.zip'), response)).rejects.toThrow('provider archive hash mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('freezes a distinct local archive hash when the provider exposes none', async () => {
    const localHash = 'b'.repeat(64);
    const record = await freezeVersion('1.128.0', '2026-07-11T00:00:00.000Z', {
      inspectArtifact: async (version: string, platform: any) => ({ ...platform, version, commit: 'f'.repeat(40), resolvedArchiveUrl: 'https://official.test/archive', providerSha256: null, localArchiveSha256: null, checksumSource: 'unresolved-local-fallback' }),
      verifyArchive: async () => ({ sha256: localHash, checksumSource: 'locally-computed-archive-sha256', providerSignature: false }),
    });
    expect(record.platforms).toHaveLength(7);
    expect(record.platforms.every((platform: any) => platform.providerSha256 === null && platform.localArchiveSha256 === localHash && platform.checksumSource === 'locally-computed-archive-sha256')).toBe(true);
    expect(() => assertPinnedVersionRecord(record)).not.toThrow();
  });
});
