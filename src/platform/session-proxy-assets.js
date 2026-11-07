'use strict';

// Resolve historical registration metadata only at the administrator API.
// Connection credentials remain encrypted in the session table, never in
// checkpoints, list responses, or customer delivery data.
async function enrichSessionProxyAssets(service, assets, detail = false) {
  if (!service || !assets.length) return assets;
  const candidates = assets.filter(a => a.sourceRunId && (!a.sourceProxy?.endpoint || detail && !a.registrationProxyUrl));
  if (!candidates.length) return assets;
  const rows = (await service.allocator.db.query(`SELECT b.final_account_id,b.run_id,b.country,b.protocol,s.endpoint_enc
    FROM session_proxy_bindings b JOIN session_proxy_sessions s ON s.session_id=b.session_ref
    JOIN session_proxy_task_items t ON t.source=b.source AND t.task_item_id=b.task_item_id
    WHERE b.final_account_id=ANY($1::text[]) AND t.task_kind='register' ORDER BY b.id`, [candidates.map(a => a.id)])).rows;
  return assets.map(asset => {
    const row = rows.find(r => r.final_account_id === asset.id && r.run_id === asset.sourceRunId);
    if (!row) return asset;
    const url = service.allocator.crypt.decrypt(row.endpoint_enc), parsed = new URL(url);
    return { ...asset, sourceProxy: { ...asset.sourceProxy, countryCode: row.country, protocol: row.protocol,
      endpoint: parsed.host, resourceKind: 'sessionProxy' }, ...(detail ? { registrationProxyUrl: url } : {}) };
  });
}
module.exports = { enrichSessionProxyAssets };
