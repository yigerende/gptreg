'use strict';

const bootStartedAt = Date.now();
const { buildApp } = require('./app');

const host = process.env.GPT_RE_UI_HOST || '127.0.0.1';
const port = Number(process.env.GPT_RE_UI_PORT || 3210);
const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);

if (!allowedHosts.has(host)) {
  throw new Error('The local UI only binds to a loopback host');
}

// SMS vendor API calls (SMSBower SMS and mail) go through the local
// forwarders in rotation instead of whatever the machine routes a bare fetch
// through. Configured here, at the real entry point, so tests that build the
// app never send vendor traffic to a port that is not listening.
const { configureProviderApiEgress, providerApiProxiesFromConfig } = require('../provider-api-egress');
const { ConfigService } = require('./config-service');

const egressConfig = new ConfigService({
  cwd: process.cwd(),
  configPath: process.env.GPT_RE_CONFIG || 'gpt-re.config.json',
});
let egressProxies = null;
let egressProxiesReadAt = 0;
configureProviderApiEgress({
  resolveProxies: () => {
    // Re-read at most every 10s, so a config edit applies without a restart.
    if (!egressProxies || Date.now() - egressProxiesReadAt > 10_000) {
      try { egressProxies = providerApiProxiesFromConfig(egressConfig.readRaw()); } catch { egressProxies = egressProxies || []; }
      egressProxiesReadAt = Date.now();
    }
    return egressProxies;
  },
});

const app = buildApp({
  cwd: process.cwd(),
  configPath: process.env.GPT_RE_CONFIG || 'gpt-re.config.json',
  harPath: process.env.GPT_RE_HAR || '',
  logger: process.env.GPT_RE_UI_LOG === '1',
  // Open the port first; history retention runs once the console is up.
  deferBootMaintenance: true,
});

// Long enough for the first page load to finish before the retention pass
// (which blocks while it walks the store) takes its turn.
const configuredDelayMs = Number(process.env.GPT_RE_BOOT_MAINTENANCE_DELAY_MS);
const bootMaintenanceDelayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0 ? configuredDelayMs : 30_000;

app.listen({ host, port }).then((address) => {
  process.stdout.write(`GPT-RE console API listening at ${address} (boot ${Date.now() - bootStartedAt} ms)\n`);
  const timer = setTimeout(() => {
    const started = Date.now();
    const result = app.services.runManager.runBootMaintenance?.();
    if (result) process.stdout.write(`GPT-RE boot maintenance finished in ${Date.now() - started} ms\n`);
  }, bootMaintenanceDelayMs);
  timer.unref();
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  // Without a port the console is unreachable; exit instead of lingering on
  // background timers so the launcher can report the failure right away.
  app.close().catch(() => {}).finally(() => process.exit(1));
});

async function shutdown() {
  try { await app.close(); } finally { process.exit(0); }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
