import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Dialog } from 'radix-ui';
import { afterEach, expect, it, vi } from 'vitest';
import { SmsbowerMailConfig } from './SmsbowerMailConfig';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Dialog.Root open><Dialog.Content><Dialog.Title>邮箱设置</Dialog.Title><Dialog.Description>接口配置测试</Dialog.Description><SmsbowerMailConfig /></Dialog.Content></Dialog.Root></QueryClientProvider>);
}

it('tests the draft before saving and clears the entered key after a successful save', async () => {
  const settings = { baseUrl: 'https://smsbower.page/api/mail', service: 'dr', maxPrice: 0.2, apiKeyConfigured: true, dedicatedApiKey: false, domain: 'gmail.com' };
  const calls: Array<{ url: string; method?: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method: init?.method, body });
    return new Response(JSON.stringify(String(url).endsWith('/test')
      ? { ok: true, message: '连接成功', count: 8, price: 0.12, latencyMs: 50, withinBudget: true }
      : init?.method === 'PUT' ? { ...settings, baseUrl: body.baseUrl, dedicatedApiKey: true } : settings));
  }));
  show();
  const address = await screen.findByLabelText('邮箱 API 地址');
  await waitFor(() => expect(address).toBeEnabled());
  fireEvent.change(address, { target: { value: 'https://custom.example/api/mail' } });
  fireEvent.change(screen.getByLabelText(/邮箱 API Key/), { target: { value: 'typed-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByText(/Gmail 库存 8 个/)).toBeInTheDocument();
  const tested = calls.find((call) => call.url.endsWith('/test'));
  expect(tested?.body).toMatchObject({ baseUrl: 'https://custom.example/api/mail', apiKey: 'typed-key', service: 'dr', maxPrice: 0.2 });
  expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByText('邮箱接口配置已保存')).toBeInTheDocument();
  expect(screen.getByLabelText(/邮箱 API Key/)).toHaveValue('');
});

it('shows test failure and clears stale feedback when the address is edited', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('/test')
    ? { ok: false, message: '接口拒绝访问，请检查 API Key 和账号权限', latencyMs: 20 }
    : { baseUrl: 'https://smsbower.page/api/mail', service: 'dr', maxPrice: 0.2, apiKeyConfigured: true, dedicatedApiKey: false }))));
  show();
  const button = await screen.findByRole('button', { name: '测试连接' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('接口拒绝访问');
  fireEvent.change(screen.getByLabelText('邮箱 API 地址'), { target: { value: 'https://next.example/api/mail' } });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
