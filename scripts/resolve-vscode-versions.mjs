import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STABLE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable';
export const SUPPORTED_PLATFORMS = Object.freeze([
  { os: 'darwin', architecture: 'x64', downloadPlatform: 'darwin', updateTarget: 'darwin' },
  { os: 'darwin', architecture: 'arm64', downloadPlatform: 'darwin-arm64', updateTarget: 'darwin-arm64' },
  { os: 'win32', architecture: 'x64', downloadPlatform: 'win32-x64-archive', updateTarget: 'win32-x64-archive' },
  { os: 'win32', architecture: 'arm64', downloadPlatform: 'win32-arm64-archive', updateTarget: 'win32-arm64-archive' },
  { os: 'linux', architecture: 'x64', downloadPlatform: 'linux-x64', updateTarget: 'linux-x64' },
  { os: 'linux', architecture: 'arm64', downloadPlatform: 'linux-arm64', updateTarget: 'linux-arm64' },
  { os: 'linux', architecture: 'armhf', downloadPlatform: 'linux-armhf', updateTarget: 'linux-armhf' },
]);

export function exactVersionUrl(version, updateTarget) {
  return `https://update.code.visualstudio.com/${encodeURIComponent(version)}/${updateTarget}/stable`;
}

function commitFromLocation(location) {
  const match = String(location ?? '').match(/\/stable\/([a-f0-9]{40})\//i);
  return match?.[1] ?? null;
}

export async function inspectExactArtifact(version, platform, fetchImpl = fetch) {
  const url = exactVersionUrl(version, platform.updateTarget);
  const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual' });
  if (response.status !== 302 && !response.ok) return null;
  const location = response.headers.get('location');
  const commit = commitFromLocation(location);
  if (!location || !commit) throw new Error(`exact-version artifact lacks stable commit redirect: ${url}`);
  const providerSha256 = response.headers.get('x-sha256');
  if (providerSha256 && !/^[a-f0-9]{64}$/i.test(providerSha256)) {
    throw new Error(`invalid provider SHA-256 for ${url}`);
  }
  return {
    ...platform,
    exactVersionUrl: url,
    resolvedArchiveUrl: location,
    version,
    commit,
    providerSha256: providerSha256?.toLowerCase() ?? null,
    localArchiveSha256: null,
    checksumSource: providerSha256 ? 'provider-x-sha256' : 'unresolved-local-fallback',
  };
}

export async function resolveCurrentStable({
  fetchJson = async () => {
    const response = await fetch(STABLE_RELEASES_URL);
    if (!response.ok) throw new Error(`stable release list returned ${response.status}`);
    return response.json();
  },
  inspectExactVersion = async (version) => {
    const artifact = await inspectExactArtifact(version, SUPPORTED_PLATFORMS[0]);
    return artifact && { version: artifact.version, commit: artifact.commit };
  },
  inspectLatest,
} = {}) {
  const releases = await fetchJson(STABLE_RELEASES_URL);
  const version = Array.isArray(releases) ? releases[0] : null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('official stable release list did not name a semantic version first');
  }
  const exact = await inspectExactVersion(version);
  if (!exact) throw new Error(`official exact-version artifact is absent for ${version}`);
  if (exact.version !== version || !exact.commit) throw new Error(`exact-version metadata mismatch for ${version}`);
  // A staged /latest endpoint is intentionally informational and never selects the pin.
  if (inspectLatest) await inspectLatest();
  return { version, commit: exact.commit };
}

export function assertPinnedVersionRecord(record, expected = record) {
  if (record?.channel !== 'stable') throw new Error('VS Code pin must use the stable channel');
  if (record.version !== expected.version) throw new Error(`version mismatch: ${record.version} != ${expected.version}`);
  if (record.commit !== expected.commit) throw new Error(`commit mismatch: ${record.commit} != ${expected.commit}`);
  if (!Array.isArray(record.platforms)) throw new Error('pin platforms must be an array');
  const requiredKeys = SUPPORTED_PLATFORMS.map((entry) => `${entry.os}/${entry.architecture}/${entry.downloadPlatform}/${entry.updateTarget}`).sort();
  const actualKeys = record.platforms.map((entry) => `${entry.os}/${entry.architecture}/${entry.downloadPlatform}/${entry.updateTarget}`);
  if (new Set(actualKeys).size !== actualKeys.length) throw new Error('duplicate supported platform record');
  if (JSON.stringify([...actualKeys].sort()) !== JSON.stringify(requiredKeys)) {
    throw new Error('pin does not contain the exact complete supported platform set');
  }
  for (const platform of record.platforms) {
    if (platform.version !== record.version || platform.commit !== record.commit) {
      throw new Error(`platform version/commit mismatch: ${platform.updateTarget ?? '<unknown>'}`);
    }
    if (!platform.providerSha256 && !platform.localArchiveSha256) {
      throw new Error(`platform checksum missing: ${platform.updateTarget ?? '<unknown>'}`);
    }
  }
  return record;
}

