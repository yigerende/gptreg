'use strict';
const { randomUUID, randomInt } = require('node:crypto');
const { fault, one } = require('./session-proxy-config');
const { SessionProxyGenerator } = require('../ui-server/session-proxy-generator');
const LIVE = "('reserved','active','stopping')";
class SessionProxyAllocator {
  constructor(config, options = {}) {
    this.config = config; this.db = config.db; this.crypt = config.crypt;
    this.processId = options.processId || randomUUID();
    this.generator = options.generator || new SessionProxyGenerator(options);
    this.generate = options.generate || ((...args) => this.generator.generate(...args));
  }
  async recoverReserved(q) {
    const rows = (await q.query("UPDATE session_proxy_bindings SET status='expired',ended_at=now() WHERE status='reserved' AND reserved_until<=now() RETURNING execution_id,owner_epoch")).rows;
    for (const r of rows) await q.query('DELETE FROM platform_account_execution_claims WHERE execution_id=$1 AND owner_epoch=$2', [r.execution_id, r.owner_epoch]);
  }
  async claimAccount(q, assetId, executionId, epoch = 1) {
    if (!assetId) return;
    const row = await one(q, `INSERT INTO platform_account_execution_claims(asset_id,execution_id,process_instance_id,owner_epoch,heartbeat_at,lease_until)
      VALUES($1,$2,$3,$4,now(),now()+interval '30 seconds') ON CONFLICT(asset_id) DO UPDATE SET heartbeat_at=now(),lease_until=now()+interval '30 seconds'
      WHERE platform_account_execution_claims.execution_id=EXCLUDED.execution_id AND platform_account_execution_claims.owner_epoch=EXCLUDED.owner_epoch AND platform_account_execution_claims.process_instance_id=EXCLUDED.process_instance_id RETURNING asset_id`, [assetId, executionId, this.processId, epoch]);
    if (!row) throw fault('SESSION_PROXY_BUSY', '该账号正在由另一个任务操作');
  }
  async reserve(request) {
    const { source, taskItemId, taskKind = 'register', executionId, policy, assetId } = request;
    return this.db.tx(async q => {
      const c = await this.config.control(q, true);
      if (c.revoked) throw fault('SESSION_PROXY_REVOKED', '独立会话凭据已紧急停用', 503);
      await this.recoverReserved(q);
      await q.query(`INSERT INTO session_proxy_task_items(source,task_item_id,task_kind,policy_snapshot,order_id,customer_user_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [source, taskItemId, taskKind, policy, request.orderId || null, request.userId || null]);
      const task = await one(q, 'SELECT * FROM session_proxy_task_items WHERE source=$1 AND task_item_id=$2 FOR UPDATE', [source, taskItemId]);
      if (task.closed_at) throw fault('SESSION_PROXY_EXPIRED', '该代理任务已关闭');
      if (request.previousRef) {
        const ref = request.previousRef;
        const previous = await one(q, `SELECT id FROM session_proxy_bindings WHERE id::text=$1 AND execution_id::text=$2 AND owner_epoch::text=$3
          AND source=$4 AND task_item_id=$5 AND attempt_seq=$6 AND config_version=$7`,
        [String(ref.bindingId), String(ref.executionId), String(ref.ownerEpoch), source, taskItemId, task.current_attempt_seq, task.policy_snapshot.configVersion]);
        if (!previous) throw fault('SESSION_PROXY_CONFIG_INVALID', '检查点代理绑定与当前任务归属不一致');
      }
      const existing = await one(q, `SELECT * FROM session_proxy_bindings WHERE source=$1 AND task_item_id=$2 AND status IN ${LIVE}`, [source, taskItemId]);
      if (existing) {
        if (existing.execution_id === executionId && existing.process_instance_id === this.processId && existing.status === 'active') return existing;
        throw fault('SESSION_PROXY_BUSY', '该执行项的代理仍在使用或收尾');
      }
      const last = await one(q, 'SELECT * FROM session_proxy_attempts WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3', [source, taskItemId, task.current_attempt_seq]);
      const attemptSeq = request.identityKey && last?.identity_key && last.identity_key !== request.identityKey && !assetId
        ? task.current_attempt_seq + 1 : task.current_attempt_seq;
      if (attemptSeq < task.current_attempt_seq || attemptSeq > task.current_attempt_seq + 1) throw fault('SESSION_PROXY_EXPIRED', '注册尝试已变化，不能使用旧执行');
      if (attemptSeq > task.current_attempt_seq) await q.query('UPDATE session_proxy_task_items SET current_attempt_seq=$3 WHERE source=$1 AND task_item_id=$2', [source, taskItemId, attemptSeq]);
      const count = await one(q, `SELECT count(*)::int AS n FROM session_proxy_bindings WHERE status IN ${LIVE}`);
      if (count.n >= c.max_parallel) throw fault('SESSION_PROXY_CAPACITY', '等待独立会话代理资源');
      const epoch = Number((await one(q, 'SELECT COALESCE(max(owner_epoch),0)+1 AS epoch FROM session_proxy_bindings WHERE source=$1 AND task_item_id=$2', [source, taskItemId])).epoch);
      await this.claimAccount(q, assetId, executionId, epoch);
      const p = task.policy_snapshot;
      let attempt = await one(q, 'SELECT * FROM session_proxy_attempts WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3', [source, taskItemId, attemptSeq]);
      if (!attempt) {
        const countries = p.countries || [];
        if (!countries.length) throw fault('SESSION_PROXY_CONFIG_INVALID', '任务没有冻结的注册地区', 503);
        const preferred = taskKind === 'oauth' && countries.find(r => r.code === p.renewalCountry);
        const country = (preferred || countries[randomInt(countries.length)]).code;
        attempt = await one(q, `INSERT INTO session_proxy_attempts(source,task_item_id,attempt_seq,config_version,country,protocol,final_account_id,identity_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [source, taskItemId, attemptSeq, p.configVersion, country, p.protocol, assetId || null, request.identityKey || null]);
      }
      if (attempt.final_account_id && assetId && attempt.final_account_id !== assetId) throw fault('SESSION_PROXY_CONFIG_INVALID', '会话账号归属不一致');
      if (attempt.registration_started_at && !assetId && !await one(q, 'SELECT session_id FROM session_proxy_sessions WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3 AND expires_at>now() AND retired_at IS NULL', [source, taskItemId, attemptSeq])) throw fault('SESSION_PROXY_EXPIRED', '注册中的会话已到期，请先核实账号结果');
      return one(q, `INSERT INTO session_proxy_bindings(source,task_item_id,attempt_seq,config_version,country,protocol,execution_id,process_instance_id,final_account_id,owner_epoch,reserved_until,run_id,initiated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '90 seconds',$11,$12) RETURNING *`,
      [source, taskItemId, attemptSeq, attempt.config_version, attempt.country, attempt.protocol, executionId, this.processId, assetId || null, epoch, request.runId || null, request.initiatedBy || null]);
    });
  }
  ref(row) { return { bindingId: String(row.id), executionId: row.execution_id, ownerEpoch: Number(row.owner_epoch) }; }
  async materialize(row) {
    const session = await one(this.db, 'SELECT * FROM session_proxy_sessions WHERE session_id=$1', [row.session_ref]);
    if (!session) throw fault('SESSION_PROXY_CONFIG_INVALID', '代理会话记录不存在', 503);
    return { ...this.ref(row), country: row.country, protocol: row.protocol, source: row.source, taskItemId: row.task_item_id,
      attemptSeq: row.attempt_seq, sessionId: session.session_id, endpoint: this.crypt.decrypt(session.endpoint_enc), expiresAt: session.expires_at };
  }
  async acquire(request) {
    request.signal?.throwIfAborted();
    const row = await this.reserve(request), ref = this.ref(row);
    if (row.status === 'active') { await this.assert(ref); return this.materialize(row); }
    try {
      const snapshot = await this.config.version(row.config_version);
      const previous = await one(this.db, `SELECT * FROM session_proxy_sessions WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3 AND expires_at>now() AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`, [row.source, row.task_item_id, row.attempt_seq]);
      for (let n = 0; n < 3; n++) {
        request.signal?.throwIfAborted();
        const generatedAt = (await one(this.db, 'SELECT clock_timestamp() AS at')).at;
        const generated = previous ? { sessionId: previous.session_id, endpoint: this.crypt.decrypt(previous.endpoint_enc) }
          : await this.generate(snapshot, row.country, request.signal);
        request.signal?.throwIfAborted();
        const active = await this.confirm(row, generated, previous, generatedAt, snapshot.lifetimeMinutes, request.signal);
        request.signal?.throwIfAborted();
        if (active) return this.materialize(active);
      }
      throw fault('SESSION_PROXY_GENERATION_FAILED', '供应商重复返回已使用的会话，请稍后重试', 502);
    } catch (error) {
      await this.db.query('UPDATE session_proxy_bindings SET last_error=$2 WHERE id=$1', [ref.bindingId, String(error.code || 'SESSION_PROXY_GENERATION_FAILED').slice(0, 100)]);
      await this.release(ref, error.code === 'SESSION_PROXY_EXPIRED' ? 'expired' : 'failed');
      throw error;
    }
  }
  async confirm(row, generated, previous, generatedAt, minutes, signal) {
    return this.db.tx(async q => {
      const c = await this.config.control(q, true);
      signal?.throwIfAborted();
      if (c.revoked) throw fault('SESSION_PROXY_REVOKED', '独立会话凭据已紧急停用', 503);
      const fresh = await one(q, `SELECT b.*,t.closed_at,t.current_attempt_seq FROM session_proxy_bindings b JOIN session_proxy_task_items t USING(source,task_item_id)
        WHERE b.id=$1 AND b.execution_id=$2 AND b.owner_epoch=$3 AND b.process_instance_id=$4 AND b.reserved_until>now() FOR UPDATE OF b,t`, [row.id, row.execution_id, row.owner_epoch, this.processId]);
      if (!fresh || fresh.closed_at || fresh.current_attempt_seq !== row.attempt_seq || !['reserved', 'active'].includes(fresh.status)) throw fault('SESSION_PROXY_EXPIRED', '代理预留已失效，迟到结果已丢弃');
      if (fresh.status === 'active') return fresh;
      if (!previous) {
        const inserted = await one(q, `INSERT INTO session_proxy_sessions(session_id,source,task_item_id,attempt_seq,config_version,country,protocol,endpoint_enc,generated_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+$10*interval '1 minute') ON CONFLICT DO NOTHING RETURNING session_id`,
        [generated.sessionId, row.source, row.task_item_id, row.attempt_seq, row.config_version, row.country, row.protocol, this.crypt.encrypt(generated.endpoint), generatedAt, minutes]);
        if (!inserted) return null;
      }
      const session = await one(q, 'SELECT * FROM session_proxy_sessions WHERE session_id=$1 AND expires_at>now()', [generated.sessionId]);
      if (!session) throw fault('SESSION_PROXY_EXPIRED', '供应商返回时会话已经到期');
      return one(q, "UPDATE session_proxy_bindings SET status='active',session_ref=$2,activated_at=now(),heartbeat_at=now(),lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *", [row.id, generated.sessionId]);
    });
  }
  async assert(ref, { assetId, registrationStarted = false } = {}) {
    return this.db.tx(async q => {
      const c = await this.config.control(q, true);
      if (c.revoked) throw fault('SESSION_PROXY_REVOKED', '独立会话凭据已紧急停用', 503);
      const row = await one(q, `SELECT b.*,s.expires_at FROM session_proxy_bindings b JOIN session_proxy_sessions s ON s.session_id=b.session_ref
        JOIN session_proxy_task_items t ON t.source=b.source AND t.task_item_id=b.task_item_id
        WHERE b.id=$1 AND b.execution_id=$2 AND b.owner_epoch=$3 AND b.process_instance_id=$4 AND b.status='active' AND s.expires_at>now() AND s.retired_at IS NULL AND t.closed_at IS NULL AND t.current_attempt_seq=b.attempt_seq`, [ref.bindingId, ref.executionId, ref.ownerEpoch, this.processId]);
      if (!row) throw fault('SESSION_PROXY_EXPIRED', '代理会话已到期或执行归属已失效');
      if (assetId) {
        if (row.final_account_id && row.final_account_id !== assetId) throw fault('SESSION_PROXY_CONFIG_INVALID', '会话账号归属不一致');
        await this.claimAccount(q, assetId, ref.executionId, ref.ownerEpoch);
        await q.query('UPDATE session_proxy_bindings SET final_account_id=$2 WHERE id=$1', [row.id, assetId]);
        await q.query('UPDATE session_proxy_attempts SET final_account_id=$4 WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3', [row.source, row.task_item_id, row.attempt_seq, assetId]);
      }
      if (registrationStarted) await q.query('UPDATE session_proxy_attempts SET registration_started_at=COALESCE(registration_started_at,now()) WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3', [row.source, row.task_item_id, row.attempt_seq]);
      await q.query("UPDATE session_proxy_bindings SET heartbeat_at=now(),lease_until=now()+interval '30 seconds' WHERE id=$1", [row.id]);
      return row;
    });
  }
  async stopping(ref) {
    await this.db.query("UPDATE session_proxy_bindings SET status='stopping',lease_until=COALESCE(lease_until,now()+interval '70 seconds') WHERE id=$1 AND execution_id=$2 AND owner_epoch=$3 AND status IN ('reserved','active')", [ref.bindingId, ref.executionId, ref.ownerEpoch]);
  }
  async release(ref, status = 'ended') {
    if (!['ended', 'expired', 'failed'].includes(status)) throw new Error('Invalid release status');
    return this.db.tx(async q => {
      await this.config.control(q, true);
      const row = await one(q, `UPDATE session_proxy_bindings SET status=$4,ended_at=now() WHERE id=$1 AND execution_id=$2 AND owner_epoch=$3 AND status IN ${LIVE} RETURNING *`, [ref.bindingId, ref.executionId, ref.ownerEpoch, status]);
      if (row) await q.query('DELETE FROM platform_account_execution_claims WHERE execution_id=$1 AND owner_epoch=$2', [ref.executionId, ref.ownerEpoch]);
      if (row) await q.query('DELETE FROM session_proxy_exit_claims WHERE binding_id=$1', [row.id]);
      return !!row;
    });
  }
}
module.exports = { SessionProxyAllocator };
