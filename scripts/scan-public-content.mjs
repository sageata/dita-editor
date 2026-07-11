import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');
const ALWAYS_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
const TEMPORARY_OUTPUT_DIRECTORIES = new Set([
  '.cache', '.tmp', 'artifacts', 'build', 'coverage', 'dist', 'test-artifacts',
]);
const BINARY_EXTENSIONS = new Set([
  '.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.ttf', '.vsix', '.webp', '.woff', '.woff2', '.zip',
]);
const TEXT_EXTENSIONS = new Set([
  '', '.css', '.dita', '.ditamap', '.gitignore', '.gitattributes', '.html', '.js', '.json', '.jsonc',
  '.lock', '.md', '.mjs', '.svg', '.ts', '.txt', '.xml', '.yaml', '.yml',
]);

const privateOrganization = ['eti', 'had'].join('');
const privateStyleAssets = [
  ['eti', 'had-preview.css'].join(''),
  ['eti', 'had-tokens.css'].join(''),
];
const privateTaxonomyAssets = [
  ['manual-', 'taxonomy-values.js'].join(''),
  ['zcard-', 'taxonomy-values.json'].join(''),
  ['manual-tagging-', 'taxonomy.md'].join(''),
];
const privateCorpusMarkers = [
  ['onboard-', 'hospitality-manual'].join(''),
  ['manuals', '_vision'].join(''),
  ['crew_', 'knowledge_base'].join(''),
  ['service_', 'standards/manual-extraction'].join(''),
];
const privateStyleToken = ['--', 'ey', '-'].join('');
const sourceMapMarker = ['source', 'MappingURL='].join('');

function compareFindings(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.rule !== right.rule) return left.rule < right.rule ? -1 : 1;
  return left.detail < right.detail ? -1 : left.detail > right.detail ? 1 : 0;
}

function addFinding(findings, path, rule, detail) {
  if (findings.some((finding) => finding.path === path && finding.rule === rule)) return;
  findings.push({ path, rule, detail });
}

function containsOne(haystack, needles) {
  const normalized = haystack.toLocaleLowerCase('en-US');
  return needles.some((needle) => normalized.includes(needle.toLocaleLowerCase('en-US')));
}

function hasPrivateOrganization(value) {
  return value.toLocaleLowerCase('en-US').includes(privateOrganization);
}

