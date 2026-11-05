"use strict";
const TERMINAL = new Set(["complete", "partial", "failed", "cancelled"]);
const ITEM_TERMINAL = new Set(["delivered", "failed", "cancelled"]);
function expired(item, now = Date.now()) {
  const started = Date.parse(item.execution_started_at || item.attempt_started_at || "");
  return Number.isFinite(started) && now >= started + item.timeout_minutes * 60000;
}
function creationUncertain(job) {
  const s = job.sessionState || {};
  return Boolean(job.accountCreatedAt || s.accountCreated || s.existingAccount
    || job.registration?.accountCreated || job.error?.accountCreated
    || s.createAccountAttempt?.status === "uncertain"
    || ["account_created", "auth_completed", "auth_callback_pending", "verified"].includes(s.step));
}
// A persisted cleanup queue fences late engine results after customer settlement.
// External resource ownership remains with the engine until cleanup really ends.
async function cleanupRuns(worker) {
  const rows = (await worker.db.query(`SELECT c.*,i.status,i.asset_id FROM platform_run_cleanup c
    JOIN platform_items i ON i.id=c.item_id
    WHERE c.finished_at IS NULL AND c.next_attempt_at<=now()
    ORDER BY c.next_attempt_at LIMIT 10`)).rows;
  for (const row of rows) {
    if (worker.closed) break;
    await worker.db.query(`UPDATE platform_run_cleanup SET attempts=attempts+1,
      next_attempt_at=now()+LEAST(300,15*power(2,LEAST(attempts,5)))*interval '1 second'
      WHERE run_id=$1`, [row.run_id]);
    try {
      let state = worker.manager.load(row.run_id);
      if (row.status !== "delivered") {
        const ids = [...new Set([row.asset_id, ...(state.jobs || []).map(j => j.sessionAssetId || j.assetId)].filter(Boolean))];
        for (const assetId of ids) await worker.db.query(`INSERT INTO platform_quarantined_assets(asset_id,item_id,run_id,reason)
          SELECT $1,$2,$3,'订单已退款，迟到结果禁止交付'
          WHERE NOT EXISTS(SELECT 1 FROM platform_accounts WHERE asset_id=$1)
          ON CONFLICT DO NOTHING`, [assetId,row.item_id,row.run_id]);
      }
      if (worker.manager.activeRun(row.run_id) || !TERMINAL.has(state.status)
        || state.externalCleanup?.length) {
        await worker.manager.cancel(row.run_id, "Customer item already settled; release remaining resources");
        state = worker.manager.load(row.run_id);
      }
      if (!worker.manager.activeRun(row.run_id) && TERMINAL.has(state.status) && !state.externalCleanup?.length) {
        // Cancellation itself can persist a last asset. Observe it next pass before finishing.
        if (row.status !== "delivered") {
          for (const j of state.jobs || []) {
            const assetId = j.sessionAssetId || j.assetId;
            if (assetId) await worker.db.query(`INSERT INTO platform_quarantined_assets(asset_id,item_id,run_id,reason)
              SELECT $1,$2,$3,'订单已退款，迟到结果禁止交付'
              WHERE NOT EXISTS(SELECT 1 FROM platform_accounts WHERE asset_id=$1) ON CONFLICT DO NOTHING`,
            [assetId,row.item_id,row.run_id]);
          }
        }
        await worker.db.query("UPDATE platform_run_cleanup SET finished_at=now(),last_error='' WHERE run_id=$1", [row.run_id]);
      }
    } catch {
      await worker.db.query("UPDATE platform_run_cleanup SET last_error='资源清理暂未完成，系统将自动重试' WHERE run_id=$1", [row.run_id]);
    }
  }
}
module.exports = { TERMINAL, ITEM_TERMINAL, expired, creationUncertain, cleanupRuns };
