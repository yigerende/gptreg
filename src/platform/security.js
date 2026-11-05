"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const id = () => crypto.randomUUID();
const digest = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
function fail(condition, message, statusCode = 400) {
  if (!condition) {
    const e = new Error(message);
    e.statusCode = statusCode;
    throw e;
  }
}
async function passwordHash(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await scrypt(value, salt, 64)).toString("hex")}`;
}
async function passwordMatches(value, hash) {
  const [, salt, expected] = String(hash || "scrypt:dummy:").split(":");
  const actual = await scrypt(String(value), salt || "dummy", 64);
  const target = Buffer.from(expected || "", "hex");
  return (
    target.length === actual.length && crypto.timingSafeEqual(target, actual)
  );
}
function loadSecrets(cwd) {
  const file = path.join(cwd, ".runtime", "platform-secrets.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        master: crypto.randomBytes(32).toString("base64"),
        internal: token(),
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  fail(
    Buffer.from(value.master, "base64").length === 32 &&
      value.internal?.length >= 32,
    "Invalid platform secrets",
    500,
  );
  return value;
}
function cipher(master) {
  const key = Buffer.from(master, "base64");
  return {
    authCodeHash(value) {
      return crypto.createHmac("sha256", key).update("gptreg/email-code/v1\0" + value).digest("hex");
    },
    encrypt(value) {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([
        c.update(JSON.stringify(value), "utf8"),
        c.final(),
      ]);
      return [
        "v1",
        iv.toString("base64"),
        c.getAuthTag().toString("base64"),
        data.toString("base64"),
      ].join(".");
    },
    decrypt(value) {
      const [v, iv, tag, data] = value.split(".");
      fail(v === "v1", "Unsupported encryption version", 500);
      const c = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64"),
      );
      c.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          c.update(Buffer.from(data, "base64")),
          c.final(),
        ]).toString("utf8"),
      );
    },
  };
}
function integer(value, min, max, label) {
  fail(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${label}须为 ${min}～${max} 的整数`,
  );
  return value;
}
module.exports = {
  id,
  digest,
  token,
  fail,
  passwordHash,
  passwordMatches,
  loadSecrets,
  cipher,
  integer,
};