function hasAbsolutePersonalPath(value) {
  return /(?:^|[\s"'`(=:]|[A-Za-z][A-Za-z0-9+.-]*:\/{2,})\/(?:Users|home)\/[^/\s"'`<>]+\//u.test(value)
    || /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'`<>]+[\\/]+/u.test(value);
}

export function scanPathForPrivateContent(path) {
  const findings = [];
  if (path.toLocaleLowerCase('en-US').endsWith('.map')) {
    addFinding(findings, path, 'source-map', 'source-map files are not public release inputs');
  }
  if (containsOne(path, privateTaxonomyAssets)) {
    addFinding(findings, path, 'private-taxonomy-asset', 'path contains a known private taxonomy asset name');
  }
  if (containsOne(path, privateStyleAssets)) {
    addFinding(findings, path, 'private-style-asset', 'path contains a known private stylesheet name');
  }
  if (containsOne(path, privateCorpusMarkers)) {
    addFinding(findings, path, 'private-corpus-path', 'path contains a known private corpus marker');
  }
  if (hasPrivateOrganization(path)) {
    addFinding(findings, path, 'private-organization', 'path contains a known private organization identifier');
  }
  if (hasAbsolutePersonalPath(path)) {
    addFinding(findings, path, 'absolute-personal-path', 'path contains an absolute personal home directory');
  }
  return findings;
}

export function scanTextForPrivateContent(path, text) {
  const findings = [];
  if (hasAbsolutePersonalPath(text)) {
    addFinding(findings, path, 'absolute-personal-path', 'text contains an absolute personal home directory');
  }
  if (containsOne(text, privateTaxonomyAssets)) {
    addFinding(findings, path, 'private-taxonomy-asset', 'text contains a known private taxonomy asset name');
  }
  if (containsOne(text, privateStyleAssets)) {
    addFinding(findings, path, 'private-style-asset', 'text contains a known private stylesheet name');
  }
  if (text.toLocaleLowerCase('en-US').includes(privateStyleToken)) {
    addFinding(findings, path, 'private-style-token', 'text contains a known private CSS token prefix');
  }
  if (containsOne(text, privateCorpusMarkers)) {
    addFinding(findings, path, 'private-corpus-path', 'text contains a known private corpus marker');
  }
  if (hasPrivateOrganization(text)) {
    addFinding(findings, path, 'private-organization', 'text contains a known private organization identifier');
  }
  if (text.includes(sourceMapMarker)) {
    addFinding(findings, path, 'source-map', 'text contains a source-map reference');
  }
  return findings;
}

export function scanBinaryForPrivateContent(path, bytes) {
  const findings = [];
  const visibleBytes = bytes.toString('latin1');
  if (hasAbsolutePersonalPath(visibleBytes)) {
    addFinding(findings, path, 'absolute-personal-path', 'binary metadata contains an absolute personal home directory');
  }
  if (containsOne(visibleBytes, privateTaxonomyAssets)) {
    addFinding(findings, path, 'private-taxonomy-asset', 'binary metadata contains a known private taxonomy asset name');
  }
  if (containsOne(visibleBytes, privateStyleAssets)) {
    addFinding(findings, path, 'private-style-asset', 'binary metadata contains a known private stylesheet name');
  }
  if (visibleBytes.toLocaleLowerCase('en-US').includes(privateStyleToken)) {
    addFinding(findings, path, 'private-style-token', 'binary metadata contains a known private CSS token prefix');
  }
  if (containsOne(visibleBytes, privateCorpusMarkers)) {
    addFinding(findings, path, 'private-corpus-path', 'binary metadata contains a known private corpus marker');
  }
  if (hasPrivateOrganization(visibleBytes)) {
    addFinding(findings, path, 'private-organization', 'binary metadata contains a known private organization identifier');
  }
  return findings;
}

function decodeText(path, bytes, findings) {
  const extension = extname(path).toLocaleLowerCase('en-US');
  if (BINARY_EXTENSIONS.has(extension)) return null;
  if (!TEXT_EXTENSIONS.has(extension) && bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (TEXT_EXTENSIONS.has(extension)) {
      addFinding(findings, path, 'invalid-utf8', 'text release input is not valid UTF-8');
    }
    return null;
  }
}

function posixRelative(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

export async function scanPublicContent({
  root = defaultRoot,
  includeBuildOutputs = false,
  ignoreContentPaths = new Set(),
} = {}) {
  const findings = [];
  const absoluteRoot = resolve(root);
  let rootStatus;
  try {
    rootStatus = lstatSync(absoluteRoot);
  } catch (error) {
    addFinding(findings, '.', 'filesystem-error', `cannot inspect scan root: ${error.message}`);
    return findings;
  }
  if (rootStatus.isSymbolicLink()) {
    addFinding(findings, '.', 'symbolic-link', 'scan root must not be a symbolic link');
    return findings;
  }
  if (!rootStatus.isDirectory()) {
    addFinding(findings, '.', 'filesystem-error', 'scan root must be a directory');
    return findings;
  }

  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    } catch (error) {
      const relativeDirectory = posixRelative(absoluteRoot, directory) || '.';
      addFinding(findings, relativeDirectory, 'filesystem-error', `cannot read directory: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const path = posixRelative(absoluteRoot, absolutePath);
      for (const finding of scanPathForPrivateContent(path)) findings.push(finding);

      let status;
      try {
        status = lstatSync(absolutePath);
      } catch (error) {
        addFinding(findings, path, 'filesystem-error', `cannot inspect path: ${error.message}`);
        continue;
      }
      if (status.isSymbolicLink()) {
        addFinding(findings, path, 'symbolic-link', 'public release trees must not contain symbolic links');
        continue;
      }
      if (status.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (!includeBuildOutputs && TEMPORARY_OUTPUT_DIRECTORIES.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }
      if (!status.isFile()) {
        addFinding(findings, path, 'special-file', 'public release trees may contain regular files only');
        continue;
      }
      if (ignoreContentPaths.has(path)) continue;
      let bytes;
      try {
        bytes = readFileSync(absolutePath);
      } catch (error) {
        addFinding(findings, path, 'filesystem-error', `cannot read file: ${error.message}`);
        continue;
      }
      const text = decodeText(path, bytes, findings);
      if (text === null) {
        for (const finding of scanBinaryForPrivateContent(path, bytes)) findings.push(finding);
        continue;
      }
      for (const finding of scanTextForPrivateContent(path, text)) findings.push(finding);
    }
  };

  walk(absoluteRoot);
  return findings.sort(compareFindings);
}

function parseArgs(argv) {
  let root = defaultRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires an absolute directory path');
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!isAbsolute(root)) throw new Error('--root must be absolute');
  return { root };
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const findings = await scanPublicContent(parseArgs(process.argv.slice(2)));
    for (const finding of findings) {
      console.error(`${finding.path} [${finding.rule}] ${finding.detail}`);
    }
    if (findings.length > 0) process.exitCode = 1;
    else console.log('Public content scan passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
