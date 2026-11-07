'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { executePureHttpUrl } = require('../pure-url');
const { one, fault } = require('./session-proxy-config');
const TERMINAL = new Set(['complete', 'partial', 'failed', 'skipped', 'cancelled']);
const secretUrl = /(?:https?|socks5h?):\/\/[^\s"'<>]*@geo\.iproyal\.com(?::\d+)?/gi;
function redact(value) {
  if (typeof value === 'string') return value.replace(secretUrl, '[独立会话代理]');
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v)]));
}
class SessionProxyRuntime {
  constructor(allocator, state, signal) { this.allocator = allocator; this.state = state; this.signal = signal; this.handles = new Map(); }
  get enabled() { return this.state.runPlan?.proxyPolicy?.mode === 'sessionProxy'; }
  async identity(job) {
    const plan = this.state.runPlan, provided = plan.sessionProxyItem;
    if (!job.sessionTaskId) {
      const parent = (this.state.jobs || []).find(j => j.id === job.replacementOf || j.id === job.rentalReplacementFor);
      const used = new Set((this.state.jobs || []).map(j => j.sessionTaskId).filter(Boolean));
      const available = (this.state.sessionProxyTaskIds || []).find(id => !used.has(id));
      job.sessionTaskId = provided?.taskItemId || parent?.sessionTaskId || available || randomUUID();
    }
    let identity = { source: provided?.source || 'engine', taskItemId: job.sessionTaskId, orderId: provided?.orderId, userId: provided?.userId };
    const assetId = job.sessionAssetId || job.assetId;
    if (!provided && assetId) {
      const original = await one(this.allocator.db, `SELECT a.source,a.task_item_id,t.policy_snapshot FROM session_proxy_attempts a JOIN session_proxy_task_items t USING(source,task_item_id)
        WHERE a.final_account_id=$1 AND a.config_version=$2 AND a.country=ANY($3::text[]) AND a.attempt_seq=t.current_attempt_seq AND t.closed_at IS NULL ORDER BY a.created_at DESC LIMIT 1`, [assetId, plan.proxyPolicy.configVersion, plan.proxyPolicy.countries.map(r => r.code)]);
      if (original) identity = { source: original.source, taskItemId: original.task_item_id, originalPolicy: original.policy_snapshot };
    }
    return { ...identity, runId: this.state.runId, initiatedBy: provided?.userId || this.state.sessionProxyActor || '', taskKind: assetId ? 'oauth' : 'register', assetId,
      identityKey: createHash('sha256').update(String(job.email || job.id)).digest('hex'), policy: identity.originalPolicy || plan.proxyPolicy };
  }
  context(job, base) {
    const controller = new AbortController();
    const entry = this.handles.get(job.id) || { controller, executionId: randomUUID(), inflight: new Set() };
    if (!this.handles.has(job.id)) this.handles.set(job.id, entry);
    const signal = AbortSignal.any([base.signal?.(), entry.controller.signal, this.signal].filter(Boolean));
    return { ...base, sessionProxyRuntime: this, signal: () => signal,
      sessionProxyExecutor: this.enabled ? async (request, options = {}) => {
        if (entry.error) throw entry.error;
        await this.check(job, true);
        const requestSignal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
        requestSignal.throwIfAborted();
        if (!entry.ref) throw fault('SESSION_PROXY_CONFIG_INVALID', '尚未取得独立会话代理，不能发送请求');
        const operation = executePureHttpUrl(request, { ...options, proxy: entry.ref.endpoint, signal: requestSignal, timeoutMs: Math.min(Math.max(Number(options.timeoutMs) || 60000, 1), 60000) });
        entry.inflight.add(operation);
        try {
          const result = await operation;
          await this.check(job, false);
          return result;
        } catch (error) {
          if (entry.error) throw entry.error;
          error.message = redact(error.message); throw error;
        } finally { entry.inflight.delete(operation); }
      } : undefined };
  }
  async check(job, started = false) {
    const entry = this.handles.get(job.id);
    if (!entry?.ref) return;
    try {
      await this.allocator.assert(entry.ref, { assetId: job.sessionAssetId || job.assetId,
        registrationStarted: started && !job.assetId && !job.sessionAssetId });
    } catch (error) {
      entry.error = error; entry.controller.abort(error);
      if (job.status === 'waiting') job.nextRunAt = new Date().toISOString();
      await this.allocator.stopping(entry.ref);
      await this.allocator.db.query('UPDATE session_proxy_bindings SET last_error=$2 WHERE id=$1', [entry.ref.bindingId, String(error.code || 'DATABASE_ERROR').slice(0, 100)]);
      throw error;
    }
  }
  async bind(worker, job, context) {
    const entry = this.handles.get(job.id);
    if (entry.error) throw entry.error;
    if (entry.ref) await this.check(job);
    else {
      const identity = await this.identity(job);
      await context.checkpoint('session_proxy_identity');
      const settings = await this.allocator.db.settings();
      for (let n = 0; n < 3; n++) {
        entry.ref = await this.allocator.acquire({ ...identity, previousRef: job.sessionProxyRef, executionId: entry.executionId, signal: context.signal() });
        job.sessionProxyRef = this.allocator.ref({ id: entry.ref.bindingId, execution_id: entry.ref.executionId, owner_epoch: entry.ref.ownerEpoch });
        if (!settings.session_proxy_ip_dedup) break;
        try {
          const probe = await this.allocator.generator.probe(entry.ref.endpoint, context.signal());
          const claimed = await one(this.allocator.db, 'INSERT INTO session_proxy_exit_claims(exit_ip,binding_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING exit_ip', [probe.exitIp, entry.ref.bindingId]);
          if (claimed) { await this.allocator.db.query('UPDATE session_proxy_bindings SET detect_result=$2 WHERE id=$1', [entry.ref.bindingId, probe]); break; }
          const attempt = await one(this.allocator.db, 'SELECT registration_started_at,final_account_id FROM session_proxy_attempts WHERE source=$1 AND task_item_id=$2 AND attempt_seq=$3', [entry.ref.source, entry.ref.taskItemId, entry.ref.attemptSeq]);
          if (attempt.registration_started_at || attempt.final_account_id) throw fault('SESSION_PROXY_GENERATION_FAILED', '原会话出口重复，已停止本次执行，未自动更换出口', 502);
          await this.allocator.release(entry.ref);
          await this.allocator.db.query('UPDATE session_proxy_sessions SET retired_at=now() WHERE session_id=$1', [entry.ref.sessionId]);
          entry.ref = null;
          if (n === 2) throw fault('SESSION_PROXY_GENERATION_FAILED', '出口重复，已达到本次尝试上限', 502);
        } catch (e) { if (entry.ref) await this.allocator.release(entry.ref, 'failed'); entry.ref = null; throw e; }
      }
      entry.timer = setInterval(() => {
        if (!entry.checking) entry.checking = this.check(job).catch(() => {}).finally(() => { entry.checking = null; });
      }, 1000); entry.timer.unref();
    }
    worker.proxy = { id: `session-proxy:${createHash('sha256').update(entry.ref.sessionId).digest('hex').slice(0, 20)}`, countryCode: entry.ref.country, protocol: entry.ref.protocol, resourceKind: 'sessionProxy', bindingId: entry.ref.bindingId };
    Object.defineProperty(worker.proxy, 'url', { value: entry.ref.endpoint, enumerable: false, configurable: true });
    worker.proxyId = worker.proxy.id;
    await context.checkpoint('session_proxy_bound');
    return worker.proxy;
  }
  async finish(job, force = false) {
    if (!force && !TERMINAL.has(job.status)) return;
    const entry = this.handles.get(job.id); if (!entry) return;
    clearInterval(entry.timer);
    if (entry.checking) await entry.checking;
    if (entry.ref) {
      await this.allocator.stopping(entry.ref);
      entry.controller.abort(); await Promise.allSettled([...entry.inflight]);
      await this.allocator.release(entry.ref, entry.error?.code === 'SESSION_PROXY_EXPIRED' ? 'expired' : 'ended');
    }
    this.handles.delete(job.id);
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled((this.state.jobs || []).map(job => this.finish(job, true)));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async interrupt() {
    const ids = [...this.handles.values()].map(entry => entry.executionId);
    if (ids.length) await this.allocator.db.tx(async q => {
      await this.allocator.config.control(q, true);
      await q.query("UPDATE session_proxy_bindings SET status='stopping',lease_until=now()+interval '70 seconds' WHERE execution_id=ANY($1::uuid[]) AND process_instance_id=$2 AND status IN ('reserved','active')", [ids, this.allocator.processId]);
    });
    for (const entry of this.handles.values()) entry.controller.abort();
  }
}
module.exports = { SessionProxyRuntime, redact };
