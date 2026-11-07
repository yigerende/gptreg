'use strict';
// Run against an empty, isolated tmpfs, with the image root mounted read-only:
// docker run --rm --read-only --network none --tmpfs /app/.runtime:rw,size=16m
//   -e GPTREG_RUNTIME_SMOKE_TEST=1 --entrypoint node IMAGE scripts/check-proxy-runtime.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeRuntime } = require('../docker/runtime');
const { ConfigService } = require('../src/ui-server/config-service');
const { ProxyService } = require('../src/ui-server/proxy-service');
const { ProxyClaims } = require('../src/oauth-proxies');
assert.equal(process.env.GPTREG_RUNTIME_SMOKE_TEST, '1', 'This check requires an isolated runtime');
const cwd = process.cwd(), directory = path.join(cwd, '.runtime');
assert.deepEqual(fs.readdirSync(directory), [], 'Never run this check on existing application data');
const { configPath } = initializeRuntime(cwd);
const create = () => new ProxyService(new ConfigService({ cwd, configPath }));
const service = create(), claims = new ProxyClaims(service.claims, 'runtime-check', service.usage);
const entry = { id: 'runtime-check', sessionMinutes: 10 };
claims.add(entry.id); claims.markUsed(entry);
const file = path.join(directory, 'proxy-usage.json');
assert.equal(service.usage.file, file);
assert.equal(create().usage.get(entry.id).inUse, true);
claims.delete(entry.id);
const reloaded = create();
assert.equal(reloaded.usage.get(entry.id).inUse, false);
assert.equal(reloaded.usage.isCooling(entry.id), true);
claims.add(entry.id); claims.markUsed(entry);
const recovered = create(); recovered.usage.recover();
assert.equal(recovered.usage.get(entry.id).inUse, false);
assert.equal(recovered.usage.isCooling(entry.id), true);
assert.equal(fs.existsSync(path.join(cwd, 'proxy-usage.json')), false);
console.log(JSON.stringify({ passed: true, file, persisted: true, released: true, recovered: true, networkRequests: 0 }));
