"use strict";

function loginTokens(asset) {
  return {
    access_token: typeof asset?.accessToken === "string" ? asset.accessToken : "",
    session_token: typeof asset?.sessionToken === "string" ? asset.sessionToken : "",
  };
}

// Upgrade encrypted deliveries from their exact engine asset. No supplier calls,
// token refresh, replacement account or change to ownership/retention/charging.
async function backfillAccountTokens(db, crypt, manager) {
  const rows = (await db.query(`SELECT id,asset_id,email,credentials FROM platform_accounts
    WHERE login_tokens_synced_at IS NULL
      AND (login_tokens_checked_at IS NULL OR login_tokens_checked_at<now()-interval '5 minutes')
    ORDER BY login_tokens_checked_at NULLS FIRST,created_at LIMIT 50`)).rows;
  let updated = 0;
  for (const row of rows) {
    await db.query("UPDATE platform_accounts SET login_tokens_checked_at=now() WHERE id=$1", [row.id]);
    try {
      const credentials = crypt.decrypt(row.credentials);
      if (credentials.asset_id !== row.asset_id || String(credentials.email || "").toLowerCase() !== row.email.toLowerCase()) continue;
      if (credentials.access_token && credentials.session_token) {
        await db.query("UPDATE platform_accounts SET login_tokens_synced_at=now() WHERE id=$1 AND credentials=$2", [row.id, row.credentials]);
        continue;
      }
      const asset = manager.sessionAssets().get(row.asset_id);
      if (!asset || asset.id !== row.asset_id || String(asset.email || "").toLowerCase() !== row.email.toLowerCase()) continue;
      const tokens = loginTokens(asset);
      const next = { ...credentials,
        access_token: credentials.access_token || tokens.access_token,
        session_token: credentials.session_token || tokens.session_token };
      updated += (await db.query(`UPDATE platform_accounts SET credentials=$2,login_tokens_synced_at=now()
        WHERE id=$1 AND credentials=$3`, [row.id, crypt.encrypt(next), row.credentials])).rowCount;
    } catch {
      // Missing/pruned/unreadable assets stay eligible for a bounded retry.
      // Never erase the existing encrypted delivery or log its contents.
    }
  }
  return { checked: rows.length, updated };
}
module.exports = { loginTokens, backfillAccountTokens };
