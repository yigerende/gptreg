import { useState } from "react";
import { Copy, ChevronDown } from "lucide-react";
import type { Row } from "./client";
export default function TokenCredentials({ value, busy, onCopy }: {
  value: Row; busy?: boolean; onCopy: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const fields = [["网页登录 AT", value.access_token], ["RT（Refresh Token）", value.oauth?.refresh_token],
    ["完整 Session Token", value.session_token], ["OAuth AT", value.oauth?.access_token]];
  return <section className="p-token-section">
    <h3>AT / RT / Session</h3>
    <p className="p-muted">有值即可复制完整内容；没有保存的字段留空。</p>
    {fields.map(([label, token]) => <div className="p-token-row" key={label}>
      <label>{label}<div className="p-inline">
        <input aria-label={label} readOnly value={token || ""} />
        <button className="p-button secondary" aria-label={`复制${label}`} disabled={busy || !token} onClick={() => onCopy(token)}><Copy size={15} /></button>
        <button className="p-button secondary" aria-label={`展开${label}`} aria-expanded={expanded.includes(label)} disabled={!token}
          onClick={() => setExpanded(v => v.includes(label) ? v.filter(x => x !== label) : [...v,label])}><ChevronDown size={15} /></button>
      </div></label>
      {expanded.includes(label) && <textarea aria-label={`${label}完整内容`} readOnly value={token || ""} rows={4} />}
    </div>)}
    <p className="p-muted p-fine">网页登录 AT 与 OAuth AT 分别显示。Session 是完整登录 Token，查看和导出不会刷新有效期。</p>
  </section>;
}