export async function downloadAndVerifyPinnedArchive(platform, destination, fetchImpl = fetch) {
  const response = await fetchImpl(platform.resolvedArchiveUrl ?? platform.exactVersionUrl);
  if (!response.ok) throw new Error(`archive download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (platform.providerSha256 && actual !== platform.providerSha256) {
    throw new Error(`provider archive hash mismatch: ${actual} != ${platform.providerSha256}`);
  }
  if (!platform.providerSha256 && platform.localArchiveSha256 && actual !== platform.localArchiveSha256) {
    throw new Error(`local archive hash mismatch: ${actual} != ${platform.localArchiveSha256}`);
  }
  await writeFile(destination, bytes);
  return {
    path: resolve(destination),
    sha256: actual,
    checksumSource: platform.providerSha256 ? 'provider-x-sha256-verified-bytes' : 'locally-computed-archive-sha256',
    providerSignature: false,
  };
}

export async function verifyPinnedArchive(path, expectedSha256) {
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== expectedSha256) throw new Error(`archive hash mismatch: ${actual} != ${expectedSha256}`);
  return actual;
}

export async function freezeVersion(version, checkedAt = new Date().toISOString(), {
  inspectArtifact = inspectExactArtifact,
  verifyArchive = downloadAndVerifyPinnedArchive,
} = {}) {
  const platforms = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    const artifact = await inspectArtifact(version, platform);
    if (!artifact) throw new Error(`missing exact-version artifact: ${version}/${platform.updateTarget}`);
    if (!artifact.providerSha256) {
      const temp = await mkdtemp(join(tmpdir(), 'vscode-pin-fallback-'));
      try {
        const verified = await verifyArchive(artifact, join(temp, 'archive'));
        artifact.localArchiveSha256 = verified.sha256;
        artifact.checksumSource = 'locally-computed-archive-sha256';
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    platforms.push(artifact);
  }
  const commits = new Set(platforms.map((entry) => entry.commit));
  if (commits.size !== 1) throw new Error(`exact-version commit mismatch across platforms for ${version}`);
  return {
    checkedAt,
    channel: 'stable',
    version,
    commit: platforms[0].commit,
    platforms,
  };
}

export async function checkPinnedFile(path) {
  const root = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['minimum', 'currentStable']) {
    const record = assertPinnedVersionRecord(root[key]);
    for (const pinned of record.platforms) {
      const live = await inspectExactArtifact(record.version, pinned);
      if (!live) throw new Error(`missing exact-version artifact: ${record.version}/${pinned.updateTarget}`);
      if (live.commit !== pinned.commit) throw new Error(`commit mismatch for ${pinned.updateTarget}`);
      if (pinned.providerSha256 && live.providerSha256 !== pinned.providerSha256) {
        throw new Error(`provider hash mismatch for ${pinned.updateTarget}`);
      }
      if (!pinned.providerSha256) {
        const temp = await mkdtemp(join(tmpdir(), 'vscode-pin-check-'));
        try {
          const verified = await downloadAndVerifyPinnedArchive(
            { ...live, localArchiveSha256: pinned.localArchiveSha256 },
            join(temp, 'archive'),
          );
          if (verified.sha256 !== pinned.localArchiveSha256 || verified.checksumSource !== 'locally-computed-archive-sha256') {
            throw new Error(`local archive hash mismatch for ${pinned.updateTarget}`);
          }
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
    }
  }
  return root;
}

function parseArgs(argv) {
  let mode;
  let writePath;
  let checkPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current-stable') mode = 'current-stable';
    else if (arg === '--write') writePath = argv[++index];
    else if (arg === '--check-pinned') checkPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (checkPath) return { mode: 'check', path: resolve(checkPath) };
  if (mode === 'current-stable' && writePath) return { mode, path: resolve(writePath) };
  throw new Error('use --current-stable --write <path> or --check-pinned <path>');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'check') {
    await checkPinnedFile(options.path);
    console.log(`Verified exact official VS Code pins in ${options.path}.`);
    return;
  }
  const current = await resolveCurrentStable();
  const frozen = await freezeVersion(current.version);
  const existing = existsSync(options.path) ? JSON.parse(await readFile(options.path, 'utf8')) : {};
  const output = { schemaVersion: 1, ...existing, currentStable: frozen };
  await writeFile(options.path, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Pinned VS Code ${frozen.version} (${frozen.commit}) in ${options.path}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
