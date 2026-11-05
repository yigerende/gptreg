import { useState, type ReactNode } from "react";
import { Search, ChevronLeft, ChevronRight, TrendingUp } from "lucide-react";
import type { Row } from "./client";
export const number = (n: unknown) => Number(n || 0).toLocaleString("zh-CN");
export const ledgerNames: Row = {
  reserve: "下单预留",
  release: "未交付退回",
  charge: "交付扣费",
  redeem: "兑换充值",
  adjust: "人工调账",
};
export function StatCards({
  items,
}: {
  items: {
    name: string;
    value: unknown;
    unit: string;
    hint: ReactNode;
    icon: ReactNode;
  }[];
}) {
  return (
    <div className="p-metric-grid">
      {items.map((item) => (
        <article className="p-metric" key={item.name}>
          <div>
            {item.name}
            <span>{item.icon}</span>
          </div>
          <strong>
            {number(item.value)}
            <small>{item.unit}</small>
          </strong>
          <p>{item.hint}</p>
        </article>
      ))}
    </div>
  );
}
export function Trend({
  daily = [],
  title = "近期业务趋势",
}: {
  daily?: Row[];
  title?: string;
}) {
  const [metric, setMetric] = useState("orders");
  const max = Math.max(1, ...daily.map((d) => Number(d[metric] || 0)));
  return (
    <section className="p-card p-trend">
      <div className="p-section-heading">
        <div>
          <span className="p-eyebrow">ACTIVITY TREND</span>
          <h2>{title}</h2>
        </div>
        <div className="p-segment">
          <button
            className={metric === "orders" ? "selected" : ""}
            onClick={() => setMetric("orders")}
          >
            订单量
          </button>
          <button
            className={metric === "charged" ? "selected" : ""}
            onClick={() => setMetric("charged")}
          >
            积分扣费
          </button>
        </div>
      </div>
      <div className="p-trend-total">
        <strong>
          {number(daily.reduce((n, d) => n + Number(d[metric] || 0), 0))}
        </strong>
        <span>
          {metric === "orders" ? "笔订单" : "积分已结算"}
          <small>近 {daily.length || 7} 天 · 北京时间</small>
        </span>
        <TrendingUp size={26} />
      </div>
      <div
        className="p-bars"
        role="img"
        aria-label={`${title}，按日展示${metric === "orders" ? "订单量" : "实际扣费"}`}
      >
        {daily.map((d, i) => (
          <div className="p-bar" key={d.day}>
            <div>
              <i
                style={{ height: `${(Number(d[metric] || 0) / max) * 100}%` }}
                title={`${d.day}：${number(d[metric])}`}
              />
            </div>
            <small>
              {daily.length <= 14 || i % 5 === 0 || i === daily.length - 1
                ? d.day.slice(5)
                : ""}
            </small>
          </div>
        ))}
      </div>
      {!daily.some((d) => Number(d[metric]) > 0) && (
        <p className="p-chart-empty">
          这个时段还没有{metric === "orders" ? "订单" : "扣费"}记录。
        </p>
      )}
    </section>
  );
}
export function Filters({
  value,
  onChange,
  status,
  mode = false,
  kind = false,
  placeholder = "搜索订单编号或邮箱",
}: {
  value: Row;
  onChange: (next: Row) => void;
  status?: Row;
  mode?: boolean;
  kind?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value.q || "");
  return (
    <form
      className="p-filter-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ ...value, q: draft.trim() });
      }}
    >
      <div className="p-search-field">
        <Search size={17} />
        <input
          aria-label="搜索"
          maxLength={200}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      {status && (
        <select
          aria-label="筛选状态"
          value={value.status || ""}
          onChange={(e) => onChange({ ...value, status: e.target.value })}
        >
          <option value="">全部状态</option>
          {Object.entries(status).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      )}
      {mode && (
        <select
          aria-label="筛选服务"
          value={value.mode || ""}
          onChange={(e) => onChange({ ...value, mode: e.target.value })}
        >
          <option value="">全部服务</option>
          <option value="standard">标准账号</option>
          <option value="oauth">OAuth 账号</option>
        </select>
      )}
      {kind && (
        <select
          aria-label="筛选流水类型"
          value={value.kind || ""}
          onChange={(e) => onChange({ ...value, kind: e.target.value })}
        >
          <option value="">全部流水类型</option>
          {Object.entries(ledgerNames).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      )}
      <button className="p-button secondary" type="submit">
        查询
      </button>
      {Object.values(value).some(Boolean) && (
        <button
          type="button"
          className="p-link"
          onClick={() => {
            setDraft("");
            onChange({});
          }}
        >
          重置
        </button>
      )}
    </form>
  );
}
export function Pagination({
  offset,
  total,
  count,
  size = 50,
  onChange,
}: {
  offset: number;
  total?: number;
  count: number;
  size?: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="p-pagination">
      <span>
        {total === undefined
          ? `本页 ${count} 条记录`
          : `共 ${number(total)} 条 · 第 ${Math.floor(offset / size) + 1} 页`}
      </span>
      <div>
        <button
          type="button"
          className="p-button secondary"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - size))}
        >
          <ChevronLeft size={15} />
          上一页
        </button>
        <button
          type="button"
          className="p-button secondary"
          disabled={total === undefined ? count < size : offset + size >= total}
          onClick={() => onChange(offset + size)}
        >
          下一页
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
