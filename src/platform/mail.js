"use strict";
const nodemailer = require("nodemailer");
const { fail } = require("./security");
const { page } = require("./reports");
async function sendMail(db, crypt, settings, email, purpose, subject, text) {
  const smtp = settings.smtp;
  fail(smtp.host && smtp.from, "邮件服务尚未配置", 503);
  const entry = await db.one(
    "INSERT INTO platform_mail_logs(recipient,purpose,status) VALUES($1,$2,'pending') RETURNING id",
    [email, purpose],
  );
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user
      ? {
          user: smtp.user,
          pass: smtp.password ? crypt.decrypt(smtp.password) : "",
        }
      : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({
      from: smtp.from,
      to: email,
      subject,
      text,
    });
    fail(result.accepted?.length > 0, "收件人未被邮件服务器接受", 503);
    await db.query(
      "UPDATE platform_mail_logs SET status='sent',detail='邮件服务器已接受发送' WHERE id=$1",
      [entry.id],
    );
  } catch (e) {
    const code = [
      "EAUTH",
      "ECONNECTION",
      "ETIMEDOUT",
      "ESOCKET",
      "EENVELOPE",
    ].includes(e.code)
      ? e.code
      : "SEND_FAILED";
    await db.query(
      "UPDATE platform_mail_logs SET status='failed',detail=$2 WHERE id=$1",
      [entry.id, `发送失败 (${code})，请检查邮件配置与网络`],
    );
    fail(false, "邮件发送失败，请检查邮件配置与发送记录", 503);
  } finally {
    transport.close();
  }
  await db.query(
    "DELETE FROM platform_mail_logs WHERE created_at<now()-interval '90 days'",
  );
}
function registerMail(app, db, crypt) {
  app.get("/api/admin/v1/mail/logs", async (r) => {
    const p = page(r.query);
    const [items, count] = await Promise.all([
      db.query(
        "SELECT * FROM platform_mail_logs ORDER BY id DESC LIMIT $1 OFFSET $2",
        [p.limit, p.offset],
      ),
      db.one("SELECT count(*)::int AS total FROM platform_mail_logs"),
    ]);
    return { items: items.rows, total: count.total, ...p };
  });
  app.post("/api/admin/v1/mail/test", async (r) => {
    const email = String(r.body?.email || "").trim();
    fail(
      email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      "请输入有效的收件邮箱",
    );
    fail(
      await db.limit(`mailtest:${r.user.id}`, 3),
      "测试过于频繁，请稍后重试",
      429,
    );
    const s = await db.settings();
    await sendMail(
      db,
      crypt,
      s,
      email,
      "test",
      `${s.site_name} 测试邮件`,
      "这是一封邮件配置测试邮件，您已成功接收。",
    );
    return { message: "邮件服务器已接受测试邮件，请检查收件箱。" };
  });
}
module.exports = { sendMail, registerMail };
