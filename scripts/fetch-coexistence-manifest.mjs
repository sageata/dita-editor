import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const companionId = 'JeremyJeanne.ditacraft';
const targetId = 'paul-razvan-sarbu.dita-editor';
const repository = 'https://github.com/sageata/dita-editor';

function parseArgs(argv) {
  let ownerEvidencePath;
  let observationDate;
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--owner-evidence') {
      ownerEvidencePath = argv[++index];
      if (!ownerEvidencePath) throw new Error('--owner-evidence requires a path');
    } else if (argument === '--observation-date') {
      observationDate = argv[++index];
      if (!observationDate) throw new Error('--observation-date requires YYYY-MM-DD');
    } else if (argument === '--validate-owner-evidence-only') {
      validateOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!ownerEvidencePath) throw new Error('--owner-evidence is required');
  if (observationDate && !validateOnly) {
    throw new Error('--observation-date is test-only and requires --validate-owner-evidence-only');
  }
  return {
    ownerEvidencePath: resolve(ownerEvidencePath),
    observationDate: observationDate ?? new Date().toISOString().slice(0, 10),
    validateOnly,
  };
}

function exactKeys(value, keys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid schema`);
  }
}

function readOwnerEvidence(path, observationDate) {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`owner evidence could not be read: ${error.message}`);
  }
  exactKeys(evidence, ['version', 'verifiedAt', 'source', 'repository', 'marketplace'], 'owner evidence');
  exactKeys(evidence.repository, ['availability', 'method', 'viewer', 'owner', 'name', 'result'], 'repository owner evidence');
  exactKeys(evidence.marketplace, ['availability', 'method', 'publisherName', 'publisherId', 'inventory', 'extensionId'], 'Marketplace owner evidence');
  if (evidence.version !== 1 || evidence.source !== 'controller-verified-owner-scoped-check') {
    throw new Error('owner evidence source or version is invalid');
  }
  if (evidence.verifiedAt !== observationDate) {
    throw new Error(`owner evidence is stale: verifiedAt ${evidence.verifiedAt}, observation date ${observationDate}`);
  }
  const repositoryMatches = evidence.repository.availability === 'verified-available-owner-scope' &&
    evidence.repository.method === 'owner-scoped-github-graphql' &&
    evidence.repository.viewer === 'sageata' && evidence.repository.owner === 'sageata' &&
    evidence.repository.name === 'dita-editor' && evidence.repository.result === 'null-with-not-found';
  const marketplaceMatches = evidence.marketplace.availability === 'verified-available-owner-scope' &&
    evidence.marketplace.method === 'owner-authenticated-publisher-inventory' &&
    evidence.marketplace.publisherName === 'Paul Razvan Sarbu' &&
    evidence.marketplace.publisherId === 'paul-razvan-sarbu' &&
    evidence.marketplace.inventory === 'empty' && evidence.marketplace.extensionId === targetId;
  if (!repositoryMatches || !marketplaceMatches) throw new Error('owner evidence identity mismatch');
  return evidence;
}

const args = parseArgs(process.argv.slice(2));
const ownerScopedAvailability = readOwnerEvidence(args.ownerEvidencePath, args.observationDate);
if (args.validateOnly) {
  console.log(`Owner-scoped availability evidence verified at ${ownerScopedAvailability.verifiedAt}.`);
  process.exit(0);
}

function normalizedManifest(manifest) {
  const configuration = Array.isArray(manifest.contributes?.configuration)
    ? manifest.contributes.configuration
    : manifest.contributes?.configuration
      ? [manifest.contributes.configuration]
      : [];
  return {
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    activationEvents: manifest.activationEvents ?? [],
    contributes: {
      commands: (manifest.contributes?.commands ?? []).map((entry) => entry.command).filter(Boolean),
      settings: configuration.flatMap((section) => Object.keys(section.properties ?? {})),
      views: Object.values(manifest.contributes?.views ?? {}).flatMap((entries) =>
        Array.isArray(entries) ? entries.map((entry) => entry.id).filter(Boolean) : []),
      languages: (manifest.contributes?.languages ?? []).map((entry) => ({
        id: entry.id,
        ...(entry.extensions ? { extensions: entry.extensions } : {}),
        ...(entry.filenames ? { filenames: entry.filenames } : {}),
        ...(entry.filenamePatterns ? { filenamePatterns: entry.filenamePatterns } : {}),
      })),
      customEditors: (manifest.contributes?.customEditors ?? []).map((entry) => ({
        viewType: entry.viewType,
        priority: entry.priority ?? 'default',
        selector: (entry.selector ?? []).map((selector) => ({
          filenamePattern: selector.filenamePattern,
        })),
      })),
    },
  };
}

function extractManifest(bytes) {
  return new Promise((resolveManifest, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error || !archive) return reject(error ?? new Error('could not open VSIX'));
      archive.readEntry();
      archive.on('entry', (entry) => {
        if (entry.fileName !== 'extension/package.json') return archive.readEntry();
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('could not read manifest'));
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => resolveManifest(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          stream.on('error', reject);
        });
      });
      archive.on('end', () => reject(new Error('VSIX does not contain extension/package.json')));
      archive.on('error', reject);
    });
  });
}

async function marketplaceQuery(id) {
  const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json;api-version=7.1-preview.1',
    },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 914 }),
  });
  if (!response.ok) throw new Error(`Marketplace query failed: ${response.status}`);
  const body = await response.json();
  return body.results?.flatMap((result) => result.extensions ?? []) ?? [];
}

const vsixResponse = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/publishers/JeremyJeanne/vsextensions/ditacraft/latest/vspackage');
if (!vsixResponse.ok) throw new Error(`Companion VSIX download failed: ${vsixResponse.status}`);
const vsix = Buffer.from(await vsixResponse.arrayBuffer());
const manifest = await extractManifest(vsix);
const targetMatches = await marketplaceQuery(targetId);
if (targetMatches.length > 0) throw new Error(`Target Marketplace identifier is now registered: ${targetId}`);
const repositoryResponse = await fetch('https://api.github.com/repos/sageata/dita-editor', {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'dita-editor-metadata-check' },
});
if (repositoryResponse.status !== 404) throw new Error(`Public repository observation changed: ${repositoryResponse.status}`);
const evidence = {
  publicObservationCheckedAt: new Date().toISOString(),
  targetRegistry: 'Visual Studio Marketplace',
  targetExtensionId: targetId,
  targetIdentifierObserved: targetMatches.length > 0,
  publicRepository: repository,
  publicRepositoryObserved: repositoryResponse.ok,
  ownerScopedAvailability,
  companionExtensionId: companionId,
  companionVersion: manifest.version,
  companionLicense: manifest.license,
  companionVsixSha256: createHash('sha256').update(vsix).digest('hex'),
  manifest: normalizedManifest(manifest),
};
writeFileSync(resolve(root, 'test/coexistence-extension.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Recorded ${companionId}@${manifest.version} and availability evidence.`);
