'use strict';

const fs = require('node:fs');
const { atomicWriteText } = require('./ui-server/utils');

// One engine owns proxy allocation. Keep usage outside the refreshed catalog:
// pulling or deleting/re-importing the same connection must not reset its history.
class ProxyUsage {
  constructor(file, { now = Date.now, sessionMinutesFor = entry => entry.sessionMinutes } = {}) {
    this.file = file;
    this.now = now;
    this.sessionMinutesFor = sessionMinutesFor;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('Invalid proxy usage file');
      this.entries = saved.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.entries = {};
    }
  }

  write(entries) {
    atomicWriteText(this.file, JSON.stringify({ version: 1, entries }) + '\n');
    this.entries = entries;
  }

  get(id) {
    const row = this.entries[id];
    return { lastUsedAt: row?.lastUsedAt || '', releasedAt: row?.releasedAt || '', cooldownUntil: row?.cooldownUntil || '',
      inUse: Boolean(row?.inUse), cooling: Boolean(row?.cooldownUntil && Date.parse(row.cooldownUntil) > this.now()) };
  }

  isCooling(id) { return this.get(id).cooling; }

  begin(entry) {
    if (!entry?.id) return;
    const minutes = Number(this.sessionMinutesFor(entry) ?? this.entries[entry.id]?.sessionMinutes);
    const sessionMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    this.write({ ...this.entries, [entry.id]: { lastUsedAt: new Date(this.now()).toISOString(), releasedAt: '', cooldownUntil: '', sessionMinutes, inUse: true } });
  }

  release(id) {
    const previous = this.entries[id];
    if (!previous?.inUse) return;
    const now = this.now();
    this.write({ ...this.entries, [id]: { ...previous, inUse: false, releasedAt: new Date(now).toISOString(),
      cooldownUntil: previous.sessionMinutes > 0 ? new Date(now + previous.sessionMinutes * 60000).toISOString() : '' } });
  }

  recover() {
    // A crashed engine cannot keep a connection in use forever. Conservatively
    // start a full cooldown at recovery; checkpoint resume may retain its binding.
    const now = this.now(), entries = { ...this.entries };
    let changed = false;
    for (const [id, row] of Object.entries(entries)) if (row.inUse) {
      entries[id] = { ...row, inUse: false, releasedAt: new Date(now).toISOString(),
        cooldownUntil: row.sessionMinutes > 0 ? new Date(now + row.sessionMinutes * 60000).toISOString() : '' };
      changed = true;
    }
    if (changed) this.write(entries);
  }
}

// Caller excludes occupied/failed entries first. Cold entries are a fallback
// only when every remaining candidate is cooling; never override occupancy.
function preferUncooled(entries, usage) {
  const ready = entries.filter(entry => !usage?.isCooling(entry.id));
  return ready.length ? ready : entries;
}

module.exports = { ProxyUsage, preferUncooled };
