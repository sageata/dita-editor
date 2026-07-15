import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildVsCodeLaunchArgs,
  captureCommand,
  cliCommandForExecutable,
  createIsolatedSmokeLayout,
  extensionIdFromManifest,
  finalizeLayoutLifecycle,
  freePort,
  installVsix,
  launchIsolatedCode,
  waitFor,
  writeUserSettings,
} from './vscode-smoke-driver.mjs';
import { assertPinnedVersionRecord, downloadAndVerifyPinnedArchive } from './resolve-vscode-versions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NORMAL_PUBLIC_SCENARIO_IDS = Object.freeze([
  'neutralDefaults',
  'orderedFolderStyles',
  'unsafePathRefusedAndLogged',
  'validTaxonomy',
  'taxonomyTransitionsNoStaleFields',
  'hostileLabelsTextOnly',
  'firstSaveCreatedManagedFile',
  'markedFileSentinelsPreserved',
  'noncanonicalFileUnchanged',
  'ditaSaveReload',
  'developerStylesheetsUnchanged',
  'outputChannelCaptured',
]);
export const RESTRICTED_PUBLIC_SCENARIO_IDS = Object.freeze([
  'neutralDefaults',
  'unsafePathRefusedAndLogged',
  'restrictedModeReadOnly',
  'outputChannelCaptured',
]);
// Compatibility alias for tests/callers that mean the normal writable run.
export const PUBLIC_SCENARIO_IDS = NORMAL_PUBLIC_SCENARIO_IDS;
export const COEXISTENCE_SCENARIO_IDS = Object.freeze([
  'candidate-activation',
  'companion-activation',
  'visual-source-visual',
]);
export const PRIVATE_SCENARIO_IDS = Object.freeze([
  'configured-appearance',
  'configured-taxonomy',
  'unknown-value-removal',
  'managed-save-reload',
]);

