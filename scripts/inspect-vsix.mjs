import {
  chmodSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import {
  scanPublicContent,
  scanTextForPrivateContent,
} from './scan-public-content.mjs';

const { getFileNameLowLevel, openPromise } = yauzl;
const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 50 * 1_048_576;
const MAX_TOTAL_BYTES = 100 * 1_048_576;
const MAX_COMPRESSION_RATIO = 200;
const REQUIRED_ENVELOPES = ['[Content_Types].xml', 'extension.vsixmanifest'];
const REQUIRED_RUNTIME = ['extension/package.json', 'extension/dist/extension.js'];
const WALKTHROUGH_FILES = new Set([
  'extension/media/walkthrough/navigate.md',
  'extension/media/walkthrough/open.md',
  'extension/media/walkthrough/source.md',
]);
const RUNTIME_MEDIA_FILES = new Set([
  'extension/media/canvas-autoformat.js',
  'extension/media/canvas-chrome.js',
  'extension/media/canvas-command-bar-ui.js',
  'extension/media/canvas-command-bar.js',
  'extension/media/canvas-command-format.js',
  'extension/media/canvas-command-insert.js',
  'extension/media/canvas-command-shortcuts.js',
  'extension/media/canvas-command-structure.js',
  'extension/media/canvas-context-menu.js',
  'extension/media/canvas-context-toolbar-state.js',
  'extension/media/canvas-context-toolbar.js',
  'extension/media/canvas-controls.js',
  'extension/media/canvas-editing-keys.js',
  'extension/media/canvas-editing-paste.js',
  'extension/media/canvas-editing-utils.js',
  'extension/media/canvas-editing.js',
  'extension/media/canvas-end-insert.js',
  'extension/media/canvas-find-replace.js',
  'extension/media/canvas-geom.js',
  'extension/media/canvas-icons.js',
  'extension/media/canvas-image-bar.js',
  'extension/media/canvas-images.js',
  'extension/media/canvas-insert-menu.js',
  'extension/media/canvas-keyboard-nav.js',
  'extension/media/canvas-keyboard-select.js',
  'extension/media/canvas-lint-marks.js',
  'extension/media/canvas-menu.js',
  'extension/media/canvas-move-block.js',
  'extension/media/canvas-properties.js',
  'extension/media/canvas-selection-announce.js',
  'extension/media/canvas-selection-aria.js',
  'extension/media/canvas-selection-clipboard.js',
  'extension/media/canvas-selection-controller.js',
  'extension/media/canvas-selection-dependencies.js',
  'extension/media/canvas-selection-range.js',
  'extension/media/canvas-selection-restore.js',
  'extension/media/canvas-selection-summary.js',
  'extension/media/canvas-selection.js',
  'extension/media/canvas-shortcut-help.js',
  'extension/media/canvas-slash-menu.js',
  'extension/media/canvas-spellcheck.js',
  'extension/media/canvas-styles.js',
  'extension/media/canvas-table-hover.js',
  'extension/media/canvas-table-insert-plus.js',
  'extension/media/canvas-table-resize.js',
  'extension/media/canvas-text-metrics.js',
  'extension/media/canvas-zoom.js',
  'extension/media/canvas.js',
  'extension/media/content-theme.css',
  'extension/media/editor.css',
  'extension/media/redline.css',
  'extension/media/redline-review.js',
]);
const OWNER_IDENTITY_KEYS = new Set([
  'name', 'displayName', 'version', 'publisher', 'repository', 'homepage', 'bugs', 'icon', 'license',
]);
const MARKETPLACE_EXTENSION_NAME = 'dita-editor';
const MARKETPLACE_PUBLISHER = 'paul-razvan-sarbu';
const MARKETPLACE_PREVIEW_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export const PRE_METADATA_DEFERRED_KEYS = Object.freeze([
  'extension/CHANGELOG.md|owner-gated-document',
  'extension/LICENSE|owner-gated-document',
  'extension/README.md|owner-gated-document',
  'extension/THIRD_PARTY_NOTICES.md|owner-gated-document',
  'extension/media/icon.png|owner-gated-icon',
  'extension/package.json|owner-gated-metadata',
]);

function compareFindings(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.rule !== right.rule) return left.rule < right.rule ? -1 : 1;
  return left.detail < right.detail ? -1 : left.detail > right.detail ? 1 : 0;
}

function addFinding(findings, path, rule, detail, deferred = false) {
  if (findings.some((finding) => finding.path === path && finding.rule === rule)) return;
  findings.push({ path, rule, detail, ...(deferred ? { deferred: true } : {}) });
}

function displayPath(name) {
  return name.replace(/[\u0000-\u001f\u007f]/gu, '\uFFFD') || '<empty>';
}

function decodeEntryName(entry) {
  const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName : entry.fileNameRaw;
  if (!Buffer.isBuffer(raw)) throw new Error('ZIP entry name bytes are unavailable');
  if ((entry.generalPurposeBitFlag & 0x0800) !== 0) {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
  }
  return {
    name: getFileNameLowLevel(
      entry.generalPurposeBitFlag,
      raw,
      entry.extraFields,
      true,
    ),
    raw,
  };
}

