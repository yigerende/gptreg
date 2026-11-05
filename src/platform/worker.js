"use strict";
const fs = require("node:fs");
const runtimeSecrets = require("./runtime-secrets");
const { id } = require("./security");
const { executionFailure } = require("./execution-failure");
const TERMINAL = new Set(["complete", "partial", "failed", "cancelled"]);
class OrderWorker {
  constructor(db, orders, manager) {
    this.db = db;
    this.orders = orders;
    this.manager = manager;
    this.closed = false;
    this.pending = null;
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
    await this.tick();
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
        "UPDATE platform_items SET status='review',message=$2,updated_at=now() WHERE id=$1",
        [item.id, message],
      );
      await this.orders.refresh(q, item.order_id);
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
    await this.syncSold();
    const running = (
      await this.db.query(
        "SELECT i.*,o.need_oauth,o.attempt_limit,o.timeout_minutes,o.cancel_requested FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.status IN ('running','review')",
      )
    ).rows;
    for (const item of running) await this.reconcile(item);
    const s = await this.db.settings();
    if (
      !s.worker_enabled ||
      this.manager.activeRuns().length ||
      this.manager.isTaskSlotBusy("main")
    )
      return;
    const candidate = await this.db.one(
      "SELECT i.*,o.template,o.need_oauth,o.attempt_limit,o.timeout_minutes,o.created_at AS order_created_at,o.user_id FROM platform_items i JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE i.status IN ('queued','oauth_pending') AND i.available_at<=now() AND NOT o.cancel_requested AND u.status='active' ORDER BY o.last_scheduled_at NULLS FIRST,o.created_at,i.position LIMIT 1",
    );
    if (!candidate) return;
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
        "UPDATE platform_items SET status='running',run_id=$2,stage=$3,attempts=attempts+$4,oauth_attempts=oauth_attempts+$5,attempt_started_at=now(),updated_at=now(),message=$6 WHERE id=$1",
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
      await this.manager.start(plan, { runId });
      await this.db.query(
        "UPDATE platform_attempts SET status='running' WHERE run_id=$1",
        [runId],
      );
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
          "任务已保存，等待管理员检查恢复",
        );
        return;
      }
      // start() fails before launching a job: safe to retry within the saved budget.
      const fresh = await this.db.one(
        "SELECT i.*,o.attempt_limit,o.cancel_requested FROM platform_items i JOIN platform_orders o ON o.id=i.order_id WHERE i.id=$1",
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
    if (item.cancel_requested || used >= item.attempt_limit) {
      await this.orders.finish(
        item.id,
        null,
        `${message}，未交付部分积分已退回`,
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
  async reconcile(item) {
    let state;
    try {
      state = this.manager.load(item.run_id);
    } catch {
      await this.review(item, "执行记录暂不可读，等待管理员核实，积分继续预留");
      return;
    }
    const active = this.manager.activeRun(item.run_id);
    const expired =
      Date.now() - new Date(item.attempt_started_at).getTime() >
      item.timeout_minutes * 60000;
    if (active) {
      if (expired && state.control?.requestedAction !== "cancel")
        await this.manager.cancel(
          item.run_id,
          "Customer order execution deadline",
        );
      return;
    }
    if (!TERMINAL.has(state.status)) {
      if (state.status === "paused" && !expired && item.status !== "review") {
        try {
          await this.manager.resume(item.run_id);
          return;
        } catch {}
      }
      if (expired) {
        try {
          await this.manager.cancel(
            item.run_id,
            "Customer order execution deadline",
          );
          state = this.manager.load(item.run_id);
        } catch {}
      }
      if (!TERMINAL.has(state.status)) {
        await this.review(item, "任务等待资源或恢复确认，请联系管理员");
        return;
      }
    }
    await this.db.query(
      "UPDATE platform_attempts SET status='finished',finished_at=now() WHERE run_id=$1",
      [item.run_id],
    );
    const jobs = state.jobs || [],
      assetIds = [
        ...new Set(
          [
            item.asset_id,
            ...jobs.map((j) => j.sessionAssetId || j.assetId),
          ].filter(Boolean),
        ),
      ];
    if (assetIds.length > 1) {
      await this.review(item, "执行结果数量异常，需要人工核实归属");
      return;
    }
    let asset;
    try {
      if (assetIds[0]) asset = this.manager.sessionAssets().get(assetIds[0]);
    } catch {}
    const result = asset && this.credentials(asset, item.need_oauth);
    if (result) {
      try {
        await this.orders.finish(item.id, result);
      } catch (e) {
        if (e.code === "23505") {
          await this.review(item, "账号已关联其他交付记录，需要管理员核实");
          return;
        }
        throw e;
      }
      await this.syncSold(asset.id);
      return;
    }
    const failure = executionFailure(
      jobs.find((job) => job.error)?.error || {},
      "ENGINE_EXECUTION_FAILED",
    );
    await this.recordFailure(item.run_id, failure);
    if (asset) {
      // A registered account is never replaced just because OAuth failed.
      await this.db.query("UPDATE platform_items SET asset_id=$2 WHERE id=$1", [
        item.id,
        asset.id,
      ]);
      item.asset_id = asset.id;
      if (
        item.need_oauth &&
        item.stage === "register" &&
        this.credentials(asset, false)
      ) {
        if (item.cancel_requested) {
          await this.orders.finish(
            item.id,
            null,
            "已取消后续 OAuth 授权，积分已退回",
          );
          return;
        }
        await this.queueNext(
          item,
          "oauth_pending",
          "账号已注册，等待 OAuth 授权",
        );
        return;
      }
      if (item.stage === "oauth") {
        await this.retryOrFinish(item, "OAuth 授权未完成");
        return;
      }
      await this.orders.finish(
        item.id,
        null,
        "账号安全凭据未完整配置，未交付部分积分已退回",
      );
      return;
    }
    const uncertain = jobs.some(
      (j) =>
        j.accountCreatedAt ||
        j.targetTouchedAt ||
        j.registration?.accountCreated,
    );
    if (uncertain) {
      await this.review(item, "注册结果需核实，避免重复创建账号");
      return;
    }
    await this.retryOrFinish(item, "本次注册未成功");
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    await this.pending;
    if (this.lock) {
      await this.lock
        .query("SELECT pg_advisory_unlock(8963002)")
        .catch(() => {});
      this.lock.release();
    }
  }
}
module.exports = { OrderWorker };
