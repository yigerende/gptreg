import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Save } from 'lucide-react';
import { endpoints } from './api';
import { call } from './portal/client';
import { Button, Notice, PageHeader, errorMessage } from './components/ConsoleUi';
import './platform-config.css';

export type ExecutionSetting = {
  group: string; path: string; label: string; type: 'number' | 'delays';
  value: number | number[]; defaultValue: number | number[]; min?: number; max?: number; help: string;
};
const orderFields = [
  { key: 'resource_retry_limit', label: '未交付账号最多换邮箱次数', value: 2, min: 0, max: 10, help: '不含首次邮箱。旧账号停止并处理租约后才领取新邮箱，旧账号保留在后台且禁止自动交付。' },
  { key: 'attempt_limit', label: '启动／授权最大尝试次数', value: 2, min: 1, max: 5, help: '包含首次执行；原任务的异常恢复也受此上限约束。' },
  { key: 'timeout_minutes', label: '单个账号总执行时限（分钟）', value: 20, min: 2, max: 120, help: '从首次执行开始计算，包含换邮箱、补安全设置、OAuth 和等待；重试不会重新计时。' },
  { key: 'registration_concurrency', label: '全平台注册并发', value: 15, min: 1, max: 100, help: '所有用户共享的并发上限，超出的账号排队。' },
  { key: 'user_registration_concurrency', label: '单用户注册并发', value: 15, min: 1, max: 100, help: '同时还受全平台并发上限限制。' },
  { key: 'max_quantity', label: '每单最大账号数量', value: 100, min: 1, max: 1000, help: '' },
  { key: 'max_open_orders', label: '每用户未完成订单上限', value: 3, min: 1, max: 20, help: '' },
];
const display = (value: number | number[]) => Array.isArray(value) ? value.join(', ') : String(value);

export function PlatformConfigPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['platform-config'], queryFn: endpoints.platformConfig });
  const orders = useQuery({ queryKey: ['platform-config-orders'], queryFn: () => call('/api/admin/v1/settings') });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [orderDraft, setOrderDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const values: Record<string, number | number[]> = {};
      for (const [path, text] of Object.entries(draft)) {
        const field = query.data?.fields.find(f => f.path === path);
        if (!field || !text.trim()) throw new Error('请填写完整参数');
        if (field.type === 'delays') {
          const parts = text.split(/[,，]/).map(s => s.trim());
          if (parts.some(s => !s)) throw new Error('重试间隔须用逗号分隔整数');
          values[path] = parts.map(Number);
        } else values[path] = Number(text);
      }
      return endpoints.savePlatformConfig(values);
    },
    onSuccess: data => { client.setQueryData(['platform-config'], data); client.invalidateQueries({ queryKey: ['config'] }); setDraft({}); setNotice('运行参数已保存；新任务使用新参数，已创建任务保留原参数。'); },
  });
  const saveOrders = useMutation({
    mutationFn: () => call('/api/admin/v1/settings', 'PATCH', Object.fromEntries(Object.entries(orderDraft).map(([k,v]) => [k, v.trim() ? Number(v) : null]))),
    onSuccess: () => { client.invalidateQueries({ queryKey: ['platform-config-orders'] }); setOrderDraft({}); setNotice('订单参数已保存；重试预算和时限只对新订单生效，并发设置立即生效。'); },
  });
  const visible = (query.data?.fields || []).filter(f => `${f.label} ${f.path} ${f.group}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="engine-settings-page">
    <PageHeader title="平台配置" description="集中管理邮箱、短信、重试、请求超时和用户订单限额" />
    <Notice tone="info">邮箱查不到验证码与代理网络故障分别处理。达到同资源重试上限后换资源；账号创建或手机号验证结果不明时，先核实结果，避免重复消耗。用户订单的所有重试均受单账号总时限约束。</Notice>
    {notice && <Notice tone="success" onClose={() => setNotice('')}>{notice}</Notice>}
    {(query.error || save.error || saveOrders.error) && <Notice tone="danger">{errorMessage(query.error || save.error || saveOrders.error)}</Notice>}
    <section className="panel engine-settings-section">
      <div className="engine-settings-heading"><div><h2>用户订单与并发</h2><p>与运营控制台共用同一份设置。修改不会改变已下单订单的价格、时限和重试预算。</p></div></div>
      {orders.isLoading ? <p role="status">正在读取订单配置…</p> : orders.error ? <Notice tone="warning">订单配置读取失败：{errorMessage(orders.error)}</Notice> : <form onSubmit={e => { e.preventDefault(); setNotice(''); saveOrders.mutate(); }}>
        <div className="engine-settings-grid">{orderFields.map(f => <label key={f.key} className="engine-setting-field"><strong>{f.label}</strong><input type="number" disabled={saveOrders.isPending} required min={f.min} max={f.max} step={1} value={orderDraft[f.key] ?? orders.data?.[f.key] ?? f.value} onChange={e => setOrderDraft(d => ({ ...d, [f.key]: e.target.value }))} /><small>{f.help}</small><span>默认：{f.value}</span></label>)}</div>
        <Button type="submit" tone="primary" disabled={saveOrders.isPending || !Object.keys(orderDraft).length} icon={saveOrders.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}>保存订单参数</Button>
      </form>}
    </section>
    <form onSubmit={e => { e.preventDefault(); setNotice(''); save.mutate(); }}>
      <div className="engine-settings-toolbar"><input aria-label="搜索配置" placeholder="搜索邮箱、短信、重试、超时…" value={filter} onChange={e => setFilter(e.target.value)} /><Button type="submit" tone="primary" disabled={save.isPending || !Object.keys(draft).length} icon={save.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}>保存运行参数{Object.keys(draft).length ? `（${Object.keys(draft).length} 项）` : ''}</Button></div>
      <p className="engine-settings-help">新任务保存一份参数快照，恢复时继续使用原参数。每个字段可单独恢复默认，再点击保存。原后台手动任务的邮箱数量仍是租用上限，不会自动补齐成功数量。接口密钥仍在对应邮箱／短信配置卡片维护。</p>
      {query.isLoading && <p role="status">正在读取运行参数…</p>}
      {[...new Set(visible.map(f => f.group))].map(group => <section key={group} className="panel engine-settings-section"><h2>{group}</h2><div className="engine-settings-grid">{visible.filter(f => f.group === group).map(f => <label key={f.path} className="engine-setting-field"><strong>{f.label}</strong><input required disabled={save.isPending} aria-label={f.label} type={f.type === 'number' ? 'number' : 'text'} min={f.min} max={f.max} step={1} value={draft[f.path] ?? display(f.value)} onChange={e => setDraft(d => ({ ...d, [f.path]: e.target.value }))} /><small>{f.help}</small><span>默认：{display(f.defaultValue)} <button type="button" disabled={save.isPending} onClick={() => setDraft(d => ({ ...d, [f.path]: display(f.defaultValue) }))}>恢复默认</button></span></label>)}</div></section>)}
      {!query.isLoading && !visible.length && <p>没有匹配的配置项。</p>}
    </form>
  </div>;
}
