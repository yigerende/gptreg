'use strict';

const { isIP } = require('node:net');
const { randomUUID } = require('node:crypto');
const { parseProxyLine } = require('../proxy-pool');
const { flattenedPoolEntries, PROXY_API_LABELS } = require('../proxy-catalog');
const { HttpError, mapLimit } = require('./utils');
const { pageRows } = require('./pagination');

class ProxyInventory {
  constructor(service) { this.service = service; this.job = null; this.flight = null; }

  rows() {
    const service = this.service;
    const rows = service.parsed().entries.map(entry => ({ ...entry, scope: 'local', countryCode: '', provider: 'local', sourceId: 'local', pulledAt: '', sessionMinutes: null }));
    for (const pool of Object.values(service.catalogSnapshot().countryPools)) {
      const sources = new Map(pool.sources.map(source => [source.id, source]));
      for (const entry of flattenedPoolEntries(pool)) {
        const source = sources.get(entry.sourceId);
        rows.push({ ...parseProxyLine(entry.url), ...entry, scope: 'country', provider: source?.provider || 'manual', pulledAt: source?.lastPulledAt || '', sessionMinutes: source?.lastPulledSettings?.sessionMinutes ?? source?.sessionMinutes ?? null });
      }
    }
    return rows.map(row => ({
      id: row.id, scope: row.scope, countryCode: row.countryCode, provider: row.provider,
      providerLabel: PROXY_API_LABELS[row.provider] || (row.provider === 'local' ? '本地端口' : '手工导入'),
      sourceId: row.sourceId, protocol: row.protocol, host: row.host, port: row.port,
      // Passwords are never returned in the inventory. Runtime keeps the original URL.
      endpoint: `${row.protocol}://${row.username ? '***@' : ''}${row.host}:${row.port}`,
      hasCredentials: Boolean(row.username), pulledAt: row.pulledAt, sessionMinutes: row.sessionMinutes,
      ...(service.usage?.get(row.id) || { lastUsedAt: '', releasedAt: '', cooldownUntil: '', inUse: false, cooling: false }),
      inUse: service.claims?.has(row.id) || service.usage?.get(row.id).inUse || false,
      check: this.service.checks.get(row.id) || null,
    }));
  }

  filtered(query = {}, rows = this.rows()) {
    const q = String(query.q || '').trim().toLowerCase();
    if (q.length > 200) throw new HttpError(400, '搜索内容最多200个字符');
    for (const [key, allowed] of Object.entries({ scope: ['all', 'local', 'country'], status: ['all', 'unknown', 'healthy', 'failed'], usage: ['all', 'available', 'cooling', 'in_use'], protocol: ['all', 'http', 'https', 'socks5'] })) {
      if (query[key] && !allowed.includes(query[key])) throw new HttpError(400, '无效的代理筛选条件');
    }
    const filtered = rows.filter(row => (!query.scope || query.scope === 'all' || row.scope === query.scope)
      && (!query.country || query.country === 'all' || row.countryCode === query.country)
      && (!query.provider || query.provider === 'all' || row.provider === query.provider)
      && (!query.protocol || query.protocol === 'all' || row.protocol === query.protocol)
      && (!query.status || query.status === 'all' || (row.check?.status || 'unknown') === query.status)
      && (!query.usage || query.usage === 'all' || (row.inUse ? 'in_use' : row.cooling ? 'cooling' : 'available') === query.usage)
      && (!q || [row.host, row.port, row.endpoint, row.countryCode, row.providerLabel, row.check?.exitIp].join(' ').toLowerCase().includes(q)));
    const sort = query.sort || 'used';
    if (!['country', 'latency', 'checked', 'pulled', 'used'].includes(sort)) throw new HttpError(400, '无效的代理排序');
    return filtered.sort((a, b) => (sort === 'latency' ? (a.check?.latencyMs ?? Infinity) - (b.check?.latencyMs ?? Infinity)
      : sort === 'used' ? b.lastUsedAt.localeCompare(a.lastUsedAt)
      : sort === 'checked' ? String(b.check?.checkedAt || '').localeCompare(a.check?.checkedAt || '')
        : sort === 'pulled' ? b.pulledAt.localeCompare(a.pulledAt) : a.countryCode.localeCompare(b.countryCode))
      || a.provider.localeCompare(b.provider) || a.host.localeCompare(b.host, undefined, { numeric: true }) || String(a.port).localeCompare(String(b.port), undefined, { numeric: true }) || a.id.localeCompare(b.id));
  }

