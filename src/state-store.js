'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const runtimeSecrets = require('./platform/runtime-secrets');

const STATE_SCHEMA_VERSION = 2;
const STATE_SAVE_RETRY_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'EEXIST', 'ENOTEMPTY']);
const STATE_SAVE_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800, 1200]);
const stateSaveTails = new Map();
let stateWriter = null;
let stateWriteSequence = 0;

class StateStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    if (options.code) this.code = options.code;
    if (options.filePath) this.filePath = options.filePath;
  }
}

class StateVersionError extends StateStoreError {
  constructor(filePath, foundVersion) {
    const shown = foundVersion === undefined ? '<missing>' : JSON.stringify(foundVersion);
    super(`Refusing non-v2 state at ${filePath}: schemaVersion is ${shown}`, {
      code: 'ESTATEVERSION',
      filePath,
    });
    this.expectedVersion = STATE_SCHEMA_VERSION;
    this.foundVersion = foundVersion;
    this.readOnly = true;
  }
}

class StateValidationError extends StateStoreError {
  constructor(filePath, issues) {
    super(`Invalid v2 state at ${filePath}: ${issues.join('; ')}`, {
      code: 'ESTATEVALIDATION',
      filePath,
    });
    this.issues = issues;
    this.readOnly = true;
  }
}

class StateCorruptionError extends StateStoreError {
  constructor(filePath, cause) {
    super(`Unable to read v2 state or backup at ${filePath}: ${cause.message}`, {
      code: 'ESTATECORRUPT',
      filePath,
      cause,
    });
  }
}

class StateLockError extends StateStoreError {
  constructor(lockPath, owner, cause) {
    const detail = owner?.pid ? ` (held by pid ${owner.pid})` : '';
    super(`State lock is already held at ${lockPath}${detail}`, {
      code: 'ELOCKED',
      filePath: lockPath,
      cause,
    });
    this.owner = owner || null;
    // A live lock is a conflict the operator can act on, not an internal
    // fault. Without this the console only ever said "the local API could not
    // complete the request", which named neither the lock nor its owner.
    this.statusCode = 409;
  }
}

