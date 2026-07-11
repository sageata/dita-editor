import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEvidenceEnvelope,
  COEXISTENCE_SCENARIO_IDS,
  extractVsixPackage,
  preparePublicWorkspace,
  resolveSelectedCode,
  sha256File,
} from './run-vsix-smoke.mjs';
import {
  buildVsCodeLaunchArgs,
  captureCommand,
  createIsolatedSmokeLayout,
  freePort,
  finalizeLayoutLifecycle,
  installVsix,
  launchIsolatedCode,
  waitFor,
  writeUserSettings,
} from './vscode-smoke-driver.mjs';

function ids(values) {
  return new Set(values.filter((value) => typeof value === 'string' && value));
}

function commands(manifest) {
  return ids((manifest.contributes?.commands ?? []).map((entry) => typeof entry === 'string' ? entry : entry.command));
}

function settings(manifest) {
  if (Array.isArray(manifest.contributes?.settings)) return ids(manifest.contributes.settings);
  const config = manifest.contributes?.configuration;
  const sections = Array.isArray(config) ? config : config ? [config] : [];
  return ids(sections.flatMap((section) => Object.keys(section.properties ?? {})));
}

function languages(manifest) {
  return ids((manifest.contributes?.languages ?? []).map((entry) => entry.id));
}

function views(manifest) {
  const contributions = manifest.contributes?.views ?? {};
  return ids(Object.values(contributions).flatMap((entries) => (entries ?? []).map((entry) => entry.id)));
}

function editors(manifest) {
  return (manifest.contributes?.customEditors ?? []).map((editor) => ({
    viewType: editor.viewType,
    priority: editor.priority ?? 'default',
    selectors: (editor.selector ?? []).map((selector) => selector.filenamePattern).filter(Boolean),
  }));
}

function overlap(left, right) {
  return [...left].filter((value) => right.has(value));
}

export function coexistenceCollisions(left, right) {
  const collisions = [
    ...overlap(commands(left), commands(right)).map((id) => ({ category: 'command', id })),
    ...overlap(settings(left), settings(right)).map((id) => ({ category: 'setting', id })),
    ...overlap(languages(left), languages(right)).map((id) => ({ category: 'language', id })),
    ...overlap(views(left), views(right)).map((id) => ({ category: 'view', id })),
  ];
  for (const a of editors(left)) {
    for (const b of editors(right)) {
      if (a.viewType && a.viewType === b.viewType) collisions.push({ category: 'custom editor', id: a.viewType });
      const shared = a.selectors.filter((selector) => b.selectors.includes(selector));
      for (const selector of shared) {
        collisions.push({ category: 'file association', id: selector });
        if (a.priority === b.priority) collisions.push({ category: 'editor priority', id: `${selector}:${a.priority}` });
      }
    }
  }
  return collisions;
}

export function assertNoCoexistenceCollisions(left, right) {
  const collisions = coexistenceCollisions(left, right);
  if (collisions.length) throw new Error(collisions.map((item) => `${item.category}: ${item.id}`).join('\n'));
  return true;
}

export function assertCoexistenceActivationEvidence(evidence) {
  if (!evidence?.candidateInstalled || !evidence?.companionInstalled) throw new Error('both VSIX files must be installed');
  if (!evidence?.candidateActivated || !evidence?.companionActivated) throw new Error('both extensions must activate');
  if (!evidence?.visualToSourceToVisual) throw new Error('visual/source switching was not exercised');
  return evidence;
}

function parseArgs(argv) {
  const vsix = argv[0] ? resolve(argv[0]) : '';
  if (!vsix || !existsSync(vsix)) throw new Error(`VSIX does not exist: ${vsix || '<missing>'}`);
  let retain = false;
  let timeoutMs = 30_000;
  let artifactRoot;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--retain') retain = true;
    else if (argv[index] === '--timeout-ms') timeoutMs = Number(argv[++index]);
    else if (argv[index] === '--artifact-root') artifactRoot = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be at least 1000');
  return { vsix, retain, timeoutMs, artifactRoot };
}

