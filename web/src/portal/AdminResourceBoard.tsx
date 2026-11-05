import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Mail, Wallet, Activity, Gauge, Archive } from "lucide-react";
import { call, date, type Row } from "./client";
const money = (v: unknown, currency = "USD") => v == null ? "—" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${currency}`;
export default function AdminResourceBoard() {
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["admin-resource-board"], queryFn: () => call("/api/v1/resources/summary"), staleTime: 65000, retry: false, refetchOnWindowFocus: false });
  const mail = data?.mail || {}, sms = data?.sms || {};
  return <section className="p-card p-engine-resources">
    <div className="p-section-heading"><div><span className="p-eyebrow">LIVE RESOURCE BOARD</span><h2>注册引擎运行概览</h2><p className="p-muted">原启动工作台的资源与任务容量 · 最近读取 {date(data?.checkedAt)}</p></div><button className="p-button secondary" disabled={isFetching} onClick={() => refetch()}><RefreshCw size={15} className={isFetching ? "spin" : ""} />{isFetching ? "读取中…" : "刷新资源"}</button></div>
    {error && <div className="p-alert">资源暂不可用，点击刷新重试。</div>}
    <div className="p-resource-metrics">{[
      ["可租邮箱库存", mail.stock == null ? "—" : Number(mail.stock).toLocaleString(), <Archive size={20}/>, mail.message],
      ["邮箱余额", money(mail.balance, mail.currency), <Wallet size={20}/>, mail.balanceError ? "余额读取失败" : mail.message],
      ["邮箱单价", money(mail.unitPrice, mail.currency), <Mail size={20}/>, mail.stockError ? "报价读取失败" : "当前租用报价"],
      ["短信余额", money(sms.balance, sms.currency), <Activity size={20}/>, sms.message || sms.provider],
      ["短信最低单价", money(sms.cheapestPrice, sms.currency), <Gauge size={20}/>, sms.marketHint],
    ].map(([name,value,icon,hint]) => <div key={String(name)}><span>{icon}<small>{name}</small></span><strong>{value}</strong><small className="p-resource-hint">{hint}</small></div>)}</div>
    <div className="p-resource-slots">{Object.entries({ main: "后台主任务", auxiliary: "附属任务", customer: "客户订单" }).map(([key,label]) => {
      const slot: Row = data?.taskCapacity?.[key] || {};
      return <div key={key}><span>{label}</span><b>{slot.running == null ? "—" : slot.running + (slot.starting || 0)} / {slot.capacity ?? "—"}</b><small>{slot.available == null ? "等待资源数据" : `可用 ${slot.available} 个任务位`}</small></div>;
    })}</div>
    <p className="p-muted p-fine">余额与报价缓存约 65 秒，按需读取；任务位数量不等于注册账号并发数。</p>
  </section>;
}