function validateEntryPath(name, findings) {
  const path = displayPath(name);
  if (name.includes('\0')) {
    addFinding(findings, path, 'archive-nul', 'ZIP entry names must not contain NUL');
  }
  if (name.includes('\\')) {
    addFinding(findings, path, 'archive-backslash', 'ZIP entry names must use POSIX separators');
  }
  if (/^[A-Za-z]:/u.test(name)) {
    addFinding(findings, path, 'archive-drive-path', 'ZIP entry names must not use drive paths');
  }
  if (name.startsWith('/')) {
    addFinding(findings, path, 'archive-absolute-path', 'ZIP entry names must be relative');
  }

  const isDirectory = name.endsWith('/');
  const core = isDirectory ? name.slice(0, -1) : name;
  const segments = core.split('/');
  if (segments.includes('..')) {
    addFinding(findings, path, 'archive-traversal', 'ZIP entry names must not traverse parents');
  }
  if (!core || segments.some((segment) => !segment || segment === '.')) {
    addFinding(findings, path, 'archive-noncanonical-path', 'ZIP entry name is not canonical POSIX-relative');
  } else if (posix.normalize(core) !== core) {
    addFinding(findings, path, 'archive-noncanonical-path', 'ZIP entry name is not normalized');
  }
  if (core.normalize('NFC') !== core) {
    addFinding(findings, path, 'archive-non-nfc-path', 'ZIP entry name must use NFC Unicode');
  }
  return { core, isDirectory };
}

function entryKind(entry, isDirectory, findings, path) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;

  if (unixType === 0o120000) {
    addFinding(findings, path, 'archive-symlink', 'ZIP archives must not contain symbolic links');
    return 'invalid';
  }
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    addFinding(findings, path, 'archive-special-file', 'ZIP archives may contain regular files and directories only');
    return 'invalid';
  }
  const typedDirectory = unixType === 0o040000 || dosDirectory;
  const typedFile = unixType === 0o100000;
  if (isDirectory && typedFile) {
    addFinding(findings, path, 'archive-type-mismatch', 'directory name carries regular-file attributes');
    return 'invalid';
  }
  if (!isDirectory && typedDirectory) {
    addFinding(findings, path, 'archive-type-mismatch', 'file name carries directory attributes');
    return 'invalid';
  }
  return isDirectory ? 'directory' : 'file';
}

function isAllowedPayloadFile(name) {
  const lower = name.toLocaleLowerCase('en-US');
  if (name === 'extension/package.json') return true;
  if (new Set([
    'extension/readme.md',
    'extension/changelog.md',
    'extension/license',
    'extension/license.md',
    'extension/license.txt',
    'extension/third_party_notices.md',
    'extension/third-party-notices.md',
  ]).has(lower)) return true;
  if (name === 'extension/dist/extension.js') return true;
  if (name === 'extension/media/icon.png') return true;
  if (WALKTHROUGH_FILES.has(name)) return true;
  if (RUNTIME_MEDIA_FILES.has(name)) return true;
  return false;
}

function validateRuntimeInventory(descriptors) {
  const findings = [];
  const files = descriptors.filter((descriptor) => descriptor.kind === 'file');
  const fileNames = new Set(files.map((descriptor) => descriptor.name));
  const allowedPayloadFiles = new Set();

  for (const descriptor of files) {
    const { name } = descriptor;
    if (REQUIRED_ENVELOPES.includes(name)) continue;
    if (!name.startsWith('extension/')) {
      addFinding(findings, name, 'vsix-forbidden-root-path', 'VSIX root contains an unexpected file');
      continue;
    }
    if (!isAllowedPayloadFile(name)) {
      addFinding(findings, name, 'vsix-forbidden-path', 'VSIX payload path is outside the runtime allowlist');
      continue;
    }
    allowedPayloadFiles.add(name);
  }

  for (const envelope of REQUIRED_ENVELOPES) {
    if (!fileNames.has(envelope)) {
      addFinding(findings, envelope, 'vsix-missing-envelope', 'VSIX mandatory envelope file is missing');
    }
  }
  for (const runtimeFile of REQUIRED_RUNTIME) {
    if (!fileNames.has(runtimeFile)) {
      addFinding(findings, runtimeFile, 'vsix-missing-runtime', 'VSIX mandatory runtime file is missing');
    }
  }

  for (const descriptor of descriptors.filter((candidate) => candidate.kind === 'directory')) {
    const directory = descriptor.core;
    const isAncestor = [...allowedPayloadFiles].some((file) => file.startsWith(`${directory}/`));
    if (!isAncestor) {
      addFinding(findings, descriptor.name, 'vsix-forbidden-directory', 'explicit ZIP directory is not an ancestor of an allowed payload file');
    }
  }
  return findings.sort(compareFindings);
}

