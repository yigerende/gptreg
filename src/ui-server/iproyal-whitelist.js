'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { parseProxyLine, stableProxyId } = require('../proxy-pool');
const { atomicWriteText, HttpError } = require('./utils');
const { IPRoyalError, iproyalHttpError } = require('./iproyal');

function lifetime(minutes) {
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
function configuration(source) {
  return `${source.countryCode === 'GLOBAL' ? '' : `_country-${source.countryCode.toLowerCase()}`}_session-${crypto.randomBytes(4).toString('hex')}_lifetime-${lifetime(source.sessionMinutes)}`;
}
function matches(row, source) {
  const text = String(row.configuration || '');
  const country = text.match(/_country-([^_]+)/)?.[1] || '';
  const time = text.match(/_lifetime-(\d+)([smhd])(?:_|$)/);
  return country === (source.countryCode === 'GLOBAL' ? '' : source.countryCode.toLowerCase())
    && /_session-[a-zA-Z0-9]{8}(?:_|$)/.test(text) && time
    && Number(time[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[time[2]] === source.sessionMinutes;
}

class IPRoyalWhitelist {
  constructor(service) { this.service = service; this.file = path.join(service.configService.cwd, '.runtime', 'iproyal-whitelist-owner.json'); }

  owner(create = true) {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(data.owner)) throw new Error('invalid');
      return data.owner;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new IPRoyalError('IPRoyal 白名单管理标识无法读取，请检查运行目录');
      if (!create) return null;
      const owner = crypto.randomBytes(16).toString('hex');
      atomicWriteText(this.file, JSON.stringify({ owner }) + '\n');
      return owner;
    }
  }

  async client(source, { signal, timeoutMs }) {
    const service = this.service, credentials = service.iproyal.prepare();
    const base = source.url.replace(/\/+$/, '');
    const api = async (suffix, method = 'GET', body) => {
      signal?.throwIfAborted();
      const response = await service.fetchApiSource(base + suffix, {
        method, headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal, timeoutMs,
      });
      if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new IPRoyalError(iproyalHttpError(response.status));
      if (method === 'DELETE') return null;
      let data;
      try { data = JSON.parse(await response.text()); } catch { throw new IPRoyalError('IPRoyal 白名单接口返回的数据无效'); }
      return data;
    };
    const me = await api('/me');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(me?.residential_user_hash || '')) throw new IPRoyalError('IPRoyal 未返回住宅代理账户');
    const route = `/residential-users/${me.residential_user_hash}/whitelist-entries`;
    const list = async () => {
      const rows = [];
      for (let page = 1; page <= 100; page++) {
        const data = await api(`${route}?page=${page}&per_page=100`);
        if (!Array.isArray(data?.data) || !Number.isInteger(data.meta?.last_page) || data.meta.last_page < 1 || data.meta.last_page > 100) throw new IPRoyalError('IPRoyal 白名单分页数据无效');
        rows.push(...data.data);
        if (page >= data.meta.last_page) break;
      }
      return rows;
    };
    return { api, route, list, credentials };
  }

  // Keep the claims until the caller has persisted the local removal. Discover
  // ownership by note, including old protocols/IPs and entries lost from cache.
  async remove(sources, { beforeDelete, commit }) {
    const service = this.service, owner = this.owner(false);
    if (!owner) {
      if (sources.some(s => s.entries.length || s.deletionPending || s.lastPulledAt)) throw new IPRoyalError('IPRoyal 白名单管理标识缺失，无法安全释放端口，请恢复运行目录中的管理标识');
      return commit();
    }
    const lockOwner = `iproyal-delete:${crypto.randomUUID()}`, locked = new Set();
    const reserve = id => {
      if (locked.has(id)) return;
      if (service.claims.has(id) || service.usage.get(id).inUse) throw new HttpError(409, 'IPRoyal 代理正在使用，未执行删除；请等待任务结束后重试');
      service.claims.set(id, lockOwner); locked.add(id);
    };
    const controller = new AbortController(), timeoutMs = 90000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (const source of sources) for (const entry of source.entries) reserve(entry.id);
      const groups = new Map();
      for (const source of sources) {
        const key = source.url.replace(/\/+$/, '');
        if (!groups.has(key)) groups.set(key, { source, notes: new Set() });
        groups.get(key).notes.add(`gptreg:${owner}:${source.id}`);
      }
      const plans = [];
      for (const group of groups.values()) {
        const client = await this.client(group.source, { signal: controller.signal, timeoutMs });
        const rows = (await client.list()).filter(row => group.notes.has(row.note));
        for (const row of rows) {
          const port = Number(row.port);
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.hash || '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new IPRoyalError('IPRoyal 白名单条目标识无效');
          // The same endpoint can be cached under an older protocol setting.
          for (const protocol of ['http', 'socks5']) reserve(stableProxyId(`${protocol}://proxy.iproyal.com:${port}`));
        }
        plans.push({ ...client, rows, notes: group.notes });
      }
      // Persist before the first upstream DELETE: a crash or uncertain response
      // must not leave removed endpoints allocatable or let a timer recreate them.
      beforeDelete();
      for (const plan of plans) {
        for (const row of plan.rows) await plan.api(`${plan.route}/${encodeURIComponent(row.hash)}`, 'DELETE');
        if ((await plan.list()).some(row => plan.notes.has(row.note))) throw new IPRoyalError('IPRoyal 仍有端口未释放，请重试删除');
      }
      return commit();
    } finally {
      clearTimeout(timer);
      for (const id of locked) if (service.claims.get(id) === lockOwner) service.claims.delete(id);
    }
  }

  async pull(source, { signal, timeoutMs }) {
    const service = this.service;
    const { api, route, list, credentials } = await this.client(source, { signal, timeoutMs });
    const rows = await list();
    let ip = credentials.whitelistIp;
    if (!ip) {
      // Detect the worker's direct egress; never send the API token to this service.
      const response = await service.fetch('https://api.ipify.org?format=json', { signal, redirect: 'error' });
      try { ip = JSON.parse(await response.text()).ip; } catch { /* Validated below. */ }
      if (!response.ok || !isIP(ip || '')) throw new IPRoyalError('无法检测服务器出口 IP，请在专属配置中填写白名单 IP');
    }
    // Require an explicit pre-existing authorization from the supplier dashboard.
    // This must not silently whitelist whichever address an environment uses.
    if (!rows.some(row => row.ip === ip)) throw new IPRoyalError(`请先在 IPRoyal 后台将服务器出口 ${ip} 加入白名单`);
    const nodes = await api('/access/entry-nodes');
    const node = Array.isArray(nodes) && nodes.find(row => row.dns === 'proxy.iproyal.com');
    const portSet = node?.ports?.find(row => row.name === (source.protocol === 'socks5' ? 'socks5' : 'http|https'));
    const ports = [...new Set([portSet?.port, ...(portSet?.alternative_ports || [])].map(Number))].filter(n => Number.isInteger(n) && n > 0 && n <= 65535);
    if (!node || !ports.length) throw new IPRoyalError('IPRoyal 没有返回该协议的白名单端口');
    const note = `gptreg:${this.owner()}:${source.id}`;
    const allOwned = rows.filter(row => row.note === note);
    const owned = allOwned.filter(row => row.ip === ip && ports.includes(Number(row.port)));
    const obsolete = allOwned.filter(row => !owned.includes(row));
    const taken = new Set(rows.filter(row => row.ip === ip).map(row => Number(row.port)));
    const free = ports.filter(port => !taken.has(port));
    const capacity = owned.length + free.length;
    const target = Math.min(source.count, capacity);
    if (!target) throw new IPRoyalError('IPRoyal 此协议的白名单端口已被其他国家或已有配置占满；请减少其他国家的条数');
    const entries = [], locked = [], notices = [];
    const lockOwner = `iproyal-refresh:${crypto.randomUUID()}`;
    const entryFor = port => {
      const entry = parseProxyLine(`${source.protocol}://${node.dns}:${port}`);
      return { ...entry, id: stableProxyId(entry.url) };
    };
    const reserve = id => {
      if (service.claims.has(id) || service.usage.get(id).inUse) return false;
      service.claims.set(id, lockOwner); locked.push(id); return true;
    };
    const valid = (row, port) => row?.ip === ip && Number(row.port) === port && row.note === note
      && /^[a-zA-Z0-9_-]{1,128}$/.test(row.hash || '') && matches(row, source);
    let issue = '';
    const uncertain = new Set();
    try {
      for (const row of allOwned) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.hash || '') || !Number.isInteger(Number(row.port)) || Number(row.port) < 1 || Number(row.port) > 65535) throw new IPRoyalError('IPRoyal 白名单条目标识无效');
      }
      for (const row of owned) {
        const id = entryFor(Number(row.port)).id;
        if ((service.claims.has(id) || service.usage.get(id).inUse || service.usage.isCooling(id)) && !matches(row, source)) {
          throw new IPRoyalError('IPRoyal 已有端口正在使用或冷却，暂不能修改国家或粘性；任务结束且冷却完成后再刷新');
        }
      }
      // Existing ports keep their session during active use and cooldown.
      // Reserve before awaiting any mutation so another task cannot acquire one.
      for (const row of owned.slice(0, target)) {
        const port = Number(row.port), entry = entryFor(port);
        const unchanged = matches(row, source);
        if (service.usage.isCooling(entry.id) || !reserve(entry.id)) {
          if (!unchanged) throw new IPRoyalError('IPRoyal 已有端口正在使用或冷却，暂不能修改国家或粘性；任务结束且冷却完成后再刷新');
          entries.push(entry); continue;
        }
        uncertain.add(entry.id);
        const updated = await api(`${route}/${encodeURIComponent(row.hash)}`, 'PUT', { configuration: configuration(source), note });
        if (!valid(updated, port)) throw new IPRoyalError('IPRoyal 返回的白名单配置与请求不一致');
        uncertain.delete(entry.id);
        entries.push(entry);
      }
      for (const port of free.slice(0, Math.max(0, target - owned.length))) {
        const entry = entryFor(port);
        if (!reserve(entry.id)) continue;
        const created = await api(route, 'POST', { ip, port, configuration: configuration(source), note });
        if (!valid(created, port)) throw new IPRoyalError('IPRoyal 返回的白名单配置与请求不一致');
        entries.push(entry);
      }
      // Only remove this source's excess ports; never touch a manual entry or
      // another project's notes. Busy/cooling ports are left for a later refresh.
      let retainedExcess = 0;
      for (const row of owned.slice(target)) {
        const entry = entryFor(Number(row.port));
        if (service.usage.isCooling(entry.id) || !reserve(entry.id)) { retainedExcess++; continue; }
        uncertain.add(entry.id);
        await api(`${route}/${encodeURIComponent(row.hash)}`, 'DELETE');
        uncertain.delete(entry.id);
      }
      if (retainedExcess) notices.push(`${retainedExcess} 个超出目标数量的端口仍在使用或冷却，暂时保留；结束后再次刷新释放`);
      // Only retire old protocol/IP bindings once replacement capacity exists.
      // Check both connection IDs so a saved protocol change cannot interrupt
      // a task holding a snapshot of the old protocol.
      let retained = 0;
      if (entries.length >= target) for (const row of obsolete) {
        const ids = ['http', 'socks5'].map(protocol => stableProxyId(`${protocol}://${node.dns}:${Number(row.port)}`));
        if (ids.some(id => service.usage.isCooling(id) || service.usage.get(id).inUse || (service.claims.has(id) && service.claims.get(id) !== lockOwner))) {
          retained++; continue;
        }
        for (const id of ids) if (service.claims.get(id) !== lockOwner) reserve(id);
        await api(`${route}/${encodeURIComponent(row.hash)}`, 'DELETE');
      }
      else retained = obsolete.length;
      if (retained) notices.push(`${retained} 个旧协议或旧白名单 IP 端口暂时保留；新代理就绪且旧端口使用和冷却结束后，再次刷新将释放`);
    } catch (error) {
      if (!entries.length) { error.invalidatedProxyIds = [...uncertain]; throw error; }
      issue = error instanceof IPRoyalError ? error.message : '部分端口更新未完成，请再次刷新';
    } finally {
      for (const id of locked) if (service.claims.get(id) === lockOwner) service.claims.delete(id);
    }
    if (!entries.length) throw new IPRoyalError('IPRoyal 暂无空闲白名单端口，请稍后刷新');
    if (entries.length < source.count) notices.push(`目标 ${source.count} 条，实际 ${entries.length} 条；当前协议共 ${ports.length} 个端口，由各国家及已有白名单共享`);
    if (issue) notices.push(issue);
    return { entries, errors: [], notice: notices.join('；'), capacity: ports.length };
  }
}

module.exports = { IPRoyalWhitelist, lifetime, matches };
