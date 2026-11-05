"use strict";
const crypto = require("node:crypto");
const { sendMail } = require("./mail");
const { activeAnnouncements } = require("./site-controls");
const {
  id,
  token,
  digest,
  fail,
  passwordHash,
  passwordMatches,
} = require("./security");
const { audit } = require("./db");
const { publicBrand } = require("./branding");
const userView = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  points: u.points,
  frozen: u.frozen,
  created_at: u.created_at,
});
const emailValid = (e) =>
  typeof e === "string" &&
  e.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const passwordValid = (p) =>
  typeof p === "string" && p.length >= 10 && p.length <= 72;
const cookieToken = (r) =>
  String(r.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("gptreg_session="))
    ?.slice(15) || "";
function registerAuth(app, db, crypt) {
  const cookie = (r, reply, value, maxAge) =>
    reply.header(
      "Set-Cookie",
      `gptreg_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${r.protocol === "https" ? "; Secure" : ""}`,
    );
  async function session(r, reply, userId) {
    const t = token();
    await db.query(
      "INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [digest(t), userId],
    );
    cookie(r, reply, t, 86400);
    return { ok: true };
  }
  async function consume(q, email, purpose, code) {
    const row = (
      await q.query(
        "SELECT * FROM platform_email_codes WHERE email=$1 AND purpose=$2 FOR UPDATE",
        [email, purpose],
      )
    ).rows[0];
    if (!row || row.expires_at < new Date() || row.attempts >= 5)
      return "验证码已失效，请重新获取";
    if (
      !/^\d{6}$/.test(String(code)) ||
      row.hash !== digest(`${email}:${purpose}:${code}`)
    ) {
      await q.query(
        "UPDATE platform_email_codes SET attempts=attempts+1 WHERE email=$1 AND purpose=$2",
        [email, purpose],
      );
      return "验证码不正确";
    }
    await q.query(
      "DELETE FROM platform_email_codes WHERE email=$1 AND purpose=$2",
      [email, purpose],
    );
    return "";
  }
  app.get("/api/public", async () => {
    const s = await db.settings();
    return {
      site_name: s.site_name,
      brand: publicBrand(s.brand),
      announcement: s.announcement,
      announcements: activeAnnouncements(s),
      features: s.features,
      registration_open: s.registration_open,
      email_verify_enabled: s.email_verify_enabled,
      email_domains: s.email_domains,
      password_reset_available: Boolean(s.smtp.host),
      orders_open: s.orders_open,
      price_standard: s.price_standard,
      price_oauth: s.price_oauth,
      max_quantity: s.max_quantity,
    };
  });
  app.post("/api/auth/login", async (r, reply) => {
    const v = r.body || {};
    fail(
      typeof v.password === "string" && v.password.length <= 128,
      "账号或密码不正确",
      401,
    );
    const u = await db.one("SELECT * FROM platform_users WHERE email=$1", [
      String(v.email || "")
        .trim()
        .toLowerCase(),
    ]);
    const valid = await passwordMatches(v.password, u?.password_hash);
    fail(
      u && valid && u.status === "active",
      "账号或密码不正确，或账户已停用",
      401,
    );
    r.user = u;
    return session(r, reply, u.id);
  });
  app.post("/api/auth/logout", async (r, reply) => {
    await db.query("DELETE FROM platform_sessions WHERE hash=$1", [
      digest(cookieToken(r)),
    ]);
    cookie(r, reply, "", 0);
    return { ok: true };
  });
  app.post("/api/auth/email-code", async (r) => {
    fail(await db.limit(`email:${r.ip}`, 5), "发送过于频繁，请稍后再试", 429);
    const { purpose } = r.body || {},
      email = String(r.body?.email || "")
        .trim()
        .toLowerCase();
    fail(
      emailValid(email) && ["register", "reset"].includes(purpose),
      "邮箱或用途不正确",
    );
    const s = await db.settings();
    fail(s.smtp.host && s.smtp.from, "邮件服务尚未配置", 503);
    fail(purpose !== "register" || s.registration_open, "暂未开放注册", 403);
    const code = String(crypto.randomInt(100000, 1000000));
    await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `code:${email}`,
      ]);
      const previous = (
        await q.query(
          "SELECT sent_at FROM platform_email_codes WHERE email=$1 AND purpose=$2",
          [email, purpose],
        )
      ).rows[0];
      fail(
        !previous || Date.now() - new Date(previous.sent_at).getTime() >= 60000,
        "请在 60 秒后重发",
        429,
      );
      await q.query(
        "INSERT INTO platform_email_codes(email,purpose,hash,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes') ON CONFLICT(email,purpose) DO UPDATE SET hash=$3,expires_at=now()+interval '15 minutes',attempts=0,sent_at=now()",
        [email, purpose, digest(`${email}:${purpose}:${code}`)],
      );
    });
    const exists = await db.one(
      "SELECT id FROM platform_users WHERE email=$1 AND status=$2",
      [email, "active"],
    );
    if (purpose === "register" || exists) {
      try {
        await sendMail(
          db,
          crypt,
          s,
          email,
          purpose,
          `${s.site_name} 邮箱验证码`,
          `您的验证码：${code}，15 分钟内有效。请勿分享给他人。`,
        );
      } catch {
        await db.query(
          "DELETE FROM platform_email_codes WHERE email=$1 AND purpose=$2 AND hash=$3",
          [email, purpose, digest(`${email}:${purpose}:${code}`)],
        );
        fail(false, "邮件发送失败，请联系管理员检查邮件服务", 503);
      }
    }
    return {
      message: "如果邮箱符合条件，验证码将发送至该邮箱。",
      retry_after: 60,
    };
  });
  app.post("/api/auth/register", async (r, reply) => {
    fail(
      await db.limit(`register:${r.ip}`, 5),
      "注册过于频繁，请稍后再试",
      429,
    );
    const v = r.body || {},
      email = String(v.email || "")
        .trim()
        .toLowerCase(),
      name = String(v.name || "").trim();
    fail(
      emailValid(email) &&
        name.length >= 1 &&
        name.length <= 80 &&
        passwordValid(v.password),
      "请填写邮箱、用户名及 10～72 位密码",
    );
    const hashed = await passwordHash(v.password),
      uid = id();
    const error = await db.tx(async (q) => {
      const s = (
        await q.query(
          "SELECT value FROM platform_settings WHERE id=1 FOR SHARE",
        )
      ).rows[0].value;
      fail(s.registration_open, "暂未开放注册", 403);
      fail(
        !s.email_domains.length ||
          s.email_domains.includes(email.split("@")[1]),
        "此邮箱域名暂不支持注册",
      );
      if (s.email_verify_enabled) {
        const error = await consume(q, email, "register", v.code);
        if (error) return error;
      }
      await q.query(
        "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [uid, email, name, hashed],
      );
      return "";
    });
    fail(!error, error);
    return session(r, reply, uid);
  });
  app.post("/api/auth/reset-password", async (r) => {
    fail(await db.limit(`reset:${r.ip}`, 10), "尝试过于频繁", 429);
    const v = r.body || {},
      email = String(v.email || "")
        .trim()
        .toLowerCase();
    fail(
      emailValid(email) && passwordValid(v.password),
      "请填写邮箱及 10～72 位新密码",
    );
    const hashed = await passwordHash(v.password);
    const error = await db.tx(async (q) => {
      const u = (
        await q.query(
          "SELECT * FROM platform_users WHERE email=$1 FOR UPDATE",
          [email],
        )
      ).rows[0];
      const e = await consume(q, email, "reset", v.code);
      if (e || !u || u.status !== "active") return e || "验证码无效";
      await q.query("UPDATE platform_users SET password_hash=$2 WHERE id=$1", [
        u.id,
        hashed,
      ]);
      await q.query("DELETE FROM platform_sessions WHERE user_id=$1", [u.id]);
      await q.query(
        "UPDATE platform_api_keys SET revoked=true WHERE user_id=$1",
        [u.id],
      );
      await audit(q, u.id, "password.reset");
      return "";
    });
    fail(!error, error);
    return { message: "密码已重置，请重新登录。原登录会话和 API 密钥已失效。" };
  });
  app.get("/api/user/v1/me", async (r) => userView(r.user));
  app.patch("/api/user/v1/me", async (r) => {
    const v = r.body || {},
      name = String(v.name || "").trim();
    fail(name.length >= 1 && name.length <= 80, "用户名长度须为 1～80");
    if (v.password)
      fail(
        passwordValid(v.password) &&
          (await passwordMatches(v.old_password, r.user.password_hash)),
        "原密码不正确或新密码须为 10～72 位",
      );
    await db.tx(async (q) => {
      await q.query("UPDATE platform_users SET name=$2 WHERE id=$1", [
        r.user.id,
        name,
      ]);
      if (v.password) {
        await q.query(
          "UPDATE platform_users SET password_hash=$2 WHERE id=$1",
          [r.user.id, await passwordHash(v.password)],
        );
        await q.query("DELETE FROM platform_sessions WHERE user_id=$1", [
          r.user.id,
        ]);
        await q.query(
          "UPDATE platform_api_keys SET revoked=true WHERE user_id=$1",
          [r.user.id],
        );
      }
      await audit(q, r.user.id, "profile.update");
    });
    return { ok: true, relogin: Boolean(v.password) };
  });
}
async function authenticate(db, r, api = false) {
  let u;
  if (api) {
    const m = /^Bearer (gr_[A-Za-z0-9_-]{43})$/.exec(
      r.headers.authorization || "",
    );
    fail(m, "请提供有效的 Bearer API Key", 401);
    u = await db.one(
      "SELECT u.*,k.scopes,k.id AS key_id FROM platform_api_keys k JOIN platform_users u ON u.id=k.user_id WHERE k.hash=$1 AND NOT k.revoked",
      [digest(m[1])],
    );
  } else {
    const t = cookieToken(r);
    fail(t, "请先登录", 401);
    u = await db.one(
      "SELECT u.* FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now()",
      [digest(t)],
    );
  }
  fail(u && u.status === "active", "登录已失效或账户已停用", 401);
  r.user = u;
  return u;
}
module.exports = { registerAuth, authenticate, userView };
