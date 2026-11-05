'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveInside, safeRunId, sanitizeValue, scrubString } = require('./utils');

// A task log is reset when it reaches this many records. Keeping the threshold
// explicit prevents a long-running task from retaining an unbounded history.
const MAX_LOG_RECORDS = 10000;
// What a caller that asks for no limit gets. Deliberately smaller than the
// reset threshold: a broad read should not silently turn into a multi-megabyte
// response. (The console asks for 2000.)
const DEFAULT_READ_RECORDS = 3000;
// A conservative estimate used to size a bounded tail read.
const BYTES_PER_RECORD_ESTIMATE = 512;
// Ceilings for the log directory as a whole.
//
// Per-task resets bound one run's log; nothing bounded the directory. Its only
// ceiling was indirect — the run-retention cap times the per-run cap, so roughly
// 140 MB had to accumulate before anything was deleted, and only when a run
// happened to reach a terminal state. These two caps make the floor explicit
// and independent of whether any task finishes.
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 14;
// Sweeping reads the whole directory, so it is not done per append.
const SWEEP_MIN_INTERVAL_MS = 60_000;

class LogStore {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.stateDir = options.stateDir || (() => path.resolve(this.cwd, '.gpt-re-state/v2'));
    this.sequences = new Map();
    this.recordCounts = new Map();
    this.subscribers = new Map();
    this.ensuredDirectory = '';
    this.maxTotalBytes = Number.isFinite(Number(options.maxTotalBytes))
      ? Math.max(0, Number(options.maxTotalBytes))
      : DEFAULT_MAX_TOTAL_BYTES;
    this.maxAgeDays = Number.isFinite(Number(options.maxAgeDays))
      ? Math.max(0, Number(options.maxAgeDays))
      : DEFAULT_MAX_AGE_DAYS;
    this.now = options.now || Date.now;
    this.lastSweepAt = 0;
  }

  /**
   * Delete whole run logs that are too old, then the oldest ones until the
   * directory fits.
   *
   * Deliberately coarse: it removes a run's log or leaves it alone, rather than
   * trimming inside files, so a log is either intact or gone. Age is applied
   * first because a stale log is worthless regardless of how much room is left.
   *
   * `protect` keeps the logs of runs that are still live — nothing should be
   * able to delete the log of a task that is currently writing to it.
   */
  sweep(options = {}) {
    const directory = this.directory();
    let names = [];
    try { names = fs.readdirSync(directory); } catch { return { removed: [], bytesFreed: 0 }; }
    const protectedIds = new Set((options.protect || []).map((runId) => String(runId || '')));
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const runId = name.slice(0, -'.jsonl'.length);
      if (protectedIds.has(runId)) continue;
      try {
        const stats = fs.statSync(path.join(directory, name));
        if (stats.isFile()) files.push({ runId, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch { /* Vanished between readdir and stat; nothing to reclaim. */ }
    }
    const removed = [];
    let bytesFreed = 0;
    const drop = (file) => {
      this.remove(file.runId);
      removed.push(file.runId);
      bytesFreed += file.size;
    };

    const maxAgeMs = this.maxAgeDays * 86_400_000;
    const cutoff = maxAgeMs > 0 ? this.now() - maxAgeMs : 0;
    const survivors = [];
    for (const file of files) {
      if (cutoff && file.mtimeMs < cutoff) drop(file);
      else survivors.push(file);
    }

    if (this.maxTotalBytes > 0) {
      let total = survivors.reduce((sum, file) => sum + file.size, 0);
      // Oldest first: the newest logs are the ones anyone is still reading.
      survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const file of survivors) {
        if (total <= this.maxTotalBytes) break;
        drop(file);
        total -= file.size;
      }
    }
    this.lastSweepAt = this.now();
    return { removed, bytesFreed };
  }

  /** Sweep at most once a minute, and never from the hot path of an append. */
  sweepThrottled(options = {}) {
    if (this.now() - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return null;
    try { return this.sweep(options); } catch { return null; }
  }

  directory() {
    const stateDir = typeof this.stateDir === 'function' ? this.stateDir() : this.stateDir;
    const resolved = resolveInside(this.cwd, stateDir);
    return path.join(resolved, 'logs');
  }

  filePath(runId) {
    return path.join(this.directory(), `${safeRunId(runId)}.jsonl`);
  }

  /** Parses JSONL text, skipping torn or otherwise invalid lines. */
  static parseLines(text) {
    const records = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch {
        // A torn line is debris, not a reason to lose the rest of the log.
      }
    }
    return records;
  }

  load(runId) {
    try {
      return LogStore.parseLines(fs.readFileSync(this.filePath(runId), 'utf8')).slice(-MAX_LOG_RECORDS);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Reads roughly the last `limit` records without parsing the whole file. */
  loadTail(runId, limit) {
    return this.loadTailFromPath(this.filePath(runId), limit);
  }

  loadTailFromPath(filePath, limit) {
    let handle;
    try {
      handle = fs.openSync(filePath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const size = fs.fstatSync(handle).size;
      const target = Math.max(1, Number(limit) || 1);
      let window = Math.min(size, Math.max(16 * 1024, target * BYTES_PER_RECORD_ESTIMATE));
      for (;;) {
        const start = size - window;
        const buffer = Buffer.alloc(window);
        fs.readSync(handle, buffer, 0, window, start);
        let text = buffer.toString('utf8');
        if (start > 0) text = text.slice(text.indexOf('\n') + 1);
        const records = LogStore.parseLines(text);
        if (records.length >= target || start <= 0) return records;
        window = Math.min(size, window * 4);
      }
    } finally {
      fs.closeSync(handle);
    }
  }

  nextSequence(runId) {
    if (!this.sequences.has(runId)) {
      const filePath = this.filePath(runId);
      const last = this.loadTail(runId, 1).at(-1)
        || this.loadTailFromPath(`${filePath}.1`, 1).at(-1);
      this.sequences.set(runId, Number(last?.seq || 0));
    }
    const next = Number(this.sequences.get(runId) || 0) + 1;
    this.sequences.set(runId, next);
    return next;
  }

  recordCount(runId) {
    if (this.recordCounts.has(runId)) return this.recordCounts.get(runId);
    const records = this.loadTail(runId, MAX_LOG_RECORDS + 1);
    const count = Math.min(records.length, MAX_LOG_RECORDS + 1);
    this.recordCounts.set(runId, count);
    return count;
  }

  append(runId, input = {}) {
    const currentCount = this.recordCount(runId);
    const record = sanitizeValue({
      seq: this.nextSequence(runId),
      at: input.at || new Date().toISOString(),
      level: input.level || 'info',
      source: input.source || 'ui-server',
      type: input.type || 'event',
      runId,
      workerId: input.workerId || '',
      jobId: input.jobId || '',
      message: scrubString(input.message || input.type || 'event', { redactPii: false }),
      details: input.details || {},
    }, { redactPii: false });

    // Clear the old history at the threshold, then keep the event that caused
    // the reset so the live stream and the next disk read remain consistent.
    // Allocate the sequence before clearing because clear intentionally keeps
    // sequence continuity across a reset.
    let clearedAtThreshold = false;
    if (currentCount + 1 >= MAX_LOG_RECORDS) {
      try {
        this.clear(runId);
        clearedAtThreshold = true;
      } catch {
        // Log maintenance must not turn a successful task event into a failed
        // task. A later append will retry the reset.
      }
    }
    if (clearedAtThreshold) record.logReset = true;

    const directory = this.directory();
    if (this.ensuredDirectory !== directory) {
      fs.mkdirSync(directory, { recursive: true });
      this.ensuredDirectory = directory;
    }
    const filePath = path.join(directory, `${safeRunId(runId)}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });

    const nextCount = clearedAtThreshold ? 1 : currentCount + 1;
    this.recordCounts.set(runId, nextCount);
    this.cleanupLegacyRotation(filePath);
    // The run being appended to is exempt, so a burst of events can never
    // delete the log it is writing.
    this.sweepThrottled({ protect: [runId] });
    for (const subscriber of this.subscribers.get(runId) || []) subscriber(record);
    return record;
  }

  read(runId, options = {}) {
    const requestedSince = Number(options.since);
    const since = Number.isFinite(requestedSince) && requestedSince > 0 ? requestedSince : 0;
    const requestedLimit = Number(options.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_LOG_RECORDS))
      : DEFAULT_READ_RECORDS;
    return this.loadTail(runId, limit)
      .filter((record) => Number(record.seq || 0) > since)
      .slice(-limit)
      .map((record) => options.reveal ? record : sanitizeValue(record, { redactPii: true }));
  }

  /** Empties a run's log while preserving sequence continuity. */
  clear(runId) {
    const filePath = this.filePath(runId);
    let removed = 0;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) removed += 1;
      fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.recordCounts.set(runId, 0);
    this.cleanupLegacyRotation(filePath);
    return { runId, removed };
  }

  cleanupLegacyRotation(filePath) {
    try {
      fs.unlinkSync(`${filePath}.1`);
    } catch (error) {
      // This is cleanup only; a transient Windows lock must not interrupt a
      // worker event.
      if (error.code !== 'ENOENT') return false;
    }
    return true;
  }

  subscribe(runId, listener) {
    const subscribers = this.subscribers.get(runId) || new Set();
    subscribers.add(listener);
    this.subscribers.set(runId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.subscribers.delete(runId);
    };
  }

  remove(runId) {
    const filePath = this.filePath(runId);
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.cleanupLegacyRotation(filePath);
    this.sequences.delete(runId);
    this.recordCounts.delete(runId);
  }
}

module.exports = { LogStore, MAX_LOG_RECORDS };
