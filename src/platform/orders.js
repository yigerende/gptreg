"use strict";
const { id, digest, fail, integer } = require("./security");
const { audit } = require("./db");
const { checkNewOrder } = require("./risk-store");
const { expiresAt, availableAccount } = require("./account-retention");
const publicOrder = (row) =>
  Object.fromEntries(
    [
      "id",
      "quantity",
      "need_oauth",
      "unit_price",
      "status",
      "delivered",
      "charged",
      "released",
      "cancel_requested",
      "source",
      "created_at",
      "updated_at",
    ].map((k) => [k, row[k]]),
  );
async function ledger(q, userId, reference, kind, points, frozen, note) {
  const inserted = await q.query(
    "INSERT INTO platform_ledger(id,user_id,reference,kind,points_delta,frozen_delta,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,reference) DO NOTHING RETURNING id",
    [id(), userId, reference, kind, points, frozen, note],
  );
  if (!inserted.rowCount) return false;
  const balance = await q.query(
    "UPDATE platform_users SET points=points+$2,frozen=frozen+$3 WHERE id=$1 RETURNING points,frozen",
    [userId, points, frozen],
  );
  await q.query(
    "UPDATE platform_ledger SET points_after=$2,frozen_after=$3 WHERE id=$1",
    [inserted.rows[0].id, balance.rows[0].points, balance.rows[0].frozen],
  );
  return true;
}
class Orders {
  constructor(db, crypt) {
    this.db = db;
    this.crypt = crypt;
  }
  async create(user, body, key, source) {
    fail(
      body && typeof body === "object" && !Array.isArray(body),
      "请求格式错误",
    );
    fail(
      Object.keys(body).every((k) => ["quantity", "need_oauth"].includes(k)),
      "仅支持 quantity 和 need_oauth 参数",
    );
    const quantity = integer(body.quantity, 1, 1000, "数量");
    fail(
      body.need_oauth === undefined || typeof body.need_oauth === "boolean",
      "need_oauth 必须为布尔值",
    );
    const oauth = body.need_oauth === true;
    fail(
      typeof key === "string" && /^[\x21-\x7e]{8,128}$/.test(key),
      "请提供 8～128 位 Idempotency-Key",
    );
    const hash = digest(JSON.stringify({ quantity, need_oauth: oauth }));
    return this.db.tx(async (q) => {
      const u = (
        await q.query("SELECT * FROM platform_users WHERE id=$1 FOR UPDATE", [
          user.id,
        ])
      ).rows[0];
      fail(u?.status === "active", "账户已停用", 403);
      const previous = (
        await q.query(
          "SELECT * FROM platform_orders WHERE user_id=$1 AND request_key=$2",
          [user.id, key],
        )
      ).rows[0];
      if (previous) {
        fail(previous.request_hash === hash, "相同幂等键不能用于不同请求", 409);
        return { order: publicOrder(previous), replayed: true };
      }
      await checkNewOrder(q, user.id);
      const s = (
        await q.query(
          "SELECT value FROM platform_settings WHERE id=1 FOR SHARE",
        )
      ).rows[0].value;
      fail(s.orders_open, "暂未开放下单，请稍后再试", 503);
      fail(source !== "api" || s.api_enabled, "API 暂未开放", 503);
      fail(quantity <= s.max_quantity, `每单最多 ${s.max_quantity} 个账号`);
      const count = (
        await q.query(
          "SELECT count(*)::int AS n FROM platform_orders WHERE user_id=$1 AND status IN ('queued','running','review')",
          [user.id],
        )
      ).rows[0].n;
      fail(count < s.max_open_orders, "进行中的订单已达上限", 429);
      const price = oauth ? s.price_oauth : s.price_standard,
        total = price * quantity;
      fail(u.points >= total, "可用积分不足", 402);
      const orderId = id();
      const order = (
        await q.query(
          "INSERT INTO platform_orders(id,user_id,quantity,need_oauth,unit_price,source,request_key,request_hash,template,attempt_limit,timeout_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            orderId,
            user.id,
            quantity,
            oauth,
            price,
            source,
            key,
            hash,
            s.template,
            s.attempt_limit,
            s.timeout_minutes,
          ],
        )
      ).rows[0];
      await ledger(
        q,
        user.id,
        `reserve:${orderId}`,
        "reserve",
        -total,
        total,
        `订单预留 ${quantity} 个账号`,
      );
      for (let n = 1; n <= quantity; n++)
        await q.query(
          "INSERT INTO platform_items(id,order_id,position) VALUES($1,$2,$3)",
          [id(), orderId, n],
        );
      await audit(q, user.id, "order.create", orderId, `${quantity}/${oauth}`);
      return { order: publicOrder(order), replayed: false };
    });
  }
  async list(userId, limit = 50, offset = 0) {
    return (
      await this.db.query(
        "SELECT * FROM platform_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [userId, limit, offset],
      )
    ).rows.map(publicOrder);
  }
  async detail(userId, orderId) {
    const row = await this.db.one(
      "SELECT * FROM platform_orders WHERE id=$1 AND user_id=$2",
      [orderId, userId],
    );
    fail(row, "订单不存在", 404);
    const items = (
      await this.db.query(
        "SELECT id,position,status,attempts,oauth_attempts,recovery_attempts,message,CASE WHEN status IN ('queued','oauth_pending','running','review') THEN available_at END AS next_retry_at,execution_started_at,execution_started_at+$2*interval '1 minute' AS execution_deadline_at,updated_at FROM platform_items WHERE order_id=$1 ORDER BY position",
        [orderId, row.timeout_minutes],
      )
    ).rows;
    return { ...publicOrder(row), items };
  }
  async cancel(userId, orderId) {
    await this.db.tx(async (q) => {
      const o = (
        await q.query(
          "SELECT * FROM platform_orders WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [orderId, userId],
        )
      ).rows[0];
      fail(o, "订单不存在", 404);
      if (!["queued", "running", "review"].includes(o.status)) return;
      await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
        userId,
      ]);
      await q.query(
        "UPDATE platform_orders SET cancel_requested=true,updated_at=now() WHERE id=$1",
        [orderId],
      );
      const items = (
        await q.query(
          "SELECT * FROM platform_items WHERE order_id=$1 AND status IN ('queued','oauth_pending') FOR UPDATE",
          [orderId],
        )
      ).rows;
      for (const item of items)
        await this.release(q, o, item, "cancelled", "已取消未执行部分");
      await this.refresh(q, orderId);
      await audit(q, userId, "order.cancel", orderId);
    });
    return this.detail(userId, orderId);
  }
  async release(q, o, item, status, message) {
    const settled = await this.settlement(q, o, item);
    if (settled) return settled;
    if (
      await ledger(
        q,
        o.user_id,
        `release:${item.id}`,
        "release",
        o.unit_price,
        -o.unit_price,
        message,
      )
    ) {
      await q.query(
        "UPDATE platform_items SET status=$2,message=$3,updated_at=now() WHERE id=$1",
        [item.id, status, message],
      );
      await q.query(
        "UPDATE platform_orders SET released=released+$2,updated_at=now() WHERE id=$1",
        [o.id, o.unit_price],
      );
    }
    await this.queueCleanup(q, item);
    return { status, refunded: true, delivered: false };
  }
  async queueCleanup(q, item) {
    await q.query(
      `INSERT INTO platform_run_cleanup(run_id,item_id)
       SELECT run_id,item_id FROM platform_attempts WHERE item_id=$1
       UNION SELECT run_id,id FROM platform_items WHERE id=$1 AND run_id IS NOT NULL
       ON CONFLICT(run_id) DO NOTHING`, [item.id]);
  }
  async settlement(q, o, item) {
    const entries = (await q.query(
      "SELECT kind,note FROM platform_ledger WHERE user_id=$1 AND reference=ANY($2::text[])",
      [o.user_id, [`release:${item.id}`, `charge:${item.id}`]],
    )).rows;
    if (!entries.length) return null;
    fail(entries.length === 1, "结算流水冲突，需要检查账本", 409);
    const delivered = entries[0].kind === "charge";
    const status = delivered ? "delivered" : o.cancel_requested ? "cancelled" : "failed";
    await q.query(
      "UPDATE platform_items SET status=$2,message=$3,updated_at=now() WHERE id=$1 AND status<>$2",
      [item.id, status, delivered ? "已交付" : entries[0].note],
    );
    await this.queueCleanup(q, item);
    return { status, delivered, refunded: !delivered };
  }
  async repairSettled(itemId) {
    return this.withItem(itemId, async (q, o, item) => {
      const result = await this.settlement(q, o, item);
      if (result) await this.refresh(q, o.id);
      return result;
    });
  }
  async withItem(itemId, fn) {
    return this.db.tx(async (q) => {
      const link = (
        await q.query("SELECT order_id FROM platform_items WHERE id=$1", [
          itemId,
        ])
      ).rows[0];
      fail(link, "任务不存在", 404);
      const o = (
        await q.query("SELECT * FROM platform_orders WHERE id=$1 FOR UPDATE", [
          link.order_id,
        ])
      ).rows[0];
      await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
        o.user_id,
      ]);
      const item = (
        await q.query("SELECT * FROM platform_items WHERE id=$1 FOR UPDATE", [
          itemId,
        ])
      ).rows[0];
      return fn(q, o, item);
    });
  }
  async finish(itemId, credentials, reason = "注册未完成，已退回预留积分", runId) {
    return this.withItem(itemId, async (q, o, item) => {
      const settled = await this.settlement(q, o, item);
      if (settled) {
        await this.refresh(q, o.id);
        return settled;
      }
      if (runId !== undefined && item.run_id !== runId) return null;
      if (["delivered", "failed", "cancelled"].includes(item.status))
        return { status: item.status, delivered: item.status === "delivered", refunded: item.status !== "delivered" };
      if (credentials) {
        fail(!(await q.query("SELECT 1 FROM platform_quarantined_assets WHERE asset_id=$1", [credentials.asset_id])).rowCount,
          "账号已被隔离，不能交付", 409);
        fail(
          credentials.email &&
            credentials.password &&
            credentials.totp_secret &&
            (!o.need_oauth || credentials.oauth?.refresh_token),
          "交付数据不完整",
          409,
        );
        await q.query(
          "INSERT INTO platform_accounts(id,user_id,order_id,item_id,asset_id,email,need_oauth,credentials) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id(),
            o.user_id,
            o.id,
            item.id,
            credentials.asset_id,
            credentials.email.toLowerCase(),
            o.need_oauth,
            this.crypt.encrypt(credentials),
          ],
        );
        await ledger(
          q,
          o.user_id,
          `charge:${item.id}`,
          "charge",
          0,
          -o.unit_price,
          "账号成功交付",
        );
        await q.query(
          "UPDATE platform_items SET status='delivered',message='已交付',updated_at=now() WHERE id=$1",
          [itemId],
        );
        await q.query(
          "UPDATE platform_orders SET delivered=delivered+1,charged=charged+$2,updated_at=now() WHERE id=$1",
          [o.id, o.unit_price],
        );
      } else
        await this.release(
          q,
          o,
          item,
          o.cancel_requested ? "cancelled" : "failed",
          reason,
        );
      await this.refresh(q, o.id);
      await this.queueCleanup(q, item);
      return { status: credentials ? "delivered" : o.cancel_requested ? "cancelled" : "failed",
        delivered: Boolean(credentials), refunded: !credentials };
    });
  }
  async refresh(q, orderId) {
    const o = (
      await q.query("SELECT * FROM platform_orders WHERE id=$1", [orderId])
    ).rows[0];
    const items = (
      await q.query("SELECT status FROM platform_items WHERE order_id=$1", [
        orderId,
      ])
    ).rows;
    let status = items.some((x) => x.status === "review")
      ? "review"
      : items.some((x) => ["running", "oauth_pending"].includes(x.status))
        ? "running"
        : items.some((x) => x.status === "queued")
          ? "queued"
          : o.delivered === o.quantity
            ? "completed"
            : o.delivered > 0
              ? "partial"
              : o.cancel_requested
                ? "cancelled"
                : "failed";
    await q.query(
      "UPDATE platform_orders SET status=$2,updated_at=now() WHERE id=$1",
      [orderId, status],
    );
  }
  async account(userId, accountId) {
    const a = await this.db.one(
      `SELECT *,${expiresAt()} AS download_expires_at FROM platform_accounts WHERE id=$1 AND user_id=$2 AND ${availableAccount()}`,
      [accountId, userId],
    );
    fail(a, "账号不存在、无权访问或领取资料已超过 72 小时", 404);
    return a;
  }
  async reveal(userId, accountId) {
    const a = await this.account(userId, accountId);
    await audit(this.db, userId, "account.credentials", accountId);
    return {
      ...this.crypt.decrypt(a.credentials),
      download_expires_at: a.download_expires_at,
    };
  }
}
module.exports = { Orders, ledger, publicOrder };