async function openValidatedArchive(vsixPath) {
  const findings = [];
  let zip;
  try {
    zip = await openPromise(vsixPath, {
      autoClose: false,
      decodeStrings: false,
      validateEntrySizes: true,
    });
  } catch (error) {
    addFinding(findings, '.', 'archive-format', `cannot open VSIX: ${error.message}`);
    return { findings, descriptors: [], root: null, close() {} };
  }

  const close = () => {
    if (zip?.isOpen) zip.close();
  };
  if (zip.entryCount > MAX_ENTRIES) {
    addFinding(findings, '.', 'archive-entry-limit', `VSIX has more than ${MAX_ENTRIES} entries`);
    return { findings, descriptors: [], root: null, close };
  }

  const descriptors = [];
  const aliases = new Map();
  const aliasPrefixes = new Map();
  let totalBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      let decoded;
      try {
        decoded = decodeEntryName(entry);
      } catch (error) {
        addFinding(findings, '<undecodable>', 'archive-name-encoding', `cannot decode ZIP entry name: ${error.message}`);
        continue;
      }
      const { name, raw } = decoded;
      const { core, isDirectory } = validateEntryPath(name, findings);
      const display = displayPath(name);
      const kind = entryKind(entry, isDirectory, findings, display);
      const normalized = core.normalize('NFC');
      const aliasKey = normalized.toUpperCase().toLowerCase();
      const previous = aliases.get(aliasKey);
      if (previous) {
        const rule = previous.core !== core && previous.core.normalize('NFC') === normalized
          ? 'archive-unicode-alias'
          : 'archive-alias-collision';
        addFinding(findings, display, rule, 'ZIP entry aliases an existing normalized path');
      } else if (core) {
        aliases.set(aliasKey, { core, kind });
      }
      if (core) {
        const segments = core.split('/');
        for (let length = 1; length <= segments.length; length += 1) {
          const prefix = segments.slice(0, length).join('/');
          const normalizedPrefix = prefix.normalize('NFC');
          const prefixKey = normalizedPrefix.toUpperCase().toLowerCase();
          const priorPrefix = aliasPrefixes.get(prefixKey);
          if (priorPrefix && priorPrefix.prefix !== prefix) {
            const rule = priorPrefix.prefix.normalize('NFC') === normalizedPrefix
              ? 'archive-unicode-alias'
              : 'archive-alias-collision';
            addFinding(findings, display, rule, 'ZIP path prefix aliases an existing normalized prefix');
          } else if (!priorPrefix) {
            aliasPrefixes.set(prefixKey, { prefix });
          }
        }
      }

      if (entry.isEncrypted()) {
        addFinding(findings, display, 'archive-encrypted-entry', 'encrypted ZIP entries are not supported');
      }
      if (!entry.canDecodeFileData() || ![0, 8].includes(entry.compressionMethod)) {
        addFinding(findings, display, 'archive-compression', 'ZIP entry uses an unsupported compression method');
      }
      if (kind === 'directory' && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) {
        addFinding(findings, display, 'archive-directory-data', 'ZIP directory entries must be empty');
      }
      if (kind === 'file') {
        const sizesAreSafe = Number.isSafeInteger(entry.compressedSize)
          && Number.isSafeInteger(entry.uncompressedSize)
          && entry.compressedSize >= 0
          && entry.uncompressedSize >= 0;
        if (!sizesAreSafe) {
          addFinding(findings, display, 'archive-size', 'ZIP entry sizes must be non-negative safe integers');
        } else if (entry.uncompressedSize > MAX_FILE_BYTES) {
          addFinding(findings, display, 'archive-file-size-limit', `ZIP entry exceeds ${MAX_FILE_BYTES} uncompressed bytes`);
        }
        if (sizesAreSafe) totalBytes += entry.uncompressedSize;
        const ratio = !sizesAreSafe || entry.uncompressedSize === 0
          ? 0
          : entry.uncompressedSize / Math.max(1, entry.compressedSize);
        if (ratio > MAX_COMPRESSION_RATIO) {
          addFinding(findings, display, 'archive-compression-ratio', `ZIP entry exceeds ${MAX_COMPRESSION_RATIO}:1 compression`);
        }
      }
      descriptors.push({ entry, name, raw, core, kind });
    }
  } catch (error) {
    addFinding(findings, '.', 'archive-format', `cannot enumerate VSIX central directory: ${error.message}`);
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    addFinding(findings, '.', 'archive-total-size-limit', `VSIX exceeds ${MAX_TOTAL_BYTES} total uncompressed bytes`);
  }

  const byCore = new Map(descriptors.filter((descriptor) => descriptor.core)
    .map((descriptor) => [descriptor.core, descriptor]));
  for (const descriptor of descriptors) {
    const segments = descriptor.core.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = byCore.get(segments.slice(0, length).join('/'));
      if (ancestor?.kind === 'file') {
        addFinding(findings, descriptor.name, 'archive-path-type-conflict', 'ZIP entry descends from a file entry');
      }
    }
  }

  for (const finding of validateRuntimeInventory(descriptors)) findings.push(finding);
  findings.sort(compareFindings);
  if (findings.length > 0) return { findings, descriptors, root: null, close };

  for (const descriptor of descriptors) {
    let local;
    try {
      local = await zip.readLocalFileHeaderPromise(descriptor.entry);
    } catch (error) {
      addFinding(findings, descriptor.name, 'archive-local-header', `cannot read local ZIP header: ${error.message}`);
      continue;
    }
    if (!Buffer.from(local.fileName).equals(descriptor.raw)
      || local.compressionMethod !== descriptor.entry.compressionMethod
      || local.generalPurposeBitFlag !== descriptor.entry.generalPurposeBitFlag) {
      addFinding(findings, descriptor.name, 'archive-local-header', 'local ZIP header disagrees with the central directory');
      continue;
    }
    if ((descriptor.entry.generalPurposeBitFlag & 0x0008) === 0
      && (local.compressedSize !== descriptor.entry.compressedSize
        || local.uncompressedSize !== descriptor.entry.uncompressedSize
        || local.crc32 !== descriptor.entry.crc32)) {
      addFinding(findings, descriptor.name, 'archive-local-header', 'local ZIP sizes or checksum disagree with the central directory');
    }
  }
  if (findings.length > 0) return { findings: findings.sort(compareFindings), descriptors, root: null, close };

  const extractionRoot = mkdtempSync(join(tmpdir(), 'ditaeditor-vsix-inspect-'));
  chmodSync(extractionRoot, 0o700);
  try {
    for (const descriptor of descriptors) {
      const destination = resolve(extractionRoot, ...descriptor.core.split('/'));
      const relativeDestination = relative(extractionRoot, destination);
      if (!relativeDestination || relativeDestination === '..'
        || relativeDestination.startsWith(`..${sep}`) || isAbsolute(relativeDestination)) {
        throw new Error('validated ZIP destination escaped the extraction root');
      }
      if (descriptor.kind === 'directory') {
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        chmodSync(destination, 0o700);
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const readStream = await zip.openReadStreamPromise(descriptor.entry);
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > descriptor.entry.uncompressedSize) {
            callback(new Error('stream exceeded declared uncompressed size'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(readStream, counter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      if (bytes !== descriptor.entry.uncompressedSize) {
        throw new Error(`stream size mismatch for ${descriptor.name}`);
      }
      const status = lstatSync(destination);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`extracted path is not a regular file: ${descriptor.name}`);
      }
      chmodSync(destination, 0o600);
    }
  } catch (error) {
    rmSync(extractionRoot, { recursive: true, force: true });
    addFinding(findings, '.', 'archive-stream', `cannot safely extract VSIX: ${error.message}`);
    return { findings: findings.sort(compareFindings), descriptors, root: null, close };
  }
  return { findings: [], descriptors, root: extractionRoot, close };
}

function readUtf8(path, findings, findingPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    addFinding(findings, findingPath, 'vsix-invalid-utf8', `cannot read required UTF-8 file: ${error.message}`);
    return null;
  }
}

