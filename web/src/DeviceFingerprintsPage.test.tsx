import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeviceFingerprintsPage } from './DeviceFingerprintsPage';
import type { DeviceFingerprint } from './device-fingerprint-types';
import App from './App';
import { Router } from './router';
import { Tooltip } from 'radix-ui';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
const item = (i = 0): DeviceFingerprint => ({
  id: `asset-${i}`, email: `account-${i}@example.test`, archived: false, lifecycle: 'sold', status: 'valid',
  createdAt: '2026-11-06T01:00:00Z', sourceRunId: 'run-example', countryCode: 'PH',
  fingerprint: 'a'.repeat(64), deviceId: `device-${i}`, fingerprintAccounts: 2, deviceAccounts: 1,
  profile: { schemaVersion: 2, browser: 'firefox', browserVersion: '156.0', userAgent: 'Fixture Firefox UA',
    platform: 'Win32', oscpu: 'Windows', language: 'fil-PH', languages: ['fil-PH', 'en'], acceptLanguage: 'fil-PH,en;q=0.9',
    timeZone: 'Asia/Manila', hardwareConcurrency: 8, maxTouchPoints: 0, storageQuotaBytes: null,
    screen: { width: 1920, height: 1080 }, viewport: {}, gpu: { vendor: 'Fixture vendor', renderer: 'Fixture renderer' } },
});
const summary = { total: 101, uniqueFingerprints: 98, uniqueDeviceIds: 101, duplicateFingerprintGroups: 3, duplicateFingerprintAccounts: 6, duplicateDeviceAccounts: 0, missing: 0, unreadable: 0 };
function show() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><DeviceFingerprintsPage /></QueryClientProvider>); }

it('opens the console deep link and places the navigation entry after platform settings', async () => {
  window.history.replaceState(null, '', '/device-fingerprints');
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input);
    return new Response(JSON.stringify(url.includes('/device-fingerprints') ? { items: [item()], total: 1, offset: 0, limit: 50, summary } : { robots: [], runs: [], services: [] }));
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
  expect(await screen.findByText('account-0@example.test')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/device-fingerprints');
  const links = [...document.querySelectorAll('.sidebar nav a')].map(link => link.textContent);
  expect(links.at(-2)).toBe('平台配置'); expect(links.at(-1)).toBe('设备指纹');
});

it('loads server pages, resets pagination for searches and opens the matching fingerprint group', async () => {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(String(input), 'http://local'); calls.push(url);
    const offset = Number(url.searchParams.get('offset'));
    return new Response(JSON.stringify({ items: [item(offset)], total: 101, offset, limit: 50, summary }));
  }));
  show();
  expect(await screen.findByText('account-0@example.test')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByText('account-50@example.test')).toBeInTheDocument();
  expect(calls.at(-1)?.searchParams.get('limit')).toBe('50');
  fireEvent.change(screen.getByLabelText('搜索设备指纹'), { target: { value: 'some@example.test' } });
  expect(calls.at(-1)?.searchParams.get('q')).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() => expect(calls.at(-1)?.searchParams.get('q')).toBe('some@example.test'));
  expect(calls.at(-1)?.searchParams.get('offset')).toBe('0');
  await waitFor(() => expect(screen.getByRole('table').parentElement).toHaveAttribute('aria-busy', 'false'));
  fireEvent.click(await screen.findByRole('button', { name: '重复 · 2 个账号' }));
  await waitFor(() => expect(calls.at(-1)?.searchParams.get('q')).toBe('a'.repeat(64)));
  fireEvent.change(screen.getByLabelText('设备记录筛选'), { target: { value: 'device' } });
  await waitFor(() => expect(calls.at(-1)?.searchParams.get('match')).toBe('device'));
});

it('expands saved profile details and copies the full untruncated identity', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [item()], total: 1, offset: 0, limit: 50, summary }))));
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  show();
  fireEvent.click(await screen.findByRole('button', { name: /查看 account-0.*设备详情/ }));
  expect(screen.getByText('Fixture Firefox UA')).toBeInTheDocument();
  expect(screen.getByText('1920 × 1080')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: `复制指纹 ${'a'.repeat(64)}` }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('a'.repeat(64)));
  expect(await screen.findByText('指纹已复制')).toBeInTheDocument();
});

it('shows request failures with a manual retry', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response(JSON.stringify({ message: '读取失败测试' }), { status: 500 }) : new Response(JSON.stringify({ items: [], total: 0, offset: 0, limit: 50, summary }))));
  show();
  expect(await screen.findByText(/读取失败测试/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText('没有匹配的账号')).toBeInTheDocument();
});
