'use strict';

const { pagination, pageRows } = require('./pagination');
const { HttpError } = require('./utils');

const text = (value) => typeof value === 'string' ? value : '';
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Explicit projection: assets also contain passwords, cookies and proxy credentials.
// None of those belong in the device inventory response, including its details.
function deviceRow(asset, archived) {
  const profile = asset.clientProfile || {};
  const dimensions = (value = {}) => Object.fromEntries(
    ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth',
      'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio']
      .filter(key => number(value?.[key]) !== null).map(key => [key, value[key]]),
  );
  return {
    id: text(asset.id), email: text(asset.email), archived,
    lifecycle: text(asset.lifecycle || asset.classification), status: text(asset.status),
    createdAt: text(asset.createdAt), sourceRunId: text(asset.sourceRunId),
    fingerprint: text(asset.clientProfileFingerprint), deviceId: text(asset.oaiDid),
    countryCode: text(asset.sourceProxy?.countryCode),
    profile: {
      schemaVersion: number(profile.schemaVersion), browser: text(profile.browser),
      browserVersion: text(profile.browserVersion), userAgent: text(profile.userAgent),
      platform: text(profile.platform), oscpu: text(profile.oscpu),
      language: text(profile.language), languages: Array.isArray(profile.languages) ? profile.languages.filter(v => typeof v === 'string') : [],
      acceptLanguage: text(profile.acceptLanguage), timeZone: text(profile.timeZone),
      hardwareConcurrency: number(profile.hardwareConcurrency), maxTouchPoints: number(profile.maxTouchPoints),
      storageQuotaBytes: number(profile.storageQuotaBytes), screen: dimensions(profile.screen),
      viewport: dimensions(profile.viewport),
      gpu: { vendor: text(profile.gpu?.vendor), renderer: text(profile.gpu?.renderer) },
    },
  };
}

function deviceFingerprintPage(store, query = {}) {
  pagination(query);
  const match = query.match || 'all';
  if (!['all', 'fingerprint', 'device', 'missing'].includes(match)) throw new HttpError(400, 'Invalid device filter');
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 256)) throw new HttpError(400, 'Search must be at most 256 characters');
  const search = String(query.q || '').trim().toLowerCase();
  const rows = [], ids = new Set();
  // Keep sold/archived accounts in the audit. The live copy takes precedence.
  for (const [files, archived] of [[store.files(), false], [store.archivedFiles(), true]]) {
    for (const file of files) {
      const asset = store.readAssetForListing(file);
      if (!asset?.id || ids.has(asset.id)) continue;
      ids.add(asset.id);
      rows.push(deviceRow(asset, archived));
    }
  }
  const fingerprints = new Map(), devices = new Map();
  for (const row of rows) {
    const account = row.email.trim().toLowerCase() || row.id;
    for (const [index, value] of [[fingerprints, row.fingerprint], [devices, row.deviceId]]) {
      if (!value) continue;
      if (!index.has(value)) index.set(value, new Set());
      index.get(value).add(account);
    }
  }
  for (const row of rows) {
    row.fingerprintAccounts = fingerprints.get(row.fingerprint)?.size || 0;
    row.deviceAccounts = devices.get(row.deviceId)?.size || 0;
  }
  const duplicateAccounts = (index) => new Set([...index.values()].filter(accounts => accounts.size > 1).flatMap(accounts => [...accounts])).size;
  const summary = {
    total: rows.length, uniqueFingerprints: fingerprints.size, uniqueDeviceIds: devices.size,
    duplicateFingerprintGroups: [...fingerprints.values()].filter(accounts => accounts.size > 1).length,
    duplicateFingerprintAccounts: duplicateAccounts(fingerprints),
    duplicateDeviceAccounts: duplicateAccounts(devices),
    missing: rows.filter(row => !row.fingerprint || !row.deviceId).length,
    unreadable: rows.filter(row => row.status === 'corrupt').length,
  };
  const filtered = rows.filter(row => (
    (!search || [row.email, row.id, row.fingerprint, row.deviceId, row.countryCode, row.sourceRunId].some(value => value.toLowerCase().includes(search)))
    && (match === 'all' || (match === 'fingerprint' && row.fingerprintAccounts > 1)
      || (match === 'device' && row.deviceAccounts > 1) || (match === 'missing' && (!row.fingerprint || !row.deviceId)))
  ));
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { ...pageRows(filtered, query), summary };
}

module.exports = { deviceFingerprintPage };
