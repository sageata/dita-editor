import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPublicContent } from './scan-public-content.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenancePath = 'docs/provenance.json';
const inventoryPath = 'docs/public-export.json';
const exactFields = [
  'path', 'sha256', 'origin', 'authorOrOwner', 'licenseBasis', 'disposition',
  'reviewer', 'reviewDate', 'approved',
];
const allowedOrigins = new Set([
  'Apache Software Foundation license text',
  'Bun package manager lock metadata',
  'DITA Editor adaptation of Contributor Covenant 2.1',
  'DITA Editor project',
  'OpenAI built-in ImageGen, owner-selected and deterministically resized',
  'Visual Studio Marketplace public API',
]);
const allowedLicenseBases = new Set([
  'Apache-2.0',
  'CC BY 4.0 adaptation',
  'MIT',
  'Owner-approved original; Apache-2.0',
  'Upstream licenses listed in package metadata and THIRD_PARTY_NOTICES.md',
]);
const placeholders = /^(?:OWNER|EMAIL|TBD|UNKNOWN|UNCLASSIFIED)$/iu;

function parseArgs(argv) {
  let root = defaultRoot;
  let scanOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      root = resolve(value);
      index += 1;
    } else if (argument === '--scan-only') {
      scanOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { root, scanOnly };
}

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path === path.normalize('NFC') &&
    !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') &&
    posix.normalize(path) === path && path !== '.' && !path.startsWith('../');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(findings, path, message) {
  findings.push(`${path}: ${message}`);
}

function readJson(root, path, findings, fallback) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    fail(findings, path, `cannot parse JSON: ${error.message}`);
    return fallback;
  }
}

function registerAlias(findings, aliases, path, label) {
  if (!validPath(path)) {
    fail(findings, label, 'path is not canonical POSIX-relative NFC');
    return;
  }
  const alias = path.normalize('NFC').toLocaleLowerCase('en-US');
  if (aliases.has(alias)) {
    fail(findings, label, `case-fold or Unicode-normalized collision with ${aliases.get(alias)}`);
  } else {
    aliases.set(alias, path);
  }
}

function validReviewDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10);
}

async function scanExactInventory(root, paths, findings) {
  const scanRoot = mkdtempSync(join(tmpdir(), 'dita-editor-public-export-scan-'));
  try {
    for (const path of paths) {
      const source = join(root, path);
      const destination = join(scanRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    const scanFindings = await scanPublicContent({ root: scanRoot });
    for (const finding of scanFindings) {
      findings.push(`${finding.path} [${finding.rule}] ${finding.detail}`);
    }
    return scanFindings.length;
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
}

async function verify({ root, scanOnly }) {
  const findings = [];
  const inventory = readJson(root, inventoryPath, findings, { version: 0, files: [] });
  if (inventory?.version !== 1 || !Array.isArray(inventory?.files)) {
    fail(findings, inventoryPath, 'must have exact schema { version: 1, files: string[] }');
  }
  const inventoryFiles = Array.isArray(inventory?.files) ? inventory.files : [];
  const inventoryAliases = new Map();
  const inventorySet = new Set();
  for (const [index, path] of inventoryFiles.entries()) {
    const label = `${inventoryPath}.files[${index}]`;
    registerAlias(findings, inventoryAliases, path, label);
    if (inventorySet.has(path)) fail(findings, label, `duplicate path ${path}`);
    inventorySet.add(path);
  }
  if (!inventorySet.has(provenancePath)) fail(findings, inventoryPath, `must include ${provenancePath}`);
  if (!inventorySet.has(inventoryPath)) fail(findings, inventoryPath, `must include ${inventoryPath}`);
  if ([...inventorySet].sort().some((path, index) => path !== inventoryFiles[index])) {
    fail(findings, inventoryPath, 'files must be sorted in canonical path order');
  }

  for (const path of inventorySet) {
    try {
      const status = lstatSync(join(root, path));
      if (status.isSymbolicLink()) fail(findings, path, 'public export files must not be a symbolic link');
      else if (!status.isFile()) fail(findings, path, 'public export path must be a regular file');
    } catch (error) {
      fail(findings, path, `public export file is missing or inaccessible: ${error.message}`);
    }
  }

  let entries = readJson(root, provenancePath, findings, []);
  if (!Array.isArray(entries)) {
    fail(findings, provenancePath, 'root must be an array');
    entries = [];
  }
  const byPath = new Map();
  const provenanceAliases = new Map();
  for (const [index, entry] of entries.entries()) {
    const label = `${provenancePath}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(findings, label, 'entry must be an object');
      continue;
    }
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([...exactFields].sort())) {
      fail(findings, label, `fields must be exactly ${exactFields.join(', ')}`);
    }
    registerAlias(findings, provenanceAliases, entry.path, label);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail(findings, label, 'sha256 is invalid');
    }
    for (const field of ['origin', 'authorOrOwner', 'licenseBasis', 'reviewer']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '' || placeholders.test(entry[field].trim())) {
        fail(findings, label, `${field} is empty or contains a placeholder`);
      }
    }
    if (!allowedOrigins.has(entry.origin)) fail(findings, label, 'origin is not an allowed classification');
    if (!allowedLicenseBases.has(entry.licenseBasis)) {
      fail(findings, label, 'licenseBasis is not an allowed classification');
    }
    if (entry.disposition !== 'public-export') fail(findings, label, 'disposition must be public-export');
    if (entry.reviewer !== 'Paul Razvan Sarbu') fail(findings, label, 'reviewer is not the approved owner');
    if (!validReviewDate(entry.reviewDate)) fail(findings, label, 'reviewDate must be a real non-future YYYY-MM-DD date');
    if (entry.approved !== true) fail(findings, label, 'approved must be true');
    if (typeof entry.path === 'string') {
      if (byPath.has(entry.path)) fail(findings, label, `duplicate path ${entry.path}`);
      byPath.set(entry.path, entry);
      if (!inventorySet.has(entry.path)) fail(findings, entry.path, 'provenance entry is not in the exact public export inventory');
    }
  }

  for (const path of inventorySet) {
    if (path === provenancePath) continue;
    const entry = byPath.get(path);
    if (!entry) {
      fail(findings, path, 'missing provenance entry');
      continue;
    }
    try {
      const status = lstatSync(join(root, path));
      if (!status.isFile() || status.isSymbolicLink()) continue;
      const actual = sha256(join(root, path));
      if (entry.sha256 !== actual) fail(findings, path, `stale sha256; expected ${actual}`);
    } catch {
      // The complete inventory check above owns the filesystem diagnostic.
    }
  }

  let scanCount = 0;
  if (findings.length === 0) scanCount = await scanExactInventory(root, inventoryFiles, findings);
  if (findings.length > 0) {
    for (const finding of findings.sort()) console.error(finding);
    return 1;
  }
  if (scanOnly) console.log(`Public export scan passed: ${inventoryFiles.length} files, ${scanCount} findings.`);
  else console.log(`Public metadata verified: ${entries.length} approved files; ${inventoryFiles.length} export paths; ${scanCount} scan findings.`);
  return 0;
}

try {
  process.exitCode = await verify(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
