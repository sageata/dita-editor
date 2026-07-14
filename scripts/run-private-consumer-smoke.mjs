import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  createEvidenceEnvelope,
  extractVsixPackage,
  resolveSelectedCode,
  sha256File,
  PRIVATE_SCENARIO_IDS,
  snapshotMutableWorkingCopies,
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

export function assertPrivateSmokeEvidence(evidence) {
  if (!evidence?.extensionInstalled) throw new Error('candidate VSIX was not installed');
  if (!evidence?.extensionActivated) throw new Error('installed extension did not activate');
  if ((evidence.launchArguments ?? []).some((arg) => String(arg).toLowerCase().includes('extensiondevelopmentpath'))) {
    throw new Error('private smoke used a source checkout');
  }
  if (!evidence.configuredAppearance) throw new Error('private appearance settings were not observed');
  if (!evidence.configuredTaxonomy) throw new Error('private taxonomy was not observed');
  if (!evidence.unknownValueRemovable) throw new Error('existing unknown private taxonomy value was not removable');
  if (!evidence.managedSaveReload) throw new Error('private managed save/reload failed');
  if (!evidence.developerStylesheetsUnchanged) throw new Error('private developer CSS changed');
  if ((evidence.privatePackageScanFindings ?? []).length) throw new Error('private data was found in the package');
  return evidence;
}

function parsePrivateSettings(source) {
  const errors = [];
  const settings = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('private workspace settings.json is not valid JSON with comments');
  }
  return settings;
}

export function parsePrivateSmokeArgs(argv, env = process.env) {
  const vsix = argv[0] ? resolve(argv[0]) : '';
  if (!vsix || !existsSync(vsix)) throw new Error(`VSIX does not exist: ${vsix || '<missing>'}`);
  let retain = false;
  let timeoutMs = 30_000;
  let artifactRoot;
  let consumerRoot = env.DITAEDITOR_PRIVATE_CONSUMER_ROOT?.trim()
    ? resolve(env.DITAEDITOR_PRIVATE_CONSUMER_ROOT)
    : '';
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--retain') retain = true;
    else if (argv[index] === '--timeout-ms') timeoutMs = Number(argv[++index]);
    else if (argv[index] === '--artifact-root') artifactRoot = resolve(argv[++index]);
    else if (argv[index] === '--consumer-root') consumerRoot = resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be at least 1000');
  if (!consumerRoot) {
    throw new Error('private consumer root is required; pass --consumer-root or set DITAEDITOR_PRIVATE_CONSUMER_ROOT');
  }
  if (!existsSync(consumerRoot)) throw new Error(`private consumer root does not exist: ${consumerRoot}`);
  return { vsix, retain, timeoutMs, artifactRoot, consumerRoot };
}

function configuredPrivateSetting(settings, currentKey, legacyKey) {
  return settings[currentKey] ?? settings[legacyKey];
}

