'use strict';

const { initializeRuntime, installAccessControl } = require('./runtime');
const { buildApp } = require('../src/ui-server/app');
const { ConfigService } = require('../src/ui-server/config-service');
const { configureProviderApiEgress, providerApiProxiesFromConfig } = require('../src/provider-api-egress');

const cwd = process.cwd();
const { configPath, credentials } = initializeRuntime(cwd);
const configService = new ConfigService({ cwd, configPath });
configureProviderApiEgress({ resolveProxies: () => providerApiProxiesFromConfig(configService.readRaw()) });
const app = buildApp({ cwd, configPath, deferBootMaintenance: true });
installAccessControl(app, credentials);

app.listen({ host: '0.0.0.0', port: 3210 }).then(() => {
  console.log('gptreg listening on port 3210; console authentication enabled');
  const timer = setTimeout(() => app.services.runManager.runBootMaintenance?.(), 30_000);
  timer.unref();
}).catch(async (error) => {
  console.error(error.message);
  await app.close();
  process.exitCode = 1;
});

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
