"use strict";
// Only enabled by the production worker entry point. Legacy plaintext remains
// readable, while new checkpoints and account artifacts protect secret fields.
const { cipher } = require("./security");
let cachedKey, cachedCipher;
function encryption() {
  const key = process.env.GPTREG_RUNTIME_MASTER_KEY;
  if (!key) return null;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedCipher = cipher(key);
  }
  return cachedCipher;
}
const sensitive = new Set([
  "password",
  "totpSecret",
  "totp_secret",
  "accessToken",
  "refreshToken",
  "idToken",
  "access_token",
  "refresh_token",
  "id_token",
  "sessionToken",
  "session_token",
  "cookieJar",
  "cookies",
  "apiKey",
  "adminToken",
  "client_secret",
  "codeVerifier",
  "code_verifier",
  "authorization",
]);
function protect(value) {
  const c = encryption();
  if (!c) return value;
  if (Array.isArray(value)) return value.map(protect);
  if (!value || typeof value !== "object") return value;
  if (typeof value.$gptreg_secret === "string") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      sensitive.has(k) && v !== undefined && v !== null && v !== ""
        ? { $gptreg_secret: c.encrypt(v) }
        : protect(v),
    ]),
  );
}
function unprotect(value) {
  if (Array.isArray(value)) return value.map(unprotect);
  if (!value || typeof value !== "object") return value;
  if (typeof value.$gptreg_secret === "string") {
    const c = encryption();
    if (!c)
      throw new Error(
        "Runtime master key is required to read encrypted credentials",
      );
    return c.decrypt(value.$gptreg_secret);
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, unprotect(v)]),
  );
}
function parse(text) {
  return unprotect(JSON.parse(text));
}
module.exports = { protect, unprotect, parse };