function privateWorkspacePath(privateRoot, configuredPath, label) {
  if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
    throw new Error(`${label} must be a non-empty workspace-relative path`);
  }
  if (isAbsolute(configuredPath) || /^[a-z][a-z0-9+.-]*:/iu.test(configuredPath)) {
    throw new Error(`${label} must be workspace-relative`);
  }
  const absolute = resolve(privateRoot, configuredPath);
  const fromRoot = relative(privateRoot, absolute);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the private consumer root`);
  }
  return absolute;
}

export async function preparePrivateConsumerWorkspace(layout, privateRoot) {
  const workspaceRoot = join(layout.workspaceDir, 'private-consumer');
  await Promise.all([
    mkdir(join(workspaceRoot, '.vscode'), { recursive: true }),
    mkdir(join(workspaceRoot, '.ditaeditor'), { recursive: true }),
    mkdir(join(workspaceRoot, 'css'), { recursive: true }),
    mkdir(join(workspaceRoot, 'topics'), { recursive: true }),
  ]);
  const settingsPath = join(workspaceRoot, '.vscode', 'settings.json');
  const taxonomyPath = join(workspaceRoot, '.ditaeditor', 'taxonomy.json');
  const sourceSettings = parsePrivateSettings(await readFile(join(privateRoot, '.vscode', 'settings.json'), 'utf8'));
  const configuredContent = configuredPrivateSetting(
    sourceSettings,
    'ditaeditor.visual.contentStylesheets',
    'ditacraft.visual.contentStylesheets',
  );
  const configuredManaged = configuredPrivateSetting(
    sourceSettings,
    'ditaeditor.visual.managedAuthorStylesheet',
    'ditacraft.visual.managedAuthorStylesheet',
  );
  const configuredTaxonomy = configuredPrivateSetting(
    sourceSettings,
    'ditaeditor.visual.taxonomyFile',
    'ditacraft.visual.taxonomyFile',
  );
  if (!Array.isArray(configuredContent) || configuredContent.length < 2 ||
      configuredContent.some((path) => typeof path !== 'string') ||
      typeof configuredManaged !== 'string' || typeof configuredTaxonomy !== 'string') {
    throw new Error('private workspace does not configure the required appearance files');
  }
  const migratedManagedPath = 'css/ditaeditor-author-styles.css';
  const settings = {
    'ditaeditor.visual.contentStylesheets': configuredContent,
    'ditaeditor.visual.managedAuthorStylesheet': migratedManagedPath,
    'ditaeditor.visual.taxonomyFile': '.ditaeditor/taxonomy.json',
    'workbench.editorAssociations': { '*.dita': 'ditaeditor.visual' },
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await cp(
    privateWorkspacePath(privateRoot, configuredTaxonomy, 'private taxonomy setting'),
    taxonomyPath,
  );
  const developerCssPaths = [];
  for (const configuredPath of configuredContent) {
    const target = privateWorkspacePath(workspaceRoot, configuredPath, 'private stylesheet setting');
    await mkdir(dirname(target), { recursive: true });
    await cp(
      privateWorkspacePath(privateRoot, configuredPath, 'private stylesheet setting'),
      target,
    );
    developerCssPaths.push(target);
  }
  async function firstTopic(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await firstTopic(path);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name.endsWith('.dita')) return path;
    }
    return null;
  }
  const sourceTopic = await firstTopic(join(privateRoot, 'src', 'dita'));
  if (!sourceTopic) throw new Error('private workspace contains no DITA topic');
  const topicPath = join(workspaceRoot, 'topics', 'private-consumer.dita');
  const source = await readFile(sourceTopic, 'utf8');
  await writeFile(topicPath, source.replace(/<(topic|concept|task|reference)\b/, '<$1 cabin="UNKNOWN-OWNER-REMOVE"'));
  const workspacePath = join(layout.workspaceDir, 'private-consumer.code-workspace');
  await writeFile(workspacePath, `${JSON.stringify({ folders: [{ path: workspaceRoot }] }, null, 2)}\n`);
  return {
    workspaceRoot,
    workspacePath,
    topicPath,
    settingsPath,
    taxonomyPath,
    developerCssPaths,
    managedCssPath: join(workspaceRoot, migratedManagedPath),
    immutableFixturePaths: [workspacePath, settingsPath, taxonomyPath, ...developerCssPaths],
    mutableSpecs: [
      { label: 'private-consumer.dita', path: topicPath, allowedActions: ['modify'], expectedTransitions: ['unknown-value-removal'], invariant: 'any-change' },
      { label: 'private-managed.css', path: join(workspaceRoot, migratedManagedPath), allowedActions: ['create'], expectedTransitions: ['managed-save-reload'], invariant: 'created' },
    ],
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parsePrivateSmokeArgs(argv);
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const privateRoot = options.consumerRoot;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = options.artifactRoot ?? join(extensionRoot, 'test-artifacts', 'public-alpha-vsix-smoke', 'private', runId);
  await mkdir(artifactRoot, { recursive: true });
  const extracted = await extractVsixPackage(options.vsix, join(artifactRoot, 'candidate-extracted'));
  const inventoryPath = join(artifactRoot, 'extracted-inventory.json');
  await writeFile(inventoryPath, `${JSON.stringify(extracted.inventory, null, 2)}\n`);
  const privacy = await captureCommand('node', [join(extensionRoot, 'scripts', 'inspect-vsix.mjs'), options.vsix]);
  const privacyLog = join(artifactRoot, 'package-privacy.log');
  await writeFile(privacyLog, `${privacy.stdout}\n${privacy.stderr}`);
  if (privacy.exitCode !== 0) throw new Error(`candidate package privacy scan failed\n${privacy.stdout}\n${privacy.stderr}`);
  const privateSettings = parsePrivateSettings(await readFile(join(privateRoot, '.vscode', 'settings.json'), 'utf8'));
  const configuredDeveloperCss = configuredPrivateSetting(
    privateSettings,
    'ditaeditor.visual.contentStylesheets',
    'ditacraft.visual.contentStylesheets',
  );
  if (!Array.isArray(configuredDeveloperCss) || configuredDeveloperCss.length < 2) {
    throw new Error('private workspace developer stylesheets are not configured');
  }
  const realDeveloperCss = configuredDeveloperCss.map((path) =>
    privateWorkspacePath(privateRoot, path, 'private stylesheet setting'));
  const realBefore = await Promise.all(realDeveloperCss.map(sha256File));
  const pins = JSON.parse(await readFile(join(extensionRoot, 'test', 'vscode-version.json'), 'utf8'));
  const layout = await createIsolatedSmokeLayout('dcp-');
  let lifecycleFinalized = false;
  try {
  const code = await resolveSelectedCode(pins.currentStable, layout, artifactRoot);
  await writeUserSettings(layout.userDataDir);
  const install = await installVsix({ executable: code.executable, extensionsDir: layout.extensionsDir, userDataDir: layout.userDataDir, vsixPath: options.vsix });
  const installLog = join(artifactRoot, 'install.log');
  await writeFile(installLog, `${install.stdout}\n${install.stderr}`);
  const workspace = await preparePrivateConsumerWorkspace(layout, privateRoot);
  const mutableWorkingCopies = await snapshotMutableWorkingCopies(workspace.mutableSpecs, join(artifactRoot, 'before-state'));
  const port = await freePort();
  const launchArgs = buildVsCodeLaunchArgs({ userDataDir: layout.userDataDir, extensionsDir: layout.extensionsDir, workspacePath: workspace.workspacePath, port });
  launchArgs.push(workspace.topicPath);
  const launch = await launchIsolatedCode({ executable: code.executable, args: launchArgs, cwd: layout.workspaceDir });
  try {
    await waitFor('private consumer VS Code launch output', async () => {
      const output = launch.output();
      if (launch.child.exitCode !== null) throw new Error(`VS Code exited ${launch.child.exitCode}: ${output.stderr}`);
      return output.stderr.includes('DevTools listening') || output.stdout.includes('DevTools listening');
    }, 15_000);
    const launchLog = join(artifactRoot, 'launch.log');
    await writeFile(launchLog, `${launch.output().stdout}\n${launch.output().stderr}`);
    const realAfter = await Promise.all(realDeveloperCss.map(sha256File));
    if (JSON.stringify(realBefore) !== JSON.stringify(realAfter)) throw new Error('real private developer CSS changed during preparation');
    const evidence = await createEvidenceEnvelope({
      runId,
      runType: 'private',
      status: 'pending-owner-observation',
      candidate: { path: options.vsix, extractedRoot: join(artifactRoot, 'candidate-extracted'), extractedInventorySha256: extracted.inventory.sha256 },
      packagePrivacy: { logPath: privacyLog, findings: [] },
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
      logs: [{ path: installLog }, { path: launchLog }, { path: privacyLog }, { path: inventoryPath }],
      workspaceFixtures: workspace.immutableFixturePaths.map((path) => ({ path })),
      mutableWorkingCopies,
      developerCss: workspace.developerCssPaths.map((path) => ({ path })),
      protectedPrivateCss: realDeveloperCss.map((path, index) => ({ path, beforeSha256: realBefore[index], afterSha256: realAfter[index] })),
      visuals: [],
      scenarios: PRIVATE_SCENARIO_IDS.map((id) => ({ id, status: 'pending-owner', observedBy: null, artifactPaths: [] })),
    });
    const evidencePath = join(artifactRoot, 'evidence.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const handoff = { status: 'PENDING_OWNER', evidencePath, evidenceBindingSha256: evidence.binding.sha256, extractedInventoryPath: inventoryPath, artifactRoot, profileRoot: layout.root, workspacePath: workspace.workspacePath, topicPath: workspace.topicPath, unknownValue: 'UNKNOWN-OWNER-REMOVE', pid: launch.child.pid };
    await writeFile(join(artifactRoot, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
    console.log(JSON.stringify(handoff, null, 2));
    if (options.retain) {
      await new Promise((resolveRetained, rejectRetained) => {
        let stopping = false;
        const stop = async () => { if (!stopping) { stopping = true; await launch.terminate(); resolveRetained(); } };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        launch.child.once('exit', (code) => { if (!stopping) rejectRetained(new Error(`retained private VS Code exited: ${code}`)); });
      });
    } else {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, options.timeoutMs));
      await launch.terminate();
    }
    throw new Error(`PENDING_OWNER: complete private consumer observations in ${evidencePath}`);
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