function parseAttributes(source) {
  const attributes = new Map();
  const duplicates = new Set();
  const expression = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/gu;
  let match;
  while ((match = expression.exec(source))) {
    if (attributes.has(match[1])) duplicates.add(match[1]);
    attributes.set(match[1], match[2]);
  }
  return { attributes, duplicates };
}

function parseTagAttributes(tag) {
  const closingLength = tag.token.endsWith('/>') ? 2 : 1;
  const inside = tag.token.slice(1, -closingLength).trim();
  return parseAttributes(inside.slice(tag.name.length));
}

function findDuplicateJsonKeys(source) {
  let cursor = 0;
  const duplicates = [];
  const skipWhitespace = () => {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor));
      }
      cursor += 1;
    }
    throw new Error('unterminated JSON string');
  };
  const parseValue = (path) => {
    skipWhitespace();
    if (source[cursor] === '{') {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        skipWhitespace();
        const key = parseString();
        const keyPath = [...path, key].join('.');
        if (keys.has(key)) duplicates.push(keyPath);
        else keys.add(key);
        skipWhitespace();
        cursor += 1; // colon; JSON.parse has already validated the grammar.
        parseValue([...path, key]);
        skipWhitespace();
        if (source[cursor] === '}') {
          cursor += 1;
          return;
        }
        cursor += 1; // comma
      }
      return;
    }
    if (source[cursor] === '[') {
      cursor += 1;
      skipWhitespace();
      let index = 0;
      if (source[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        parseValue([...path, `[${index}]`]);
        index += 1;
        skipWhitespace();
        if (source[cursor] === ']') {
          cursor += 1;
          return;
        }
        cursor += 1; // comma
      }
      return;
    }
    if (source[cursor] === '"') {
      parseString();
      return;
    }
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1;
  };

  parseValue([]);
  return duplicates;
}

function isValidXmlCodePoint(codePoint) {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function validateXmlMarkupPlacement(source, findings, path) {
  let inTag = false;
  let quote = null;
  let tagStart = -1;
  let elementDepth = 0;
  let cursor = 0;

  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      if (inTag) {
        addFinding(findings, path, 'vsix-envelope-format', 'XML comments are not allowed inside tags or attributes');
      }
      const close = source.indexOf('-->', cursor + 4);
      if (close === -1) return;
      cursor = close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', cursor)) {
      if (inTag || elementDepth === 0) {
        addFinding(findings, path, 'vsix-envelope-format', 'CDATA is allowed only in element character data');
      }
      const close = source.indexOf(']]>', cursor + 9);
      if (close === -1) return;
      cursor = close + 3;
      continue;
    }
    if (!inTag && source.startsWith('<?', cursor)) {
      const close = source.indexOf('?>', cursor + 2);
      if (close === -1) return;
      cursor = close + 2;
      continue;
    }

    const character = source[cursor];
    if (!inTag) {
      if (character === '<') {
        inTag = true;
        quote = null;
        tagStart = cursor;
      }
      cursor += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === '>') {
      const token = source.slice(tagStart, cursor + 1)
        .replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/gu, ' ');
      if (/^<\//u.test(token)) elementDepth = Math.max(0, elementDepth - 1);
      else if (/^<[A-Za-z_]/u.test(token) && !/\/\s*>$/u.test(token)) elementDepth += 1;
      inTag = false;
      tagStart = -1;
    }
    cursor += 1;
  }
}

function sanitizeEnvelopeXml(source, findings, path) {
  if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(source)) {
    addFinding(findings, path, 'vsix-envelope-format', 'DTD and entity declarations are not allowed in VSIX envelopes');
  }
  for (const character of source) {
    if (!isValidXmlCodePoint(character.codePointAt(0))) {
      addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains an invalid XML character');
      break;
    }
  }
  validateXmlMarkupPlacement(source, findings, path);
  const declarationIndex = source.search(/<\?xml\b/u);
  const declarationPrefix = declarationIndex >= 0
    ? source.slice(0, declarationIndex).replace(/^\uFEFF/u, '')
    : '';
  if (declarationIndex >= 0 && declarationPrefix.length > 0) {
    addFinding(findings, path, 'vsix-envelope-format', 'XML declaration must be the first non-BOM bytes');
  }
  for (const match of source.matchAll(/<!--([\s\S]*?)-->/gu)) {
    if (match[1].includes('--') || match[1].endsWith('-')) {
      addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains an invalid XML comment');
      break;
    }
  }
  const mask = (block) => ' '.repeat(block.length);
  const withoutComments = source.replace(/<!--[\s\S]*?-->/gu, mask);
  const withoutCdata = withoutComments.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, mask);
  if (withoutCdata.includes('<!--') || withoutCdata.includes('<![CDATA[')) {
    addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains an unterminated comment or CDATA section');
  }
  if (withoutCdata.includes(']]>')) {
    addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains ]]> outside a CDATA section');
  }
  return withoutCdata;
}

