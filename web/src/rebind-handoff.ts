import type { RebindQueueAddResult, SessionAssetListRow } from './types';

/**
 * In-memory hand-off for "select in 登录态资产 → jump to 换绑".
 *
 * The console is a single-page app, so module state survives the client-side
 * route change. The rebind page drains this on mount; a hard reload simply
 * loses it, which is fine for a one-shot hand-off.
 */
const ICLOUD_DOMAINS = ['icloud.com', 'me.com', 'mac.com'];

/** Only accounts registered at least 24h ago may enter the rebind queue. */
export const REGISTRATION_LOCK_MS = 24 * 60 * 60 * 1000;

export function rebindEligible(createdAt?: string, now = Date.now()): boolean {
  if (!createdAt) return false;
  const ts = Date.parse(createdAt);
  return Number.isFinite(ts) && now - ts >= REGISTRATION_LOCK_MS;
}

export function eligibleInLabel(createdAt?: string, now = Date.now()): string {
  if (!createdAt) return '入库时间未知';
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return '入库时间未知';
  const remain = ts + REGISTRATION_LOCK_MS - now;
  if (remain <= 0) return '';
  const minutes = Math.ceil(remain / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `还需 ${h}h${m}m` : `还需 ${m}m`;
}

export function summarizeRebindAdd(result: RebindQueueAddResult, unmatched = 0) {
  const labels: Record<string, string> = { too_new: '未满24h或时间未知', not_icloud: '非iCloud', already: '已在队列', not_found: '账号不存在', needs_review: '上次结果待核对' };
  const parts = [`已加入 ${result.added} 个`];
  const counts = new Map<string, number>();
  for (const item of result.blocked) counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
  for (const [reason, count] of counts) parts.push(`${labels[reason] || reason} ${count}`);
  if (unmatched) parts.push(`未匹配 ${unmatched}`);
  return { tone: result.added > 0 && !result.blocked.length && !unmatched ? 'success' : 'warning', text: parts.join(' · ') };
}

export function isIcloudEmail(email: string): boolean {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 && ICLOUD_DOMAINS.includes(email.slice(at + 1).toLowerCase());
}

/** iCloud accounts are the only ones the left column accepts. */
export function isIcloudAssetRow(asset: { email?: string; mailProvider?: string; facets?: string[] }): boolean {
  const provider = String(asset.mailProvider || '').toLowerCase();
  if (provider) return provider === 'icloud';
  if (Array.isArray(asset.facets) && asset.facets.includes('mailProvider:icloud')) return true;
  return isIcloudEmail(String(asset.email || ''));
}

let pending: SessionAssetListRow[] = [];

export function setRebindPending(rows: SessionAssetListRow[]) {
  pending = rows.slice();
}

export function takeRebindPending(): SessionAssetListRow[] {
  const rows = pending;
  pending = [];
  return rows;
}
