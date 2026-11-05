import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { Gauge, LoaderCircle, Save } from 'lucide-react';
import { endpoints } from './api';
import { Button, ConfigNumberInput, errorMessage } from './components/ConsoleUi';

export type SmsbowerMailSettings = {
  baseUrl: string; service: string; domain: string; maxPrice: number;
  apiKeyConfigured: boolean; dedicatedApiKey: boolean;
};
export type SmsbowerMailInput = Pick<SmsbowerMailSettings, 'baseUrl' | 'service' | 'maxPrice'> & { apiKey?: string };
export type SmsbowerMailTest = { ok: boolean; message: string; code?: string; httpStatus?: number; latencyMs: number; price?: number; count?: number; withinBudget?: boolean };

export function SmsbowerMailConfig() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['smsbower-mail-config'], queryFn: endpoints.smsbowerMailConfig, refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<Partial<SmsbowerMailInput>>({});
  const values = {
    baseUrl: draft.baseUrl ?? settings.data?.baseUrl ?? 'https://smsbower.page/api/mail',
    service: draft.service ?? settings.data?.service ?? 'dr',
    maxPrice: draft.maxPrice ?? settings.data?.maxPrice ?? 0,
    apiKey: draft.apiKey ?? '',
  };
  const save = useMutation({
    mutationFn: endpoints.saveSmsbowerMailConfig,
    onSuccess: (value) => {
      client.setQueryData(['smsbower-mail-config'], value);
      setDraft({});
      client.invalidateQueries({ queryKey: ['config'] });
      client.invalidateQueries({ queryKey: ['resources'] });
    },
  });
  const test = useMutation({ mutationFn: endpoints.testSmsbowerMailConfig });
  const busy = save.isPending || test.isPending;
  const disabled = busy || !settings.data;
  const edit = (patch: Partial<SmsbowerMailInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    save.reset(); test.reset();
  };
  const error = settings.error || save.error || test.error;
  const result = test.data;

  return <div className="sms-mail-api-config">
    <p className="sms-mail-api-help">填写 SMSBower Gmail 接口。测试使用当前填写内容，只查询库存和价格，不会租用邮箱。</p>
    <div className="sms-mail-api-fields">
      <label className="sms-mail-api-wide"><span>邮箱 API 地址</span><input value={values.baseUrl} disabled={disabled} spellCheck={false} onChange={(event) => edit({ baseUrl: event.target.value })} /></label>
      <label className="sms-mail-api-wide"><span>邮箱 API Key</span><input type="password" autoComplete="new-password" value={values.apiKey} disabled={disabled}
        placeholder={settings.data?.apiKeyConfigured ? '已配置；留空保持' : '输入 SMSBower API Key'} onChange={(event) => edit({ apiKey: event.target.value })} />
        <small>{settings.data?.dedicatedApiKey ? '已保存独立邮箱密钥；留空保持原值。' : settings.data?.apiKeyConfigured ? '当前复用已保存的平台密钥；填写后使用独立邮箱密钥。' : '保存后仅用于邮箱接口，密钥不会明文回显。'}</small></label>
      <label><span>邮箱服务代码</span><input value={values.service} placeholder="dr" disabled={disabled} onChange={(event) => edit({ service: event.target.value })} /></label>
      <label><span>邮箱单价上限（USD）</span><ConfigNumberInput min={0} max={5} step={0.01} value={values.maxPrice} disabled={disabled} onValueChange={(maxPrice) => edit({ maxPrice })} /></label>
    </div>
    {settings.isPending && <p role="status">正在读取配置…</p>}
    {error && <p className="sms-mail-api-result error" role="alert">{errorMessage(error)}</p>}
    {result && <div className={`sms-mail-api-result ${result.ok ? 'success' : 'error'}`} role={result.ok ? 'status' : 'alert'}>
      <strong>{result.message}</strong>
      {result.ok && <span>Gmail 库存 {result.count} 个 · 单价 ${result.price?.toFixed(3)} · 耗时 {result.latencyMs} ms</span>}
      {result.ok && result.count === 0 && <span>接口可用，当前暂无库存。</span>}
      {result.ok && !result.withinBudget && <span>当前单价超出上限或尚未设置上限，请调整后再启动任务。</span>}
    </div>}
    {save.isSuccess && <p className="sms-mail-api-result success" role="status">邮箱接口配置已保存</p>}
    <div className="dialog-actions">
      <Dialog.Close asChild><Button tone="quiet" disabled={busy}>关闭</Button></Dialog.Close>
      <Button icon={test.isPending ? <LoaderCircle className="spin" size={15} /> : <Gauge size={15} />} disabled={disabled} onClick={() => test.mutate(values)}>{test.isPending ? '测试中…' : '测试连接'}</Button>
      <Button tone="primary" icon={<Save size={15} />} disabled={disabled} onClick={() => save.mutate(values)}>{save.isPending ? '保存中…' : '保存配置'}</Button>
    </div>
  </div>;
}