function validateXmlEntityReferences(source, findings, path) {
  let cursor = 0;
  while ((cursor = source.indexOf('&', cursor)) !== -1) {
    const match = /^&(?:(amp|lt|gt|apos|quot)|#([0-9]+)|#x([0-9A-Fa-f]+));/u.exec(source.slice(cursor));
    if (!match) {
      addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains an invalid XML entity reference');
      return;
    }
    const numeric = match[2] ? Number.parseInt(match[2], 10)
      : match[3] ? Number.parseInt(match[3], 16)
        : null;
    if (numeric !== null && !isValidXmlCodePoint(numeric)) {
      addFinding(findings, path, 'vsix-envelope-format', 'VSIX envelope contains an invalid numeric XML reference');
      return;
    }
    cursor += match[0].length;
  }
}

function decodeXmlCharacterReferences(source) {
  const predefined = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['apos', "'"], ['quot', '"'],
  ]);
  return source.replace(
    /&(?:(amp|lt|gt|apos|quot)|#([0-9]+)|#x([0-9A-Fa-f]+));/gu,
    (_reference, name, decimal, hexadecimal) => {
      if (name) return predefined.get(name);
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : Number.parseInt(hexadecimal, 16);
      return isValidXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : _reference;
    },
  );
}

function xmlLogicalTextProjection(source) {
  const attributeValues = [];
  let characterData = '';
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4);
      if (close === -1) break;
      cursor = close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', cursor)) {
      const close = source.indexOf(']]>', cursor + 9);
      if (close === -1) break;
      characterData += source.slice(cursor + 9, close);
      cursor = close + 3;
      continue;
    }
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const end = next === -1 ? source.length : next;
      characterData += decodeXmlCharacterReferences(source.slice(cursor, end));
      cursor = end;
      continue;
    }

    const processingInstruction = source.startsWith('<?', cursor);
    let quote = null;
    let close = -1;
    for (let index = cursor + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if ((processingInstruction && source.startsWith('?>', index))
        || (!processingInstruction && character === '>')) {
        close = processingInstruction ? index + 1 : index;
        break;
      }
    }
    if (close === -1) break;
    const token = source.slice(cursor, close + 1);
    for (const match of token.matchAll(
      /\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
    )) {
      attributeValues.push(decodeXmlCharacterReferences(match[1] ?? match[2] ?? ''));
    }
    cursor = close + 1;
  }
  return `${attributeValues.join('\n')}\n${characterData}`;
}

function validateXmlAttributeSyntax(token, name) {
  const closingLength = token.endsWith('/>') ? 2 : 1;
  const inside = token.slice(1, -closingLength).trim();
  const attributes = inside.slice(name.length);
  let cursor = 0;
  const names = new Set();
  while (cursor < attributes.length) {
    const match = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/u.exec(attributes.slice(cursor));
    if (!match || names.has(match[1])) return false;
    names.add(match[1]);
    cursor += match[0].length;
  }
  return true;
}

function validateBalancedXml(source, expectedRoot, findings, path) {
  const stack = [];
  const tags = [];
  let rootName = null;
  let rootCount = 0;
  let xmlDeclarationSeen = false;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) break;
    if (stack.length === 0 && source.slice(cursor, open).trim()) {
      addFinding(findings, path, 'vsix-envelope-format', 'XML envelope has text outside its root element');
      return tags;
    }
    if (source.startsWith('<?', open)) {
      const close = source.indexOf('?>', open + 2);
      if (close === -1 || rootCount > 0 || stack.length > 0) {
        addFinding(findings, path, 'vsix-envelope-format', 'invalid XML processing instruction');
        return tags;
      }
      const instruction = source.slice(open, close + 2);
      const target = /^<\?([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s[\s\S]*?)?\?>$/u.exec(instruction)?.[1];
      if (!target) {
        addFinding(findings, path, 'vsix-envelope-format', 'invalid XML processing instruction');
        return tags;
      }
      if (target.toLocaleLowerCase('en-US') === 'xml') {
        const declaration = /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/u;
        if (target !== 'xml' || xmlDeclarationSeen
          || source.slice(0, open).trim() || !declaration.test(instruction)) {
          addFinding(findings, path, 'vsix-envelope-format', 'invalid or duplicate XML declaration');
          return tags;
        }
        xmlDeclarationSeen = true;
      }
      cursor = close + 2;
      continue;
    }

    let quote = null;
    let close = -1;
    for (let index = open + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        close = index;
        break;
      }
    }
    if (close === -1 || quote) {
      addFinding(findings, path, 'vsix-envelope-format', 'unterminated XML tag or attribute');
      return tags;
    }

    const token = source.slice(open, close + 1);
    const closing = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/u.exec(token);
    if (closing) {
      if (stack.at(-1) !== closing[1]) {
        addFinding(findings, path, 'vsix-envelope-format', 'XML tags are not properly nested');
        return tags;
      }
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const opening = /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[\s\S]*?)?\/?>$/u.exec(token);
    if (!opening || token.startsWith('<!') || token.slice(1, -1).includes('<')
      || !validateXmlAttributeSyntax(token, opening?.[1] ?? '')) {
      addFinding(findings, path, 'vsix-envelope-format', 'XML envelope contains an invalid tag or attribute');
      return tags;
    }
    if (stack.length === 0) {
      rootCount += 1;
      rootName ??= opening[1];
    }
    tags.push({
      end: close + 1,
      name: opening[1],
      path: [...stack, opening[1]].join('/'),
      start: open,
      token,
    });
    if (!token.endsWith('/>')) stack.push(opening[1]);
    cursor = close + 1;
  }

  if ((stack.length === 0 && source.slice(cursor).trim())
    || stack.length > 0 || rootCount !== 1 || rootName !== expectedRoot) {
    addFinding(findings, path, 'vsix-envelope-format', `XML envelope must have one balanced ${expectedRoot} root`);
  }
  return tags;
}