  list(query = {}) {
    const rows = this.rows(), filtered = this.filtered(query, rows);
    return { ...pageRows(filtered, query),
      summary: { total: rows.length, matched: filtered.length, healthy: filtered.filter(r => r.check?.status === 'healthy').length, failed: filtered.filter(r => r.check?.status === 'failed').length, unknown: filtered.filter(r => !r.check).length,
        inUse: filtered.filter(r => r.inUse).length, cooling: filtered.filter(r => !r.inUse && r.cooling).length },
      countries: [...new Set(rows.map(r => r.countryCode).filter(Boolean))].sort(),
      providers: [...new Set(rows.map(r => r.provider))].map(value => ({ value, label: rows.find(r => r.provider === value).providerLabel })),
      test: this.status(),
    };
  }

  status() { return this.job ? { ...this.job } : null; }

  start(payload = {}) {
    if (this.flight) throw new HttpError(409, '代理测试正在进行，请等待完成');
    const all = this.filtered(payload.filters || {});
    let selected;
    if (payload.all === true) selected = all;
    else {
      if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.some(id => typeof id !== 'string')) throw new HttpError(400, '请选择要测试的代理');
      const ids = new Set(payload.ids);
      selected = all.filter(row => ids.has(row.id));
      if (new Set(selected.map(row => row.id)).size !== ids.size) throw new HttpError(409, '部分代理已被刷新移除，请刷新列表后重新选择');
    }
    const urls = new Map(this.service.parsed().entries.map(entry => [entry.id, entry.url]));
    for (const pool of Object.values(this.service.catalogSnapshot().countryPools)) for (const entry of flattenedPoolEntries(pool)) urls.set(entry.id, entry.url);
    const ids = [...new Set(selected.map(row => row.id))];
    if (!ids.length || ids.length > 1000) throw new HttpError(400, '每次测试1～1000条代理，请缩小筛选范围');
    const job = this.job = { id: randomUUID(), status: 'running', total: ids.length, done: 0, succeeded: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: '' };
    this.controller = new AbortController();
    this.flight = mapLimit(ids, 4, async id => {
      const started = Date.now(), checkedAt = new Date().toISOString();
      try {
        const result = await this.service.executor({ index: -2081, method: 'GET', url: 'https://api.ipify.org?format=json', headers: { Accept: 'application/json' }, cookies: {}, body: '', contentType: '', expectStatus: 200, redirect: '' }, { name: 'proxy_inventory_check', proxy: urls.get(id), timeoutMs: 15000, signal: this.controller.signal });
        const httpStatus = Number(result.response?.status || result.status || 0);
        let exitIp = '';
        try { exitIp = JSON.parse(result.response?.text || '{}').ip || ''; } catch { /* Invalid response is a failed probe. */ }
        if (httpStatus !== 200 || !isIP(exitIp)) throw new Error(httpStatus === 200 ? '检测服务未返回有效出口IP' : `检测服务返回 HTTP ${httpStatus || '未知'}`);
        this.service.checks.set(id, { status: 'healthy', checkedAt, httpStatus, latencyMs: Date.now() - started, exitIp });
        job.succeeded++;
      } catch (error) {
        // Transport error text can contain proxy credentials; expose only a safe classification.
        const message = /timeout|timed out|abort/i.test(error.message) ? '连接超时或检测已中止' : /^(检测服务)/.test(error.message) ? error.message : '代理连接失败，请检查有效期、白名单或供应商状态';
        this.service.checks.set(id, { status: 'failed', checkedAt, httpStatus: 0, latencyMs: null, exitIp: '', message });
        job.failed++;
      } finally { job.done++; }
    }).finally(() => { job.status = 'completed'; job.finishedAt = new Date().toISOString(); this.flight = null; });
    return this.status();
  }

  async shutdown() { this.controller?.abort(); await this.flight; }
}

module.exports = { ProxyInventory };
