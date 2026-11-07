'use strict';

const { isIP } = require('node:net');
const { executePureHttpUrl } = require('./pure-url');

function exitIp(value) {
  if (typeof value !== 'string' || !isIP(value.trim())) return '';
  const ip = value.trim();
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

// Old engine-created assets predate registeredAt. Their first save is the only
// historical registration timestamp available; never substitute updatedAt.
function registrationTime(asset) {
  return String(asset?.registeredAt || ((asset?.sourceProxy || asset?.sourceKind === 'register_session') ? asset.createdAt || '' : ''));
}

function proxyAddress(proxy) {
  try {
    const url = new URL(String(proxy?.url || `${proxy?.protocol || 'http'}://${proxy?.endpoint || ''}`));
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return '';
    return `${url.protocol}//${url.host}`;
  } catch { return ''; }
}

// Probe the exact leased connection before registration, with no account
// cookies/headers and no direct fallback. A failed observation is not an IP.
async function probeRegistrationExit(proxy, { executor = executePureHttpUrl, signal, now = () => new Date().toISOString() } = {}) {
  if (!proxy?.url) return { exitIp: '', exitIpCheckedAt: '', exitIpStatus: 'unrecorded' };
  const checkedAt = now();
  try {
    const result = await executor({ index: -2082, method: 'GET', url: 'https://api.ipify.org?format=json',
      headers: { Accept: 'application/json' }, cookies: {}, body: '', contentType: '', expectStatus: 200, redirect: '' },
    { name: 'registration_exit_ip', proxy: proxy.url, timeoutMs: 8000,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    const ip = result.response?.status === 200 ? exitIp(JSON.parse(result.response.text).ip) : '';
    if (ip) return { exitIp: ip, exitIpCheckedAt: checkedAt, exitIpStatus: 'recorded' };
  } catch { /* Do not fail registration or expose a credentialed proxy error. */ }
  return { exitIp: '', exitIpCheckedAt: checkedAt, exitIpStatus: 'failed' };
}

module.exports = { exitIp, registrationTime, proxyAddress, probeRegistrationExit };
