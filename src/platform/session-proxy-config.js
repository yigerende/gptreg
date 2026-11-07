"use strict";
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fail, integer } = require('./security');
const LOCK = 8963010;
const DEFAULTS = { authType: 'credentials', protocol: 'http', lifetimeMinutes: 120, renewalCountry: '', apiToken: '', username: '', password: '', subuserHash: '' };
function fault(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode }); }
function ready(v) { return Boolean(v.apiToken && (v.authType === 'subuser' ? v.subuserHash : v.username && v.password)); }
const one = async (q, sql, args = []) => (await q.query(sql, args)).rows[0];
function pageQuery(query = {}) {
  return { limit: integer(Number(query.limit ?? 25), 1, 100, '每页条数'), offset: integer(Number(query.offset ?? 0), 0, Number.MAX_SAFE_INTEGER, '分页位置') };
}
class SessionProxyConfig {
  constructor(db, crypt) { this.db = db; this.crypt = crypt; }
  async control(q = this.db, lock = false) {
    if (lock) await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    return one(q, "SELECT * FROM session_proxy_controls WHERE provider_ref='iproyal-main'");
  }
  async version(version, q = this.db) {
    if (!version) return { ...DEFAULTS };
    const row = await one(q, 'SELECT snapshot_enc FROM session_proxy_config_versions WHERE version_id=$1', [version]);
    if (!row) throw fault('SESSION_PROXY_CONFIG_INVALID', '独立会话配置版本不存在', 503);
    return this.crypt.decrypt(row.snapshot_enc);
  }
  async public(q) {
    if (!q) return this.db.tx(tx => this.public(tx));
    const c = await this.control(q, true), v = await this.version(c.active_version, q);
    const rows = (await q.query("SELECT status,count(*)::int AS n FROM session_proxy_bindings WHERE status IN ('reserved','active','stopping') GROUP BY status")).rows;
    const counts = Object.fromEntries(rows.map(r => [r.status, r.n]));
    const occupied = rows.reduce((n, r) => n + r.n, 0);
    const countryCount = await one(q, 'SELECT count(*)::int AS n FROM session_proxy_regions WHERE enabled AND NOT suppressed');
    const settings = (await one(q, 'SELECT value FROM platform_settings WHERE id=1')).value;
    return { authType: v.authType, protocol: v.protocol, lifetimeMinutes: v.lifetimeMinutes, renewalCountry: v.renewalCountry,
      token_configured: !!v.apiToken, password_configured: !!v.password, username_configured: !!v.username, subuser_configured: !!v.subuserHash,
      ready: ready(v) && !c.revoked, enabled: c.enabled, revoked: c.revoked, maxParallel: c.max_parallel,
      revision: Number(c.revision), activeVersion: c.active_version, syncedAt: c.synced_at, checkedAt: c.checked_at,
      last_error: c.last_error, country_count: countryCount.n, occupied, counts, available: Math.max(0, c.max_parallel - occupied),
      defaultMode: settings.default_proxy_mode || 'countryPool', ipDedup: settings.session_proxy_ip_dedup === true };
  }
  async save(input) {
    const allowed = new Set([...Object.keys(DEFAULTS), 'enabled', 'revoked', 'maxParallel', 'expected_revision', 'clear', 'defaultMode', 'ipDedup']);
    fail(input && typeof input === 'object' && Object.keys(input).every(k => allowed.has(k)), '独立会话配置字段无效');
    await this.db.tx(async q => {
      const c = await this.control(q, true);
      fail(Number(input.expected_revision) === Number(c.revision), '配置已更新，请刷新后再保存', 409);
      const previous = await this.version(c.active_version, q), v = { ...previous };
      for (const key of ['authType', 'protocol', 'lifetimeMinutes', 'renewalCountry']) if (input[key] !== undefined) v[key] = input[key];
      for (const key of ['apiToken', 'username', 'password', 'subuserHash']) {
        if (input[key] !== undefined) fail(typeof input[key] === 'string' && input[key].length <= 4096, '凭据格式无效');
        if (input[key]) v[key] = input[key];
      }
      if (input.clear !== undefined) {
        fail(Array.isArray(input.clear) && input.clear.every(k => ['apiToken', 'username', 'password', 'subuserHash'].includes(k)), '清除字段无效');
        for (const key of input.clear) v[key] = '';
      }
      fail(['credentials', 'subuser'].includes(v.authType), '认证方式无效');
      fail(['http', 'socks5'].includes(v.protocol), '仅支持 HTTP / SOCKS5');
      integer(v.lifetimeMinutes, 1, 10080, '粘性分钟数');
      fail(v.renewalCountry === '' || /^[A-Z]{2}$/.test(v.renewalCountry), '补 OAuth 默认国家无效');
      if (v.renewalCountry) fail(await one(q, 'SELECT code FROM session_proxy_regions WHERE code=$1 AND enabled AND NOT suppressed', [v.renewalCountry]), '补 OAuth 默认国家尚未开放');
      for (const k of ['enabled', 'revoked', 'ipDedup']) if (input[k] !== undefined) fail(typeof input[k] === 'boolean', `${k} 须为布尔值`);
      const cap = integer(input.maxParallel ?? c.max_parallel, 1, 100, '独立会话总并发');
      const version = !c.active_version || !isDeepStrictEqual(previous, v) ? randomUUID() : c.active_version;
      if (version !== c.active_version) await q.query('INSERT INTO session_proxy_config_versions(version_id,auth_type,snapshot_enc) VALUES($1,$2,$3)', [version, v.authType, this.crypt.encrypt(v)]);
      await q.query("UPDATE session_proxy_controls SET active_version=$1,enabled=$2,revoked=$3,max_parallel=$4,revision=revision+1 WHERE provider_ref='iproyal-main'", [version, input.enabled ?? c.enabled, input.revoked ?? c.revoked, cap]);
      if (input.defaultMode !== undefined) {
        fail(['local', 'countryPool', 'sessionProxy'].includes(input.defaultMode), '代理模式无效');
        if (input.defaultMode === 'sessionProxy') {
          fail(ready(v) && (input.enabled ?? c.enabled) && !(input.revoked ?? c.revoked), '请先完成配置并启用接新任务');
          fail(await one(q, 'SELECT code FROM session_proxy_regions WHERE enabled AND NOT suppressed LIMIT 1'), '请先开放注册地区');
        }
        await q.query("UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1", [{ default_proxy_mode: input.defaultMode }]);
      }
      if (input.ipDedup !== undefined) await q.query("UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1", [{ session_proxy_ip_dedup: input.ipDedup }]);
    });
    return this.public();
  }
  async policy(region = 'random', q = this.db, { test = false } = {}) {
    if (q === this.db) return this.db.tx(tx => this.policy(region, tx, { test }));
    fail(/^(random|GLOBAL|[A-Z]{2})$/.test(region), '注册地区无效');
    const c = await this.control(q, true), v = await this.version(c.active_version, q);
    if (c.revoked) throw fault('SESSION_PROXY_REVOKED', '独立会话凭据已紧急停用', 503);
    fail(ready(v) && (test || c.enabled), '独立会话代理尚未开放', 503);
    const rows = (await q.query(`SELECT code,name FROM session_proxy_regions WHERE NOT suppressed ${test ? '' : 'AND enabled'} ORDER BY sort,code`)).rows;
    const countries = ['random', 'GLOBAL'].includes(region) ? rows : rows.filter(r => r.code === region);
    fail(countries.length, '所选注册地区当前不可用');
    return { mode: 'sessionProxy', configVersion: c.active_version, protocol: v.protocol, lifetimeMinutes: v.lifetimeMinutes,
      renewalCountry: v.renewalCountry, requestedRegion: region, countries, rulesVersion: 1 };
  }
  async regions(query = {}) {
    const { limit, offset } = pageQuery(query);
    const search = String(query.search || '').slice(0, 100), includeDeleted = query.deleted === '1';
    const where = '(code ILIKE $1 OR name ILIKE $1) AND ($2 OR NOT suppressed)';
    const args = [`%${search}%`, includeDeleted];
    return { items: (await this.db.query(`SELECT * FROM session_proxy_regions WHERE ${where} ORDER BY sort,code LIMIT $3 OFFSET $4`, [...args, limit, offset])).rows,
      total: (await one(this.db, `SELECT count(*)::int AS n FROM session_proxy_regions WHERE ${where}`, args)).n, limit, offset };
  }
  async syncRows(rows, expectedVersion) {
    await this.db.tx(async q => {
      const c = await this.control(q, true);
      if (expectedVersion !== undefined) fail(c.active_version === expectedVersion && !c.revoked, '同步期间配置已变化，请重新同步', 409);
      for (const row of rows) {
        fail(/^[A-Z]{2}$/.test(row.code) && typeof row.name === 'string', '供应商地区数据无效');
        await q.query("INSERT INTO session_proxy_regions(code,name,provider_ref) VALUES($1,$2,'iproyal-main') ON CONFLICT DO NOTHING", [row.code, row.name.slice(0, 100)]);
      }
      await q.query("UPDATE session_proxy_controls SET synced_at=now(),last_error='',revision=revision+1 WHERE provider_ref='iproyal-main'");
    });
    return this.regions();
  }
  async editRegion(code, input, tx) {
    fail(/^[A-Z]{2}$/.test(code), '国家代码无效');
    fail(Object.keys(input).every(k => ['name', 'sort', 'enabled', 'suppressed', 'expected_revision'].includes(k)), '地区字段无效');
    const update = async q => {
      const c = await this.control(q, true);
      if (input.expected_revision !== undefined) fail(Number(input.expected_revision) === Number(c.revision), '地区已更新，请刷新后重试', 409);
      const row = await one(q, 'SELECT * FROM session_proxy_regions WHERE code=$1 FOR UPDATE', [code]);
      fail(row, '地区不存在', 404);
      if (input.name !== undefined) fail(typeof input.name === 'string' && input.name.trim() && input.name.length <= 100, '地区名称无效');
      if (input.sort !== undefined) integer(input.sort, 0, 1000000, '排序');
      for (const k of ['enabled', 'suppressed']) if (input[k] !== undefined) fail(typeof input[k] === 'boolean', '地区状态无效');
      const next = { ...row, ...input };
      if (next.suppressed) next.enabled = false;
      await q.query('UPDATE session_proxy_regions SET name=$2,sort=$3,enabled=$4,suppressed=$5,updated_at=now() WHERE code=$1', [code, next.name, next.sort, next.enabled, next.suppressed]);
      await q.query("UPDATE session_proxy_controls SET revision=revision+1 WHERE provider_ref='iproyal-main'");
    };
    if (tx) await update(tx); else await this.db.tx(update);
    return { ok: true };
  }
  async batchRegions(codes, enabled, revision) {
    return this.db.tx(async q => {
      const c = await this.control(q, true);
      if (revision !== undefined) fail(Number(revision) === Number(c.revision), '地区已更新，请刷新后重试', 409);
      for (const code of [...new Set(codes)].sort()) await this.editRegion(code, { enabled }, q);
      return { ok: true };
    });
  }
}
module.exports = { SessionProxyConfig, LOCK, fault, one, ready, pageQuery };
