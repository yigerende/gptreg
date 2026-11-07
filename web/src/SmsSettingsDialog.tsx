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
  const [progress, setProgress] = useState({ done: 0, total: 0 });
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
  const edit = (patch: any, keepQuotes = false) => { setDrafts((d) => ({ ...d, [provider]: { ...d[provider], ...patch } })); if (!keepQuotes) setResults((r) => ({ ...r, [provider]: undefined })); setNotice(''); };
  const test = useMutation({
    mutationFn: ({ p, value }: { p: SmsVendor; value: any }) => endpoints.testSmsSettings(p, value),
    onSuccess: (data, { p }) => { setResults((r) => ({ ...r, [p]: data })); if (data.countries) setCatalogs((c) => ({ ...c, [p]: data.countries })); },
  });
  const refreshCountries = useMutation({
    mutationFn: async ({ p, value }: { p: SmsVendor; value: any }) => {
      const data = await endpoints.refreshSmsCountries(p, value);
      if (!data.ok) throw new Error(data.message || '国家列表刷新失败，请重试');
      return data;
    },
    onSuccess: (data, { p }) => {
      if (data.ok) setCatalogs(c => ({ ...c, [p]: data.countries }));
      setNotice(data.message || '国家列表刷新失败，请重试');
    },
  });
  const quote = useMutation({
    mutationFn: ({ p, value }: { p: SmsVendor; value: any }) => endpoints.quoteSmsCountry(p, value),
    onSuccess: (data, { p }) => setResults(r => {
      const previous = r[p];
      const rows = new Map<string, any>((previous?.market?.countries || []).map((c: any) => [String(c.id), c]));
      for (const c of data.market?.countries || []) rows.set(String(c.id), c);
      return { ...r, [p]: { ...previous, ...data, balance: previous?.balance, market: { ...data.market, countries: [...rows.values()] } } };
    }),
  });
  const refreshMarket = useMutation({
    mutationFn: async ({ p, value, displayed }: { p: SmsVendor; value: any; displayed: any[] }) => {
      setNotice(''); setProgress({ done: 0, total: 0 });
      const data = await endpoints.testSmsSettings(p, { ...value, skipQuotes: true });
      if (!data.ok) throw new Error(data.message || '余额或国家列表查询失败');
      const catalog = new Map<string, any>();
      for (const c of [...(data.countries || []), ...displayed]) catalog.set(String(c.id ?? c.code), c);
      const all = [...catalog.values()];
      setCatalogs(c => ({ ...c, [p]: all }));
      setResults(r => ({ ...r, [p]: { ...data, market: { countries: [] } } }));
      setProgress({ done: 0, total: all.length });
      const rows: any[] = [], batchSize = p === 'firefox' ? 500 : 8;
      for (let offset = 0; offset < all.length; offset += batchSize) {
        const batch = all.slice(offset, offset + batchSize);
        try {
          const quoted = await endpoints.quoteSmsCountry(p, { ...value, countries: batch });
          if (!quoted.ok) throw new Error(quoted.message || '报价查询失败');
          rows.push(...(quoted.market?.countries || []));
        } catch (error) {
          // Keep partial results and mark this batch unknown, never zero stock.
          rows.push(...batch.map(c => ({ id: String(c.id ?? c.code), cheapestPrice: null, inventory: null, issue: 'QUERY_FAILED' })));
          if ((error as { status?: number }).status === 401) throw error;
        }
        setResults(r => ({ ...r, [p]: { ...data, market: { countries: [...rows] } } }));
        setProgress({ done: Math.min(offset + batchSize, all.length), total: all.length });
      }
      const failed = rows.filter(c => c.issue && !['SMS_PRICE_ABOVE_MAX', 'SMS_INVENTORY_EMPTY'].includes(c.issue)).length;
      setNotice(`已刷新 ${all.length} 个国家报价，按价格从低到高显示${failed ? `；${failed} 个查询失败，可重新刷新` : ''}。勾选范围保持不变。`);
    },
  });
  const save = useMutation({
    mutationFn: ({ p, value }: { p: SmsVendor; value: any }) => endpoints.saveSmsSettings(p, value),
    onSuccess: async (data, { p, value }) => {
      client.setQueryData(['config'], data);
      const configured = Boolean(data.secrets?.[p === 'hero-sms' ? 'heroSmsApiKeyConfigured' : p === 'firefox' ? 'firefoxCredentialsConfigured' : 'smsApiKeyConfigured']);
      setDrafts((d) => ({ ...d, [p]: { ...d[p], apiKey: '', apiKeyConfigured: configured } }));
      setNotice(value.activate === false ? `已保存 ${labels[p]} 配置，当前启用的短信供应商保持不变。` : `已保存并切换到 ${labels[p]}，新任务使用此配置。`);
      for (const key of ['sms-settings', 'sms-market', 'services', 'resources']) void client.invalidateQueries({ queryKey: [key] });
      if (value.activate !== false) onSaved(p);
    },
  });
  const busy = save.isPending || test.isPending || refreshCountries.isPending || quote.isPending || refreshMarket.isPending;
  const countryId = (c: any) => String(c.id ?? c.code ?? c.country ?? c);
  const countriesById = new Map<string, any>();
  for (const c of [...(catalogs[provider] || []), ...(draft?.countries || [])]) {
    const id = countryId(c); if (!countriesById.has(id)) countriesById.set(id, c);
  }
  const selected = new Set<string>((draft?.countries || []).map(countryId));
  const markets = new Map<string, any>((result?.market?.countries || []).map((c: any) => [countryId(c), c]));
  const priceRank = (id: string) => {
    const row = markets.get(id), price = row?.cheapestPrice;
    return price != null && Number.isFinite(Number(price)) && (!row.issue || row.issue === 'SMS_PRICE_ABOVE_MAX') ? Number(price) : Infinity;
  };
  const countries = [...countriesById].filter(([id, c]) => `${id} ${c.name || ''} ${c.chn || ''} ${c.eng || ''} ${c.rus || ''} ${c.dialingCode || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort(([a], [b]) => priceRank(a) - priceRank(b));
  const selectedPrices = [...markets].filter(([id, c]) => (provider === 'firefox' && !selected.size || selected.has(id)) && c.cheapestPrice != null).map(([, c]) => Number(c.cheapestPrice));
  const cheapestPrice = selectedPrices.length ? Math.min(...selectedPrices) : null;
  const toggle = (id: string, country: any) => {
    const list = draft.countries || [];
    const adding = !selected.has(id), choice = provider === 'firefox' ? { ...country, code: id } : { ...country, id };
    edit({ countries: adding ? [...list, choice] : list.filter((c: any) => countryId(c) !== id) }, true);
    if (adding && provider === 'smsbower') quote.mutate({ p: provider, value: { ...draft, countries: [choice] } });
  };
  const error = activeConfig.error || settings.error || save.error || test.error || refreshCountries.error || quote.error || refreshMarket.error;
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="dialog-content dialog-wide sms-settings-dialog">
      <Dialog.Title>OAuth 短信配置</Dialog.Title>
      <Dialog.Description>只有登录或授权要求手机验证时才取号。“仅保存配置”不切换供应商；“保存配置并切换”对新任务生效，已有任务保持原配置。</Dialog.Description>
      <div className="sms-provider-switch segmented" role="radiogroup" aria-label="短信供应商">
        {(Object.keys(labels) as SmsVendor[]).map((p) => <button type="button" role="radio" aria-checked={p === provider} className={p === provider ? 'selected' : ''} key={p} disabled={busy} onClick={() => { setProvider(p); setNotice(''); setQuery(''); save.reset(); test.reset(); refreshCountries.reset(); quote.reset(); refreshMarket.reset(); }}>{labels[p]}</button>)}
      </div>
      {draft ? <>
        <div className="sms-settings-summary" aria-live="polite">
          <div><span>当前余额</span><strong>{result?.ok && result.balance != null ? `${result.balance} ${result.currency}` : '—'}</strong><small>{test.isPending ? '查询中' : result?.ok && result.balance != null ? '已同步' : '尚未成功查询'}</small></div>
          <div><span>{provider === 'firefox' ? '公开价目最低价' : '所选国家最低价'}</span><strong>{cheapestPrice != null ? `${cheapestPrice} ${result.currency}` : '—'}</strong><small>{result?.marketError ? '报价查询失败' : provider === 'firefox' ? '公开报价不代表实时库存' : '取号时仍受最高单价限制'}</small></div>
        </div>
        <div className="sms-settings-grid">
          <label><span>接口地址</span><input aria-label="短信接口地址" value={draft.baseUrl || ''} readOnly={provider === 'firefox'} disabled={busy} onChange={(e) => edit({ baseUrl: e.target.value })} /></label>
          <label><span>{provider === 'firefox' ? 'API Token' : 'API Key'}</span><input aria-label="短信 API Key" type="password" autoComplete="new-password" value={draft.apiKey || ''} disabled={busy} placeholder={draft.apiKeyConfigured ? '已配置；留空保持' : '尚未配置，请输入密钥'} onChange={(e) => edit({ apiKey: e.target.value })} /></label>
          <label><span>服务代码</span><input aria-label="短信服务代码" value={draft.service || ''} disabled={busy} readOnly={provider === 'firefox'} onChange={(e) => edit({ service: e.target.value })} /></label>
          <label><span>最高单价 {draft.currency}</span><input aria-label="短信最高单价" type="number" min="0" step="0.001" max={provider === 'smsbower' ? 0.1 : undefined} value={draft.maxPrice ?? ''} disabled={busy} onChange={(e) => edit({ maxPrice: e.target.value })} /></label>
          <label><span>等待验证码（秒）</span><input aria-label="验证码等待秒数" type="number" min="1" max="3600" value={Number(draft.codeTimeoutMs || 120000) / 1000} disabled={busy} onChange={(e) => edit({ codeTimeoutMs: Number(e.target.value) * 1000 })} /></label>
        </div>
        <div className="sms-country-heading"><div><strong>参与国家</strong><small>{provider === 'firefox' ? '未选择时使用全部公开价目，自动选择最低价。' : provider === 'hero-sms' ? '在勾选的可用国家中随机选择，再按该国最低报价限价取号；价格排序不改变随机策略。' : '在勾选的可用国家中随机选择，取号不超过最高单价；实际分配价格由供应商返回，价格排序不改变随机策略。'}</small></div>
          <Button disabled={busy} onClick={() => { setNotice(''); refreshCountries.mutate({ p: provider, value: draft }); }}>{refreshCountries.isPending ? '刷新国家中…' : '刷新国家列表'}</Button>
        </div>
        <small className="sms-country-help">刷新余额/报价会查询列表全部国家，无需勾选，按报价从低到高排序；无报价或查询失败的国家排在末尾。{provider === 'firefox' ? '火狐狸仅提供公开报价，实时库存以取号结果为准。' : '限价内库存按最高单价计算，实际取号以供应商当时返回为准。'}</small>
        <input className="sms-country-search" type="search" aria-label="搜索接码国家" placeholder="搜索国家、ID或区号" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!countriesById.size && <p>填写密钥后点击“刷新国家列表”加载国家目录。</p>}
        <div className="sms-bower-country-selector" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {countries.map(([id, c]) => { const m = markets.get(id), querying = quote.isPending && String(quote.variables?.value.countries[0].id) === id;
            const failed = m?.issue && !['SMS_PRICE_ABOVE_MAX', 'SMS_INVENTORY_EMPTY'].includes(m.issue);
            const state = querying ? '查询中…' : !result?.ok ? '待查询' : result.marketError ? '查询失败' : !m ? '待查询' : m.issue === 'SMS_INVENTORY_EMPTY' ? m.inventory === 0 ? '暂无库存' : '暂无可用报价' : failed ? '查询失败' : `${m.cheapestPrice} ${result.currency}${m.issue === 'SMS_PRICE_ABOVE_MAX' ? ' · 超过最高价' : ''}`;
            return <label className="sms-bower-country-option" key={id}><input type="checkbox" checked={selected.has(id)} disabled={busy} onChange={() => toggle(id, c)} /><span><strong>{c.chn || c.name || c.eng || c.rus || id}</strong><small>ID {id}{c.dialingCode ? ` · +${c.dialingCode}` : ''}</small></span><em className="sms-country-quote">{state}{m && !querying && !result?.marketError && <small>{provider === 'firefox' ? '公开价目 · 不提供实时库存' : m.inventory == null || failed ? '库存未查询成功' : `库存 ${m.inventory} · 限价内 ${m.affordableInventory ?? '—'}`}</small>}</em></label>;
          })}
        </div>
        {refreshMarket.isPending && <div role="status">正在刷新全部国家报价：{progress.done} / {progress.total || '加载目录中'}<progress aria-label="国家报价刷新进度" value={progress.done} max={progress.total || 1} /></div>}
        {result && <Notice tone={result.ok ? 'success' : 'danger'}>{result.message}{result.marketError ? `；${result.marketError.message}` : ''}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
      </> : <p>正在读取短信配置…</p>}
      {error && <Notice tone="danger">{error instanceof Error ? error.message : '请求失败'}</Notice>}
      <div className="dialog-actions sms-settings-actions" style={{ flexWrap: 'wrap' }}>
        <Dialog.Close asChild><Button tone="quiet" disabled={busy}>关闭</Button></Dialog.Close>
        <Button disabled={!draft || busy} onClick={() => test.mutate({ p: provider, value: draft })}>{test.isPending ? '查询中…' : '测试连接'}</Button>
        <Button disabled={!draft || busy} onClick={() => refreshMarket.mutate({ p: provider, value: draft, displayed: [...countriesById.values()] })}>{refreshMarket.isPending ? '刷新报价中…' : '刷新余额/报价'}</Button>
        <Button disabled={!draft || busy || (provider !== 'firefox' && !selected.size)} onClick={() => save.mutate({ p: provider, value: { ...draft, activate: false } })}>仅保存配置</Button>
        <Button tone="primary" disabled={!draft || busy || (provider !== 'firefox' && !selected.size)} onClick={() => save.mutate({ p: provider, value: draft })}>{save.isPending ? '保存中…' : '保存配置并切换'}</Button>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