function validateEnvelopes(extractionRoot) {
  const findings = [];
  const packageSource = readUtf8(join(extractionRoot, 'extension/package.json'), findings, 'extension/package.json');
  const manifestSource = readUtf8(join(extractionRoot, 'extension.vsixmanifest'), findings, 'extension.vsixmanifest');
  const contentTypesSource = readUtf8(join(extractionRoot, '[Content_Types].xml'), findings, '[Content_Types].xml');
  if (findings.length > 0 || packageSource === null || manifestSource === null || contentTypesSource === null) {
    return { findings: findings.sort(compareFindings), packageJson: null };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageSource);
  } catch (error) {
    addFinding(findings, 'extension/package.json', 'vsix-package-json', `cannot parse extension manifest JSON: ${error.message}`);
    return { findings: findings.sort(compareFindings), packageJson: null };
  }
  let duplicateJsonKeys;
  try {
    duplicateJsonKeys = findDuplicateJsonKeys(packageSource);
  } catch (error) {
    addFinding(findings, 'extension/package.json', 'vsix-package-json', `cannot validate JSON object keys: ${error.message}`);
    return { findings: findings.sort(compareFindings), packageJson: null };
  }
  if (duplicateJsonKeys.length > 0) {
    addFinding(
      findings,
      'extension/package.json',
      'vsix-package-json',
      `duplicate JSON object key: ${duplicateJsonKeys[0]}`,
    );
  }

  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    addFinding(findings, 'extension/package.json', 'vsix-package-json', 'extension manifest JSON must be an object');
    return { findings: findings.sort(compareFindings), packageJson: null };
  }
  if (packageJson.main !== './dist/extension.js') {
    addFinding(findings, 'extension/package.json', 'vsix-runtime-manifest', 'extension main must be ./dist/extension.js');
  }

  const cleanManifest = sanitizeEnvelopeXml(
    manifestSource,
    findings,
    'extension.vsixmanifest',
  );
  const cleanContentTypes = sanitizeEnvelopeXml(
    contentTypesSource,
    findings,
    '[Content_Types].xml',
  );
  validateXmlEntityReferences(cleanManifest, findings, 'extension.vsixmanifest');
  validateXmlEntityReferences(cleanContentTypes, findings, '[Content_Types].xml');
  const manifestTags = validateBalancedXml(
    cleanManifest,
    'PackageManifest',
    findings,
    'extension.vsixmanifest',
  );
  const contentTypeTags = validateBalancedXml(
    cleanContentTypes,
    'Types',
    findings,
    '[Content_Types].xml',
  );
  const metadataTags = manifestTags.filter((tag) =>
    tag.path === 'PackageManifest/Metadata');
  const assetsTags = manifestTags.filter((tag) =>
    tag.path === 'PackageManifest/Assets');
  if (metadataTags.length !== 1 || assetsTags.length !== 1) {
    addFinding(findings, 'extension.vsixmanifest', 'vsix-envelope-format', 'VSIX manifest requires one Metadata and one Assets child');
  }
  const identityTags = manifestTags.filter((tag) =>
    tag.path === 'PackageManifest/Metadata/Identity');
  const assetTags = manifestTags
    .filter((tag) => tag.path === 'PackageManifest/Assets/Asset')
    .map((tag) => parseTagAttributes(tag));
  const manifestAssets = assetTags.filter(({ attributes }) =>
    attributes.get('Type') === 'Microsoft.VisualStudio.Code.Manifest');
  if (identityTags.length !== 1) {
    addFinding(findings, 'extension.vsixmanifest', 'vsix-envelope-format', 'VSIX manifest must contain exactly one Identity element');
  }
  if (identityTags.length > 0) {
    const identity = parseTagAttributes(identityTags[0]);
    if (identity.duplicates.size > 0) {
      addFinding(findings, 'extension.vsixmanifest', 'vsix-envelope-format', 'VSIX Identity contains duplicate attributes');
    }
    const expected = {
      Id: packageJson.name,
      Version: packageJson.version,
      Publisher: packageJson.publisher,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value !== 'string' || identity.attributes.get(key) !== value) {
        addFinding(findings, 'extension.vsixmanifest', 'vsix-identity-mismatch', `${key} does not agree with extension/package.json`);
      }
    }
  }
  if (manifestAssets.length !== 1
    || manifestAssets[0].duplicates.size > 0
    || manifestAssets[0].attributes.get('Path') !== 'extension/package.json') {
    addFinding(findings, 'extension.vsixmanifest', 'vsix-envelope-format', 'VSIX manifest does not point at extension/package.json exactly once');
  }

  const defaults = contentTypeTags
    .filter((tag) => tag.path === 'Types/Default')
    .map((tag) => parseTagAttributes(tag));
  if (defaults.some((entry) => entry.duplicates.size > 0)) {
    addFinding(findings, '[Content_Types].xml', 'vsix-envelope-format', 'content-types envelope contains duplicate attributes');
  }
  const requiredTypes = new Map([
    ['json', 'application/json'],
    ['vsixmanifest', 'text/xml'],
  ]);
  for (const [extension, contentType] of requiredTypes) {
    const declarations = defaults.filter(({ attributes }) => {
      const declaredExtension = attributes.get('Extension')?.replace(/^\./u, '');
      return declaredExtension === extension;
    });
    if (declarations.length !== 1 || declarations[0].attributes.get('ContentType') !== contentType) {
      addFinding(findings, '[Content_Types].xml', 'vsix-envelope-format', `missing ${extension} content-type declaration`);
    }
  }
  return { findings: findings.sort(compareFindings), packageJson };
}

