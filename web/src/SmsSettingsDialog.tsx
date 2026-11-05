import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { endpoints } from './api';
import { Button, Notice } from './components/ConsoleUi';

export type SmsVendor = 'smsbower' | 'firefox' | 'hero-sms';
const labels: Record<SmsVendor, string> = { smsbower: 'SMSBower', firefox: '火狐狸', 'hero-sms': 'Hero-SMS' };
export function SmsSettingsDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; onSaved: (provider: SmsVendor) => void }) {
  const client = useQueryClient();
  const [provider, setProvider] = useState<SmsVendor>('smsbower');
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [results, setResults] = useState<Record<string, any>>({});
  const [catalogs, setCatalogs] = useState<Record<string, any[]>>({});
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const initialized = useRef(false);
  const activeConfig = useQuery({ queryKey: ['config'], queryFn: endpoints.config, enabled: open });
  useEffect(() => {
    if (open && activeConfig.data && !initialized.current) {
      const p = activeConfig.data.config.sms?.provider;
      setProvider(p === 'hero-sms' || p === 'firefox' ? p : 'smsbower');
      initialized.current = true;
    } else if (!open) { initialized.current = false; setDrafts({}); setResults({}); setCatalogs({}); setNotice(''); setQuery(''); }
  }, [open, activeConfig.data]);
  const settings = useQuery({ queryKey: ['sms-settings', provider], queryFn: () => endpoints.smsSettings(provider), enabled: open, staleTime: 0 });
  useEffect(() => {
    if (open && settings.data) setDrafts((d) => d[provider] ? d : { ...d, [provider]: { ...settings.data, apiKey: '' } });
  }, [open, provider, settings.data]);
  const draft = drafts[provider];
  const result = results[provider];
  const edit = (patch: any) => { setDrafts((d) => ({ ...d, [provider]: { ...d[provider], ...patch } })); setResults((r) => ({ ...r, [provider]: undefined })); setNotice(''); };
  const test = useMutation({
    mutationFn: ({ p, value }: { p: SmsVendor; value: any }) => endpoints.testSmsSettings(p, value),
    onSuccess: (data, { p }) => { setResults((r) => ({ ...r, [p]: data })); if (data.countries) setCatalogs((c) => ({ ...c, [p]: data.countries })); },
  });
  const save = useMutation({
    mutationFn: ({ p, value }: { p: SmsVendor; value: any }) => endpoints.saveSmsSettings(p, value),
    onSuccess: async (data, { p }) => {
      client.setQueryData(['config'], data);
      const configured = Boolean(data.secrets?.[p === 'hero-sms' ? 'heroSmsApiKeyConfigured' : p === 'firefox' ? 'firefoxCredentialsConfigured' : 'smsApiKeyConfigured']);
      setDrafts((d) => ({ ...d, [p]: { ...d[p], apiKey: '', apiKeyConfigured: configured } }));
      setNotice(`已保存并切换到 ${labels[p]}，新任务使用此配置。`);
      for (const key of ['sms-settings', 'sms-market', 'services', 'resources']) void client.invalidateQueries({ queryKey: [key] });
      onSaved(p);
      test.mutate({ p, value: { ...drafts[p], apiKey: '' } });
    },
  });
  const busy = save.isPending || test.isPending;
  const countryId = (c: any) => String(c.id ?? c.code ?? c.country ?? c);
  const countriesById = new Map<string, any>();
  for (const c of [...(catalogs[provider] || []), ...(draft?.countries || [])]) {
    const id = countryId(c); if (!countriesById.has(id)) countriesById.set(id, c);
  }
  const selected = new Set<string>((draft?.countries || []).map(countryId));
  const markets = new Map<string, any>((result?.market?.countries || []).map((c: any) => [countryId(c), c]));
  const countries = [...countriesById].filter(([id, c]) => `${id} ${c.name || ''} ${c.eng || ''} ${c.rus || ''} ${c.dialingCode || ''}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string, country: any) => {
    const list = draft.countries || [];
    edit({ countries: selected.has(id) ? list.filter((c: any) => countryId(c) !== id) : [...list, provider === 'firefox' ? { ...country, code: id } : { ...country, id }] });
  };
  const error = activeConfig.error || settings.error || save.error || test.error;
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="dialog-content dialog-wide sms-settings-dialog">
      <Dialog.Title>OAuth 短信配置</Dialog.Title>
      <Dialog.Description>只有登录或授权要求手机验证时才取号。保存后新任务使用所选供应商；已有任务保持原配置。</Dialog.Description>
      <div className="sms-provider-switch segmented" role="radiogroup" aria-label="短信供应商">
        {(Object.keys(labels) as SmsVendor[]).map((p) => <button type="button" role="radio" aria-checked={p === provider} className={p === provider ? 'selected' : ''} key={p} disabled={busy} onClick={() => { setProvider(p); setNotice(''); setQuery(''); save.reset(); test.reset(); }}>{labels[p]}</button>)}
      </div>
      {draft ? <>
        <div className="sms-settings-summary" aria-live="polite">
          <div><span>当前余额</span><strong>{result?.ok ? `${result.balance} ${result.currency}` : '—'}</strong><small>{test.isPending ? '查询中' : result?.ok ? '已同步' : '尚未成功查询'}</small></div>
          <div><span>{provider === 'firefox' ? '公开价目最低价' : '所选国家最低价'}</span><strong>{result?.market?.cheapestPrice != null ? `${result.market.cheapestPrice} ${result.currency}` : '—'}</strong><small>{result?.marketError ? '报价查询失败' : provider === 'firefox' ? '公开报价不代表实时库存' : '取号时仍受最高单价限制'}</small></div>
        </div>
        <div className="sms-settings-grid">
          <label><span>接口地址</span><input aria-label="短信接口地址" value={draft.baseUrl || ''} readOnly={provider === 'firefox'} disabled={busy} onChange={(e) => edit({ baseUrl: e.target.value })} /></label>
          <label><span>{provider === 'firefox' ? 'API Token' : 'API Key'}</span><input aria-label="短信 API Key" type="password" autoComplete="new-password" value={draft.apiKey || ''} disabled={busy} placeholder={draft.apiKeyConfigured ? '已配置；留空保持' : '尚未配置，请输入密钥'} onChange={(e) => edit({ apiKey: e.target.value })} /></label>
          <label><span>服务代码</span><input aria-label="短信服务代码" value={draft.service || ''} disabled={busy} readOnly={provider === 'firefox'} onChange={(e) => edit({ service: e.target.value })} /></label>
          <label><span>最高单价 {draft.currency}</span><input aria-label="短信最高单价" type="number" min="0" step="0.001" max={provider === 'smsbower' ? 0.1 : undefined} value={draft.maxPrice ?? ''} disabled={busy} onChange={(e) => edit({ maxPrice: e.target.value })} /></label>
          <label><span>等待验证码（秒）</span><input aria-label="验证码等待秒数" type="number" min="1" max="3600" value={Number(draft.codeTimeoutMs || 120000) / 1000} disabled={busy} onChange={(e) => edit({ codeTimeoutMs: Number(e.target.value) * 1000 })} /></label>
        </div>
        <div className="sms-country-heading"><div><strong>参与国家</strong><small>{provider === 'firefox' ? '未选择时使用全部公开价目，自动选择最低价。' : '只会在勾选的可用国家中随机取号；每个国家内按最高价限制获取最低价可用号码。'}</small></div></div>
        <input className="sms-country-search" type="search" aria-label="搜索接码国家" placeholder="搜索国家、ID或区号" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!countriesById.size && <p>填写密钥后点击“测试连接”加载国家目录。</p>}
        <div className="sms-bower-country-selector" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {countries.map(([id, c]) => { const m = markets.get(id); const state = !result?.ok ? '待查询' : result.marketError ? '查询失败' : !m ? '待查询' : m.issue === 'SMS_PRICE_ABOVE_MAX' ? '超过最高价' : m.issue === 'SMS_INVENTORY_EMPTY' ? '暂无库存' : m.issue ? '查询失败' : `${m.cheapestPrice} ${result.currency}`;
            return <label className="sms-bower-country-option" key={id}><input type="checkbox" checked={selected.has(id)} disabled={busy} onChange={() => toggle(id, c)} /><span><strong>{c.name || c.eng || c.rus || id}</strong><small>ID {id}{c.dialingCode ? ` · +${c.dialingCode}` : ''}</small></span><em>{state}</em></label>;
          })}
        </div>
        {result && <Notice tone={result.ok ? 'success' : 'danger'}>{result.message}{result.marketError ? `；${result.marketError.message}` : ''}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
      </> : <p>正在读取短信配置…</p>}
      {error && <Notice tone="danger">{error instanceof Error ? error.message : '请求失败'}</Notice>}
      <div className="dialog-actions sms-settings-actions" style={{ flexWrap: 'wrap' }}>
        <Dialog.Close asChild><Button tone="quiet" disabled={busy}>关闭</Button></Dialog.Close>
        <Button disabled={!draft || busy} onClick={() => test.mutate({ p: provider, value: draft })}>{test.isPending ? '查询中…' : '测试连接'}</Button>
        <Button disabled={!draft || busy} onClick={() => test.mutate({ p: provider, value: draft })}>刷新余额/报价</Button>
        <Button tone="primary" disabled={!draft || busy || (provider !== 'firefox' && !selected.size)} onClick={() => save.mutate({ p: provider, value: draft })}>{save.isPending ? '保存中…' : '保存配置并切换'}</Button>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