class StateLockOwnershipError extends StateStoreError {
  constructor(lockPath) {
    super(`State lock ownership changed before release: ${lockPath}`, {
      code: 'ELOCKOWNERSHIP',
      filePath: lockPath,
    });
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hydrateV2State(state) {
  return {
    ...state,
    phase: state.phase === undefined ? 'normal' : state.phase,
    workers: state.workers === undefined ? [] : state.workers,
    proxyHealth: state.proxyHealth === undefined ? {} : state.proxyHealth,
    proxyCandidates: state.proxyCandidates === undefined ? [] : state.proxyCandidates,
    finalizationQueue: state.finalizationQueue === undefined ? [] : state.finalizationQueue,
  };
}

function validateV2State(state, options = {}) {
  const filePath = path.resolve(options.filePath || '<memory>');
  if (!isPlainObject(state)) {
    throw new StateValidationError(filePath, ['state must be a JSON object']);
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StateVersionError(filePath, state.schemaVersion);
  }

  const issues = [];
  if (typeof state.runId !== 'string' || state.runId.trim() === '') {
    issues.push('runId must be a non-empty string');
  }
  if (state.mode !== 'gpt-re-orchestrator-v2') {
    issues.push('mode must be "gpt-re-orchestrator-v2"');
  }
  if (typeof state.status !== 'string' || state.status.trim() === '') {
    issues.push('status must be a non-empty string');
  }
  if (state.phase !== undefined && (typeof state.phase !== 'string' || state.phase.trim() === '')) {
    issues.push('phase must be a non-empty string when present');
  }
  for (const key of ['mailboxes', 'jobs', 'events']) {
    if (!Array.isArray(state[key])) {
      issues.push(`${key} must be an array`);
    }
  }
  for (const key of ['workers', 'proxyCandidates', 'finalizationQueue']) {
    if (state[key] !== undefined && !Array.isArray(state[key])) {
      issues.push(`${key} must be an array when present`);
    }
  }
  for (const key of ['proxyLeases', 'smsMarkets']) {
    if (!isPlainObject(state[key])) issues.push(`${key} must be an object`);
  }
  if (state.proxyHealth !== undefined && !isPlainObject(state.proxyHealth)) {
    issues.push('proxyHealth must be an object when present');
  }
  if (state.control !== undefined && !isPlainObject(state.control)) {
    issues.push('control must be an object when present');
  }
  if (state.runPlan !== undefined && !isPlainObject(state.runPlan)) {
    issues.push('runPlan must be an object when present');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(state.configFingerprint || ''))) {
    issues.push('configFingerprint must be a SHA-256 hex digest');
  }
  if (issues.length) throw new StateValidationError(filePath, issues);
  return hydrateV2State(state);
}

function parseStateText(text, filePath) {
  let value;
  try {
    value = runtimeSecrets.parse(text);
  } catch (cause) {
    const error = new SyntaxError(`Invalid JSON in state file ${filePath}: ${cause.message}`, { cause });
    error.code = 'ESTATEJSON';
    error.filePath = filePath;
    throw error;
  }
  return validateV2State(value, { filePath });
}

function readOneState(filePath) {
  return parseStateText(fs.readFileSync(filePath, 'utf8'), filePath);
}

function loadV2State(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  try {
    return readOneState(resolved);
  } catch (primaryError) {
    if (primaryError instanceof StateVersionError) throw primaryError;
    const backupPath = `${resolved}.bak`;
    try {
      const recovered = readOneState(backupPath);
      if (typeof options.onRecovery === 'function') {
        options.onRecovery({ filePath: resolved, backupPath, error: primaryError });
      }
      return recovered;
    } catch (backupError) {
      if (backupError instanceof StateVersionError) throw backupError;
      if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') throw primaryError;
      const cause = new AggregateError([primaryError, backupError], 'Primary and backup state are unreadable');
      throw new StateCorruptionError(resolved, cause);
    }
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EBADF', 'EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeSyncedFile(filePath, content) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function temporaryPathFor(filePath, label = 'tmp') {
  return `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.${label}`;
}

function replaceByRename(source, target) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    if (!['EACCES', 'EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(target)) throw error;
  }

  const displaced = temporaryPathFor(target, 'replaced');
  fs.renameSync(target, displaced);
  try {
    fs.renameSync(source, target);
    fs.unlinkSync(displaced);
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(displaced)) fs.renameSync(displaced, target);
    throw error;
  }
}

// Paths this process has already confirmed hold a v2 state.
const verifiedV2Paths = new Set();

/**
 * Whether the file already on disk is a v2 state worth rotating into `.bak`.
 *
 * The version guard here is what stops a v2 run from overwriting a v1 state
 * file, so it cannot go — but it used to read and `JSON.parse` the entire
 * existing state on *every* checkpoint, which at twenty Workers was the single
 * most wasted work in the process. A path can only change lineage once, so the
 * parse now happens on the first save to a given path and never again: after
 * this process has written it, the file is v2 by construction, and the primary
 * is only ever replaced by an atomic rename of an fsync'd temporary, so a
 * non-empty file is a complete earlier state.
 */
function inspectExistingV2(filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, valid: false, error };
    throw error;
  }
  if (!stats.isFile() || stats.size === 0) return { exists: true, valid: false };
  if (verifiedV2Paths.has(filePath)) return { exists: true, valid: true };
  try {
    parseStateText(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (error) {
    if (error instanceof StateVersionError || error instanceof StateValidationError) throw error;
    return { exists: true, valid: false, error };
  }
  verifiedV2Paths.add(filePath);
  return { exists: true, valid: true };
}

function saveV2State(filePath, state) {
  const resolved = path.resolve(filePath);
  // Validate before creating directories or touching an existing state file.
  const hydratedState = validateV2State(state, { filePath: resolved });
  const existing = inspectExistingV2(resolved);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });

  const temporaryPath = temporaryPathFor(resolved);
  // Compact, not pretty-printed. Nothing reads this by eye, and the indentation
  // was about a third of the bytes serialized, written, fsync'd and re-parsed
  // on every checkpoint of every Worker.
  const content = `${JSON.stringify(runtimeSecrets.protect(hydratedState))}\n`;
  writeSyncedFile(temporaryPath, content);

  const backupPath = `${resolved}.bak`;
  let primaryMovedToBackup = false;
  try {
    if (existing.valid) {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(resolved, backupPath);
      primaryMovedToBackup = true;
    }
    replaceByRename(temporaryPath, resolved);
    fsyncDirectory(directory);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    if (primaryMovedToBackup && !fs.existsSync(resolved) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, resolved);
    }
    throw error;
  }
  // Written by this process, so later saves can skip the version probe.
  verifiedV2Paths.add(resolved);
  return resolved;
}