export async function downloadPinnedCompanion(pin, destination, fetchImpl = fetch) {
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/JeremyJeanne/vsextensions/ditacraft/${pin.companionVersion}/vspackage`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`pinned companion download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== pin.companionVsixSha256) throw new Error(`pinned companion hash mismatch: ${sha256}`);
  await writeFile(destination, bytes);
  return { path: resolve(destination), url, sha256, version: pin.companionVersion };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pin = JSON.parse(await readFile(resolve(root, 'test', 'coexistence-extension.json'), 'utf8'));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = options.artifactRoot ?? join(root, 'test-artifacts', 'public-alpha-vsix-smoke', 'coexistence', runId);
  await mkdir(artifactRoot, { recursive: true });
  const candidate = await extractVsixPackage(options.vsix, join(artifactRoot, 'candidate-extracted'));
  assertNoCoexistenceCollisions(candidate.manifest, pin.manifest);
  const companion = await downloadPinnedCompanion(pin, join(artifactRoot, `JeremyJeanne.ditacraft-${pin.companionVersion}.vsix`));
  const companionExtracted = await extractVsixPackage(companion.path, join(artifactRoot, 'companion-extracted'));
  if (companionExtracted.manifest.version !== pin.companionVersion ||
      `${companionExtracted.manifest.publisher}.${companionExtracted.manifest.name}` !== pin.companionExtensionId) {
    throw new Error('downloaded companion manifest does not match the reviewed pin');
  }
  assertNoCoexistenceCollisions(candidate.manifest, companionExtracted.manifest);
  const inventoryPath = join(artifactRoot, 'extracted-inventory.json');
  await writeFile(inventoryPath, `${JSON.stringify({ candidate: candidate.inventory, companion: companionExtracted.inventory }, null, 2)}\n`);
  const pins = JSON.parse(await readFile(join(root, 'test', 'vscode-version.json'), 'utf8'));
  const layout = await createIsolatedSmokeLayout('dcc-');
  let lifecycleFinalized = false;
  try {
  const code = await resolveSelectedCode(pins.currentStable, layout, artifactRoot);
  await writeUserSettings(layout.userDataDir);
  const candidateInstall = await installVsix({ executable: code.executable, extensionsDir: layout.extensionsDir, userDataDir: layout.userDataDir, vsixPath: options.vsix });
  const companionInstall = await installVsix({ executable: code.executable, extensionsDir: layout.extensionsDir, userDataDir: layout.userDataDir, vsixPath: companion.path });
  const installLog = join(artifactRoot, 'install.log');
  await writeFile(installLog, `${candidateInstall.stdout}\n${candidateInstall.stderr}\n${companionInstall.stdout}\n${companionInstall.stderr}`);
  const workspace = await preparePublicWorkspace(layout);
  const port = await freePort();
  const topicPath = join(workspace.folderA, 'corpus', 'topic', 'lists-notes-code-lines.dita');
  const launchArgs = buildVsCodeLaunchArgs({ userDataDir: layout.userDataDir, extensionsDir: layout.extensionsDir, workspacePath: workspace.workspacePath, port });
  launchArgs.push(topicPath);
  const launch = await launchIsolatedCode({ executable: code.executable, args: launchArgs, cwd: layout.workspaceDir });
  try {
    await waitFor('coexistence VS Code launch output', async () => {
      const output = launch.output();
      if (launch.child.exitCode !== null) throw new Error(`VS Code exited ${launch.child.exitCode}: ${output.stderr}`);
      return output.stderr.includes('DevTools listening') || output.stdout.includes('DevTools listening');
    }, 15_000);
    const launchLog = join(artifactRoot, 'launch.log');
    await writeFile(launchLog, `${launch.output().stdout}\n${launch.output().stderr}`);
    const evidence = await createEvidenceEnvelope({
      runId,
      runType: 'coexistence',
      status: 'pending-owner-observation',
      candidate: {
        path: options.vsix,
        extractedRoot: join(artifactRoot, 'candidate-extracted'),
        extractedInventorySha256: candidate.inventory.sha256,
      },
      companion: {
        ...companion,
        extractedRoot: join(artifactRoot, 'companion-extracted'),
        extractedInventorySha256: companionExtracted.inventory.sha256,
      },
      vscode: {
        pin: 'current-stable', version: pins.currentStable.version, commit: pins.currentStable.commit,
        platform: code.platform.updateTarget, architecture: code.platform.architecture,
        downloadTarget: code.platform.downloadPlatform,
        providerSha256: code.sourceKind === 'official-archive' ? code.platform.providerSha256 : null,
        localArchiveSha256: code.sourceKind === 'official-archive' ? code.platform.localArchiveSha256 : null,
        archive: code.archive,
        sourceKind: code.sourceKind, localBinary: code.localBinary,
      },
      launch: { args: launchArgs, isolation: { userDataDir: layout.userDataDir, extensionsDir: layout.extensionsDir, workspaceDir: layout.workspaceDir, artifactDir: artifactRoot } },
      logs: [{ path: installLog }, { path: launchLog }, { path: inventoryPath }],
      workspaceFixtures: workspace.fixturePaths.map((path) => ({ path })),
      developerCss: [join(workspace.folderA, 'css', 'first.css'), join(workspace.folderB, 'css', 'first.css')].map((path) => ({ path })),
      visuals: [],
      scenarios: COEXISTENCE_SCENARIO_IDS.map((id) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })),
    });
    const evidencePath = join(artifactRoot, 'evidence.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const handoff = { status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: evidence.binding.sha256, extractedInventoryPath: inventoryPath, artifactRoot, profileRoot: layout.root, workspacePath: workspace.workspacePath, topicPath, pid: launch.child.pid };
    await writeFile(join(artifactRoot, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
    console.log(JSON.stringify(handoff, null, 2));
    if (options.retain) {
      await new Promise((resolveRetained, rejectRetained) => {
        let stopping = false;
        const stop = async () => { if (!stopping) { stopping = true; await launch.terminate(); resolveRetained(); } };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        launch.child.once('exit', (code) => { if (!stopping) rejectRetained(new Error(`retained coexistence VS Code exited: ${code}`)); });
      });
    } else {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, options.timeoutMs));
      await launch.terminate();
    }
    throw new Error(`PENDING_OWNER: activate both extensions and record visual/source switching in ${evidencePath}`);
  } finally {
    if (launch.child.exitCode === null && launch.child.signalCode === null) await launch.terminate();
    await finalizeLayoutLifecycle(layout, { retain: options.retain, evidenceRoot: artifactRoot });
    lifecycleFinalized = true;
  }
  } catch (error) {
    if (!lifecycleFinalized) await finalizeLayoutLifecycle(layout, { retain: false, evidenceRoot: artifactRoot });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
