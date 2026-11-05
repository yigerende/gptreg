import { LoaderCircle } from "lucide-react";
import { call, type Row } from "./client";

export function ExportProgress({ text }: { text: string }) {
  return text ? (
    <div className="p-export-progress" role="status" aria-live="polite">
      <LoaderCircle size={18} className="p-export-spinner" />
      <span>{text}，请保持页面打开…</span>
    </div>
  ) : null;
}

export async function selectFilteredAccounts(
  prefix: string,
  filters: Row,
  progress: (text: string) => void,
) {
  const ids: string[] = [];
  let total = 0;
  while (ids.length < 1000) {
    progress(`正在选择账号，已读取 ${ids.length} 个`);
    const result = await call(
      `${prefix}?${new URLSearchParams({ ...filters, limit: "100", offset: String(ids.length) })}`,
    );
    total = result.total;
    ids.push(...result.items.map((row: Row) => row.id));
    if (!result.items.length || ids.length >= total) break;
  }
  return { ids: [...new Set(ids)].slice(0, 1000), total };
}