function isRetryableStateSaveError(error) {
  return STATE_SAVE_RETRY_CODES.has(String(error?.code || '').toUpperCase());
}

function restoreStateWriteError(details) {
  const error = details.code === 'ESTATEVERSION'
    ? new StateVersionError(details.filePath, details.foundVersion)
    : details.code === 'ESTATEVALIDATION'
      ? new StateValidationError(details.filePath, details.issues)
      : new Error(details.message);
  return Object.assign(error, details);
}

function backgroundStateWriter() {
  if (stateWriter) return stateWriter;
  // Reuse the synchronous atomic writer off the event loop. Its validation,
  // fsync, Windows rename fallback and backup recovery remain one code path.
  const worker = new Worker(path.join(__dirname, 'state-save-worker.js'));
  const writer = { worker, pending: new Map() };
  stateWriter = writer;
  const failed = (error) => {
    if (stateWriter === writer) stateWriter = null;
    for (const request of writer.pending.values()) request.reject(error);
    writer.pending.clear();
    worker.unref();
  };
  worker.on('message', ({ id, result, error }) => {
    const request = writer.pending.get(id);
    if (!request) return;
    writer.pending.delete(id);
    if (error) request.reject(restoreStateWriteError(error));
    else request.resolve(result);
    if (!writer.pending.size) worker.unref();
  });
  worker.once('error', failed);
  worker.once('exit', (code) => failed(Object.assign(
    new Error(`State writer exited before completing its writes (code ${code})`),
    { code: 'ESTATEWRITEREXIT' },
  )));
  // An idle writer must not keep a CLI or a test process alive.
  worker.unref();
  return writer;
}

function saveV2StateInBackground(filePath, state) {
  const writer = backgroundStateWriter();
  const id = ++stateWriteSequence;
  return new Promise((resolve, reject) => {
    writer.pending.set(id, { resolve, reject });
    writer.worker.ref();
    try {
      // postMessage snapshots the state before returning. Later mutations are
      // persisted by the next queued checkpoint, never mixed into this write.
      writer.worker.postMessage({ id, filePath, state });
    } catch (error) {
      writer.pending.delete(id);
      if (!writer.pending.size) writer.worker.unref();
      reject(error);
    }
  });
}

/**
 * Windows can briefly hold the state or backup file while an antivirus scan,
 * indexer, or another reader is closing its handle. A transient sharing error
 * must not turn a live registration run into a terminal failure, so the caller
 * gets a bounded async retry window before the original error is surfaced.
 */
