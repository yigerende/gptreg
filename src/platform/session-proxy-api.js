'use strict';
const { randomUUID } = require('node:crypto');
const { fail } = require('./security');
const { audit } = require('./db');
const { one, pageQuery } = require('./session-proxy-config');
function registerSessionProxy(app, config, allocator) {
  const base = '/api/admin/v1/session-proxy', db = config.db;
  const record = (r, action, target, result) => audit(db, r.user.id, `session-proxy.${action}`, target, result).catch(() => console.error('[session-proxy] audit write failed'));
  const limited = async (r, key, max = 12) => fail(await db.limit(`session-proxy:${key}:${r.user.id}`, max), '操作过于频繁，请稍后再试', 429);
  app.get(base, () => config.public());
  app.put(base, async r => { await limited(r, 'save'); const result = await config.save(r.body); await audit(db, r.user.id, 'session-proxy.save', result.activeVersion); return result; });
  for (const action of ['test', 'sync']) app.post(`${base}/${action}`, async r => {
    await limited(r, action, 5);
    const c = await config.control();
    fail(!c.revoked, '凭据已紧急停用', 409);
    let rows;
    try {
      rows = await allocator.generator.countries(await config.version(c.active_version));
      if (action === 'sync') await config.syncRows(rows, c.active_version);
    } catch (error) {
      await record(r, action, c.active_version || '', 'failed');
      await db.query("UPDATE session_proxy_controls SET checked_at=now(),last_error=$2 WHERE active_version=$1", [c.active_version, error.code || '供应商请求失败，请检查 API Token 或重试']);
      throw error;
    }
    await db.query("UPDATE session_proxy_controls SET checked_at=now(),last_error='' WHERE provider_ref='iproyal-main' AND active_version=$1", [c.active_version]);
    await record(r, action, c.active_version, 'ok');
    return { ok: true, countryCount: rows.length, message: action === 'test' ? 'API 连通；账号密码请使用指定国家测试验证' : '同步完成，新国家默认关闭' };
  });
  app.get(`${base}/regions`, r => config.regions(r.query));
  app.get(`${base}/regions/selection`, r => config.regionSelection(r.query));
  app.patch(`${base}/regions/:code`, async r => { await limited(r, 'regions', 60); const result = await config.editRegion(r.params.code, r.body || {}); await record(r, 'region.edit', r.params.code, 'ok'); return result; });
  app.delete(`${base}/regions/:code`, async r => { await limited(r, 'regions', 60); const result = await config.editRegion(r.params.code, { suppressed: true, expected_revision: r.body?.expected_revision }); await record(r, 'region.delete', r.params.code, 'ok'); return result; });
  app.post(`${base}/regions/batch`, async r => {
    const { codes, enabled } = r.body || {};
    fail(Array.isArray(codes) && codes.length > 0 && codes.length <= 676 && typeof enabled === 'boolean', '批量地区参数无效');
    await limited(r, 'regions', 60);
    const result = await config.batchRegions(codes, enabled, r.body.expected_revision);
    await record(r, 'region.batch', codes.join(','), enabled ? 'enabled' : 'disabled');
    return result;
  });
  const tests = new Set();
  app.post(`${base}/test-country`, async (r, reply) => {
    await limited(r, 'test-country', 5);
    fail(!tests.has(r.user.id), '已有国家测试正在执行', 409);
    tests.add(r.user.id);
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 60000);
    const closed = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close', closed);
    let held;
    try {
      const policy = await config.policy(r.body?.country, db, { test: true });
      held = await allocator.acquire({ source: 'test', taskKind: 'test', taskItemId: randomUUID(), executionId: randomUUID(), initiatedBy: r.user.id, policy, signal: abort.signal });
      await allocator.assert(held);
      const result = await allocator.generator.probe(held.endpoint, abort.signal);
      await allocator.assert(held);
      await db.query('UPDATE session_proxy_bindings SET detect_result=$2 WHERE id=$1', [held.bindingId, result]);
      await record(r, 'test-country', held.country, 'ok');
      return { ...result, country: held.country, session: held.sessionId.slice(0, 3) + '…' };
    } catch (error) {
      await record(r, 'test-country', held?.country || '', 'failed');
      throw error;
    } finally {
      clearTimeout(timeout);
      reply.raw.removeListener('close', closed);
      tests.delete(r.user.id);
      if (held) await allocator.release(held);
    }
  });
  app.get(`${base}/sessions`, async r => {
    const query = r.query || {}, args = [], conditions = [];
    const { limit, offset } = pageQuery(query);
    if (query.session_key) { args.push(String(query.session_key)); conditions.push(`md5(s.session_id)=$${args.length}`); }
    for (const [key, column] of [['source','b.source'], ['status','b.status'], ['country','b.country'], ['order','t.order_id']]) {
      if (query[key]) { args.push(String(query[key])); conditions.push(`${column}=$${args.length}`); }
    }
    if (query.search) { args.push(`%${String(query.search).slice(0, 100)}%`); conditions.push(`(b.task_item_id ILIKE $${args.length} OR b.run_id ILIKE $${args.length} OR b.final_account_id ILIKE $${args.length} OR t.order_id ILIKE $${args.length} OR EXISTS(SELECT 1 FROM platform_accounts a WHERE a.asset_id=b.final_account_id AND a.email ILIKE $${args.length}))`); }
    for (const [key, op] of [['from', '>='], ['to', '<=']]) if (query[key]) { fail(Number.isFinite(Date.parse(query[key])), '时间无效'); args.push(new Date(query[key]).toISOString()); conditions.push(`b.created_at${op}$${args.length}::timestamptz`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const join = 'FROM session_proxy_bindings b JOIN session_proxy_task_items t USING(source,task_item_id) LEFT JOIN session_proxy_sessions s ON s.session_id=b.session_ref';
    const total = (await one(db, `SELECT count(*)::int AS n ${join} ${where}`, args)).n;
    const items = (await db.query(`SELECT b.id,b.source,b.task_item_id,b.run_id,b.initiated_by,b.attempt_seq,b.country,b.protocol,b.status,b.created_at,b.activated_at,b.reserved_until,b.ended_at,b.last_error,b.detect_result,b.final_account_id,t.order_id,s.expires_at,substring(b.session_ref,1,3)||'…' AS session,md5(s.session_id) AS session_key,(SELECT count(*)::int FROM session_proxy_bindings h WHERE h.session_ref=b.session_ref) AS intervals
      ${join} ${where} ORDER BY b.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset])).rows;
    return { items, total, limit, offset };
  });
}
module.exports = { registerSessionProxy };
