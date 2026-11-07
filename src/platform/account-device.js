"use strict";
const { deviceRow } = require("../ui-server/device-fingerprints");
const { availableAccount, expiresAt } = require("./account-retention");
const { fail } = require("./security");
const { audit } = require("./db");

// Only the delivered account's saved device configuration. No global inventory,
// proxy credentials, source tasks, cookies or other accounts are exposed.
function accountDevice(asset) {
  const { fingerprint, deviceId, countryCode, profile, exitIp, exitIpCheckedAt, registeredAt } = deviceRow(asset || {}, false);
  return { fingerprint, deviceId, countryCode, profile, exitIp, exitIpCheckedAt, registeredAt };
}
function storedDevice(value) {
  if (!value || typeof value !== "object") return null;
  return accountDevice({ clientProfileFingerprint: value.fingerprint, oaiDid: value.deviceId,
    registeredAt: value.registeredAt,
    sourceProxy: { countryCode: value.countryCode, exitIp: value.exitIp, exitIpCheckedAt: value.exitIpCheckedAt }, clientProfile: value.profile });
}
function registerAccountDevice(app, db, crypt) {
  for (const admin of [false, true]) {
    const prefix = admin ? "/api/admin/v1" : "/api/user/v1";
    app.get(`${prefix}/accounts/:id/device-fingerprint`, async r => {
      const row = await db.one(`SELECT *,${expiresAt()} AS download_expires_at FROM platform_accounts WHERE id=$1${admin ? "" : ` AND user_id=$2 AND ${availableAccount()}`}`,
        admin ? [r.params.id] : [r.params.id, r.user.id]);
      fail(row, "账号不存在、无权访问或领取资料已到期", 404);
      const c = crypt.decrypt(row.credentials);
      fail(c.asset_id === row.asset_id && String(c.email || "").toLowerCase() === row.email.toLowerCase(), "账号资料暂时不可用", 409);
      await audit(db, r.user.id, admin ? "admin.account.device" : "account.device", row.id);
      return { id: row.id, email: row.email, device_fingerprint: storedDevice(c.device_fingerprint),
        ...(!admin ? { download_expires_at: row.download_expires_at } : {}) };
    });
  }
}
module.exports = { accountDevice, storedDevice, registerAccountDevice };
