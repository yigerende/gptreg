"use strict";
const fs = require("node:fs");
const runtimeSecrets = require("./runtime-secrets");
const { id, fail } = require("./security");
const { executionFailure } = require("./execution-failure");
const { syncAttemptCosts, backfillCosts } = require("./execution-costs");
const { TERMINAL, ITEM_TERMINAL, expired, creationUncertain, cleanupRuns } = require("./order-recovery");
class OrderWorker {
  constructor(db, orders, manager) {
    this.db = db;
    this.orders = orders;
    this.manager = manager;
    this.closed = false;
    this.pending = null;
    this.operations = new Map();
  }
  async start(lock) {
    this.lock = lock || (await this.db.pool.connect());
    this.lock.on("error", () => {
      this.closed = true;
      process.exitCode = 1;
      this.manager.shutdown().finally(() => process.exit(1));
    });
    if (!lock) {
      const r = await this.lock.query(
        "SELECT pg_try_advisory_lock(8963002) AS locked",
      );
      if (!r.rows[0].locked)
        throw new Error("Another registration worker owns the queue");
    }
    this.heartbeatTimer = setInterval(
      () => this.heartbeat("").catch(() => {}),
      15000,
    );
    this.heartbeatTimer.unref();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
    this.cleanupTimer = setInterval(() => this.kickCleanup(), 5000);
    this.cleanupTimer.unref();
    await this.tick();
    this.kickCleanup();
  }
  async tick() {
    if (this.closed || this.pending) return;
    this.pending = this.cycle()
      .then(() => this.heartbeat(""))
      .catch(async (e) => {
        console.error("Platform worker:", e.code || e.name);
        await this.heartbeat("执行器需要检查，请查看管理后台").catch(() => {});
      })
      .finally(() => {
        this.pending = null;
      });
    await this.pending;
  }
  heartbeat(error) {
    return this.db.query(
      "INSERT INTO platform_worker(id,heartbeat,error) VALUES(1,now(),$1) ON CONFLICT(id) DO UPDATE SET heartbeat=now(),error=$1",
      [error],
    );
  }
  async review(item, message) {
    await this.db.tx(async (q) => {
      await q.query("SELECT id FROM platform_orders WHERE id=$1 FOR UPDATE", [
        item.order_id,
      ]);
      await q.query(
        "UPDATE platform_items SET status='running',message=$2,available_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND run_id IS NOT DISTINCT FROM $3 AND status IN ('running','review') AND NOT EXISTS(SELECT 1 FROM platform_ledger WHERE reference IN ('release:'||$1,'charge:'||$1))",
        [item.id, message, item.run_id],
      );
      await this.orders.refresh(q, item.order_id);
    });
  }
  operation(itemId, fn) {
    const previous = this.operations.get(itemId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.operations.set(itemId, next);
    return next.finally(() => { if (this.operations.get(itemId) === next) this.operations.delete(itemId); });
  }
  kickCleanup() {
    if (this.closed || this.cleanupPending) return;
    this.cleanupPending = cleanupRuns(this).catch(() => {}).finally(() => { this.cleanupPending = null; });
  }
  async current(itemId) {
    return this.db.one(`SELECT i.*,o.need_oauth,o.attempt_limit,o.timeout_minutes,o.cancel_requested,
      COALESCE(LEAST(i.execution_started_at,(SELECT min(a.created_at) FROM platform_attempts a WHERE a.item_id=i.id)),i.attempt_started_at) AS execution_started_at
      FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.id=$1`, [itemId]);
  }
  async refund(item, reason) {
    return this.orders.finish(item.id, null, `${reason}，未交付部分积分已退回`, item.run_id);
  }
  async recover(item, message, allowResume, resume = true) {
    if (expired(item) || item.cancel_requested)
      return this.refund(item, item.cancel_requested ? "已取消后续执行" : "执行超过总时限");
    if (!allowResume || new Date(item.available_at).getTime() > Date.now()) return;
    if (item.recovery_attempts >= item.attempt_limit)
      return this.refund(item, `${message}，自动恢复次数已用尽`);
    const claimed = await this.db.tx(async q => {
      await q.query("SELECT id FROM platform_orders WHERE id=$1 FOR UPDATE", [item.order_id]);
      const changed = (await q.query(`UPDATE platform_items SET status='running',recovery_attempts=recovery_attempts+1,
        available_at=now()+LEAST(120,30*power(2,recovery_attempts))*interval '1 second',
        message=$3,updated_at=now() WHERE id=$1 AND run_id=$2 AND status IN ('running','review')
        AND NOT EXISTS(SELECT 1 FROM platform_ledger WHERE reference IN ('release:'||$1,'charge:'||$1)) RETURNING id`,
      [item.id,item.run_id,`${message}，系统自动恢复 ${item.recovery_attempts+1}/${item.attempt_limit}`])).rowCount;
      if (changed) await this.orders.refresh(q, item.order_id);
      return changed;
    });
    if (!claimed || !resume) return;
    try { await this.manager.resume(item.run_id); }
    catch (e) {
      const failure = executionFailure(e, "ENGINE_EXECUTION_FAILED");
      await this.recordFailure(item.run_id, failure);
      if (["CUSTOMER_TASK_CAPACITY", "CUSTOMER_USER_CAPACITY", "SESSION_ASSET_IN_USE"].includes(failure.code))
        await this.db.query("UPDATE platform_items SET recovery_attempts=GREATEST(0,recovery_attempts-1) WHERE id=$1 AND run_id=$2 AND status='running'", [item.id,item.run_id]);
    }
  }
  async resolve(itemId, action) {
    fail(["resume", "fail"].includes(action), "操作无效");
    return this.operation(itemId, async () => {
      const settled = await this.orders.repairSettled(itemId);
      if (settled) return { ok: true, ...settled };
      const item = await this.current(itemId);
      fail(item && ["running", "review"].includes(item.status), "任务不在恢复状态", 409);
      if (action === "fail") {
        const result = await this.refund(item, "管理员确认终止交付");
        this.kickCleanup();
        return { ok: true, ...result };
      }
      await this.db.query("UPDATE platform_items SET available_at=now() WHERE id=$1 AND status IN ('running','review')", [itemId]);
      await this.reconcile(await this.current(itemId));
      return { ok: true, status: (await this.current(itemId)).status };
    });
  }
  credentials(asset, needOauth) {
    if (
      !asset?.password ||
      !asset.totpSecret ||
      asset.security?.passwordStatus !== "configured" ||
      asset.security?.totpStatus !== "configured"
    )
      return null;
    let oauth;
    if (needOauth) {
      if (!asset.cpa?.path) return null;
      try {
        oauth = runtimeSecrets.parse(
          fs.readFileSync(
            this.manager.cpaFile({ cpaPath: asset.cpa.path }),
            "utf8",
          ),
        );
      } catch {
        return null;
      }
      if (!oauth.refresh_token || !oauth.access_token) return null;
    }
    return {
      asset_id: asset.id,
      email: asset.email,
      password: asset.password,
      totp_secret: asset.totpSecret,
      ...(needOauth ? { oauth } : {}),
    };
  }
  async cycle() {
    const s = await this.db.settings();
    if (!this.costBackfillAt || Date.now() - this.costBackfillAt > 30000) {
      this.costBackfillAt = Date.now();
      await backfillCosts(this.db, this.manager).catch(() => {});
    }
    this.manager.setCustomerConcurrency(
      s.registration_concurrency,
      s.user_registration_concurrency,
    );
    await this.syncSold();
    const running = (
      await this.db.query(
        "SELECT i.*,o.need_oauth,o.attempt_limit,o.timeout_minutes,o.cancel_requested FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.status IN ('running','review')",
      )
    ).rows;
    const cleanup = (await this.db.query("SELECT run_id FROM platform_run_cleanup WHERE finished_at IS NULL")).rows;
    this.manager.setCustomerPendingRuns([...running,...cleanup].map((item) => item.run_id));
    for (const item of running) {
      try { await this.operation(item.id, () => this.reconcile(item, s.worker_enabled)); }
      catch (e) {
        console.error("Customer item reconciliation:", e.code || e.name);
        // One corrupt asset or temporary failure must not stop unrelated customers.
        try { await this.recover(await this.current(item.id), "执行状态同步异常", s.worker_enabled, false); } catch {}
      }
    }
    const overdue = (await this.db.query(`SELECT i.* FROM platform_items i JOIN platform_orders o ON o.id=i.order_id
      WHERE i.status IN ('queued','oauth_pending') AND i.execution_started_at IS NOT NULL
      AND i.execution_started_at+o.timeout_minutes*interval '1 minute'<=now()`)).rows;
    for (const item of overdue) await this.refund(item, "执行超过总时限");
    if (!s.worker_enabled || this.closed) return;
    // The durable count also covers jobs whose engine checkpoint is missing
    // after a crash. Never replace uncertain work with a duplicate execution.
    const pending = (
      await this.db.query(
        "SELECT i.status,i.run_id,o.user_id FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.status IN ('running','review')",
      )
    ).rows;
    this.manager.setCustomerPendingRuns([...pending,...cleanup].map((item) => item.run_id));
    const occupied = pending.filter((item) => {
      if (item.status === "running" || this.manager.activeRun(item.run_id))
        return true;
      try {
        return !TERMINAL.has(this.manager.load(item.run_id).status);
      } catch {
        return true;
      }
    });
    const perUser = new Map();
    for (const item of occupied)
      perUser.set(item.user_id, (perUser.get(item.user_id) || 0) + 1);
    const available = Math.max(0, s.registration_concurrency - occupied.length);
    // Claims stay sequential and fair across orders; launched runs execute
    // concurrently. Limit starts per cycle even when preflight fails quickly.
    for (let n = 0; n < available; n += 1) {
      if (this.closed || this.manager.isTaskSlotBusy("customer")) break;
      const excluded = [...perUser]
        .filter(([, count]) => count >= s.user_registration_concurrency)
        .map(([userId]) => userId);
      const owner = await this.startNext(excluded);
      if (owner === false) break;
      if (owner) perUser.set(owner, (perUser.get(owner) || 0) + 1);
    }
  }
  async startNext(excludedUsers = []) {
    const candidate = await this.db.one(
      "SELECT i.*,o.template,o.need_oauth,o.attempt_limit,o.timeout_minutes,o.created_at AS order_created_at,o.user_id FROM platform_items i JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE i.status IN ('queued','oauth_pending') AND i.available_at<=now() AND NOT o.cancel_requested AND u.status='active' AND NOT (u.id=ANY($1::text[])) ORDER BY o.last_scheduled_at NULLS FIRST,o.created_at,i.position LIMIT 1",
      [excludedUsers],
    );
    if (!candidate) return false;
    if (expired(candidate)) { await this.refund(candidate, "执行超过总时限"); return; }
    // Each customer receives one account per turn. Durable run IDs are written
    // before invoking the engine so a restart can never silently start a duplicate.
    const runId = `customer-${id()}`,
      stage = candidate.asset_id ? "oauth" : "register";
    const claimed = await this.db.tx(async (q) => {
      const o = (
        await q.query("SELECT * FROM platform_orders WHERE id=$1 FOR UPDATE", [
          candidate.order_id,
        ])
      ).rows[0];
      if (o.cancel_requested) return false;
      const item = (
        await q.query("SELECT * FROM platform_items WHERE id=$1 FOR UPDATE", [
          candidate.id,
        ])
      ).rows[0];
      if (!["queued", "oauth_pending"].includes(item.status)) return false;
      await q.query(
        "UPDATE platform_items SET status='running',run_id=$2,stage=$3,attempts=attempts+$4,oauth_attempts=oauth_attempts+$5,attempt_started_at=now(),execution_started_at=COALESCE(execution_started_at,now()),available_at=now(),updated_at=now(),message=$6 WHERE id=$1",
        [
          item.id,
          runId,
          stage,
          stage === "register" ? 1 : 0,
          stage === "oauth" ? 1 : 0,
          stage === "oauth"
            ? "正在补充 OAuth 授权"
            : candidate.need_oauth
              ? "正在注册并完成 OAuth 授权"
              : "正在注册账号",
        ],
      );
      await q.query(
        "INSERT INTO platform_attempts(id,item_id,run_id,stage) VALUES($1,$2,$3,$4)",
        [id(), item.id, runId, stage],
      );
      await q.query(
        "UPDATE platform_orders SET status='running',last_scheduled_at=now(),updated_at=now() WHERE id=$1",
        [o.id],
      );
      return true;
    });
    if (!claimed) return;
    const plan = {
      ...candidate.template,
      schemaVersion: 2,
      taskKind: stage === "oauth" ? "oauth" : "register_session",
      mailCount: 1,
      workerConcurrency: 1,
      aliasEnabled: false,
      mailRentalWatch: false,
      postRegistrationOAuth: stage === "register" && candidate.need_oauth,
      security: { setPassword: true, enrollTotp: true },
      ...(stage === "oauth"
        ? {
            oauthSource: {
              kind: "session_assets",
              assetIds: [candidate.asset_id],
            },
          }
        : {}),
    };
    try {
      await this.manager.start(plan, {
        runId,
        customerExecution: true,
        customerUserId: candidate.user_id,
      });
      await this.db.query(
        "UPDATE platform_attempts SET status='running' WHERE run_id=$1",
        [runId],
      );
      return candidate.user_id;
    } catch (e) {
      const failure = executionFailure(e);
      await this.recordFailure(runId, failure);
      let persisted;
      try {
        persisted = this.manager.load(runId);
      } catch {}
      if (persisted) {
        await this.review(
          { ...candidate, run_id: runId },
          "任务已保存，系统将自动恢复",
        );
        return candidate.user_id;
      }
      // start() fails before launching a job: safe to retry within the saved budget.
      const fresh = await this.db.one(
        "SELECT i.*,o.attempt_limit,o.timeout_minutes,o.cancel_requested FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.id=$1",
        [candidate.id],
      );
      if (failure.wait && !fresh.cancel_requested) {
        await this.db.query(
          "UPDATE platform_attempts SET status='finished',finished_at=now() WHERE run_id=$1",
          [runId],
        );
        // Resource waits never consume a registration/OAuth execution attempt.
        // Bound the wait by this item's first claim, excluding time in the queue.
        const first = await this.db.one(
          "SELECT min(created_at) AS started FROM platform_attempts WHERE item_id=$1",
          [fresh.id],
        );
        const remaining =
          candidate.timeout_minutes * 60 -
          (Date.now() - new Date(first.started).getTime()) / 1000;
        if (remaining <= 0) {
          await this.orders.finish(
            fresh.id,
            null,
            "资源等待超时，未交付部分积分已退回",
          );
          return;
        }
        await this.db.query(
          "UPDATE platform_items SET attempts=attempts-$2,oauth_attempts=oauth_attempts-$3 WHERE id=$1",
          [fresh.id, stage === "register" ? 1 : 0, stage === "oauth" ? 1 : 0],
        );
        await this.queueNext(
          fresh,
          fresh.asset_id ? "oauth_pending" : "queued",
          `${failure.detail}，稍后自动继续`,
          Math.min(failure.delay, Math.ceil(remaining)),
        );
        return;
      }
      await this.retryOrFinish(fresh, failure.detail);
    }
  }
  async recordFailure(runId, failure) {
    await this.db.query(
      "UPDATE platform_attempts SET error_code=$2,error_category=$3,error_detail=$4 WHERE run_id=$1",
      [runId, failure.code, failure.category, failure.detail],
    );
  }
  async syncSold(assetId = null) {
    const rows = (
      await this.db.query(
        "SELECT id,asset_id FROM platform_accounts WHERE engine_sold_at IS NULL AND engine_sold_retry_at<=now() AND ($1::text IS NULL OR asset_id=$1) ORDER BY engine_sold_retry_at,id LIMIT 100",
        [assetId],
      )
    ).rows;
    for (const row of rows) {
      await this.db.query(
        "UPDATE platform_accounts SET engine_sold_retry_at=now()+interval '30 seconds' WHERE id=$1",
        [row.id],
      );
      try {
        const store = this.manager.sessionAssets();
        if (typeof store.markLifecycle !== "function") continue;
        const result = store.markLifecycle([row.asset_id], "sold");
        if (result?.missing?.length) continue;
        await this.db.query(
          "UPDATE platform_accounts SET engine_sold_at=now() WHERE id=$1",
          [row.id],
        );
      } catch {
        // Delivery is already committed. Retry this durable marker next cycle,
        // including after restart, without charging or delivering again.
      }
    }
  }
  async retryOrFinish(item, message) {
    await this.db.query(
      "UPDATE platform_attempts SET status='finished',finished_at=now() WHERE run_id=$1",
      [item.run_id],
    );
    const used = item.stage === "oauth" ? item.oauth_attempts : item.attempts;
    if (item.cancel_requested || expired(item) || used >= item.attempt_limit) {
      await this.orders.finish(
        item.id,
        null,
        `${message}，未交付部分积分已退回`,
        item.run_id,
      );
      return;
    }
    await this.queueNext(
      item,
      item.asset_id ? "oauth_pending" : "queued",
      `${message}，等待重试`,
      30,
    );
  }
  async queueNext(item, status, message, delay = 0) {
    await this.db.tx(async (q) => {
      const o = (
        await q.query("SELECT * FROM platform_orders WHERE id=$1 FOR UPDATE", [
          item.order_id,
        ])
      ).rows[0];
      const current = (
        await q.query("SELECT * FROM platform_items WHERE id=$1 FOR UPDATE", [
          item.id,
        ])
      ).rows[0];
      if (["delivered", "failed", "cancelled"].includes(current.status)) return;
      if (current.run_id !== item.run_id) return;
      if (await this.orders.settlement(q, o, current)) { await this.orders.refresh(q, o.id); return; }
      if (o.cancel_requested) {
        await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
          o.user_id,
        ]);
        await this.orders.release(
          q,
          o,
          current,
          "cancelled",
          "已取消后续执行，积分已退回",
        );
      } else {
        await q.query(
          "UPDATE platform_items SET status=$2,message=$3,available_at=now()+$4*interval '1 second',updated_at=now() WHERE id=$1",
          [item.id, status, message, delay],
        );
      }
      await this.orders.refresh(q, o.id);
    });
  }
  async reconcile(item, allowResume = true) {
    // Re-read after acquiring the per-item executor lock. Financial evidence is
    // authoritative even when an older worker overwrote the terminal status.
    if (await this.orders.repairSettled(item.id)) return;
    item = await this.current(item.id);
    if (!item || ITEM_TERMINAL.has(item.status)) return;
    let state;
    try { state = this.manager.load(item.run_id); }
    catch { return this.recover(item, "执行记录暂不可读", allowResume, false); }
    const active = this.manager.activeRun(item.run_id);
    if (!active || !this.costSyncAt?.has(item.run_id) || Date.now() - this.costSyncAt.get(item.run_id) > 10000) {
      this.costSyncAt ||= new Map();
      await syncAttemptCosts(this.db, this.manager, item.run_id, state).catch(() => {});
      if (active) this.costSyncAt.set(item.run_id, Date.now());
      else this.costSyncAt.delete(item.run_id);
    }
    if (active) {
      if (expired(item)) await this.refund(item, "执行超过总时限");
      return;
    }
    const jobs = state.jobs || [];
    const assetIds = [...new Set([item.asset_id, ...jobs.map(j => j.sessionAssetId || j.assetId)].filter(Boolean))];
    if (assetIds.length > 1) return this.refund(item, "执行结果归属异常，已隔离");
    let asset;
    try {
      if (assetIds[0]) asset = this.manager.sessionAssets().get(assetIds[0]);
    } catch { return this.recover(item, "账号资料暂不可读", allowResume, false); }
    if (assetIds[0] && !asset) return this.recover(item, "账号资料尚未同步", allowResume, false);
    const result = asset && this.credentials(asset, item.need_oauth);
    // A complete durable asset can be delivered while the stopped engine still
    // has mailbox/SMS cleanup pending. Cleanup has its own persistent queue.
    if (result) {
      try {
        const done = await this.orders.finish(item.id, result, undefined, item.run_id);
        if (done?.delivered) await this.syncSold(asset.id);
      } catch (e) {
        if (e.code === "23505" || e.statusCode === 409)
          return this.refund(item, "账号归属或交付资料校验失败，已隔离");
        throw e;
      }
      return;
    }
    if (expired(item) || item.cancel_requested)
      return this.refund(item, item.cancel_requested ? "已取消后续执行" : "执行超过总时限");
    const failure = executionFailure(jobs.find(job => job.error)?.error || {}, "ENGINE_EXECUTION_FAILED");
    await this.recordFailure(item.run_id, failure);
    if (!TERMINAL.has(state.status))
      return this.recover(item, failure.detail, allowResume);
    await this.db.query("UPDATE platform_attempts SET status='finished',finished_at=COALESCE(finished_at,now()) WHERE run_id=$1", [item.run_id]);
    if (asset) {
      await this.db.query("UPDATE platform_items SET asset_id=$2 WHERE id=$1 AND run_id=$3 AND status IN ('running','review')", [item.id,asset.id,item.run_id]);
      item.asset_id = asset.id;
      if (item.need_oauth && item.stage === "register" && this.credentials(asset, false))
        return this.queueNext(item, "oauth_pending", "账号已注册，等待 OAuth 授权");
      if (item.stage === "oauth") return this.retryOrFinish(item, "OAuth 授权未完成");
      // Restore security on this account; never replace an already-created one.
      return this.recover(item, "账号安全设置未完成", allowResume);
    }
    if (jobs.some(creationUncertain))
      return this.recover(item, "正在恢复原账号注册结果", allowResume);
    // targetTouchedAt only means registration was started (e.g. password sent).
    // It is not evidence that create_account succeeded. An OTP timeout before
    // account creation may retry within the original time/attempt budget.
    await this.retryOrFinish(item, failure.detail);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.cleanupTimer);
    await this.pending;
    await this.cleanupPending;
    if (this.lock) {
      await this.lock
        .query("SELECT pg_advisory_unlock(8963002)")
        .catch(() => {});
      this.lock.release();
    }
  }
}
module.exports = { OrderWorker };