async function saveV2StateWithRetryOnce(filePath, state, options = {}) {
  const save = options.save || saveV2StateInBackground;
  const delays = Array.isArray(options.delaysMs)
    ? options.delaysMs.map((value) => Math.max(0, Number(value) || 0))
    : STATE_SAVE_RETRY_DELAYS_MS;
  const wait = options.wait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await save(filePath, state);
    } catch (error) {
      if (!isRetryableStateSaveError(error) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

async function saveV2StateWithRetry(filePath, state, options = {}) {
  const resolved = path.resolve(filePath);
  const previous = stateSaveTails.get(resolved) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => saveV2StateWithRetryOnce(filePath, state, options));
  stateSaveTails.set(resolved, current);
  try {
    return await current;
  } finally {
    if (stateSaveTails.get(resolved) === current) stateSaveTails.delete(resolved);
  }
}

const SECRET_KEY_PATTERN = /(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token$|tokens$|authorization|cookie|credential|private[_-]?key)/i;
const SECRET_QUERY_PATTERN = /^(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)$/i;
// Keys dropped before fingerprinting: things that may legitimately change
// between runs without altering the account, mailbox, proxy, or protocol
// contract a checkpoint captured. `securityRequestTimeoutMs` is transport
// tuning; `chain` is the standalone PayPal-link extractor config, which shares
// the config file but is never part of a registration/oauth run — including it
// would make adding or editing chain settings invalidate every open checkpoint.
const RUNTIME_TUNING_KEYS = new Set([
  'retryPolicy',
  'sendRetryLimit',
  'oauthCodeTimeoutMs',
  'authRequestTimeoutMs',
  'securityRequestTimeoutMs',
  'chain',
  'maintenanceProxy',
  // Alias policy affects fresh preflight, but a parked task can safely rebuild
  // its proxy/mail snapshot when the operator edits it while recovering a
  // transport failure. Provider settings are intentionally treated as one
  // runtime-tuning block so Mail.com and Fastmail never invalidate each
  // other's parked checkpoints.
  'providerSettings',
  'aliasBatchSize',
  'aliasDomainMode',
  'aliasDomains',
]);

function isSecretConfigKey(key) {
  const value = String(key || '');
  if (/(?:env|environment|envname)$/i.test(value)) return false;
  return SECRET_KEY_PATTERN.test(value);
}

function sanitizeUrlString(value) {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '<secret>';
    if (parsed.password) parsed.password = '<secret>';
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_QUERY_PATTERN.test(key)) parsed.searchParams.set(key, '<secret>');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizeConfigForFingerprint(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeConfigForFingerprint(item));
  if (!isPlainObject(value)) {
    return typeof value === 'string' ? sanitizeUrlString(value) : value;
  }

  const sanitized = {};
  for (const key of Object.keys(value).sort()) {
    if (RUNTIME_TUNING_KEYS.has(key)) continue;
    sanitized[key] = isSecretConfigKey(key)
      ? '<secret>'
      : sanitizeConfigForFingerprint(value[key]);
  }
  return sanitized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function configFingerprint(config) {
  const sanitized = sanitizeConfigForFingerprint(config || {});
  return crypto.createHash('sha256').update(stableJson(sanitized)).digest('hex');
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether the process that wrote a lock is still running.
 *
 * `kill(pid, 0)` sends no signal and only asks. EPERM means it exists under
 * another user, which still counts as alive; ESRCH means it is gone.
 */
function lockOwnerAlive(owner) {
  const pid = Number(owner?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // Only this host's PIDs are ours to judge. A lock from another machine is
  // opaque and must be left alone.
  if (String(owner?.hostname || '') !== os.hostname()) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function acquireExclusiveLock(lockPath, metadata = {}) {
  const resolved = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const token = crypto.randomUUID();
  const owner = {
    ...metadata,
    lockVersion: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  let fd;
  let reclaimed = null;
  try {
    fd = fs.openSync(resolved, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } catch (cause) {
    if (fd !== undefined) fs.closeSync(fd);
    if (cause.code === 'EEXIST') {
      // A run that was killed — a crash, or the console being restarted while
      // it was working — leaves its lock behind forever, and every resume and
      // cancel afterwards fails with an opaque 500. If the owning process is
      // demonstrably gone from this machine, the lock is debris: take it.
      const previous = readLockOwner(resolved);
      if (!lockOwnerAlive(previous)) {
        try {
          fs.unlinkSync(resolved);
          const retry = fs.openSync(resolved, 'wx', 0o600);
          fs.writeFileSync(retry, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
          fs.fsyncSync(retry);
          fs.closeSync(retry);
          reclaimed = previous;
        } catch {
          throw new StateLockError(resolved, readLockOwner(resolved), cause);
        }
      } else {
        throw new StateLockError(resolved, previous, cause);
      }
    }
    if (!reclaimed) {
      try {
        if (fs.existsSync(resolved) && readLockOwner(resolved)?.token === token) fs.unlinkSync(resolved);
      } catch {
        // Preserve the original acquisition error.
      }
      throw cause;
    }
  }
  if (fd !== undefined && !reclaimed) fs.closeSync(fd);

  let released = false;
  return {
    path: resolved,
    metadata: owner,
    /** Set when this lock replaced debris left by a dead process. */
    reclaimedFrom: reclaimed,
    release() {
      if (released) return false;
      const current = readLockOwner(resolved);
      if (!current) {
        if (fs.existsSync(resolved)) throw new StateLockOwnershipError(resolved);
        released = true;
        return false;
      }
      if (current.token !== token) throw new StateLockOwnershipError(resolved);
      fs.unlinkSync(resolved);
      fsyncDirectory(path.dirname(resolved));
      released = true;
      return true;
    },
  };
}

function acquireStateLock(stateFilePath, metadata = {}) {
  return acquireExclusiveLock(`${path.resolve(stateFilePath)}.lock`, metadata);
}

module.exports = {
  StateLockError,
  StateVersionError,
  acquireExclusiveLock,
  acquireStateLock,
  configFingerprint,
  loadV2State,
  sanitizeConfigForFingerprint,
  saveV2State,
  saveV2StateWithRetry,
  validateV2State,
};
