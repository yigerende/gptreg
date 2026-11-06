import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SmsSettingsDialog } from './SmsSettingsDialog';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(options: { countryFailure?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init?: RequestInit) => {
    const u = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, method: init?.method || 'GET', body });
    const provider = u.includes('hero-sms') ? 'hero-sms' : 'smsbower';
    const value = u.endsWith('/config') ? { config: { sms: { provider: 'smsbower' } }, secrets: {} }
      : init?.method === 'PUT' ? { config: { sms: { provider } }, secrets: {} }
      : u.endsWith('/countries') ? options.countryFailure ? { ok: false, message: '国家目录请求失败' } : { ok: true, message: '已刷新国家列表', countries: [{ id: '4', name: 'Philippines' }, { id: '1003', name: 'Bermuda', chn: '百慕大' }] }
      : u.endsWith('/quotes') ? { ok: true, currency: 'USD', message: '已查询报价和库存', market: { countries: body.countries.map((c: any) => ({ id: c.id, cheapestPrice: .03, inventory: 14, affordableInventory: 5, issue: '' })) } }
      : u.endsWith('/test') ? { ok: true, message: '连接成功；测试不会购买号码', balance: 5, currency: 'USD', countries: [{ id: '4', name: 'Philippines' }, { id: '6', name: 'Indonesia' }], market: null }
      : { provider, baseUrl: provider === 'hero-sms' ? 'https://hero-sms.com/stubs/handler_api.php' : 'https://smsbower.page/stubs/handler_api.php', service: 'dr', apiKeyConfigured: provider === 'smsbower', maxPrice: provider === 'hero-sms' ? 1 : 0.05, countries: provider === 'hero-sms' ? [] : [{ id: '4', name: 'Philippines' }], codeTimeoutMs: 120000, currency: 'USD' };
    return new Response(JSON.stringify(value));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function View() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(true)}>打开配置</button><SmsSettingsDialog open={open} onOpenChange={setOpen} onSaved={() => {}} /></>;
  }
  render(<QueryClientProvider client={client}><View /></QueryClientProvider>);
  return calls;
}

it('allows entering a key, tests unsaved Hero settings and retains the country catalog while selecting multiple countries', async () => {
  const calls = show();
  expect(await screen.findByLabelText('短信 API Key')).not.toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('radio', { name: 'Hero-SMS' }));
  await waitFor(() => expect(screen.getByLabelText('短信最高单价')).toHaveValue(1));
  expect(screen.getByRole('button', { name: '保存配置并切换' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('短信 API Key'), { target: { value: 'draft-hero-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByText('连接成功；测试不会购买号码')).toBeInTheDocument();
  expect(calls.find((c) => c.url.endsWith('/hero-sms/test'))?.body.apiKey).toBe('draft-hero-key');
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /Philippines/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Indonesia/ }));
  expect(screen.getByRole('checkbox', { name: /Philippines/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Indonesia/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '保存配置并切换' }));
  expect(await screen.findByText(/已保存并切换到 Hero-SMS/)).toBeInTheDocument();
  const saved = calls.find((c) => c.method === 'PUT');
  expect(saved?.body.countries.map((c: any) => c.id)).toEqual(['4', '6']);
  expect(screen.getByLabelText('短信 API Key')).toHaveValue('');
});

it('keeps each vendor draft separate and never invents no-stock before a query', async () => {
  show(); const key = await screen.findByLabelText('短信 API Key');
  fireEvent.change(key, { target: { value: 'bower-draft' } });
  expect(screen.queryByText('暂无库存')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Hero-SMS' }));
  await waitFor(() => expect(screen.getByLabelText('短信最高单价')).toHaveValue(1));
  expect(screen.getByLabelText('短信 API Key')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('短信 API Key'), { target: { value: 'hero-draft' } });
  fireEvent.click(screen.getByRole('radio', { name: 'SMSBower' }));
  await waitFor(() => expect(screen.getByLabelText('短信 API Key')).toHaveValue('bower-draft'));
});

it('reopens cached settings after closing and discards the unsaved key', async () => {
  show();
  fireEvent.change(await screen.findByLabelText('短信 API Key'), { target: { value: 'unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '打开配置' }));
  expect(await screen.findByLabelText('短信 API Key')).toHaveValue('');
  expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
});

it('refreshes live SMSBower countries, preserves selections and automatically quotes newly checked countries', async () => {
  const calls = show();
  await screen.findByLabelText('短信 API Key');
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await screen.findByText('5 USD');
  fireEvent.click(screen.getByRole('button', { name: '刷新国家列表' }));
  const country = await screen.findByRole('checkbox', { name: /百慕大/ });
  expect(screen.getByRole('checkbox', { name: /Philippines/ })).toBeChecked();
  expect(country).not.toBeChecked();
  expect(calls.filter(c => c.url.endsWith('/quotes'))).toHaveLength(0);
  fireEvent.click(country);
  expect(await screen.findByText('库存 14 · 限价内 5')).toBeInTheDocument();
  expect(screen.getByText('5 USD')).toBeInTheDocument();
  expect(country).toBeChecked();
  const request = calls.find(c => c.url.endsWith('/quotes'))!;
  expect(request.body.countries.map((c: any) => c.id)).toEqual(['1003']);
  expect(request.body.service).toBe('dr');
  expect(calls.some(c => c.method === 'PUT')).toBe(false);
  fireEvent.change(screen.getByLabelText('短信服务代码'), { target: { value: 'tg' } });
  expect(screen.queryByText('库存 14 · 限价内 5')).not.toBeInTheDocument();
  fireEvent.click(country); fireEvent.click(country);
  await screen.findByText('库存 14 · 限价内 5');
  expect(calls.filter(c => c.url.endsWith('/quotes')).at(-1)?.body.service).toBe('tg');
});

it('retains the existing selection when country refresh fails', async () => {
  show({ countryFailure: true });
  await screen.findByLabelText('短信 API Key');
  fireEvent.click(screen.getByRole('button', { name: '刷新国家列表' }));
  expect(await screen.findByText('国家目录请求失败')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Philippines/ })).toBeChecked();
  expect(screen.queryByText('暂无库存')).not.toBeInTheDocument();
});
