'use strict';

/**
 * Write the derived `lifecycle` axis onto every stored login-state asset.
 *
 * The store also migrates lazily on read, so this script is an optimisation
 * rather than a prerequisite: running it means the first console load after a
 * deploy is not also a full rewrite of the asset directory.
 *
 * Reports before it writes, and writes nothing without `--apply`.
 *
 *   node scripts/session-asset-lifecycle-migrate.js          # dry run
 *   node scripts/session-asset-lifecycle-migrate.js --apply
 */

const path = require('node:path');

const { SessionAssetStore } = require('../src/session-asset-store');
const { assetLifecycle } = require('../src/session-asset-grouping');

function main() {
  const apply = process.argv.includes('--apply');
  const cwd = path.resolve(process.argv.find((arg) => arg.startsWith('--cwd='))?.slice(6) || process.cwd());
  const store = new SessionAssetStore({ cwd });

  const planned = [];
  const corrupt = [];
  for (const asset of store.allRaw()) {
    if (asset.status === 'corrupt') { corrupt.push(asset.id); continue; }
    const resolved = assetLifecycle(asset);
    if (asset.lifecycle === resolved) continue;
    planned.push({ id: asset.id, email: asset.email, from: asset.lifecycle ?? '(unset)', to: resolved });
  }

  const byTransition = new Map();
  for (const item of planned) {
    const key = `${item.from} -> ${item.to}`;
    byTransition.set(key, (byTransition.get(key) || 0) + 1);
  }

  console.log(`store: ${cwd}`);
  console.log(`assets needing a lifecycle write: ${planned.length}`);
  for (const [transition, count] of [...byTransition].sort()) console.log(`  ${transition}: ${count}`);
  if (corrupt.length) console.log(`unreadable, skipped: ${corrupt.length}`);

  if (!apply) {
    console.log('\ndry run — re-run with --apply to write.');
    return;
  }

  let written = 0;
  const failed = [];
  for (const item of planned) {
    try {
      // `save` rather than `update`, so a migration does not restamp
      // `updatedAt` and reshuffle a list the operator sorts by it.
      store.save({ ...store.get(item.id), lifecycle: item.to });
      written += 1;
    } catch (error) {
      failed.push({ id: item.id, message: String(error?.message || error) });
    }
  }
  console.log(`\nwritten: ${written}`);
  if (failed.length) {
    console.log(`failed: ${failed.length}`);
    for (const failure of failed.slice(0, 20)) console.log(`  ${failure.id}: ${failure.message}`);
  }
}

main();
