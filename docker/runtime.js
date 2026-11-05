'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeNew(file, value) {
  try { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function initializeRuntime(cwd) {
  const directory = path.join(cwd, '.runtime');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'gpt-re.config.json');
  if (!fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'gpt-re.config.example.json'), 'utf8'));
    function clearPlaceholders(value) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /^YOUR_/.test(item)) value[key] = '';
        else if (item && typeof item === 'object') clearPlaceholders(item);
      }
    }
    clearPlaceholders(config);
    config.output = { ...config.output, stateDir: '.runtime/state/v2', cpaDir: '.runtime/state/v2/output' };
    config.proxyPool = {
      ...config.proxyPool, path: '.runtime/proxy-pool.txt', catalogPath: '.runtime/dynamic-proxy-pools.json',
      apiRequestProxy: '', maintenanceProxy: '', providerApiProxies: [],
    };
    writeNew(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  writeNew(path.join(directory, 'proxy-pool.txt'), '# Configure proxies in the console.\n');
  writeNew(path.join(directory, 'dynamic-proxy-pools.json'), '{"schemaVersion":1,"countryPools":{}}\n');
  const authPath = path.join(directory, 'console-auth.json');
  writeNew(authPath, `${JSON.stringify({ username: 'admin', password: crypto.randomBytes(24).toString('base64url') }, null, 2)}\n`);
  const credentials = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (!credentials.username || typeof credentials.password !== 'string' || credentials.password.length < 16) {
    throw new Error('Set a console password of at least 16 characters in .runtime/console-auth.json');
  }
  return { configPath, credentials };
}

function installAccessControl(app, credentials) {
  const expected = crypto.createHash('sha256').update(`${credentials.username}:${credentials.password}`).digest();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz' && ['GET', 'HEAD'].includes(request.method)) return;
    const header = request.headers.authorization || '';
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    const actual = crypto.createHash('sha256').update(match ? Buffer.from(match[1], 'base64') : '').digest();
    if (!match || !crypto.timingSafeEqual(expected, actual)) {
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="gptreg", charset="UTF-8"')
        .header('Cache-Control', 'no-store').send({ error: 'Authentication required' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
      let originHost;
      try { originHost = new URL(request.headers.origin).host; } catch { originHost = ''; }
      if (originHost !== request.headers.host) return reply.code(403).send({ error: 'Origin rejected' });
    }
  });
  app.get('/healthz', async () => ({ ok: true }));
}

module.exports = { initializeRuntime, installAccessControl };
