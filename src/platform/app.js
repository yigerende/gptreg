"use strict";
const Fastify = require("fastify");
const fs = require("node:fs");
const path = require("node:path");
const { authenticate, registerAuth } = require("./auth");
const { registerApi } = require("./api");
const { openapi } = require("./openapi");
const { fail } = require("./security");
const { siteIcon } = require("./branding");
const { requestFeature } = require("./site-controls");
const { registerRisk } = require("./risk");
function buildPlatform({
  db,
  orders,
  crypt,
  secrets,
  cwd = process.cwd(),
  workerUrl = "http://worker:3211",
  proxy = true,
}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: ["127.0.0.1", "::1"],
  });
  registerRisk(app, db);
  app.addHook("onRequest", async (r, reply) => {
    // Check the decoded path used by routing, including encoded asset names.
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(r.url, "http://local").pathname);
    } catch {
      fail(false, "请求路径无效", 400);
    }
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(r.method) &&
      !pathname.startsWith("/open/v1")
    ) {
      if (r.headers.origin) {
        let origin;
        try {
          origin = new URL(r.headers.origin);
        } catch {}
        fail(origin?.host === r.headers.host, "请求来源不允许", 403);
      }
      fail(
        r.headers["x-requested-with"] === "gptreg",
        "缺少网页请求校验标识",
        403,
      );
    }
    const admin =
      /^\/admin(?:\/|$)/.test(pathname) ||
      /^\/admin-assets(?:\/|$)/.test(pathname) ||
      pathname.startsWith("/api/admin/") ||
      pathname.startsWith("/api/v1/") ||
      /^\/assets\/Admin[^/]*\.(?:js|css)(?:\.map)?$/.test(pathname);
    if (
      admin ||
      pathname.startsWith("/api/user/") ||
      pathname.startsWith("/open/v1/")
    ) {
      const api = pathname.startsWith("/open/v1/");
      await authenticate(db, r, api);
      if (admin) fail(r.user.role === "admin", "需要管理员权限", 403);
      const settings = await db.settings();
      const feature = requestFeature(pathname, r.method);
      if (!admin && r.user.role !== "admin") {
        fail(
          !feature || settings.features[feature] !== false,
          "此功能暂未开放",
          403,
        );
        if (api)
          fail(settings.features.keys !== false, "开发接入暂未开放", 403);
      }
      if (api) {
        fail(settings.api_enabled, "API 暂未开放", 503);
      }
    }
    if (
      ["/docs", "/openapi.json"].includes(pathname) &&
      (await db.settings()).features.docs === false
    ) {
      try {
        await authenticate(db, r, false);
      } catch {}
      fail(r.user?.role === "admin", "接口文档暂未开放", 403);
    }
  });
  app.setErrorHandler((e, r, reply) => {
    let status = e.statusCode || 500,
      message = e.message;
    if (e.code === "23505") {
      status = 409;
      message = "记录已存在，请勿重复提交";
    }
    if (status >= 500 && status !== 503) {
      message = "服务暂时不可用，请稍后重试";
      console.error("Platform request error:", e.code || e.name);
    }
    reply.code(status).send({ error: message, status });
  });
  registerAuth(app, db, crypt);
  registerApi(app, db, orders, crypt);
  for (const route of ["/site-icon", "/favicon.ico", "/site-icon/default"]) {
    app.get(route, async (r, reply) => {
      const icon = siteIcon(
        route.endsWith("/default") ? {} : (await db.settings()).brand,
      );
      return reply
        .type(icon.mime)
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "no-cache")
        .header("ETag", `"${icon.hash}"`)
        .send(icon.bytes);
    });
  }
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/health/ready", async (r, reply) => {
    await db.query("SELECT 1");
    const w = await db.one("SELECT heartbeat FROM platform_worker WHERE id=1");
    const ready = Boolean(
      w && Date.now() - new Date(w.heartbeat).getTime() < 90000,
    );
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });
  app.get("/openapi.json", async () => openapi);
  if (proxy)
    app.register(require("@fastify/http-proxy"), {
      upstream: workerUrl,
      prefix: "/api/v1",
      rewritePrefix: "/api/v1",
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => ({
          ...headers,
          authorization: `Bearer ${secrets.internal}`,
          "x-gptreg-actor": request.user.id,
        }),
      },
    });
  const root = path.join(cwd, "web", "dist");
  const serveAsset = (directory) => async (r, reply) => {
    const rel = r.params["*"];
    fail(
      /^[a-zA-Z0-9._/-]+$/.test(rel) &&
        !rel.includes("..") &&
        !rel.endsWith(".map"),
      "文件不存在",
      404,
    );
    const file = path.join(root, directory, rel);
    fail(fs.existsSync(file) && fs.statSync(file).isFile(), "文件不存在", 404);
    reply.type(
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[path.extname(file)] || "application/octet-stream",
    );
    return fs.createReadStream(file);
  };
  app.get("/assets/*", serveAsset("assets"));
  app.get("/admin-assets/*", serveAsset("admin-assets"));
  app.setNotFoundHandler((r, reply) => {
    if (
      r.method !== "GET" ||
      r.url.startsWith("/api/") ||
      r.url.startsWith("/open/")
    )
      return reply.code(404).send({ error: "接口不存在" });
    const index = path.join(root, "index.html");
    if (!fs.existsSync(index))
      return reply.code(503).send({ error: "请先构建前端" });
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(index));
  });
  return app;
}
module.exports = { buildPlatform };
