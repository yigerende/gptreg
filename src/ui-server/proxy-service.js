'use strict';

const fs = require('node:fs');

const { executePureHttpUrl } = require('../pure-url');
const {
  PROXY_API_LABELS,
  apiBaseUrlOf,
  buildProxyApiUrl,
  emptyProxyCatalog,
  flattenedPoolEntries,
  normalizeProviderSettings,
  providerSettingsSnapshot,
  normalizeProxyApiUrl,
  normalizeProxyCatalog,
  parseDynamicContent,
  proxyApiSourceId,
} = require('../proxy-catalog');
const { parseProxyLine, probeProxy, stableProxyId } = require('../proxy-pool');
const { atomicWriteText, HttpError, mapLimit } = require('./utils');
const { clone } = require('../util/shared');
const { ProxyInventory } = require('./proxy-inventory');
const { IPRoyalCredentials, IPRoyalError, parseIPRoyalResponse, iproyalHttpError } = require('./iproyal');

function parseProxyContent(content, options = {}) {
  const entries = [];
  const errors = [];
  const duplicates = [];
  const seen = new Set();
  String(content || '').split(/\r?\n/).forEach((line, index) => {
    try {
      const entry = parseProxyLine(line, options);
      if (!entry) return;
      if (seen.has(entry.url)) {
        duplicates.push({ line: index + 1, endpoint: entry.url });
        return;
      }
      seen.add(entry.url);
      entries.push({ ...entry, id: stableProxyId(entry.url), line: index + 1 });
    } catch (error) {
      errors.push({ line: index + 1, message: error.message });
    }
  });
  return { entries, errors, duplicates };
}

function poolFor(catalog, countryCode) {
  catalog.countryPools[countryCode] = catalog.countryPools[countryCode] || {
    countryCode,
    manualEntries: [],
    sources: [],
  };
  return catalog.countryPools[countryCode];
}

function sourceInCatalog(catalog, sourceId) {
  for (const pool of Object.values(catalog.countryPools || {})) {
    const source = (pool.sources || []).find((candidate) => candidate.id === sourceId);
    if (source) return { pool, source };
  }
  return null;
}

function countryCodesFromOptions(options = {}) {
  const countryCodes = Array.isArray(options.countryCodes)
    ? options.countryCodes
      .map((countryCode) => String(countryCode || '').trim().toUpperCase())
      .filter(Boolean)
    : [];
  return countryCodes.length ? new Set(countryCodes) : null;
}

class ProxyService {
  constructor(configService, options = {}) {
    this.configService = configService;
    this.fetch = options.fetch || globalThis.fetch;
    this.executor = options.executor || executePureHttpUrl;
    this.checks = new Map();
    this.inventory = new ProxyInventory(this);
    this.iproyal = new IPRoyalCredentials(configService.cwd);
    this.catalogBusy = false;
    this.catalogRefreshFlight = null;
    this.catalogRefreshCountries = null;
    this.catalogRefreshShareable = false;
    this.pendingRetirements = [];
    // Normalized catalog, keyed by the catalog file's mtime and size.
    this.catalogCache = null;
    this.settingsRefresh = null;
    this.settingsRefreshController = null;
    this.settingsRefreshFlight = null;
  }