function metadataReady(packageJson) {
  const repositoryUrl = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url;
  return typeof packageJson.version === 'string'
    && MARKETPLACE_PREVIEW_VERSION.test(packageJson.version)
    && packageJson.preview === true
    && !Object.hasOwn(packageJson, 'private')
    && packageJson.publisher === MARKETPLACE_PUBLISHER
    && packageJson.name === MARKETPLACE_EXTENSION_NAME
    && typeof packageJson.displayName === 'string' && packageJson.displayName.length > 0
    && packageJson.icon === 'media/icon.png'
    && typeof packageJson.license === 'string' && packageJson.license.length > 0
    && typeof repositoryUrl === 'string' && repositoryUrl.length > 0
    && typeof packageJson.homepage === 'string' && packageJson.homepage.length > 0
    && typeof packageJson.bugs?.url === 'string' && packageJson.bugs.url.length > 0
    && packageJson.pricing === 'Free';
}

function ownerGateFindings(extractionRoot, descriptors, packageJson, phase) {
  const findings = [];
  const deferred = phase === 'pre-metadata';
  const filesByLower = new Map(descriptors
    .filter((descriptor) => descriptor.kind === 'file')
    .map((descriptor) => [descriptor.name.toLocaleLowerCase('en-US'), descriptor.name]));

  if (!metadataReady(packageJson)) {
    addFinding(findings, 'extension/package.json', 'owner-gated-metadata', 'public identity and registry metadata are not finalized', deferred);
  }
  const readmeName = filesByLower.get('extension/readme.md');
  let readmeReady = false;
  if (readmeName) {
    const source = readUtf8(join(extractionRoot, ...readmeName.split('/')), findings, 'extension/README.md');
    readmeReady = source !== null
      && ['docs/STYLING.md', 'docs/TAXONOMY.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md']
        .every((reference) => source.includes(reference));
  }
  if (!readmeReady) {
    addFinding(findings, 'extension/README.md', 'owner-gated-document', 'public README is not finalized', deferred);
  }

  const requiredOwnerFiles = [
    {
      path: 'extension/CHANGELOG.md',
      keys: ['extension/changelog.md'],
      rule: 'owner-gated-document',
    },
    {
      path: 'extension/LICENSE',
      keys: ['extension/license', 'extension/license.md', 'extension/license.txt'],
      rule: 'owner-gated-document',
    },
    {
      path: 'extension/THIRD_PARTY_NOTICES.md',
      keys: ['extension/third_party_notices.md', 'extension/third-party-notices.md'],
      rule: 'owner-gated-document',
    },
    {
      path: 'extension/media/icon.png',
      keys: ['extension/media/icon.png'],
      rule: 'owner-gated-icon',
    },
  ];
  for (const requirement of requiredOwnerFiles) {
    if (!requirement.keys.some((key) => filesByLower.has(key))) {
      addFinding(findings, requirement.path, requirement.rule, 'owner-approved release file is missing', deferred);
    }
  }
  return findings.sort(compareFindings);
}