function expectedScenarioIds(runType) {
  if (runType === 'public-normal') return NORMAL_PUBLIC_SCENARIO_IDS;
  if (runType === 'public-restricted') return RESTRICTED_PUBLIC_SCENARIO_IDS;
  if (runType === 'coexistence') return COEXISTENCE_SCENARIO_IDS;
  if (runType === 'private') return PRIVATE_SCENARIO_IDS;
  throw new Error(`unknown smoke run type: ${runType ?? '<missing>'}`);
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function hashDirectoryInventory(root) {
  const files = [];
  async function walk(directory, relative = '') {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const path = relative ? `${relative}/${name}` : name;
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`inventory refuses symlink: ${path}`);
      if (status.isDirectory()) await walk(absolute, path);
      else if (status.isFile()) files.push({ path, sha256: await sha256File(absolute), size: status.size });
      else throw new Error(`inventory refuses non-file: ${path}`);
    }
  }
  await walk(root);
  return {
    files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

export async function snapshotMutableWorkingCopies(specs, snapshotRoot) {
  await mkdir(snapshotRoot, { recursive: true });
  return Promise.all(specs.map(async (spec, index) => {
    const exists = existsSync(spec.path);
    const snapshotPath = exists ? join(snapshotRoot, `${String(index).padStart(2, '0')}-${spec.label}`) : null;
    if (exists) await cp(spec.path, snapshotPath);
    return {
      ...spec,
      path: resolve(spec.path),
      beforeExists: exists,
      beforeSha256: exists ? await sha256File(spec.path) : null,
      snapshotPath,
      snapshotSha256: exists ? await sha256File(snapshotPath) : null,
      action: null,
      transitions: [],
      afterExists: null,
      afterSha256: null,
    };
  }));
}

function managedOutsideRegion(bytes) {
  const text = bytes.toString('utf8');
  const startMarker = '/* DITAEDITOR_MANAGED_STYLES_START */';
  const endMarker = '/* DITAEDITOR_MANAGED_STYLES_END */';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error('managed-region invariant markers are missing');
  return { prefix: bytes.subarray(0, Buffer.byteLength(text.slice(0, start + startMarker.length))), suffix: bytes.subarray(Buffer.byteLength(text.slice(0, end))) };
}

export async function finalizeMutableWorkingCopies(draft, observations) {
  const observationByPath = new Map((observations ?? []).map((entry) => [resolve(entry.path), entry]));
  if (observationByPath.size !== draft.length || draft.some((entry) => !observationByPath.has(entry.path))) {
    throw new Error('mutable working-copy observations do not match the exact expected path set');
  }
  return Promise.all(draft.map(async (entry) => {
    if (entry.snapshotPath) {
      if (!existsSync(entry.snapshotPath) || await sha256File(entry.snapshotPath) !== entry.snapshotSha256) {
        throw new Error(`immutable before snapshot changed: ${entry.path}`);
      }
    }
    const observation = observationByPath.get(entry.path);
    if (!entry.allowedActions.includes(observation.action)) throw new Error(`unexpected mutable action for ${entry.path}`);
    const transitions = observation.transitions ?? [];
    if (JSON.stringify([...transitions].sort()) !== JSON.stringify([...entry.expectedTransitions].sort())) {
      throw new Error(`mutable transition record mismatch: ${entry.path}`);
    }
    const afterExists = existsSync(entry.path);
    if (observation.action === 'delete' && afterExists) throw new Error(`expected explicit deletion: ${entry.path}`);
    if (observation.action !== 'delete' && !afterExists) throw new Error(`mutable working copy is unexpectedly missing: ${entry.path}`);
    const afterSha256 = afterExists ? await sha256File(entry.path) : null;
    if (entry.invariant === 'byte-identical' && afterSha256 !== entry.beforeSha256) throw new Error(`byte-identical refusal invariant failed: ${entry.path}`);
    if (entry.invariant === 'managed-region-only') {
      const before = await readFile(entry.snapshotPath);
      const after = await readFile(entry.path);
      const beforeOutside = managedOutsideRegion(before);
      const afterOutside = managedOutsideRegion(after);
      if (!beforeOutside.prefix.equals(afterOutside.prefix) || !beforeOutside.suffix.equals(afterOutside.suffix)) {
        throw new Error(`managed prefix/suffix invariant failed: ${entry.path}`);
      }
    }
    return { ...entry, action: observation.action, transitions, afterExists, afterSha256 };
  }));
}

async function validateMutableWorkingCopies(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('mutable working-copy evidence is missing');
  const observations = entries.map((entry) => ({ path: entry.path, action: entry.action, transitions: entry.transitions }));
  const finalized = await finalizeMutableWorkingCopies(entries, observations);
  if (finalized.some((entry, index) => entry.afterExists !== entries[index].afterExists || entry.afterSha256 !== entries[index].afterSha256)) {
    throw new Error('mutable working-copy after-state binding mismatch');
  }
}

async function validatePendingMutableWorkingCopies(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('mutable working-copy draft is missing');
  const paths = new Set();
  for (const entry of entries) {
    if (!entry?.path || resolve(entry.path) !== entry.path || paths.has(entry.path)) throw new Error('mutable working-copy draft path set is invalid');
    paths.add(entry.path);
    if (!Array.isArray(entry.allowedActions) || entry.allowedActions.length === 0 ||
        entry.allowedActions.some((action) => !['create', 'modify', 'delete', 'unchanged'].includes(action)) ||
        new Set(entry.allowedActions).size !== entry.allowedActions.length) throw new Error(`mutable allowed actions are invalid: ${entry.path}`);
    if (!Array.isArray(entry.expectedTransitions) || entry.expectedTransitions.length === 0 ||
        entry.expectedTransitions.some((transition) => typeof transition !== 'string' || !transition) ||
        new Set(entry.expectedTransitions).size !== entry.expectedTransitions.length) throw new Error(`mutable transition baseline is invalid: ${entry.path}`);
    if (!['any-change', 'managed-region-only', 'byte-identical', 'created'].includes(entry.invariant)) throw new Error(`mutable invariant is invalid: ${entry.path}`);
    if (entry.action !== null || !Array.isArray(entry.transitions) || entry.transitions.length !== 0 ||
        entry.afterExists !== null || entry.afterSha256 !== null) throw new Error(`mutable draft already contains an after state: ${entry.path}`);
    if (entry.beforeExists) {
      if (!entry.beforeSha256 || !entry.snapshotPath || !entry.snapshotSha256 ||
          !existsSync(entry.snapshotPath) || await sha256File(entry.snapshotPath) !== entry.snapshotSha256 ||
          entry.beforeSha256 !== entry.snapshotSha256) throw new Error(`mutable before-state baseline is invalid: ${entry.path}`);
    } else if (entry.beforeSha256 !== null || entry.snapshotPath !== null || entry.snapshotSha256 !== null ||
        !entry.allowedActions.includes('create') || entry.invariant !== 'created') {
      throw new Error(`mutable missing-file baseline is invalid: ${entry.path}`);
    }
  }
}

export async function extractVsixPackage(vsixPath, extractedRoot) {
  await mkdir(extractedRoot, { recursive: true });
  const extraction = await captureCommand('unzip', ['-q', resolve(vsixPath), '-d', extractedRoot]);
  if (extraction.exitCode !== 0) throw new Error(`VSIX extraction failed\n${extraction.stderr}`);
  const inventory = await hashDirectoryInventory(extractedRoot);
  const manifest = JSON.parse(await readFile(join(extractedRoot, 'extension', 'package.json'), 'utf8'));
  return { manifest, inventory };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function evidenceBinding(evidence) {
  const { binding: _binding, ...payload } = evidence;
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

async function bindFiles(entries, label) {
  return Promise.all((entries ?? []).map(async (entry) => {
    if (!entry?.path || !existsSync(entry.path)) throw new Error(`${label} file is missing: ${entry?.path ?? '<missing>'}`);
    const actual = await sha256File(entry.path);
    if (entry.sha256 && entry.sha256 !== actual) throw new Error(`${label} immutable hash changed: ${entry.path}`);
    return { ...entry, path: resolve(entry.path), sha256: entry.sha256 ?? actual };
  }));
}

export async function createEvidenceEnvelope(payload) {
  if (!payload?.candidate?.path || !existsSync(payload.candidate.path)) throw new Error('candidate VSIX is missing');
  const developerCss = await Promise.all((payload.developerCss ?? []).map(async (entry) => {
    const current = await sha256File(entry.path);
    return {
      ...entry,
      path: resolve(entry.path),
      beforeSha256: entry.beforeSha256 ?? current,
      afterSha256: entry.afterSha256 ?? current,
    };
  }));
  const envelope = {
    schemaVersion: 2,
    ...payload,
    candidate: {
      ...payload.candidate,
      path: resolve(payload.candidate.path),
      sha256: await sha256File(payload.candidate.path),
    },
    logs: await bindFiles(payload.logs, 'log'),
    workspaceFixtures: await bindFiles(payload.workspaceFixtures, 'workspace fixture'),
    developerCss,
    visuals: await bindFiles(payload.visuals, 'visual'),
  };
  return { ...envelope, binding: { algorithm: 'sha256-canonical-json', sha256: evidenceBinding(envelope) } };
}

export async function finalizeOwnerEvidence(draft, observations, validationOptions = {}) {
  await validateBoundPublicEvidence(draft, { ...validationOptions, pendingOwner: true });
  const requiresMutations = draft.runType === 'public-normal' || draft.runType === 'private';
  const forbidsMutations = draft.runType === 'public-restricted' || draft.runType === 'coexistence';
  if (!requiresMutations && !forbidsMutations) throw new Error(`unknown finalizer run type: ${draft.runType}`);
  if (requiresMutations && (!Array.isArray(draft.mutableWorkingCopies) || !Array.isArray(observations.mutations))) {
    throw new Error(`${draft.runType} finalization requires the exact mutable observation set`);
  }
  if (forbidsMutations && ((draft.mutableWorkingCopies?.length ?? 0) > 0 || (observations.mutations?.length ?? 0) > 0)) {
    throw new Error(`${draft.runType} finalization forbids mutable observations`);
  }
  const { binding: _binding, visuals: _visuals, scenarios: _scenarios, mutableWorkingCopies: _mutable, ...payload } = draft;
  return createEvidenceEnvelope({
    ...payload,
    status: 'owner-observed',
    visuals: observations.visuals,
    scenarios: observations.scenarios,
    ...(requiresMutations
      ? { mutableWorkingCopies: await finalizeMutableWorkingCopies(draft.mutableWorkingCopies, observations.mutations) }
      : {}),
  });
}

export function createFinalOwnerHandoff(evidencePath, evidence) {
  const artifactRoot = evidence.launch?.isolation?.artifactDir;
  if (!artifactRoot || resolve(dirname(evidencePath)) !== resolve(artifactRoot)) throw new Error('final evidence artifact path is inconsistent');
  return {
    status: 'OWNER_OBSERVED',
    evidencePath: resolve(evidencePath),
    evidenceBindingSha256: evidence.binding.sha256,
    runType: evidence.runType,
  };
}

export async function writeFinalOwnerHandoff(evidencePath, evidence) {
  const handoff = createFinalOwnerHandoff(evidencePath, evidence);
  const artifactRoot = evidence.launch.isolation.artifactDir;
  const handoffPath = join(artifactRoot, 'handoff.final.json');
  const temporaryPath = `${handoffPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(handoff, null, 2)}\n`);
  await rename(temporaryPath, handoffPath);
  return handoffPath;
}

async function writeJsonAtomically(path, payload) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(temporaryPath, path);
}

export async function finalizeOwnerEvidenceFiles(evidencePath, observations, validationOptions = {}) {
  const draft = JSON.parse(await readFile(evidencePath, 'utf8'));
  const finalized = await finalizeOwnerEvidence(draft, observations, validationOptions);
  const expectedFinalHandoff = createFinalOwnerHandoff(evidencePath, finalized);
  await validateBoundPublicEvidence(finalized, { ...validationOptions, expectedFinalHandoff });
  await writeFinalOwnerHandoff(evidencePath, finalized);
  await writeJsonAtomically(evidencePath, finalized);
  return finalized;
}

async function verifyBoundFiles(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} evidence is missing`);
  for (const entry of entries) {
    if (!entry?.path || !existsSync(entry.path)) throw new Error(`${label} file is missing: ${entry?.path ?? '<missing>'}`);
    if (await sha256File(entry.path) !== entry.sha256) throw new Error(`${label} hash mismatch: ${entry.path}`);
  }
}

async function verifyVisualFormat(visual) {
  const bytes = await readFile(visual.path);
  if (visual.kind === 'screenshot') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        !bytes.includes(Buffer.from('IEND'))) throw new Error(`visual PNG structure is invalid: ${visual.path}`);
  } else if (visual.kind === 'video') {
    if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error(`visual MP4 ftyp box is missing: ${visual.path}`);
    const brand = bytes.toString('ascii', 8, 12);
    const compatible = bytes.toString('ascii', 16);
    if (!['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].some((value) => brand === value || compatible.includes(value))) {
      throw new Error(`visual MP4 compatible brand is invalid: ${visual.path}`);
    }
  }
}

export async function validateBoundPublicEvidence(evidence, {
  candidateVsixPath,
  selectedPin = evidence?.vscode?.pin,
  pinsPath = join(ROOT, 'test', 'vscode-version.json'),
  skipVersionArchiveBinding = false,
  skipMutableBinding = false,
  pendingOwner = false,
  expectedFinalHandoff,
} = {}) {
  if (evidence?.schemaVersion !== 2) throw new Error('bound public smoke evidence schema is invalid');
  if (evidence.binding?.algorithm !== 'sha256-canonical-json' || evidence.binding.sha256 !== evidenceBinding(evidence)) {
    throw new Error('evidence envelope binding mismatch');
  }
  const candidate = resolve(candidateVsixPath ?? evidence.candidate?.path ?? '');
  if (!candidate || candidate !== evidence.candidate?.path || !existsSync(candidate)) throw new Error('candidate VSIX binding mismatch');
  if (await sha256File(candidate) !== evidence.candidate.sha256) throw new Error('candidate VSIX hash mismatch');
  if (!/^[a-f0-9]{64}$/.test(evidence.candidate.extractedInventorySha256 ?? '')) {
    throw new Error('candidate extracted inventory hash is missing');
  }
  if (!evidence.candidate.extractedRoot || !existsSync(evidence.candidate.extractedRoot) ||
      (await hashDirectoryInventory(evidence.candidate.extractedRoot)).sha256 !== evidence.candidate.extractedInventorySha256) {
    throw new Error('candidate extracted inventory binding mismatch');
  }
  if (evidence.runType === 'coexistence' && !evidence.companion) throw new Error('coexistence companion binding is missing');
  if (evidence.runType !== 'coexistence' && evidence.companion) throw new Error('unexpected companion binding');
  if (evidence.companion) {
    if (!evidence.companion.path || !existsSync(evidence.companion.path) ||
        await sha256File(evidence.companion.path) !== evidence.companion.sha256) {
      throw new Error('companion VSIX file/hash binding mismatch');
    }
    if (!/^[a-f0-9]{64}$/.test(evidence.companion.extractedInventorySha256 ?? '')) {
      throw new Error('companion extracted inventory hash is missing');
    }
    if (!evidence.companion.extractedRoot || !existsSync(evidence.companion.extractedRoot) ||
        (await hashDirectoryInventory(evidence.companion.extractedRoot)).sha256 !== evidence.companion.extractedInventorySha256) {
      throw new Error('companion extracted inventory binding mismatch');
    }
  }
  if (!evidence.runId || !evidence.vscode?.pin || !evidence.vscode?.version || !/^[a-f0-9]{40}$/.test(evidence.vscode?.commit ?? '')) {
    throw new Error('run ID or VS Code pin/version/commit binding is missing');
  }
  if (!skipVersionArchiveBinding) {
    if (selectedPin !== evidence.vscode.pin) throw new Error(`selected VS Code pin mismatch: ${selectedPin} != ${evidence.vscode.pin}`);
    const pins = JSON.parse(await readFile(pinsPath, 'utf8'));
    const pinKey = selectedPin === 'minimum' ? 'minimum' : selectedPin === 'current-stable' ? 'currentStable' : null;
    if (!pinKey) throw new Error(`unknown selected VS Code pin: ${selectedPin}`);
    const record = assertPinnedVersionRecord(pins[pinKey]);
    const platform = record.platforms.find((entry) =>
      entry.updateTarget === evidence.vscode.platform &&
      entry.architecture === evidence.vscode.architecture &&
      entry.downloadPlatform === evidence.vscode.downloadTarget);
    if (!platform || evidence.vscode.version !== record.version || evidence.vscode.commit !== record.commit) {
      throw new Error('VS Code pin/platform/archive metadata mismatch');
    }
    if (evidence.vscode.sourceKind === 'official-archive') {
      if (evidence.vscode.providerSha256 !== platform.providerSha256 || evidence.vscode.localArchiveSha256 !== platform.localArchiveSha256) {
        throw new Error('VS Code archive pin checksum metadata mismatch');
      }
      const archive = evidence.vscode.archive;
      if (!archive?.path || !existsSync(archive.path)) throw new Error('executed verified VS Code archive is missing');
      const actualArchiveHash = await sha256File(archive.path);
      const expectedArchiveHash = platform.providerSha256 ?? platform.localArchiveSha256;
      if (!expectedArchiveHash || actualArchiveHash !== expectedArchiveHash || archive.sha256 !== actualArchiveHash) {
        throw new Error('executed VS Code archive hash mismatch');
      }
      const expectedSource = platform.providerSha256 ? 'provider-x-sha256-verified-bytes' : 'locally-computed-archive-sha256';
      if (archive.checksumSource !== expectedSource || archive.providerSignature !== false) {
        throw new Error('VS Code archive checksum provenance mismatch');
      }
    } else if (evidence.vscode.sourceKind === 'explicit-local-binary') {
      if (evidence.vscode.archive !== null || evidence.vscode.providerSha256 !== null || evidence.vscode.localArchiveSha256 !== null) {
        throw new Error('explicit local binary must not claim provider archive evidence');
      }
      const binary = evidence.vscode.localBinary;
      await validateExplicitLocalBinary(binary, record);
    } else {
      throw new Error('VS Code source kind is invalid');
    }
  }
  if ((evidence.launch?.args ?? []).some((arg) => String(arg).toLowerCase().includes('extensiondevelopmentpath'))) {
    throw new Error('bound launch used a source checkout');
  }
  if (evidence.runType === 'public-normal') {
    if (evidence.restricted !== false || !(evidence.launch?.args ?? []).includes('--disable-workspace-trust')) {
      throw new Error('normal public evidence is not bound to a trusted writable launch');
    }
  } else if (evidence.runType === 'public-restricted') {
    if (evidence.restricted !== true || (evidence.launch?.args ?? []).includes('--disable-workspace-trust')) {
      throw new Error('restricted public evidence is not bound to a restricted launch');
    }
  }
  for (const key of ['userDataDir', 'extensionsDir', 'workspaceDir']) {
    if (!evidence.launch?.isolation?.[key]) throw new Error(`isolated launch path is missing: ${key}`);
  }
  await verifyBoundFiles(evidence.logs, 'log');
  await verifyBoundFiles(evidence.workspaceFixtures, 'workspace fixture');
  if (!skipMutableBinding && (evidence.runType === 'public-normal' || evidence.runType === 'private')) {
    if (pendingOwner) await validatePendingMutableWorkingCopies(evidence.mutableWorkingCopies);
    else await validateMutableWorkingCopies(evidence.mutableWorkingCopies);
  } else if ((evidence.mutableWorkingCopies?.length ?? 0) > 0) {
    throw new Error(`${evidence.runType} evidence must not contain mutable working copies`);
  }
  if (pendingOwner) {
    if (evidence.status !== 'pending-owner-observation' || !Array.isArray(evidence.visuals) || evidence.visuals.length !== 0) {
      throw new Error('pending owner evidence state is invalid');
    }
  } else {
    if (evidence.status !== 'owner-observed') throw new Error('final owner evidence state is invalid');
    await verifyBoundFiles(evidence.visuals, 'visual');
  }
  if (!Array.isArray(evidence.developerCss) || evidence.developerCss.length === 0) throw new Error('developer CSS evidence is missing');
  for (const css of evidence.developerCss) {
    const actual = await sha256File(css.path);
    if (css.beforeSha256 !== css.afterSha256 || actual !== css.afterSha256) throw new Error(`developer CSS hash mismatch: ${css.path}`);
  }
  for (const css of evidence.protectedPrivateCss ?? []) {
    const actual = await sha256File(css.path);
    if (css.beforeSha256 !== css.afterSha256 || actual !== css.afterSha256) {
      throw new Error(`protected private CSS hash mismatch: ${css.path}`);
    }
  }
  if (evidence.runType === 'private' && (!Array.isArray(evidence.protectedPrivateCss) || evidence.protectedPrivateCss.length === 0)) {
    throw new Error('private protected CSS baseline is missing');
  }
  if (evidence.packagePrivacy && (evidence.packagePrivacy.findings?.length ||
      !evidence.logs.some((log) => log.path === resolve(evidence.packagePrivacy.logPath)))) {
    throw new Error('package privacy evidence is missing or contains findings');
  }
  if (evidence.runType === 'private' && !evidence.packagePrivacy) throw new Error('private package privacy baseline is missing');
  const expectedIds = [...expectedScenarioIds(evidence.runType)].sort();
  const actualIds = (evidence.scenarios ?? []).map((scenario) => scenario.id);
  if (new Set(actualIds).size !== actualIds.length) throw new Error('duplicate scenario ID');
  if (JSON.stringify([...actualIds].sort()) !== JSON.stringify(expectedIds)) {
    throw new Error('scenario IDs do not exactly match the expected run type set');
  }
  if (pendingOwner) {
    for (const scenario of evidence.scenarios) {
      if (scenario.status !== 'pending-owner' || scenario.observedBy !== null || !Array.isArray(scenario.artifactPaths) || scenario.artifactPaths.length !== 0) {
        throw new Error(`pending scenario baseline is invalid: ${scenario.id ?? '<missing>'}`);
      }
    }
    const artifactRoot = evidence.launch?.isolation?.artifactDir;
    if (artifactRoot) {
      const handoff = JSON.parse(await readFile(join(artifactRoot, 'handoff.json'), 'utf8'));
      if (handoff.status !== 'PENDING_OWNER' || resolve(handoff.evidencePath) !== join(resolve(artifactRoot), 'evidence.json') ||
          handoff.evidenceBindingSha256 !== evidence.binding.sha256) throw new Error('pending handoff binding mismatch');
    }
    return evidence;
  }
  const artifactRoot = evidence.launch?.isolation?.artifactDir;
  if (artifactRoot) {
    const handoff = expectedFinalHandoff ?? JSON.parse(await readFile(join(artifactRoot, 'handoff.final.json'), 'utf8'));
    if (handoff.status !== 'OWNER_OBSERVED' || resolve(handoff.evidencePath) !== join(resolve(artifactRoot), 'evidence.json') ||
        handoff.evidenceBindingSha256 !== evidence.binding.sha256 || handoff.runType !== evidence.runType) {
      throw new Error('final handoff binding mismatch');
    }
  }
  const visualByPath = new Map(evidence.visuals.map((visual) => [visual.path, visual]));
  for (const visual of evidence.visuals) {
    const extension = visual.path.toLowerCase().match(/\.[^.]+$/)?.[0];
    const expectedExtension = visual.kind === 'screenshot' ? '.png' : visual.kind === 'video' ? '.mp4' : null;
    if (!expectedExtension || extension !== expectedExtension) throw new Error(`visual kind/extension mismatch: ${visual.path}`);
    await verifyVisualFormat(visual);
  }
  for (const scenario of evidence.scenarios) {
    if (scenario.status !== 'observed' || !['owner-ui', 'automation-ui'].includes(scenario.observedBy)) {
      throw new Error(`scenario is not observed: ${scenario.id ?? '<missing>'}`);
    }
    if (!Array.isArray(scenario.artifactPaths) || scenario.artifactPaths.length === 0) {
      throw new Error(`scenario has no bound artifact: ${scenario.id}`);
    }
    for (const artifactPath of scenario.artifactPaths) {
      if (!visualByPath.has(resolve(artifactPath))) {
        throw new Error(`scenario visual is unbound: ${artifactPath}`);
      }
    }
  }
  return evidence;
}

export function parseVsixSmokeArgs(argv) {
  const vsixPath = argv[0] ? resolve(argv[0]) : '';
  let vscodeVersion;
  let evidencePath;
  let retain = false;
  let timeoutMs = 30_000;
  let runId;
  let artifactRoot;
  let finalizeOwnerPath;
  let restricted = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vscode-version') vscodeVersion = argv[++index];
    else if (arg === '--evidence') evidencePath = resolve(argv[++index]);
    else if (arg === '--retain') retain = true;
    else if (arg === '--timeout-ms') timeoutMs = Number(argv[++index]);
    else if (arg === '--run-id') runId = argv[++index];
    else if (arg === '--artifact-root') artifactRoot = resolve(argv[++index]);
    else if (arg === '--finalize-owner') finalizeOwnerPath = resolve(argv[++index]);
    else if (arg === '--restricted') restricted = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!vsixPath || !existsSync(vsixPath)) throw new Error(`VSIX does not exist: ${vsixPath || '<missing>'}`);
  if (!['minimum', 'current-stable'].includes(vscodeVersion)) {
    throw new Error('--vscode-version must be minimum or current-stable');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error('--timeout-ms must be 1000..3600000');
  if (runId && !/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('--run-id is not filesystem-safe');
  if (finalizeOwnerPath && !evidencePath) throw new Error('--finalize-owner requires --evidence');
  return { vsixPath, vscodeVersion, evidencePath, retain, timeoutMs, runId, artifactRoot, finalizeOwnerPath, restricted };
}

export function assertPublicSmokeEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== 1) throw new Error('public smoke evidence schema is missing');
  if (evidence.channel !== 'stable') throw new Error('public smoke must use the stable channel');
  if (!['minimum', 'current-stable'].includes(evidence.selectedPin)) throw new Error('selected VS Code pin is invalid');
  const source = evidence.source ?? {};
  if (source.kind === 'local-executable' && !source.exactPinMatch) throw new Error('local VS Code executable does not exactly match the selected pin');
  if (!['official-exact-version-download', 'local-executable'].includes(source.kind)) throw new Error('VS Code source is not approved');
  for (const field of ['updateServiceUrl', 'version', 'commit', 'platform', 'architecture', 'integrityBoundary']) {
    if (!source[field]) throw new Error(`VS Code evidence field missing: ${field}`);
  }
  if (!source.providerSha256 && !source.localArchiveSha256) throw new Error('VS Code archive checksum evidence is missing');
  if (source.integrityBoundary === 'local-archive-sha256') {
    throw new Error('a locally computed archive hash is not an upstream signature or integrity boundary');
  }
  if (!evidence.extension?.installed) throw new Error('candidate VSIX was not installed');
  if (!evidence.extension?.activated) throw new Error('installed extension did not activate');
  if ((evidence.launchArguments ?? []).some((arg) => String(arg).toLowerCase().includes('extensiondevelopmentpath'))) {
    throw new Error('public smoke used a source checkout');
  }
  for (const [name, value] of Object.entries(evidence.isolated ?? {})) {
    if (!value) throw new Error(`smoke directory was not isolated: ${name}`);
  }
  for (const assertion of PUBLIC_SCENARIO_IDS) {
    if (evidence.assertions?.[assertion] !== true) throw new Error(`required smoke assertion failed: ${assertion}`);
  }
  if (!Array.isArray(evidence.visualEvidence) || evidence.visualEvidence.length === 0 ||
      evidence.visualEvidence.some((item) => !item?.path || !item?.kind)) {
    throw new Error('installed webview visual evidence is missing');
  }
  return evidence;
}

function currentPlatformRecord(record) {
  const arch = process.arch === 'arm' ? 'armhf' : process.arch;
  const match = record.platforms.find((entry) => entry.os === process.platform && entry.architecture === arch);
  if (!match) throw new Error(`no pinned VS Code artifact for ${process.platform}/${arch}`);
  return match;
}

async function packageManifest(vsixPath) {
  const result = await captureCommand('unzip', ['-p', vsixPath, 'extension/package.json']);
  if (result.exitCode !== 0) throw new Error(`could not read packaged manifest\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function localExecutableIdentity(executable, expected, capture = captureCommand) {
  const identityCommand = /\.app\/Contents\/MacOS\/(?:Electron|Code)$/.test(executable)
    ? cliCommandForExecutable(executable, 'darwin')
    : { command: executable, args: [] };
  const result = await capture(identityCommand.command, [...identityCommand.args, '--version']);
  if (result.exitCode !== 0) throw new Error(`local VS Code version check failed\n${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  const identity = { version: lines[0], commit: lines[1] };
  if (identity.version !== expected.version || identity.commit !== expected.commit) {
    throw new Error(`local VS Code ${identity.version}/${identity.commit} does not match ${expected.version}/${expected.commit}`);
  }
  return { ...identity, output: result.stdout };
}

export async function inspectExplicitLocalBinary(executable, record, capture = captureCommand) {
  const path = await realpath(resolve(executable));
  const identity = await localExecutableIdentity(path, record, capture);
  return {
    path,
    sha256: await sha256File(path),
    version: identity.version,
    commit: identity.commit,
    identityOutputSha256: createHash('sha256').update(identity.output).digest('hex'),
  };
}

export async function validateExplicitLocalBinary(binary, record) {
  if (!binary?.path || !existsSync(binary.path) || await realpath(binary.path) !== binary.path || await sha256File(binary.path) !== binary.sha256) {
    throw new Error('explicit local binary path/hash identity mismatch');
  }
  const actual = await inspectExplicitLocalBinary(binary.path, record);
  if (binary.version !== actual.version || binary.commit !== actual.commit || binary.identityOutputSha256 !== actual.identityOutputSha256) {
    throw new Error('explicit local binary product identity mismatch');
  }
  return actual;
}

export async function resolveSelectedCode(record, layout, artifactDir = layout.artifactDir) {
  const platform = currentPlatformRecord(record);
  if (process.env.DITAEDITOR_VSCODE_BIN) {
    const executable = await realpath(resolve(process.env.DITAEDITOR_VSCODE_BIN));
    const localBinary = await inspectExplicitLocalBinary(executable, record);
    return {
      executable,
      platform,
      sourceKind: 'explicit-local-binary',
      exactPinMatch: true,
      archive: null,
      localBinary,
    };
  }
  await mkdir(artifactDir, { recursive: true });
  const archive = await downloadAndVerifyPinnedArchive(
    platform,
    join(artifactDir, `vscode-${record.version}-${platform.updateTarget}.archive`),
  );
  const extractedCodeRoot = join(layout.root, 'verified-vscode');
  await mkdir(extractedCodeRoot, { recursive: true });
  const extract = platform.os === 'linux'
    ? await captureCommand('tar', ['-xzf', archive.path, '-C', extractedCodeRoot], { timeoutMs: 120_000 })
    : await captureCommand('unzip', ['-q', archive.path, '-d', extractedCodeRoot], { timeoutMs: 120_000 });
  if (extract.exitCode !== 0) throw new Error(`verified VS Code archive extraction failed\n${extract.stderr}`);
  async function findExecutable(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await findExecutable(path);
        if (nested) return nested;
      } else if (entry.isFile()) {
        if (platform.os === 'darwin' && /\.app\/Contents\/MacOS\/(?:Electron|Code)$/.test(path)) return path;
        if (platform.os === 'win32' && entry.name === 'Code.exe') return path;
        if (platform.os === 'linux' && entry.name === 'code' && /VSCode-linux/.test(path)) return path;
      }
    }
    return null;
  }
  const executable = await findExecutable(extractedCodeRoot);
  if (!executable) throw new Error(`verified VS Code executable not found in ${extractedCodeRoot}`);
  await localExecutableIdentity(executable, record);
  return { executable, platform, sourceKind: 'official-archive', archive, localBinary: null };
}

export async function preparePublicWorkspace(layout) {
  const folderA = join(layout.workspaceDir, 'folder-a');
  const folderB = join(layout.workspaceDir, 'folder-b');
  await Promise.all([mkdir(join(folderA, '.vscode'), { recursive: true }), mkdir(join(folderB, '.vscode'), { recursive: true })]);
  await cp(join(ROOT, 'test', 'fixtures', 'corpus'), join(folderA, 'corpus'), { recursive: true });
  await cp(join(ROOT, 'test', 'fixtures', 'corpus'), join(folderB, 'corpus'), { recursive: true });
  const immutableFixturePaths = [];
  const mutableSpecs = [];
  for (const [folder, color, label, variant] of [[folderA, '#123456', 'Folder A', 'a'], [folderB, '#654321', 'Folder B', 'b']]) {
    await mkdir(join(folder, 'css'), { recursive: true });
    await mkdir(join(folder, '.ditaeditor'), { recursive: true });
    await writeFile(join(folder, 'css', 'first.css'), `.topic { color: ${color}; }\n`);
    await writeFile(join(folder, 'css', 'second.css'), `.title { border-color: ${color}; }\n`);
    const taxonomyPath = join(folder, '.ditaeditor', 'taxonomy.json');
    await writeFile(taxonomyPath, JSON.stringify({
      version: 1,
      fields: [{ attribute: 'audience', label, values: [{ value: 'author', label: `${label} author` }] }],
    }, null, 2));
    const settingsPath = join(folder, '.vscode', 'settings.json');
    const settingsBytes = `${JSON.stringify({
      'ditaeditor.visual.contentStylesheets': ['css/first.css', 'css/second.css'],
      'ditaeditor.visual.managedAuthorStylesheet': 'css/managed.css',
      'ditaeditor.visual.taxonomyFile': '.ditaeditor/taxonomy.json',
      'workbench.editorAssociations': { '*.dita': 'ditaeditor.visual' },
    }, null, 2)}\n`;
    await writeFile(settingsPath, settingsBytes);
    const variantPath = join(folder, '.vscode', `settings.${variant}.json`);
    await writeFile(variantPath, settingsBytes);
    immutableFixturePaths.push(variantPath, join(folder, 'css', 'first.css'), join(folder, 'css', 'second.css'));
    if (variant === 'a') {
      mutableSpecs.push(
        { label: 'settings.json', path: settingsPath, allowedActions: ['modify'], expectedTransitions: ['neutral', 'folder-a', 'unsafe'], invariant: 'any-change' },
        { label: 'taxonomy.json', path: taxonomyPath, allowedActions: ['modify', 'delete'], expectedTransitions: ['valid-a', 'invalid', 'deleted', 'disabled', 'valid-b', 'hostile'], invariant: 'any-change' },
      );
    } else {
      immutableFixturePaths.push(taxonomyPath, settingsPath);
    }
  }
  const neutralSettings = join(folderA, '.vscode', 'settings.neutral.json');
  const unsafeSettings = join(folderA, '.vscode', 'settings.unsafe.json');
  const taxonomyA = join(folderA, '.ditaeditor', 'taxonomy-a.json');
  const taxonomyB = join(folderA, '.ditaeditor', 'taxonomy-b.json');
  const taxonomyInvalid = join(folderA, '.ditaeditor', 'taxonomy-invalid.json');
  const taxonomyHostile = join(folderA, '.ditaeditor', 'taxonomy-hostile.json');
  const managedSentinel = join(folderA, 'css', 'managed-sentinel.css');
  const noncanonical = join(folderA, 'css', 'managed-noncanonical.css');
  await writeFile(neutralSettings, JSON.stringify({
    'ditaeditor.visual.contentStylesheets': [],
    'ditaeditor.visual.managedAuthorStylesheet': 'css/managed-new.css',
    'ditaeditor.visual.taxonomyFile': '',
    'workbench.editorAssociations': { '*.dita': 'ditaeditor.visual' },
  }, null, 2));
  await writeFile(unsafeSettings, JSON.stringify({
    'ditaeditor.visual.contentStylesheets': ['../escape.css'],
    'ditaeditor.visual.managedAuthorStylesheet': '../escape-managed.css',
    'ditaeditor.visual.taxonomyFile': '../escape-taxonomy.json',
  }, null, 2));
  await writeFile(taxonomyA, JSON.stringify({ version: 1, fields: [{ attribute: 'audience', label: 'Taxonomy A', values: [{ value: 'a', label: 'A' }] }] }, null, 2));
  await writeFile(taxonomyB, JSON.stringify({ version: 1, fields: [{ attribute: 'platform', label: 'Taxonomy B', values: [{ value: 'b', label: 'B' }] }] }, null, 2));
  await writeFile(taxonomyInvalid, '{"version":1,"fields":[');
  await writeFile(taxonomyHostile, JSON.stringify({
    version: 1,
    fields: [{
      attribute: 'audience',
      label: '<img src=x onerror="globalThis.__hostile=1">',
      values: [{ value: 'unknown-existing', label: '<script>globalThis.__hostile=1</script>' }],
    }],
  }, null, 2));
  await writeFile(managedSentinel, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('/* PREFIX-SENTINEL */\r\n/* DITAEDITOR_MANAGED_STYLES_START */\r\n/* DITAEDITOR_MANAGED_STYLES_END */\r\n/* SUFFIX-SENTINEL */\r\n'),
  ]));
  await writeFile(noncanonical, '/* developer CSS without canonical managed markers */\n.topic { color: rebeccapurple; }\n');
  immutableFixturePaths.push(neutralSettings, unsafeSettings, taxonomyA, taxonomyB, taxonomyInvalid, taxonomyHostile);
  mutableSpecs.push(
    { label: 'managed-sentinel.css', path: managedSentinel, allowedActions: ['modify'], expectedTransitions: ['managed-save'], invariant: 'managed-region-only' },
    { label: 'managed-noncanonical.css', path: noncanonical, allowedActions: ['unchanged'], expectedTransitions: ['refused-save'], invariant: 'byte-identical' },
    { label: 'managed-new.css', path: join(folderA, 'css', 'managed-new.css'), allowedActions: ['create'], expectedTransitions: ['first-save'], invariant: 'created' },
  );
  const workspacePath = join(layout.workspaceDir, 'public-smoke.code-workspace');
  await writeFile(workspacePath, JSON.stringify({ folders: [{ path: folderA }, { path: folderB }] }, null, 2));
  immutableFixturePaths.push(workspacePath);
  const topicPath = join(folderA, 'corpus', 'topic', 'lists-notes-code-lines.dita');
  mutableSpecs.push({ label: 'topic-save-reload.dita', path: topicPath, allowedActions: ['modify'], expectedTransitions: ['save-reload'], invariant: 'any-change' });
  return { workspacePath, folderA, folderB, topicPath, immutableFixturePaths, mutableSpecs, fixturePaths: [...immutableFixturePaths] };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseVsixSmokeArgs(argv);
  if (options.evidencePath) {
    if (options.finalizeOwnerPath) {
      const observations = JSON.parse(await readFile(options.finalizeOwnerPath, 'utf8'));
      await finalizeOwnerEvidenceFiles(options.evidencePath, observations, {
        candidateVsixPath: options.vsixPath,
        selectedPin: options.vscodeVersion,
      });
    }
    await validateBoundPublicEvidence(
      JSON.parse(await readFile(options.evidencePath, 'utf8')),
      { candidateVsixPath: options.vsixPath, selectedPin: options.vscodeVersion },
    );
    console.log(`Validated installed smoke evidence: ${options.evidencePath}`);
    return;
  }
  const pins = JSON.parse(await readFile(join(ROOT, 'test', 'vscode-version.json'), 'utf8'));
  const record = options.vscodeVersion === 'minimum' ? pins.minimum : pins.currentStable;
  const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = options.artifactRoot ?? join(
    ROOT,
    'test-artifacts',
    'public-alpha-vsix-smoke',
    options.vscodeVersion,
    runId,
  );
  await mkdir(artifactRoot, { recursive: true });
  const layout = await createIsolatedSmokeLayout('dcv-');
  let launch;
  try {
    const extractedRoot = join(artifactRoot, 'extracted-vsix');
    const extracted = await extractVsixPackage(options.vsixPath, extractedRoot);
    const extractedInventory = extracted.inventory;
    await writeFile(join(artifactRoot, 'extracted-inventory.json'), `${JSON.stringify(extractedInventory, null, 2)}\n`);
    const manifest = extracted.manifest;
    const extensionId = extensionIdFromManifest(manifest);
    const code = await resolveSelectedCode(record, layout, artifactRoot);
    await writeUserSettings(layout.userDataDir);
    const install = await installVsix({
      executable: code.executable,
      extensionsDir: layout.extensionsDir,
      userDataDir: layout.userDataDir,
      vsixPath: options.vsixPath,
    });
    const cli = cliCommandForExecutable(code.executable);
    const listed = await captureCommand(cli.command, [...cli.args, `--extensions-dir=${layout.extensionsDir}`, '--list-extensions', '--show-versions']);
    if (!listed.stdout.toLowerCase().includes(`${extensionId}@${manifest.version}`.toLowerCase())) {
      throw new Error(`installed extension missing from isolated profile\n${listed.stdout}\n${listed.stderr}`);
    }
    const installLog = join(artifactRoot, 'install.log');
    await writeFile(installLog, `${install.stdout}\n${install.stderr}`);
    const workspace = await preparePublicWorkspace(layout);
    const mutableWorkingCopies = options.restricted
      ? undefined
      : await snapshotMutableWorkingCopies(workspace.mutableSpecs, join(artifactRoot, 'before-state'));
    const port = await freePort();
    const launchArguments = buildVsCodeLaunchArgs({
      userDataDir: layout.userDataDir,
      extensionsDir: layout.extensionsDir,
      workspacePath: workspace.workspacePath,
      port,
      restrictedMode: options.restricted,
    });
    const topicPath = join(workspace.folderA, 'corpus', 'topic', 'lists-notes-code-lines.dita');
    launchArguments.push(topicPath);
    launch = await launchIsolatedCode({
      executable: code.executable,
      args: launchArguments,
      cwd: layout.workspaceDir,
    });
    await waitFor('isolated VS Code launch output', async () => {
      const output = launch.output();
      if (launch.child.exitCode !== null) throw new Error(`VS Code exited ${launch.child.exitCode}: ${output.stderr}`);
      return output.stderr.includes('DevTools listening') || output.stdout.includes('DevTools listening');
    }, 15_000);
    const launchLog = join(artifactRoot, 'launch.log');
    await writeFile(launchLog, `${launch.output().stdout}\n${launch.output().stderr}`);
    const cssPaths = [
      join(workspace.folderA, 'css', 'first.css'),
      join(workspace.folderA, 'css', 'second.css'),
      join(workspace.folderB, 'css', 'first.css'),
      join(workspace.folderB, 'css', 'second.css'),
    ];
    const evidence = await createEvidenceEnvelope({
      runId,
      status: 'pending-owner-observation',
      candidate: {
        path: options.vsixPath,
        extractedRoot,
        extractedInventorySha256: extractedInventory.sha256,
        extensionId,
        version: manifest.version,
      },
      vscode: {
        pin: options.vscodeVersion,
        channel: record.channel,
        version: record.version,
        commit: record.commit,
        platform: code.platform.updateTarget,
        architecture: code.platform.architecture,
        downloadTarget: code.platform.downloadPlatform,
        providerSha256: code.sourceKind === 'official-archive' ? code.platform.providerSha256 : null,
        localArchiveSha256: code.sourceKind === 'official-archive' ? code.platform.localArchiveSha256 : null,
        archive: code.archive,
        sourceKind: code.sourceKind,
        localBinary: code.localBinary,
      },
      launch: {
        args: launchArguments,
        pid: launch.child.pid,
        isolation: {
          root: layout.root,
          userDataDir: layout.userDataDir,
          extensionsDir: layout.extensionsDir,
          workspaceDir: layout.workspaceDir,
          artifactDir: artifactRoot,
        },
      },
      logs: [{ path: installLog }, { path: launchLog }],
      workspaceFixtures: workspace.immutableFixturePaths.map((path) => ({ path })),
      ...(mutableWorkingCopies ? { mutableWorkingCopies } : {}),
      developerCss: cssPaths.map((path) => ({ path, beforeSha256: null, afterSha256: null })),
      visuals: [],
      runType: options.restricted ? 'public-restricted' : 'public-normal',
      restricted: options.restricted,
      scenarios: (options.restricted ? RESTRICTED_PUBLIC_SCENARIO_IDS : NORMAL_PUBLIC_SCENARIO_IDS)
        .map((id) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })),
    });
    const evidencePath = join(artifactRoot, 'evidence.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const handoff = {
      status: 'PENDING_OWNER',
      runId,
      commandMode: options.retain ? 'retained-owner-review' : 'bounded-preparation',
      restrictedMode: options.restricted,
      evidencePath,
      evidenceBindingSha256: evidence.binding.sha256,
      artifactRoot,
      profileRoot: layout.root,
      workspacePath: workspace.workspacePath,
      topicPath,
      pid: launch.child.pid,
      validationCommand: `bun run smoke:vsix -- ${options.vsixPath} --vscode-version ${options.vscodeVersion} --evidence ${evidencePath}`,
    };
    await writeFile(join(artifactRoot, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
    console.log(JSON.stringify(handoff, null, 2));
    if (options.retain) {
      await new Promise((resolveRetained, rejectRetained) => {
        let stopping = false;
        const stop = async () => {
          if (stopping) return;
          stopping = true;
          await launch.terminate();
          resolveRetained();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        launch.child.once('exit', (code) => {
          if (!stopping) rejectRetained(new Error(`retained VS Code exited unexpectedly: ${code}`));
        });
      });
    } else {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, options.timeoutMs));
      await launch.terminate();
    }
    throw new Error(`PENDING_OWNER: complete observed scenarios and visual evidence, then validate ${evidencePath}`);
  } finally {
    if (launch && launch.child.exitCode === null && launch.child.signalCode === null) await launch.terminate();
    await finalizeLayoutLifecycle(layout, { retain: options.retain, evidenceRoot: artifactRoot });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
