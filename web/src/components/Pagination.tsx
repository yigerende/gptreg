import { useEffect } from 'react';

export type PageInfo = { total: number; offset: number; limit: number };
export const CONSOLE_PAGE_SIZE = 50;

export function Pagination({ total, offset, limit = CONSOLE_PAGE_SIZE, busy = false, onChange, label = '列表分页' }: {
  total: number; offset: number; limit?: number; busy?: boolean; onChange: (offset: number) => void; label?: string;
}) {
  const last = Math.max(0, Math.ceil(total / limit) - 1) * limit;
  useEffect(() => { if (!busy && offset > last) onChange(last); }, [busy, offset, last, onChange]);
  return <nav className="console-pagination" aria-label={label} aria-busy={busy}>
    <span>共 {total} 条 · 第 {Math.floor(Math.min(offset, last) / limit) + 1} / {Math.max(1, Math.ceil(total / limit))} 页 · 每页 {limit} 条</span>
    <div>
      <button className="button button-quiet" disabled={busy || offset === 0} onClick={() => onChange(0)}>首页</button>
      <button className="button button-quiet" disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>上一页</button>
      <button className="button button-quiet" disabled={busy || offset >= last} onClick={() => onChange(offset + limit)}>下一页</button>
      <button className="button button-quiet" disabled={busy || offset >= last} onClick={() => onChange(last)}>末页</button>
    </div>
  </nav>;
}