function redactPreMetadataManifest(source) {
  const parseFindings = [];
  const clean = sanitizeEnvelopeXml(
    source,
    parseFindings,
    'extension.vsixmanifest',
  );
  validateXmlEntityReferences(clean, parseFindings, 'extension.vsixmanifest');
  const tags = validateBalancedXml(
    clean,
    'PackageManifest',
    parseFindings,
    'extension.vsixmanifest',
  );
  if (parseFindings.length > 0) return source;

  const replacements = [];
  const identities = tags.filter((tag) =>
    tag.path === 'PackageManifest/Metadata/Identity');
  if (identities.length === 1) {
    const identity = identities[0];
    const segment = source.slice(identity.start, identity.end);
    const ownerAttributes = new Set(['Id', 'Publisher', 'Version']);
    const redacted = segment.replace(
      /(\s+)([A-Za-z_:][A-Za-z0-9_.:-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gu,
      (match, whitespace, name, equals, doubleValue, singleValue) => {
        if (!ownerAttributes.has(name)) return match;
        const quote = doubleValue !== undefined ? '"' : "'";
        return `${whitespace}${name}${equals}${quote}__OWNER_VALUE__${quote}`;
      },
    );
    replacements.push({ start: identity.start, end: identity.end, value: redacted });
  }

  const displayNames = tags.filter((tag) =>
    tag.path === 'PackageManifest/Metadata/DisplayName');
  if (displayNames.length === 1) {
    const displayName = displayNames[0];
    const closingStart = source.indexOf('</DisplayName>', displayName.end);
    if (closingStart >= 0) {
      const body = source.slice(displayName.end, closingStart);
      if (!body.includes('<')) {
        replacements.push({
          start: displayName.end,
          end: closingStart,
          value: '__OWNER_DISPLAY_NAME__',
        });
      }
    }
  }

  let redacted = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    redacted = redacted.slice(0, replacement.start)
      + replacement.value
      + redacted.slice(replacement.end);
  }
  return redacted;
}

async function contentFindings(extractionRoot, packageJson, phase) {
  const ignored = new Set(REQUIRED_ENVELOPES.concat('extension/package.json'));
  const findings = await scanPublicContent({
    root: extractionRoot,
    includeBuildOutputs: true,
    ignoreContentPaths: ignored,
  });
  const packageForScan = phase === 'pre-metadata'
    ? Object.fromEntries(Object.entries(packageJson)
      .filter(([key]) => !OWNER_IDENTITY_KEYS.has(key)))
    : packageJson;
  const packageSource = readUtf8(
    join(extractionRoot, 'extension/package.json'),
    findings,
    'extension/package.json',
  );
  if (phase !== 'pre-metadata' && packageSource !== null) {
    for (const finding of scanTextForPrivateContent(
      'extension/package.json',
      packageSource,
    )) findings.push(finding);
  }
  for (const finding of scanTextForPrivateContent(
    'extension/package.json',
    JSON.stringify(packageForScan),
  )) findings.push(finding);

  const manifestSource = readUtf8(
    join(extractionRoot, 'extension.vsixmanifest'),
    findings,
    'extension.vsixmanifest',
  );
  if (manifestSource !== null) {
    const sourceForScan = phase === 'pre-metadata'
      ? redactPreMetadataManifest(manifestSource)
      : manifestSource;
    for (const finding of scanTextForPrivateContent(
      'extension.vsixmanifest',
      sourceForScan,
    )) findings.push(finding);
    for (const finding of scanTextForPrivateContent(
      'extension.vsixmanifest',
      decodeXmlCharacterReferences(sourceForScan),
    )) findings.push(finding);
    for (const finding of scanTextForPrivateContent(
      'extension.vsixmanifest',
      xmlLogicalTextProjection(sourceForScan),
    )) findings.push(finding);
  }
  const contentTypesSource = readUtf8(
    join(extractionRoot, '[Content_Types].xml'),
    findings,
    '[Content_Types].xml',
  );
  if (contentTypesSource !== null) {
    for (const finding of scanTextForPrivateContent(
      '[Content_Types].xml',
      contentTypesSource,
    )) findings.push(finding);
    for (const finding of scanTextForPrivateContent(
      '[Content_Types].xml',
      decodeXmlCharacterReferences(contentTypesSource),
    )) findings.push(finding);
    for (const finding of scanTextForPrivateContent(
      '[Content_Types].xml',
      xmlLogicalTextProjection(contentTypesSource),
    )) findings.push(finding);
  }
  return findings.sort(compareFindings);
}

async function inspectCore(vsixPath, includeContentAndMetadata, phase) {
  const archive = await openValidatedArchive(vsixPath);
  const findings = [...archive.findings];
  try {
    if (!archive.root) {
      if (phase === 'pre-metadata') {
        addFinding(
          findings,
          '.',
          'pre-metadata-deferral-set',
          'finding set is not the exact frozen owner-gated pre-metadata set',
        );
      }
      return { ok: false, findings: findings.sort(compareFindings) };
    }
    const envelope = validateEnvelopes(archive.root);
    findings.push(...envelope.findings);
    if (includeContentAndMetadata && envelope.packageJson) {
      findings.push(...await contentFindings(
        archive.root,
        envelope.packageJson,
        phase,
      ));
      findings.push(...ownerGateFindings(
        archive.root,
        archive.descriptors,
        envelope.packageJson,
        phase,
      ));
    }
  } finally {
    archive.close();
    if (archive.root) rmSync(archive.root, { recursive: true, force: true });
  }

  findings.sort(compareFindings);
  if (phase === 'pre-metadata') {
    const actual = findings.filter((finding) => finding.deferred)
      .map((finding) => `${finding.path}|${finding.rule}`)
      .sort();
    const expected = [...PRE_METADATA_DEFERRED_KEYS].sort();
    const nonDeferred = findings.filter((finding) => !finding.deferred);
    if (nonDeferred.length > 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
      addFinding(
        findings,
        '.',
        'pre-metadata-deferral-set',
        'finding set is not the exact frozen owner-gated pre-metadata set',
      );
    }
    findings.sort(compareFindings);
    return {
      ok: findings.every((finding) => finding.deferred),
      findings,
    };
  }
  return { ok: findings.length === 0, findings };
}

export async function inspectVsixStructure(vsixPath) {
  return inspectCore(resolve(vsixPath), false, undefined);
}

export async function inspectVsix({ vsixPath, phase } = {}) {
  if (!vsixPath) {
    return {
      ok: false,
      findings: [{ path: '.', rule: 'argument', detail: 'VSIX path is required' }],
    };
  }
  return inspectCore(resolve(vsixPath), true, phase);
}

function parseArgs(argv) {
  let phase;
  let vsixPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--phase') {
      if (argv[index + 1] !== 'pre-metadata') throw new Error('--phase accepts only pre-metadata');
      phase = 'pre-metadata';
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`unknown argument: ${argument}`);
    if (vsixPath) throw new Error('exactly one VSIX path is required');
    vsixPath = argument;
  }
  if (!vsixPath) throw new Error('VSIX path is required');
  return { vsixPath, phase };
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!isAbsolute(resolve(options.vsixPath))) throw new Error('VSIX path must resolve absolutely');
    const result = await inspectVsix(options);
    for (const finding of result.findings) {
      const label = finding.deferred ? 'DEFERRED' : 'ERROR';
      const output = `${label} ${finding.path} [${finding.rule}] ${finding.detail}`;
      if (finding.deferred) console.log(output);
      else console.error(output);
    }
    if (!result.ok) process.exitCode = 1;
    else console.log(options.phase === 'pre-metadata'
      ? 'VSIX pre-metadata hygiene gate passed with the exact owner deferrals.'
      : 'VSIX hygiene gate passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
