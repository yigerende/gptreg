'use strict';

/**
 * A minimal ZIP writer.
 *
 * The console exports batches as one file per account inside a folder, which
 * needs an archive container. Nothing in the tree pulls a zip dependency and a
 * store/deflate writer is small enough to own: the format below is the classic
 * 32-bit local-header + central-directory layout, which every extractor on
 * Windows, macOS and Linux reads without help.
 *
 * Deliberately not supported: ZIP64, encryption, streaming. These archives hold
 * a few hundred small JSON files, so the whole thing fits in memory and stays
 * far below the 4 GiB and 65 535-entry limits of the base format.
 */

const { crc32, deflateRawSync } = require('node:zlib');

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
// Bit 11 marks the file name as UTF-8, so non-ASCII paths survive extraction.
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const STORE = 0;
const MAX_ENTRIES = 65_535;

/** MS-DOS date/time, the only timestamp the base format carries. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function normalizeEntryPath(value) {
  // Backslashes and leading slashes are what turn an archive into a path
  // traversal on extraction; `..` segments are dropped for the same reason.
  const parts = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..');
  if (!parts.length) throw new Error('ZIP entry path is empty');
  return parts.join('/');
}

/**
 * Builds a ZIP archive in memory.
 *
 * `entries` is `[{ path, content }]`, where `content` is a Buffer or a string.
 * Duplicate paths are refused rather than silently shadowed — an archive where
 * one account quietly overwrites another is worse than a failed export.
 */
function createZipArchive(entries = [], options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new Error('A ZIP archive needs at least one entry');
  if (list.length > MAX_ENTRIES) throw new Error(`A ZIP archive holds at most ${MAX_ENTRIES} entries`);
  const stamp = dosDateTime(options.date instanceof Date ? options.date : new Date());
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of list) {
    const path = normalizeEntryPath(entry?.path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate ZIP entry: ${path}`);
    seen.add(key);

    const name = Buffer.from(path, 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''), 'utf8');
    const deflated = content.length ? deflateRawSync(content) : Buffer.alloc(0);
    // Tiny or incompressible payloads can deflate larger than they started;
    // storing those keeps the archive honest about its own size.
    const compressed = deflated.length && deflated.length < content.length ? deflated : content;
    const method = compressed === deflated && deflated.length ? DEFLATE : STORE;
    const checksum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, end]);
}

/**
 * Makes `name` unique within `taken`, which it also updates.
 *
 * Two accounts can share a display name — the same address exported from two
 * runs — and the archive must keep both rather than lose one to a collision.
 */
function uniqueEntryName(name, taken) {
  const key = String(name).toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }
  const match = /^(.*?)(\.[^.]*(?:\.[^.]*)?)?$/.exec(String(name));
  const stem = match?.[1] || String(name);
  const suffix = match?.[2] || '';
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-${index}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error(`Cannot make a unique ZIP entry name for ${name}`);
}

module.exports = { createZipArchive, uniqueEntryName };