  async fetchApiSource(url, options = {}) {
    const config = this.configService.readRaw();
    const apiRequestProxy = String(config.proxyPool?.apiRequestProxy || '').trim();
    const method = options.method || 'GET';
    const headers = { Accept: 'text/plain', ...options.headers };
    if (!apiRequestProxy) {
      return this.fetch(url, {
        method,
        redirect: 'manual',
        signal: options.signal,
        headers,
        ...(options.body ? { body: options.body } : {}),
      });
    }
    const result = await this.executor({
      index: -1024,
      method,
      url,
      headers: { ...headers, 'User-Agent': 'gpt-re-proxy-source/0.1' },
      cookies: {},
      body: options.body || '',
      contentType: headers['Content-Type'] || '',
      expectStatus: 200,
      redirect: '',
    }, {
      name: 'proxy_api_source_pull',
      proxy: apiRequestProxy,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const status = Number(result.response?.status || 0);
    const text = String(result.response?.text || '');
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }

  readText() {
    const filePath = this.configService.proxyFilePath();
    try { return fs.readFileSync(filePath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }

  /**
   * The normalized catalog, re-normalized only when the file changes.
   *
   * `normalizeProxyCatalog` re-derives a SHA-256 id and re-parses a URL for
   * every entry in the file. On the real catalog — a few thousand endpoints —
   * that is tens of milliseconds of blocking CPU, and it was being paid on
   * every read: the chains page polls four times a minute and each poll went
   * through it twice, for two integers per pool.
   *
   * The returned object is shared. `readCatalog` hands out a copy for callers
   * that edit; everything internal here only reads.
   */
  catalogSnapshot() {
    let stats = null;
    const filePath = this.configService.proxyCatalogPath();
    try {
      stats = fs.statSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.catalogCache = null;
      return emptyProxyCatalog();
    }
    const cached = this.catalogCache;
    if (cached && cached.path === filePath && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.catalog;
    }
    let catalog;
    try {
      catalog = normalizeProxyCatalog(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyProxyCatalog();
      if (error instanceof SyntaxError) throw new HttpError(500, 'Dynamic proxy catalog is not valid JSON');
      throw error;
    }
    this.catalogCache = { path: filePath, mtimeMs: stats.mtimeMs, size: stats.size, catalog };
    return catalog;
  }

  readCatalog() {
    return clone(this.catalogSnapshot());
  }

  writeCatalog(catalog) {
    const normalized = normalizeProxyCatalog(catalog);
    atomicWriteText(this.configService.proxyCatalogPath(), `${JSON.stringify(normalized, null, 2)}\n`);
    this.catalogCache = null;
    return normalized;
  }

  parsed(content = this.readText(), defaultProtocol) {
    const config = this.configService.readRaw();
    return parseProxyContent(content, {
      defaultProtocol: defaultProtocol || config.proxyPool?.defaultProtocol || 'http',
    });
  }

  localSnapshot() {
    const parsed = this.parsed();
    return {
      total: parsed.entries.length,
      errors: parsed.errors,
      proxies: parsed.entries.map((entry) => ({
        id: entry.id,
        endpoint: entry.url,
        url: entry.url,
        protocol: entry.protocol,
        host: entry.host,
        port: entry.port,
        hasCredentials: Boolean(entry.username),
        check: this.checks.get(entry.id) || null,
      })),
    };
  }

  /**
   * Country pools with their flattened endpoints, without the local port list.
   *
   * The chain extractor needs nothing but this, and used to reach it through
   * `list()` — building the whole console payload, twice per extraction, to
   * pick one endpoint.
   */
  countryPools() {
    return this.dynamicSnapshot().countryPools;
  }

  dynamicSnapshot() {
    const catalog = this.catalogSnapshot();
    const providerSettings = providerSettingsSnapshot(catalog.providerSettings);
    providerSettings.iproyal.iproyal = this.iproyal.snapshot();
    const countryPools = Object.values(catalog.countryPools || {})
      .map((pool) => {
        const entries = flattenedPoolEntries(pool);
        const protocols = entries.reduce((counts, entry) => {
          counts[entry.protocol] = Number(counts[entry.protocol] || 0) + 1;
          return counts;
        }, {});
        return {
          countryCode: pool.countryCode,
          total: entries.length,
          protocols,
          entries,
          manualCount: pool.manualEntries.length,
          sources: pool.sources.map((source) => ({
            ...source,
            cachedCount: source.entries.length,
          })),
        };
      })
      .sort((left, right) => left.countryCode === 'GLOBAL' ? -1 : right.countryCode === 'GLOBAL' ? 1 : left.countryCode.localeCompare(right.countryCode));
    return {
      total: countryPools.reduce((sum, pool) => sum + pool.total, 0),
      providerSettings,
      settingsRefresh: this.settingsRefresh ? clone(this.settingsRefresh) : null,
      countryPools,
    };
  }

  list() {
    const local = this.localSnapshot();
    const dynamic = this.dynamicSnapshot();
    return {
      total: local.total + dynamic.total,
      local,
      dynamic,
      errors: local.errors,
      proxies: local.proxies,
    };
  }

  preview(payload = {}) {
    if (payload.scope === 'dynamic') {
      const parsed = parseDynamicContent(payload.content, {
        providerSettings: this.catalogSnapshot().providerSettings,
        defaultProtocol: payload.defaultProtocol,
        overrides: payload.overrides,
      });
      return {
        valid: parsed.items.length,
        invalid: parsed.errors.length,
        duplicate: parsed.duplicates.length,
        errors: parsed.errors,
        duplicates: parsed.duplicates,
        items: parsed.items,
      };
    }
    const parsed = this.parsed(payload.content, payload.defaultProtocol);
    return {
      valid: parsed.entries.length,
      invalid: parsed.errors.length,
      duplicate: parsed.duplicates.length,
      errors: parsed.errors,
      duplicates: parsed.duplicates,
      proxies: parsed.entries.map((entry) => ({ endpoint: entry.url, protocol: entry.protocol })),
    };
  }

  import(payload = {}) {
    if (payload.scope === 'dynamic') return this.importDynamic(payload);
    return this.importLocal(payload);
  }

  importLocal(payload = {}) {
    const mode = payload.mode === 'append' ? 'append' : 'replace';
    const incoming = this.parsed(payload.content, payload.defaultProtocol);
    if (incoming.errors.length) throw new HttpError(400, 'Proxy import contains invalid lines', incoming.errors);
    const existing = mode === 'append' ? this.parsed().entries : [];
    const merged = [];
    const seen = new Set();
    for (const entry of [...existing, ...incoming.entries]) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      merged.push(entry);
    }
    const content = merged.length ? `${merged.map((entry) => entry.url).join('\n')}\n` : '# Local proxy pool intentionally empty.\n';
    atomicWriteText(this.configService.proxyFilePath(), content);
    return this.list();
  }

  importDynamic(payload = {}) {
    if (this.catalogBusy) throw new HttpError(409, 'A dynamic proxy source is currently being refreshed');
    const incoming = parseDynamicContent(payload.content, {
      providerSettings: this.catalogSnapshot().providerSettings,
      defaultProtocol: payload.defaultProtocol,
      overrides: payload.overrides,
    });
    if (incoming.errors.length) throw new HttpError(400, 'Dynamic proxy import contains invalid lines', incoming.errors);
    const catalog = payload.mode === 'replace' ? emptyProxyCatalog() : this.readCatalog();
    if (payload.mode === 'replace') catalog.providerSettings = clone(this.catalogSnapshot().providerSettings);
    for (const item of incoming.items) {
      const pool = poolFor(catalog, item.countryCode);
      if (item.kind === 'proxy') {
        pool.retiredEntries = (pool.retiredEntries || []).filter((entry) => entry.id !== item.id);
        if (!pool.manualEntries.some((entry) => entry.url === item.url)) {
          pool.manualEntries.push({
            id: item.id,
            url: item.url,
            protocol: item.protocol,
            countryCode: item.countryCode,
            sourceId: 'manual',
          });
        }
        continue;
      }
      const id = proxyApiSourceId(item);
      const existing = pool.sources.find((source) => source.id === id);
      if (existing) {
        const protocolChanged = existing.protocol !== item.protocol;
        Object.assign(existing, {
          provider: item.provider,
          apiBaseUrl: apiBaseUrlOf(item.url),
          url: item.url,
          countryCode: item.countryCode,
          count: item.count,
          protocol: item.protocol,
          sessionType: item.sessionType,
          sessionMinutes: item.sessionMinutes,
          earlyRotation: item.earlyRotation,
        });
        if (protocolChanged) {
          existing.entries = [];
          existing.lastPulledAt = '';
          existing.lastPullCount = 0;
          existing.lastError = '';
          existing.lastPulledSettings = null;
        }
        continue;
      }
      pool.sources.push({
        id,
        provider: item.provider,
        apiBaseUrl: apiBaseUrlOf(item.url),
        url: item.url,
        countryCode: item.countryCode,
        count: item.count,
        protocol: item.protocol,
        sessionType: item.sessionType,
        sessionMinutes: item.sessionMinutes,
        earlyRotation: item.earlyRotation,
        entries: [],
        lastPulledAt: '',
        lastPullCount: 0,
        lastError: '',
      });
    }
    this.writeCatalog(catalog);
    return this.list();
  }

  /**
   * Permanently retire one endpoint from its country pool. The retirement is
   * kept separately from source.entries so a later API refresh cannot put a
   * known-bad endpoint back into service.
   */
  _applyDynamicRetirement(catalog, payload = {}) {
    const countryCode = String(payload.countryCode || '').trim().toUpperCase();
    const pool = catalog.countryPools[countryCode];
    if (!pool) return { retired: false, countryCode, proxyId: '', changed: false };

    const requestedId = String(payload.proxyId || payload.entryId || '').trim();
    const requestedUrl = String(payload.proxyUrl || payload.url || '').trim();
    const targetIds = new Set(requestedId ? [requestedId] : []);
    if (requestedUrl) {
      try { targetIds.add(stableProxyId(parseProxyLine(requestedUrl).url)); } catch { /* URL matching below still applies. */ }
    }
    if (!targetIds.size && !requestedUrl) throw new HttpError(400, 'A dynamic proxy entry is required to retire it');
    const matches = (entry) => targetIds.has(String(entry?.id || ''))
      || (requestedUrl && String(entry?.url || '') === requestedUrl);
    const existingEntry = [
      ...(pool.manualEntries || []),
      ...(pool.sources || []).flatMap((source) => source.entries || []),
    ].find(matches);
    let removed = 0;
    pool.manualEntries = (pool.manualEntries || []).filter((entry) => {
      if (!matches(entry)) return true;
      removed += 1;
      return false;
    });
    for (const source of pool.sources || []) {
      source.entries = (source.entries || []).filter((entry) => {
        if (!matches(entry)) return true;
        removed += 1;
        return false;
      });
    }

    const retiredId = existingEntry?.id || [...targetIds].find((id) => id.startsWith('proxy-')) || requestedId;
    pool.retiredEntries = Array.isArray(pool.retiredEntries) ? pool.retiredEntries : [];
    const alreadyRetired = pool.retiredEntries.some((entry) => entry.id === retiredId);
    if (!alreadyRetired) {
      pool.retiredEntries.push({
        id: retiredId,
        retiredAt: new Date().toISOString(),
        reason: String(payload.reason || 'proxy_probe_failed')
          .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1<redacted>@')
          .slice(0, 300),
      });
    }
    return {
      retired: true,
      countryCode,
      proxyId: retiredId,
      removed,
      changed: Boolean(removed || !alreadyRetired),
    };
  }

  _flushPendingRetirements() {
    if (!this.pendingRetirements.length) return;
    const pending = this.pendingRetirements.splice(0);
    try {
      const catalog = this.readCatalog();
      let changed = false;
      for (const payload of pending) {
        const outcome = this._applyDynamicRetirement(catalog, payload);
        changed = outcome.changed || changed;
      }
      if (changed) this.writeCatalog(catalog);
    } catch {
      // Keep the requests for the next catalog operation if the refresh write
      // failed; the in-run allocator has already excluded these endpoints.
      this.pendingRetirements.unshift(...pending);
    }
  }

  retireDynamicEntry(payload = {}) {
    const countryCode = String(payload.countryCode || '').trim().toUpperCase();
    const requestedId = String(payload.proxyId || payload.entryId || '').trim();
    const requestedUrl = String(payload.proxyUrl || payload.url || '').trim();
    if (!requestedId && !requestedUrl) throw new HttpError(400, 'A dynamic proxy entry is required to retire it');
    const request = { ...payload, countryCode, proxyId: requestedId, proxyUrl: requestedUrl };
    if (this.catalogBusy) {
      const key = `${countryCode}\0${requestedId}\0${requestedUrl}`;
      const existing = this.pendingRetirements.find((item) => item.key === key);
      if (existing) Object.assign(existing, request);
      else this.pendingRetirements.push({ ...request, key });
      return { retired: true, queued: true, countryCode, proxyId: requestedId };
    }
    const catalog = this.readCatalog();
    const outcome = this._applyDynamicRetirement(catalog, request);
    if (outcome.changed) this.writeCatalog(catalog);
    if (!outcome.retired) return { ...this.list(), retired: false };
    return { ...this.list(), ...outcome };
  }

  clear(payload = {}) {
    const scope = typeof payload === 'string' ? payload : payload.scope || 'local';
    if (scope === 'dynamic') {
      if (this.catalogBusy) throw new HttpError(409, 'A dynamic proxy source is currently being refreshed');
      this.writeCatalog({ ...emptyProxyCatalog(), providerSettings: clone(this.catalogSnapshot().providerSettings) });
      return this.list();
    }
    atomicWriteText(this.configService.proxyFilePath(), '# Local proxy pool intentionally empty.\n');
    this.checks.clear();
    return this.list();
  }

  removeDynamic(payload = {}) {
    if (this.catalogBusy) throw new HttpError(409, 'A dynamic proxy source is currently being refreshed');
    const catalog = this.readCatalog();
    const countryCode = String(payload.countryCode || '').toUpperCase();
    const pool = catalog.countryPools[countryCode];
    if (!pool) return this.list();
    if (payload.sourceId) pool.sources = pool.sources.filter((source) => source.id !== payload.sourceId);
    if (payload.entryId) pool.manualEntries = pool.manualEntries.filter((entry) => entry.id !== payload.entryId);
    if (!payload.sourceId && !payload.entryId) delete catalog.countryPools[countryCode];
    else if (!pool.sources.length && !pool.manualEntries.length) delete catalog.countryPools[countryCode];
    this.writeCatalog(catalog);
    return this.list();
  }

  /**
   * Refreshes one source in place, recording the outcome on the source itself.
   *
   * Mutates `found` rather than reading or writing the catalog, so the single
   * and the all-pools refresh can share it while each owns its own persistence
   * and its own hold on `catalogBusy`. Never throws for a source-level failure:
   * a batch has to keep going and report at the end.
   */
  async pullInto(found, options = {}) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The caller's signal has to reach the socket, or stopping the robot and
    // shutting the server down both sit through the full timeout of every
    // source still queued.
    const abortFromCaller = () => controller.abort();
    const callerSignal = options.signal;
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const providerLabel = PROXY_API_LABELS[found.source.provider] || 'Dynamic proxy';
    const isIPRoyal = found.source.provider === 'iproyal';
    try {
      const request = isIPRoyal ? this.iproyal.request(found.source) : {};
      const response = await this.fetchApiSource(found.source.url, { ...request, signal: controller.signal, timeoutMs });
      if (!response.ok) throw isIPRoyal ? new IPRoyalError(iproyalHttpError(response.status)) : new Error(`${providerLabel} API returned HTTP ${response.status}`);
      const content = await response.text();
      const parsed = isIPRoyal ? parseIPRoyalResponse(content, found.source.protocol) : parseProxyContent(content, { defaultProtocol: found.source.protocol });
      // A malformed line used to throw away the other 499 proxies in the same
      // response. Bad lines are counted and reported; only a response with
      // nothing usable in it is a failure.
      if (!parsed.entries.length) {
        const EmptyError = isIPRoyal ? IPRoyalError : Error;
        throw new EmptyError(parsed.errors.length
          ? `${providerLabel} returned ${parsed.errors.length} invalid proxy line(s) and no usable proxy`
          : `${providerLabel} returned an empty proxy list`);
      }
      const entries = parsed.entries.slice(0, found.source.count).map((entry) => ({
        id: stableProxyId(entry.url),
        url: entry.url,
        protocol: entry.protocol,
        countryCode: found.pool.countryCode,
        sourceId: found.source.id,
      }));
      found.source.entries = entries;
      found.source.lastPulledSettings = { count: found.source.count, protocol: found.source.protocol, sessionMinutes: found.source.sessionMinutes, apiBaseUrl: apiBaseUrlOf(found.source.url) };
      found.source.lastPulledAt = new Date().toISOString();
      found.source.lastPullCount = entries.length;
      found.source.lastError = parsed.errors.length
        ? `已忽略 ${parsed.errors.length} 行无法解析的代理`
        : '';
      return {
        ok: true,
        countryCode: found.pool.countryCode,
        sourceId: found.source.id,
        pulled: entries.length,
        skippedLines: parsed.errors.length,
      };
    } catch (error) {
      const message = error.name === 'AbortError'
        ? `Dynamic proxy pull timed out after ${timeoutMs} ms`
        : isIPRoyal && !(error instanceof IPRoyalError) && !(error instanceof HttpError)
          ? 'IPRoyal 连接失败，请检查 API 地址、网络或供应商状态' : error.message;
      found.source.lastError = message;
      return { ok: false, countryCode: found.pool.countryCode, sourceId: found.source.id, pulled: 0, error: message };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.('abort', abortFromCaller);
    }
  }

  async pull(sourceId, options = {}) {
    return this.runCatalogRefresh(async () => {
      if (this.catalogBusy) throw new HttpError(409, 'Another dynamic proxy source is currently being refreshed');
      this.catalogBusy = true;
      try {
        const catalog = this.readCatalog();
        const found = sourceInCatalog(catalog, sourceId);
        if (!found) throw new HttpError(404, 'Dynamic proxy API source was not found');
        const outcome = await this.pullInto(found, options);
        // Written either way: a failure records `lastError` on the source, which
        // is what the console shows next to it.
        this.writeCatalog(catalog);
        this._flushPendingRetirements();
        if (!outcome.ok) throw new HttpError(502, `Dynamic proxy pull failed: ${outcome.error}`);
        return this.list();
      } finally {
        this.catalogBusy = false;
        this._flushPendingRetirements();
      }
    });
  }

  async runCatalogRefresh(operation, options = {}) {
    const shareable = options.shareable === true;
    const requestedCountries = shareable ? countryCodesFromOptions(options) : null;
    for (;;) {
      const activeFlight = this.catalogRefreshFlight;
      if (activeFlight) {
        const activeCountries = this.catalogRefreshCountries;
        const coversRequest = shareable
          && this.catalogRefreshShareable
          && (requestedCountries
            ? (!activeCountries || [...requestedCountries].every((countryCode) => activeCountries.has(countryCode)))
            : !activeCountries);
        if (coversRequest) return activeFlight;
        try { await activeFlight; } catch { /* The requested scope still needs its own refresh. */ }
        continue;
      }

      const flight = Promise.resolve().then(operation);
      this.catalogRefreshFlight = flight;
      this.catalogRefreshCountries = requestedCountries;
      this.catalogRefreshShareable = shareable;
      try {
        return await flight;
      } finally {
        if (this.catalogRefreshFlight === flight) {
          this.catalogRefreshFlight = null;
          this.catalogRefreshCountries = null;
          this.catalogRefreshShareable = false;
        }
      }
    }
  }

  /**
   * Refreshes every API source in every country pool.
   *
   * Grouped by host: sources on the same host run one at a time, different
   * hosts run in parallel. Full serialisation was there to avoid rate limiting
   * one provider, which is a real constraint — but it applied that constraint
   * globally, so eight sources at a 20s timeout each meant a worst case of
   * 160s for a refresh that only ever contended on two hosts.
   *
   * The catalog is written once, at the end. Writing after every source cost a
   * 1MB normalize-and-fsync each time (~22ms of blocking CPU per write on the
   * live catalog) and dropped the normalized-catalog cache eight times a round,
   * making every concurrent reader pay to rebuild it. Mid-run visibility now
   * comes from `onProgress` instead of from that write's side effects.
   */
  async pullAll(options = {}) {
    return this.runCatalogRefresh(() => this.pullAllOnce(options), {
      ...options,
      shareable: !options.provider,
    });
  }

  async pullAllOnce(options = {}) {
    if (this.catalogBusy) throw new HttpError(409, 'A dynamic proxy source is currently being refreshed');
    this.catalogBusy = true;
    try {
      const catalog = this.readCatalog();
      const requestedCountries = countryCodesFromOptions(options);
      const allTargets = Object.values(catalog.countryPools || {})
        .flatMap((pool) => (pool.sources || []).map((source) => ({ pool, source })))
        .sort((left, right) => left.pool.countryCode.localeCompare(right.pool.countryCode));
      const targets = allTargets.filter(({ pool, source }) =>
        (!requestedCountries || requestedCountries.has(String(pool.countryCode || '').toUpperCase()))
        && (!options.provider || source.provider === options.provider));
      if (!targets.length) {
        if (!options.allowEmpty) throw new HttpError(400, 'No dynamic proxy API source to refresh');
        return {
          ...this.list(),
          refresh: {
            requested: 0,
            succeeded: 0,
            failed: 0,
            pulled: 0,
            skipped: requestedCountries?.size ? 'no_matching_sources' : 'no_sources',
            results: [],
          },
        };
      }
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const groups = new Map();
      for (const found of targets) {
        let host = '';
        try { host = new URL(String(found.source.url || '')).host; } catch { host = String(found.source.id || ''); }
        const bucket = groups.get(host) || [];
        bucket.push(found);
        groups.set(host, bucket);
      }
      const concurrency = Math.max(1, Math.min(
        Number(options.concurrency || groups.size) || groups.size,
        groups.size,
      ));
      let completed = 0;
      const grouped = await mapLimit([...groups.values()], concurrency, async (bucket) => {
        const bucketResults = [];
        for (const found of bucket) {
          if (options.signal?.aborted) {
            bucketResults.push({
              ok: false,
              countryCode: found.pool.countryCode,
              sourceId: found.source.id,
              pulled: 0,
              error: 'Dynamic proxy refresh was cancelled',
            });
            continue;
          }
          bucketResults.push(await this.pullInto(found, options));
          completed += 1;
          if (onProgress) {
            try { onProgress({ done: completed, total: targets.length, label: found.pool.countryCode }); } catch { /* Progress is cosmetic. */ }
          }
        }
        return bucketResults;
      });
      const results = grouped.flat();
      // One write for the whole round, after every source has had its say.
      this.writeCatalog(catalog);
      this._flushPendingRetirements();
      const failures = results.filter((result) => !result.ok);
      return {
        ...this.list(),
        refresh: {
          requested: results.length,
          succeeded: results.length - failures.length,
          failed: failures.length,
          pulled: results.reduce((sum, result) => sum + result.pulled, 0),
          cancelled: options.signal?.aborted === true,
          results,
        },
      };
    } finally {
      this.catalogBusy = false;
      this._flushPendingRetirements();
    }
  }

  async buildAndPullApi(payload = {}) {
    let source;
    let iproyalCredentials;
    try {
      const defaults = this.catalogSnapshot().providerSettings[payload.provider || '711proxy'] || {};
      source = buildProxyApiUrl(payload.provider || '711proxy', {
        countryCode: payload.countryCode || 'GLOBAL',
        count: payload.count ?? defaults.count,
        protocol: payload.protocol ?? defaults.protocol,
        sessionMinutes: payload.sessionMinutes ?? defaults.sessionMinutes,
        apiBaseUrl: payload.apiBaseUrl ?? defaults.apiBaseUrl,
      });
      if (source.provider === 'iproyal') iproyalCredentials = this.iproyal.prepare(payload.iproyal);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (iproyalCredentials) {
      if (this.catalogBusy || this.catalogRefreshFlight || this.settingsRefreshFlight) throw new HttpError(409, '代理正在刷新，请刷新完成后拉取');
      this.iproyal.save(iproyalCredentials);
    }
    this.importDynamic({
      mode: 'append',
      content: source.url,
      defaultProtocol: source.protocol,
      overrides: [{ line: 1, provider: source.provider, countryCode: source.countryCode, apiBaseUrl: apiBaseUrlOf(source.url), count: source.count, protocol: source.protocol, sessionMinutes: source.sessionMinutes }],
    });
    return this.pull(proxyApiSourceId(source), { timeoutMs: payload.timeoutMs });
  }

  saveProviderSettings(payload = {}) {
    if (this.catalogBusy || this.catalogRefreshFlight || this.settingsRefreshFlight) throw new HttpError(409, '代理正在刷新，请刷新完成后保存');
    let settings;
    let iproyalCredentials;
    try {
      if (!Number.isSafeInteger(payload.count) || payload.count < 1) throw new Error('请填写有效的代理条数');
      if (payload.sessionMinutes === undefined || payload.protocol === undefined) throw new Error('请填写协议和会话粘性时间');
      settings = normalizeProviderSettings(payload.provider, {
        ...payload,
        apiBaseUrl: payload.apiBaseUrl ?? this.catalogSnapshot().providerSettings[payload.provider]?.apiBaseUrl,
      });
      for (const [provider, config] of Object.entries(this.catalogSnapshot().providerSettings)) {
        if (provider !== payload.provider && config.apiBaseUrl === settings.apiBaseUrl) throw new Error('此 API 地址已用于其他代理厂商');
      }
      if (payload.provider === 'iproyal') iproyalCredentials = this.iproyal.prepare(payload.iproyal);
    }
    catch (error) { throw new HttpError(400, error.message); }
    const catalog = this.readCatalog();
    catalog.providerSettings[payload.provider] = settings;
    for (const pool of Object.values(catalog.countryPools)) {
      for (const source of pool.sources) {
        if (source.provider !== payload.provider) continue;
        // Cached endpoints keep their actual protocol until a successful pull.
        // Changing preferences cannot change an already issued upstream lease.
        if (!source.lastPulledSettings && source.lastPulledAt) {
          source.lastPulledSettings = { count: source.count, protocol: source.protocol, sessionMinutes: source.sessionMinutes, apiBaseUrl: apiBaseUrlOf(source.url) };
        }
        const url = new URL(settings.apiBaseUrl);
        url.search = new URL(source.url).search;
        Object.assign(source, normalizeProxyApiUrl(url.href, { provider: source.provider, countryCode: pool.countryCode, ...settings }), { apiBaseUrl: settings.apiBaseUrl });
      }
    }
    if (iproyalCredentials) this.iproyal.save(iproyalCredentials);
    const updated = this.writeCatalog(catalog);
    const total = Object.values(updated.countryPools).reduce((sum, pool) => sum + pool.sources.filter(source => source.provider === payload.provider).length, 0);
    const job = { provider: payload.provider, status: 'running', done: 0, total, startedAt: new Date().toISOString(), finishedAt: '', result: null, error: '' };
    this.settingsRefresh = job;
    const controller = new AbortController();
    this.settingsRefreshController = controller;
    // A non-shareable operation ensures each save performs a fresh pull. The
    // existing refresh lock serializes it with scheduled and manual refreshes.
    this.settingsRefreshFlight = this.runCatalogRefresh(() => this.pullAllOnce({
      provider: payload.provider, allowEmpty: true, signal: controller.signal,
      onProgress: ({ done, total: targetCount }) => { job.done = done; job.total = targetCount; },
    })).then(snapshot => {
      job.result = snapshot.refresh;
      job.status = snapshot.refresh.failed ? (snapshot.refresh.succeeded ? 'partial' : 'failed') : 'success';
    }).catch(error => {
      job.status = 'failed';
      job.error = error.message;
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      this.settingsRefreshFlight = null;
      this.settingsRefreshController = null;
    });
    return { ok: true, provider: payload.provider, settings, refresh: clone(job) };
  }

  async shutdown() {
    await this.inventory.shutdown();
    this.settingsRefreshController?.abort();
    await this.settingsRefreshFlight;
  }

  async buildAndPull711(payload = {}) {
    return this.buildAndPullApi({ ...payload, provider: '711proxy' });
  }

  async check(payload = {}) {
    const config = this.configService.readRaw();
    const healthCheck = config.proxyPool?.healthCheck || {};
    const entries = this.parsed().entries;
    const selected = Array.isArray(payload.ids) && payload.ids.length
      ? entries.filter((entry) => payload.ids.includes(entry.id))
      : entries;
    const results = await mapLimit(selected, 4, async (entry) => {
      const checkedAt = new Date().toISOString();
      try {
        const result = await probeProxy(entry, {
          probeUrl: healthCheck.probeUrl || 'https://auth.openai.com/',
          timeoutMs: healthCheck.timeoutMs || 15000,
          executor: executePureHttpUrl,
        });
        const check = { status: 'healthy', checkedAt, httpStatus: result.status, latencyMs: result.latencyMs };
        this.checks.set(entry.id, check);
        return { id: entry.id, endpoint: entry.url, ...check };
      } catch (error) {
        const check = { status: 'failed', checkedAt, httpStatus: 0, latencyMs: null, message: error.message };
        this.checks.set(entry.id, check);
        return { id: entry.id, endpoint: entry.url, ...check };
      }
    });
    return { total: results.length, results };
  }
}

module.exports = { ProxyService, parseProxyContent };
