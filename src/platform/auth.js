"use strict";
const crypto = require("node:crypto");
const { sendMail } = require("./mail");
const { activeAnnouncements, customerNavigation } = require("./site-controls");
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
const { trustedPeer } = require("./risk-config");
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
  /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e);
const passwordValid = (p) =>
  typeof p === "string" && p.length >= 10 && p.length <= 72;
const cookieToken = (r) =>
  String(r.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("gptreg_session="))
    ?.slice(15) || "";
const codeHash = (crypt, email, purpose, code, challenge) =>
  crypt.authCodeHash(JSON.stringify([email, purpose, challenge, code]));
const sourceIP = (r) => r.risk?.source_ip || r.raw.socket.remoteAddress;
const allowedEmail = (s, email) => !s.email_domains.length || s.email_domains.includes(email.split("@")[1]);
function registerAuth(app, db, crypt, { publicOrigin = "", secureCookies = false } = {}) {
  let origin;
  if (publicOrigin) {
    origin = new URL(publicOrigin);
    fail(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "PUBLIC_ORIGIN 格式无效", 500);
  }
  const secure = (r) => secureCookies || Boolean(r.raw.socket.encrypted) ||
    (origin?.protocol === "https:" && r.headers.host === origin.host) ||
    (trustedPeer(r, r.risk?.cfg.trusted_proxies || []) && r.headers["x-forwarded-proto"] === "https");
  const cookie = (r, reply, value, maxAge) =>
    reply.header(
      "Set-Cookie",
      `gptreg_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(r) ? "; Secure" : ""}`,
    );
  const {consumeSlider}=require("./login-slider").registerSlider(app,db,secure);
  async function insertSession(q, userId, t) {
    await q.query("INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", [digest(t), userId]);
  }
  async function session(r, reply, verified) {
    const t = token();
    r.user = await db.tx(async (q) => {
      const current = (await q.query("SELECT * FROM platform_users WHERE id=$1 FOR UPDATE", [verified.id])).rows[0];
      fail(current?.status === "active" && current.password_hash === verified.password_hash && current.email === verified.email, "登录信息已变更，请重新登录", 401);
      await insertSession(q, current.id, t);
      return current;
    });
    cookie(r, reply, t, 86400);
    return { ok: true };
  }
  async function consume(q, email, purpose, code, user) {
    const row = (
      await q.query(
        "SELECT * FROM platform_email_codes WHERE email=$1 AND purpose=$2 FOR UPDATE",
        [email, purpose],
      )
    ).rows[0];
    if (!row || !row.challenge_id || !row.delivered || row.expires_at <= new Date() || row.attempts >= 5)
      return "验证码已失效，请重新获取";
    await q.query("UPDATE platform_email_codes SET attempts=attempts+1 WHERE email=$1 AND purpose=$2", [email, purpose]);
    const expected = Buffer.from(codeHash(crypt, email, purpose, code, row.challenge_id));
    const actual = Buffer.from(row.hash);
    if (
      typeof code !== "string" || !/^\d{6}$/.test(code) ||
      actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)
    ) {
      return "验证码不正确";
    }
    if (purpose === "reset" && (!user || user.status !== "active" || row.user_id !== user.id || row.credential_hash !== digest(user.password_hash)))
      return "验证码已失效，请重新获取";
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
      features: {...s.features, partners: s.features.partners !== false && s.invitations.enabled},
      registration_open: s.registration_open,
      login_slider_enabled:s.login_slider_enabled,
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
    await consumeSlider(r,v.slider_proof);
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
    return session(r, reply, u);
  });
  app.post("/api/auth/logout", async (r, reply) => {
    await db.query("DELETE FROM platform_sessions WHERE hash=$1", [
      digest(cookieToken(r)),
    ]);
    cookie(r, reply, "", 0);
    return { ok: true };
  });
  app.post("/api/auth/email-code", async (r) => {
    fail(await db.limit(`email:${sourceIP(r)}`, 5), "发送过于频繁，请稍后再试", 429);
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
    if (purpose === "register") {
      fail(s.email_verify_enabled, "当前注册无需邮箱验证码", 403);
      fail(allowedEmail(s, email), "此邮箱域名暂不支持注册");
    }
    fail(await db.limit(`email-day-ip:${sourceIP(r)}`, 100, 86400), "今日发送次数已达上限", 429);
    fail(await db.limit(`email-day-recipient:${digest(email)}`, 20, 86400), "此邮箱今日发送次数已达上限", 429);
    const code = String(crypto.randomInt(100000, 1000000));
    const challenge = id(), hash = codeHash(crypt, email, purpose, code, challenge);
    const eligible = await db.tx(async (q) => {
      const current = (await q.query("SELECT value FROM platform_settings WHERE id=1 FOR SHARE")).rows[0].value;
      if (purpose === "register") {
        fail(current.registration_open, "暂未开放注册", 403);
        fail(current.email_verify_enabled, "当前注册无需邮箱验证码", 403);
        fail(allowedEmail(current, email), "此邮箱域名暂不支持注册");
      }
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
      const user = (await q.query("SELECT id,password_hash,status FROM platform_users WHERE email=$1", [email])).rows[0];
      await q.query(
        "INSERT INTO platform_email_codes(email,purpose,hash,expires_at,challenge_id,user_id,credential_hash,delivered) VALUES($1,$2,$3,now()+interval '15 minutes',$4,$5,$6,false) ON CONFLICT(email,purpose) DO UPDATE SET hash=$3,expires_at=now()+interval '15 minutes',attempts=0,sent_at=now(),challenge_id=$4,user_id=$5,credential_hash=$6,delivered=false",
        [email, purpose, hash, challenge, user?.id || "", user ? digest(user.password_hash) : ""],
      );
      return purpose === "register" ? !user : user?.status === "active";
    });
    if (eligible) {
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
        await db.query("UPDATE platform_email_codes SET delivered=true WHERE email=$1 AND purpose=$2 AND challenge_id=$3", [email, purpose, challenge]);
      } catch {
        await db.query(
          "DELETE FROM platform_email_codes WHERE email=$1 AND purpose=$2 AND challenge_id=$3",
          [email, purpose, challenge],
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
      await db.limit(`register:${sourceIP(r)}`, 5),
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
      uid = id(), sessionToken = token();
    const error = await db.tx(async (q) => {
      const s = (
        await q.query(
          "SELECT value FROM platform_settings WHERE id=1 FOR SHARE",
        )
      ).rows[0].value;
      fail(s.registration_open, "暂未开放注册", 403);
      fail(
        allowedEmail(s, email),
        "此邮箱域名暂不支持注册",
      );
      if (s.email_verify_enabled) {
        const error = await consume(q, email, "register", v.code);
        if (error) return error;
      }
      let inviter=null;
      if(v.invite){
        fail(typeof v.invite==='string'&&v.invite.length<=80,'邀请标识无效');
        inviter=(await q.query("SELECT id FROM platform_users WHERE invite_code=$1 AND status='active' FOR SHARE",[v.invite])).rows[0]?.id;
        fail(inviter,'邀请标识无效');
      }
      await q.query(
        "INSERT INTO platform_users(id,email,name,password_hash,invited_by) VALUES($1,$2,$3,$4,$5)",
        [uid, email, name, hashed,inviter],
      );
      await insertSession(q, uid, sessionToken);
      return "";
    });
    fail(!error, error);
    cookie(r, reply, sessionToken, 86400);
    return { ok: true };
  });
  app.post("/api/auth/reset-password", async (r) => {
    fail(await db.limit(`reset:${sourceIP(r)}`, 10), "尝试过于频繁", 429);
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
      const e = await consume(q, email, "reset", v.code, u);
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
  app.get("/api/user/v1/me", async (r) => ({...userView(r.user), navigation: customerNavigation(await db.settings(), r.user.role)}));
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
    const hashed = v.password ? await passwordHash(v.password) : null;
    await db.tx(async (q) => {
      const current = (await q.query("SELECT * FROM platform_users WHERE id=$1 FOR UPDATE", [r.user.id])).rows[0];
      fail(current?.status === "active" && current.password_hash === r.user.password_hash, "登录信息已变更，请重新登录", 401);
      const validSession = (await q.query("SELECT 1 FROM platform_sessions WHERE hash=$1 AND user_id=$2 AND expires_at>now()", [digest(cookieToken(r)), current.id])).rowCount;
      fail(validSession, "登录已失效，请重新登录", 401);
      await q.query("UPDATE platform_users SET name=$2 WHERE id=$1", [
        r.user.id,
        name,
      ]);
      if (v.password) {
        await q.query(
          "UPDATE platform_users SET password_hash=$2 WHERE id=$1",
          [r.user.id, hashed],
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
module.exports = { registerAuth, authenticate, userView, codeHash };
