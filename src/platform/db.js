"use strict";
const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const { id, passwordHash } = require("./security");
const { brandDefaults } = require("./branding");
const defaults = {
  site_name: "GPT Register",
  brand: brandDefaults,
  announcement: "",
  registration_open: true,
  email_verify_enabled: false,
  email_domains: [],
  orders_open: false,
  api_enabled: true,
  worker_enabled: true,
  price_standard: 50,
  price_oauth: 100,
  max_quantity: 50,
  max_open_orders: 3,
  attempt_limit: 2,
  timeout_minutes: 20,
  template: {},
  smtp: { host: "", port: 465, secure: true, user: "", password: "", from: "" },
};
class Database {
  constructor(url) {
    this.pool = new Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 10000,
    });
  }
  query(sql, params = []) {
    return this.pool.query(sql, params);
  }
  async one(sql, params = []) {
    return (await this.query(sql, params)).rows[0];
  }
  async tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async initialize(credentials) {
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(8963001)");
      await c.query(
        fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"),
      );
      await c.query(
        "INSERT INTO platform_settings(id,value) VALUES(1,$1) ON CONFLICT DO NOTHING",
        [defaults],
      );
      if (
        credentials &&
        !(
          await c.query(
            "SELECT id FROM platform_users WHERE role='admin' LIMIT 1",
          )
        ).rows.length
      ) {
        await c.query(
          "INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'admin')",
          [
            id(),
            credentials.username.toLowerCase(),
            "管理员",
            await passwordHash(credentials.password),
          ],
        );
      }
    });
  }
  async settings() {
    const value = (await this.one("SELECT value FROM platform_settings WHERE id=1")).value;
    return {
      ...defaults,
      ...value,
      brand: { ...brandDefaults, ...value.brand },
    };
  }
  async limit(key, max, seconds = 60) {
    const r = await this.one(
      "INSERT INTO platform_rate_limits(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN platform_rate_limits.expires_at<now() THEN 1 ELSE platform_rate_limits.hits+1 END,expires_at=CASE WHEN platform_rate_limits.expires_at<now() THEN now()+$2*interval '1 second' ELSE platform_rate_limits.expires_at END RETURNING hits",
      [key, seconds],
    );
    return r.hits <= max;
  }
  close() {
    return this.pool.end();
  }
}
const audit = (q, actor, action, target = "", detail = "") =>
  q.query(
    "INSERT INTO platform_audit(actor_id,action,target,detail) VALUES($1,$2,$3,$4)",
    [actor, action, target, detail],
  );
module.exports = { Database, defaults, audit };
