"use strict";
const { digest } = require("./security");
const { settings } = require("./risk-config");
const { event } = require("./risk-store");
async function scan(db, force = false) {
  return db.tx(async (q) => {
    await q.query("SET LOCAL statement_timeout='15s'");
    await q.query("SET LOCAL lock_timeout='2s'");
    // One scanner across application replicas; no worker or supplier calls.
    if (
      !(await q.query("SELECT pg_try_advisory_xact_lock(8963017) AS locked"))
        .rows[0].locked
    )
      return;
    const c = await settings(q);
    const state = (
      await q.query(
        "SELECT *,last_scan<=now()-$1*interval '1 second' AS due FROM platform_risk_scan WHERE id=1 FOR UPDATE",
        [c.scan_seconds],
      )
    ).rows[0];
    if (!force && !state.due) return;
    const jobs = [
      [
        "login_source",
        `SELECT '' AS user_id,'' AS account,source_ip,source_ip AS target FROM platform_risk_events WHERE kind='login_failed' AND source_verified AND last_seen>now()-$1*interval '1 second' GROUP BY source_ip HAVING count(DISTINCT account)>=$2`,
        [c.behavior_window_seconds, c.login_source_accounts],
      ],
      [
        "duplicate_many",
        `SELECT user_id,max(account) AS account,user_id AS target FROM platform_risk_events WHERE kind='duplicate' AND user_id<>'' AND last_seen>now()-$1*interval '1 second' GROUP BY user_id HAVING sum(occurrences)>=$2`,
        [c.behavior_window_seconds, c.duplicate_count],
      ],
      [
        "cancel_many",
        `SELECT o.user_id,u.email AS account,o.user_id AS target FROM platform_orders o JOIN platform_users u ON u.id=o.user_id WHERE cancel_requested AND updated_at>now()-$1*interval '1 second' GROUP BY o.user_id,u.email HAVING count(*)>=$2`,
        [c.behavior_window_seconds, c.cancel_count],
      ],
      [
        "failure_rate",
        `SELECT o.user_id,u.email AS account,o.user_id AS target FROM platform_items i JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE i.status IN ('delivered','failed') AND i.updated_at>now()-$1*interval '1 second' GROUP BY o.user_id,u.email HAVING count(*)>=$2 AND count(*) FILTER(WHERE i.status='failed')*100.0/count(*)>=$3`,
        [c.behavior_window_seconds, c.failure_min_count, c.failure_percent],
      ],
      [
        "queue_many",
        `SELECT o.user_id,u.email AS account,o.user_id AS target FROM platform_items i JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE i.status='queued' GROUP BY o.user_id,u.email HAVING count(*)>=$1`,
        [c.queue_count],
      ],
      [
        "queue_long",
        `SELECT o.user_id,u.email AS account,o.id AS target FROM platform_orders o JOIN platform_users u ON u.id=o.user_id WHERE EXISTS(SELECT 1 FROM platform_items i WHERE i.order_id=o.id AND i.status='queued' AND i.updated_at<now()-$1*interval '1 second')`,
        [c.queue_seconds],
      ],
      [
        "processing_long",
        `SELECT DISTINCT o.user_id,u.email AS account,o.id AS target FROM platform_items i JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE i.status='running' AND i.attempt_started_at<now()-$1*interval '1 second'`,
        [c.processing_seconds],
      ],
      [
        "review_pending",
        `SELECT o.user_id,u.email AS account,o.id AS target FROM platform_orders o JOIN platform_users u ON u.id=o.user_id WHERE o.status='review'`,
        [],
      ],
      [
        "large_adjustment",
        `SELECT l.user_id,u.email AS account,l.id AS target FROM platform_ledger l JOIN platform_users u ON u.id=l.user_id WHERE kind='adjust' AND abs(points_delta::bigint)>=$1 AND l.created_at>now()-$2*interval '1 day'`,
        [c.large_adjustment, c.retention_days],
      ],
    ];
    if (c.finance_checks)
      jobs.push(
        [
          "frozen_mismatch",
          `SELECT u.id AS user_id,u.email AS account,u.id AS target FROM platform_users u WHERE u.frozen<>(SELECT coalesce(sum(o.quantity::bigint*o.unit_price-o.charged-o.released),0) FROM platform_orders o WHERE o.user_id=u.id)`,
          [],
        ],
        [
          "ledger_mismatch",
          `SELECT u.id AS user_id,u.email AS account,u.id AS target FROM platform_users u LEFT JOIN platform_ledger l ON l.user_id=u.id GROUP BY u.id HAVING u.points<>coalesce(sum(l.points_delta),0) OR u.frozen<>coalesce(sum(l.frozen_delta),0)`,
          [],
        ],
        [
          "settlement_mismatch",
          `SELECT o.user_id,u.email AS account,o.id AS target FROM platform_orders o JOIN platform_users u ON u.id=o.user_id WHERE
        o.delivered<>(SELECT count(*) FROM platform_accounts a WHERE a.order_id=o.id) OR o.charged<>o.delivered::bigint*o.unit_price OR
        o.charged<>coalesce((SELECT -sum(l.frozen_delta) FROM platform_items i JOIN platform_ledger l ON l.reference='charge:'||i.id AND l.user_id=o.user_id AND l.kind='charge' WHERE i.order_id=o.id),0) OR
        o.released<>coalesce((SELECT sum(l.points_delta) FROM platform_items i JOIN platform_ledger l ON l.reference='release:'||i.id AND l.user_id=o.user_id AND l.kind='release' WHERE i.order_id=o.id),0)`,
          [],
        ],
      );
    if (c.enabled) {
      for (const [kind, sql, args] of jobs) {
        for (const row of (await q.query(sql, args)).rows) {
          const base = digest(`${kind}:${row.target}`);
          const condition = (
            await q.query(
              `INSERT INTO platform_risk_conditions(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET
            episode=platform_risk_conditions.episode+CASE WHEN platform_risk_conditions.active THEN 0 ELSE 1 END,active=true,seen_at=now() RETURNING episode`,
              [base],
            )
          ).rows[0];
          await event(
            q,
            kind,
            {
              ...row,
              source_verified: Boolean(row.source_ip),
              operation: "scan",
            },
            `${base}:${condition.episode}`,
          );
        }
      }
      await q.query(
        "UPDATE platform_risk_conditions SET active=false WHERE active AND seen_at<now()",
      );
    }
    await q.query(
      "DELETE FROM platform_risk_events WHERE last_seen<now()-$1*interval '1 day'",
      [c.retention_days],
    );
    await q.query(
      "DELETE FROM platform_risk_traffic WHERE minute<now()-$1*interval '1 day'",
      [c.retention_days],
    );
    await q.query(
      "DELETE FROM platform_risk_conditions WHERE NOT active AND seen_at<now()-$1*interval '1 day'",
      [c.retention_days],
    );
    await q.query(
      "DELETE FROM platform_risk_buckets WHERE window_until<now()-interval '1 day' AND coalesce(blocked_until<now(),true)",
    );
    await q.query("UPDATE platform_risk_scan SET last_scan=now() WHERE id=1");
  });
}
module.exports = { scan };
