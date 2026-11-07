import { useQuery } from '@tanstack/react-query';
import { notifySessionExpired } from './auth-navigation';
export type SessionProxySettings = {
  authType: 'credentials' | 'subuser'; protocol: 'http' | 'socks5'; lifetimeMinutes: number;
  renewalCountry: string; enabled: boolean; revoked: boolean; maxParallel: number;
  ready: boolean; revision: number; activeVersion: string; defaultMode: string; ipDedup: boolean;
  token_configured: boolean; password_configured: boolean; username_configured: boolean; subuser_configured: boolean;
  occupied: number; available: number; counts: Record<string, number>; country_count: number; last_error: string;
};
export type SessionRegion = { code: string; name: string; sort: number; enabled: boolean; suppressed: boolean };
export type SessionRow = {
  id: string; source: string; task_item_id: string; attempt_seq: number; country: string; protocol: string;
  session: string; status: string; created_at: string; activated_at: string; expires_at: string; ended_at: string;
  reserved_until: string; last_error: string; final_account_id: string; order_id: string;
  session_key: string; intervals: number; run_id?: string; initiated_by?: string;
  detect_result: { exitIp?: string; latencyMs?: number; status?: string };
};
export type SessionPage<T> = { items: T[]; total: number; offset: number; limit: number };
export async function sessionProxyApi<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/admin/v1/session-proxy' + path, { method,
    headers: { 'X-Requested-With': 'gptreg', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (response.status === 401) notifySessionExpired();
  if (!response.ok) throw new Error(result.error || result.message || `请求失败 ${response.status}`);
  return result;
}
export function useSessionProxySettings() {
  return useQuery({ queryKey: ['session-proxy', 'settings'], queryFn: () => sessionProxyApi<SessionProxySettings>(), retry: false });
}
