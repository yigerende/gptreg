'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { parseProxyLine, stableProxyId } = require('../proxy-pool');
const { atomicWriteText } = require('./utils');
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

  owner() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(data.owner)) throw new Error('invalid');
      return data.owner;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new IPRoyalError('IPRoyal 白名单管理标识无法读取，请检查运行目录');
      const owner = crypto.randomBytes(16).toString('hex');
      atomicWriteText(this.file, JSON.stringify({ owner }) + '\n');
      return owner;
    }
  }

  async pull(source, { signal, timeoutMs }) {
    const service = this.service, credentials = service.iproyal.prepare();
    const base = source.url.replace(/\/+$/, '');
    const api = async (suffix, method = 'GET', body) => {
      signal?.throwIfAborted();
      const response = await service.fetchApiSource(base + suffix, {
        method, headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal, timeoutMs,
      });
      if (!response.ok) throw new IPRoyalError(iproyalHttpError(response.status));
      if (method === 'DELETE') return null;
      let data;
      try { data = JSON.parse(await response.text()); } catch { throw new IPRoyalError('IPRoyal 白名单接口返回的数据无效'); }
      return data;
    };
    const me = await api('/me');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(me?.residential_user_hash || '')) throw new IPRoyalError('IPRoyal 未返回住宅代理账户');
    const route = `/residential-users/${me.residential_user_hash}/whitelist-entries`;
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const data = await api(`${route}?page=${page}&per_page=100`);
      if (!Array.isArray(data?.data) || !Number.isInteger(data.meta?.last_page) || data.meta.last_page > 100) throw new IPRoyalError('IPRoyal 白名单分页数据无效');
      rows.push(...data.data);
      if (page >= data.meta.last_page) break;
    }
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
    const owned = rows.filter(row => row.ip === ip && row.note === note && ports.includes(Number(row.port)));
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
      for (const row of owned) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.hash || '')) throw new IPRoyalError('IPRoyal 白名单条目标识无效');
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
      for (const row of owned.slice(target)) {
        const entry = entryFor(Number(row.port));
        if (service.usage.isCooling(entry.id) || !reserve(entry.id)) continue;
        uncertain.add(entry.id);
        await api(`${route}/${encodeURIComponent(row.hash)}`, 'DELETE');
        uncertain.delete(entry.id);
      }
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
