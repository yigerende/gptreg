"use strict";
const { digest, fail, integer } = require("./security");
const { audit } = require("./db");
const { settings, ruleNames, validateSettings } = require("./risk-config");
const kinds = {
  login_failed: ["login", "warning", "登录验证失败"],
  auth_failed: ["access", "warning", "身份验证失败"],
  denied: ["access", "warning", "访问权限不足"],
  server_error: ["access", "warning", "业务接口服务异常"],
  rate_observed: ["limit", "warning", "访问频率超过观察阈值"],
  rate_blocked: ["limit", "warning", "访问频率超限，已暂时限制"],
  customer_paused: ["limit", "warning", "客户新订单已暂停"],
  redeem_failed: ["finance", "warning", "积分兑换失败"],
  duplicate: ["application", "info", "订单幂等键与请求内容冲突"],
  cancelled: ["application", "info", "客户请求取消订单"],
  admin_change: ["admin", "info", "管理员执行管理操作"],
  login_source: ["login", "warning", "同一已核实来源尝试登录多个账号"],
  duplicate_many: ["application", "warning", "短时间多次提交冲突订单"],
  cancel_many: ["application", "warning", "短时间多次取消订单"],
  failure_rate: ["application", "warning", "注册或授权失败比例较高"],
  queue_many: ["application", "warning", "客户排队账号数量较多"],
  queue_long: ["application", "warning", "注册订单排队时间较长"],
  processing_long: ["application", "warning", "注册或授权执行时间较长"],
  review_pending: ["application", "warning", "注册结果需要人工核实"],
  large_adjustment: ["finance", "warning", "管理员大额调整积分"],
  frozen_mismatch: ["finance", "critical", "冻结积分与未结算订单不一致"],
  ledger_mismatch: ["finance", "critical", "账户积分与账本累计不一致"],
  settlement_mismatch: ["finance", "critical", "订单交付或积分结算记录不一致"],
};
async function event(q, kind, m, dedupe) {
  const spec = kinds[kind];
  if (!spec) return;
  const fingerprint =
    dedupe ||
    digest(
      [
        kind,
        m.user_id,
        m.key_id,
        m.account,
        m.source_ip,
        m.rule,
        m.operation,
      ].join("|"),
    );
  await q.query(
    `INSERT INTO platform_risk_events(dedupe,kind,category,severity,message,operation,rule,user_id,key_id,account,source_ip,source_verified,target,status)
    VALUES(CASE WHEN $15 THEN $1 ELSE $1||':'||date_trunc('minute',now())::text END,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(dedupe) DO UPDATE SET last_seen=now(),occurrences=platform_risk_events.occurrences+CASE WHEN $15 THEN 0 ELSE 1 END`,
    [
      fingerprint,
      kind,
      ...spec,
      m.operation || "",
      m.rule || "",
      m.user_id || "",
      m.key_id || "",
      m.account || "",
      m.source_ip || "",
      Boolean(m.source_verified),
      m.target || "",
      m.status || 0,
      Boolean(dedupe),
    ],
  );
}
async function consume(db, meta, user, loginAccount) {
  return db.tx(async (q) => {
    await q.query("SELECT id FROM platform_risk_settings WHERE id=1 FOR SHARE");
    const cfg = await settings(q);
    meta.cfg = cfg;
    let names,
      control = {};
    if (loginAccount !== undefined) names = ["login"];
    else {
      control =
        (
          await q.query(
            "SELECT * FROM platform_risk_controls WHERE user_id=$1",
            [user.id],
          )
        ).rows[0] || {};
      names = [
        "account",
        meta.operation === "submit"
          ? "submit"
          : meta.operation === "redeem"
            ? "redeem"
            : meta.operation === "export"
              ? "export"
              : meta.method === "GET"
                ? "query"
                : "write",
      ];
      if (user.key_id) names.push("api_key");
    }
    const decisions = [];
    for (const name of names.sort()) {
      const p = { ...cfg.rules[name] };
      if (control.limits?.[name]) p.limit = control.limits[name];
      if (p.mode === "off" || (!cfg.enabled && p.mode !== "enforce")) continue;
      const subject =
        name === "login"
          ? `login:${digest(loginAccount)}`
          : name === "api_key"
            ? `key:${user.key_id}`
            : `user:${user.id}`;
      const bucketId = digest(`${name}:${subject}`),
        signature = JSON.stringify(p);
      await q.query(
        `INSERT INTO platform_risk_buckets(id,rule,subject,label,user_id,key_id,window_until,policy)
        VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second',$8) ON CONFLICT(id) DO UPDATE SET
        hits=CASE WHEN platform_risk_buckets.policy<>$8 OR platform_risk_buckets.blocked_until<=now() OR (platform_risk_buckets.window_until<=now() AND platform_risk_buckets.blocked_until IS NULL) THEN 1 ELSE least(platform_risk_buckets.hits+1,100000000) END,
        window_until=CASE WHEN platform_risk_buckets.policy<>$8 OR platform_risk_buckets.blocked_until<=now() OR (platform_risk_buckets.window_until<=now() AND platform_risk_buckets.blocked_until IS NULL) THEN now()+$7*interval '1 second' ELSE platform_risk_buckets.window_until END,
        blocked_until=CASE WHEN platform_risk_buckets.policy<>$8 OR platform_risk_buckets.blocked_until<=now() THEN NULL ELSE platform_risk_buckets.blocked_until END,policy=$8`,
        [
          bucketId,
          name,
          subject,
          loginAccount ?? user.email,
          user?.id || "",
          name === "api_key" ? user.key_id : "",
          p.window_seconds,
          signature,
        ],
      );
      const b = (
        await q.query(
          `UPDATE platform_risk_buckets SET blocked_until=CASE WHEN hits>$2 AND $3 AND blocked_until IS NULL THEN now()+$4*interval '1 second' ELSE blocked_until END
        WHERE id=$1 RETURNING *, greatest(1,ceil(extract(epoch FROM blocked_until-now())))::int AS retry_seconds,blocked_until>now() AS blocked`,
          [bucketId, p.limit, p.mode === "enforce", p.cooldown_seconds],
        )
      ).rows[0];
      if (b.hits > p.limit || b.blocked)
        decisions.push({
          rule: name,
          blocked: Boolean(b.blocked),
          retry_seconds: b.retry_seconds,
        });
    }
    return decisions;
  });
}
async function record(db, m) {
  if (!m.cfg.enabled || (m.operation === "risk" && m.method === "GET")) return;
  await db.tx(async (q) => {
    const key = digest(
      [m.user_id, m.key_id, m.source_ip, m.channel, m.operation].join("|"),
    );
    await q.query(
      `INSERT INTO platform_risk_traffic(id,user_id,key_id,source_ip,channel,operation,errors,blocked,duration_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id,minute) DO UPDATE SET
      requests=platform_risk_traffic.requests+1,errors=platform_risk_traffic.errors+excluded.errors,
      blocked=platform_risk_traffic.blocked+excluded.blocked,duration_ms=platform_risk_traffic.duration_ms+excluded.duration_ms`,
      [
        key,
        m.user_id || "",
        m.key_id || "",
        m.source_ip,
        m.channel,
        m.operation,
        Number(m.status >= 400),
        Number(m.status === 429 || m.kind === "customer_paused"),
        m.duration_ms,
      ],
    );
    let kind = m.kind;
    if (!kind)
      kind =
        m.status >= 500
          ? "server_error"
          : m.status === 429
            ? "rate_blocked"
            : m.status === 401
              ? m.operation === "login"
                ? "login_failed"
                : "auth_failed"
              : m.status === 403
                ? "denied"
                : m.operation === "redeem" && m.status >= 400
                  ? "redeem_failed"
                  : m.status === 409 && m.operation === "submit"
                    ? "duplicate"
                    : m.status < 300 && m.operation === "cancel"
                      ? "cancelled"
                      : m.status < 300 &&
                          ["admin", "risk"].includes(m.operation) &&
                          m.method !== "GET"
                        ? "admin_change"
                        : "";
    if (kind) await event(q, kind, m);
    // An observed threshold must not hide an authentication or redemption failure.
    if (m.observed && kind !== "rate_blocked")
      await event(q, "rate_observed", { ...m, rule: m.observed });
  });
}
async function saveSettings(db, actor, value) {
  const cfg = validateSettings(value);
  integer(value.revision, 0, 2147483646, "配置版本");
  await db.tx(async (q) => {
    const old = (
      await q.query(
        "SELECT revision FROM platform_risk_settings WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    fail(
      old.revision === value.revision,
      "配置已被其他管理员修改，请重新加载后保存",
      409,
    );
    const previous = await settings(q);
    await q.query(
      "UPDATE platform_risk_settings SET value=$1,revision=revision+1 WHERE id=1",
      [cfg],
    );
    for (const name of Object.keys(ruleNames)) {
      if (
        JSON.stringify(previous.rules[name]) !== JSON.stringify(cfg.rules[name])
      )
        await q.query("DELETE FROM platform_risk_buckets WHERE rule=$1", [
          name,
        ]);
    }
    await audit(q, actor, "risk.settings", "", String(value.revision + 1));
  });
}
async function customer(db, id) {
  const row = (
    await db.query(
      `SELECT u.id AS user_id,u.email,u.name,coalesce(c.paused,false) AS paused,c.paused_until,
    coalesce(c.limits,'{}'::jsonb) AS limits FROM platform_users u LEFT JOIN platform_risk_controls c ON c.user_id=u.id WHERE u.id=$1`,
      [id],
    )
  ).rows[0];
  fail(row, "客户不存在", 404);
  return row;
}
async function saveCustomer(db, actor, userId, v) {
  fail(
    v &&
      typeof v.paused === "boolean" &&
      v.limits &&
      !Array.isArray(v.limits) &&
      typeof v.limits === "object",
    "客户规则格式错误",
  );
  for (const [k, value] of Object.entries(v.limits)) {
    fail(k !== "login" && Object.hasOwn(ruleNames, k), "客户规则名称无效");
    integer(value, 1, 100000, "客户次数");
  }
  fail(
    !v.paused_until || typeof v.paused_until === "string",
    "恢复时间格式无效",
  );
  const until = v.paused && v.paused_until ? new Date(v.paused_until) : null;
  fail(
    !until ||
      (Number.isFinite(until.getTime()) &&
        until.getTime() > Date.now() &&
        until.getTime() < Date.now() + 365 * 86400000),
    "恢复时间须在未来一年内",
  );
  await db.tx(async (q) => {
    fail(
      (
        await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
          userId,
        ])
      ).rowCount,
      "客户不存在",
      404,
    );
    await q.query(
      `INSERT INTO platform_risk_controls(user_id,paused,paused_until,limits) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET paused=$2,paused_until=$3,limits=$4,updated_at=now()`,
      [userId, v.paused, until, v.limits],
    );
    await q.query("DELETE FROM platform_risk_buckets WHERE user_id=$1", [
      userId,
    ]);
    await audit(
      q,
      actor,
      "risk.customer",
      userId,
      JSON.stringify({
        paused: v.paused,
        paused_until: until,
        limits: v.limits,
      }),
    );
  });
}
// Called after the existing order's idempotency lookup, under the user's row lock.
async function checkNewOrder(q, userId) {
  const blocked = (
    await q.query(
      "SELECT user_id FROM platform_risk_controls WHERE user_id=$1 AND paused AND (paused_until IS NULL OR paused_until>now())",
      [userId],
    )
  ).rowCount;
  if (blocked) {
    const e = new Error("当前账户已暂停提交新订单，请联系管理员");
    e.statusCode = 403;
    e.riskKind = "customer_paused";
    throw e;
  }
}
module.exports = {
  kinds,
  event,
  consume,
  record,
  saveSettings,
  customer,
  saveCustomer,
  checkNewOrder,
};
