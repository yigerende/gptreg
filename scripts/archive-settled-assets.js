#!/usr/bin/env node
'use strict';

/**
 * Moves settled accounts out of the login-state listing, by hand.
 *
 * The 清洗机器人 does this on its own schedule; this is the same call with a
 * dry run in front of it, for the first sweep or for a one-off window.
 *
 * An account that is sold and whose CPA batch was locked a day ago is finished
 * business: nothing refreshes it, nothing exports it, and the lock already
 * refuses every action on it. It still costs a stat and a read on every cold
 * index rebuild. Measured on 2026-09-25: 8064 assets, 90.8s to index cold,
 * 4637 of them sold.
 *
 * Archiving is a rename into `session-assets/archive/`. The CPA page keeps
 * showing them — that is the record a locked batch exists to preserve — `get`
 * still resolves an archived id, the addresses stay in `knownEmails` so none
 * of them becomes registerable again, and `--restore` moves them back.
 * Nothing is deleted.
 *
 *   node scripts/archive-settled-assets.js                    # dry run
 *   node scripts/archive-settled-assets.js --apply
 *   node scripts/archive-settled-assets.js --apply --hours 72
 *   node scripts/archive-settled-assets.js --restore --apply
 */

const fs = require('node:fs');
const path = require('node:path');

const { SessionAssetStore, SETTLED_ARCHIVE_HOURS } = require('../src/session-asset-store');
const { validateV2Config } = require('../src/config-v2');

const apply = process.argv.includes('--apply');
const restore = process.argv.includes('--restore');
const hours = process.argv.includes('--hours')
  ? Number(process.argv[process.argv.indexOf('--hours') + 1])
  : SETTLED_ARCHIVE_HOURS;
if (!Number.isFinite(hours) || hours < 0) {
  console.error('--hours takes a non-negative number of hours');
  process.exit(2);
}

const cwd = process.cwd();
const config = validateV2Config(JSON.parse(fs.readFileSync(path.join(cwd, 'gpt-re.config.json'), 'utf8')));
const store = new SessionAssetStore({ cwd, config });
const report = (label, value) => console.log(`${String(label).padEnd(26)}${value}`);

function summarise(action, moved, skipped) {
  console.log(`\n${action} ${moved}, skipped ${skipped}`);
  report('listing now holds', store.entries().length);
  report('archive now holds', store.archivedFiles().length);
}

async function main() {
  if (restore) {
    const ids = store.archivedFiles().map((file) => path.basename(file).slice('asset-'.length, -'.json'.length));
    report('archived assets', ids.length);
    if (!apply) return console.log('\ndry run; pass --apply to move them back into the listing');
    const result = store.relocate(ids, { restore: true });
    return summarise('restored', result.moved.length, result.skipped.length);
  }

  const ids = store.settledSoldIds({ hours });
  let bytes = 0;
  for (const id of ids) {
    try { bytes += fs.statSync(store.filePath(id)).size; } catch { /* counted as zero */ }
  }
  const listed = store.entries().length;
  report('listed assets', listed);
  report(`sold, locked over ${hours}h`, `${ids.length}  (${(bytes / 1048576).toFixed(1)} MB)  <- to archive`);
  report('already archived', store.archivedFiles().length);

  if (!apply) return console.log('\ndry run; nothing moved. --apply to archive, --restore --apply to undo.');
  if (!ids.length) return console.log('\nnothing to archive');
  const result = store.relocate(ids);
  return summarise('archived', result.moved.length, result.skipped.length);
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => store.close());
