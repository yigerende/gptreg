import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from 'radix-ui';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RebindPage } from './RebindPage';
import { RebindProgress } from './RebindProgress';
import { Router } from './router';
import { REGISTRATION_LOCK_MS, eligibleInLabel, rebindEligible } from './rebind-handoff';

const timestamp = '2026-09-10T00:00:00Z';
const account = (id: string) => ({
  id, email: `${id}@icloud.com`, accountId: id, mailProvider: 'icloud', planType: 'free',
  hasAccessToken: true, canRefresh: true, createdAt: timestamp, eligible: true, eligibleAt: timestamp, ageMs: 86400000, health: null,
});
const idle = { running: false, starting: false, provider: '', workerConcurrency: 0, total: 0, done: 0, ok: 0, fail: 0, needsRefresh: 0, refreshed: 0, proxyRetried: 0, startedAt: '', finishedAt: '', error: '', reboundEmails: [], results: [], stopRequested: false };
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Handler = (url: URL, init?: RequestInit) => unknown | Promise<unknown>;
function mount(accounts = [account('one')], handler?: Handler) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const custom = await handler?.(url, init);
    if (custom instanceof Response) return custom;
    const payloads: Record<string, unknown> = {
      '/api/v1/rebind/providers': { activeProvider: 'icloud', providers: [{ id: 'fastmail', label: 'Fastmail', configured: true }] },
      '/api/v1/proxies': { dynamic: { countryPools: [] } },
      '/api/v1/rebind/queue': { accounts },
      '/api/v1/rebind/queue/ids': { ids: accounts.map(account => account.id) },
      '/api/v1/rebind/status': idle,
    };
    const payload = custom ?? payloads[url.pathname];
    if (!payload) throw new Error(`Unexpected request: ${url.pathname}`);
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Tooltip.Provider><Router><RebindPage /></Router></Tooltip.Provider></QueryClientProvider>);
  return fetcher;
}

async function openPicker() {
  const button = screen.getByRole('button', { name: '加入账号' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

it('uses a precise 24-hour boundary and does not show zero minutes while locked', () => {
  const start = Date.parse(timestamp);
  expect(rebindEligible(timestamp, start + REGISTRATION_LOCK_MS - 1)).toBe(false);
  expect(rebindEligible(timestamp, start + REGISTRATION_LOCK_MS)).toBe(true);
  expect(eligibleInLabel(timestamp, start + REGISTRATION_LOCK_MS - 1)).toBe('还需 1m');
  expect(eligibleInLabel(undefined)).toBe('入库时间未知');
  expect(rebindEligible('invalid')).toBe(false);
});

it('allows old accounts, labels missing dates, and keeps selections across pages', async () => {
  const added: string[][] = [];
  mount([], (url, init) => {
    if (url.pathname === '/api/v1/session-assets') return url.searchParams.get('cursor') === '100'
      ? { assets: [account('two')], total: 101, cursor: '' }
      : { assets: [account('one'), { ...account('young'), createdAt: new Date(Date.now() - 3600000).toISOString() }, { ...account('unknown'), createdAt: '' }], total: 101, cursor: '100' };
    if (url.pathname.endsWith('/queue/add')) {
      added.push(JSON.parse(String(init?.body)).assetIds);
      return { accounts: [account('one'), account('two')], added: 2, blocked: [] };
    }
  });
  await openPicker();
  const first = await screen.findByRole('checkbox', { name: '选择 one@icloud.com' });
  expect(first).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: '选择 young@icloud.com' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '选择 unknown@icloud.com' })).toBeDisabled();
  expect(screen.getAllByText('入库时间未知').length).toBeGreaterThan(0);
  fireEvent.click(first);
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择 two@icloud.com' }));
  expect(screen.getByText('已选 2 个（跨页保留）')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
  await waitFor(() => expect(added).toEqual([['one', 'two']]));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('keeps a partial add report visible and prevents selecting an already queued account', async () => {
  mount([account('queued')], (url) => {
    if (url.pathname === '/api/v1/session-assets') return { assets: [account('queued'), account('one'), account('two')], total: 3, cursor: '' };
    if (url.pathname.endsWith('/queue/add')) return { accounts: [account('queued'), account('one')], added: 1, blocked: [{ id: 'two', email: 'two@icloud.com', reason: 'too_new' }] };
  });
  await openPicker();
  expect(await screen.findByRole('checkbox', { name: '选择 queued@icloud.com' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '全选本页可用账号' }));
  fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已加入 1 个 · 未满24h或时间未知 1');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('keeps the previous page visible while fetching and uses cached pages when going back', async () => {
  let completeNext: (value: unknown) => void = () => {};
  const requests: string[] = [];
  mount([], (url) => {
    if (url.pathname !== '/api/v1/session-assets') return;
    expect(url.searchParams.get('sort')).toBe('createdAtAsc');
    const cursor = url.searchParams.get('cursor') || '';
    requests.push(cursor);
    if (cursor === '100') return new Promise((resolve) => { completeNext = resolve; });
    return { assets: [account('one')], total: 101, offset: 0, cursor: '100' };
  });
  await openPicker();
  await screen.findByRole('checkbox', { name: '选择 one@icloud.com' });
  await waitFor(() => expect(requests).toEqual(['', '100']));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 one@icloud.com' })).toBeDisabled());
  expect(screen.queryByText('读取账号…')).not.toBeInTheDocument();
  expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
  await act(async () => completeNext({ assets: [account('two')], total: 101, offset: 100, cursor: '' }));
  expect(await screen.findByRole('checkbox', { name: '选择 two@icloud.com' })).toBeEnabled();
  expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(screen.getByRole('checkbox', { name: '选择 one@icloud.com' })).toBeEnabled();
  expect(requests).toEqual(['', '100']);
});

it('starts all queued accounts and disables queue edits while the request is pending', async () => {
  let release: (value: unknown) => void = () => {};
  let startedIds: string[] = [];
  let didStart = false;
  mount([account('one'), account('two')], (url, init) => {
    if (url.pathname.endsWith('/start')) {
      startedIds = JSON.parse(String(init?.body)).assetIds;
      return new Promise((resolve) => { release = resolve; });
    }
    if (url.pathname.endsWith('/status') && didStart) return { ...idle, running: true, total: 2, provider: 'fastmail', workerConcurrency: 2, startedAt: timestamp };
  });
  const button = await screen.findByRole('button', { name: '启动全部' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(screen.getByRole('checkbox', { name: 'one@icloud.com' }));
  fireEvent.click(button);
  await waitFor(() => expect(startedIds).toEqual(['one', 'two']));
  expect(screen.getByRole('button', { name: '准备中…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '加入账号' })).toBeDisabled();
  didStart = true;
  await act(async () => release({ ok: true, total: 2, provider: 'fastmail', workerConcurrency: 2 }));
  expect(await screen.findByRole('button', { name: '停止任务' })).toBeEnabled();
});

it('preserves selections when removing from the queue fails', async () => {
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/queue/remove')) return new Response(JSON.stringify({ message: '写入失败' }), { status: 500 });
  });
  const row = await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: '移除' }));
  expect(await screen.findByText('写入失败')).toBeInTheDocument();
  expect(row).toBeChecked();
});

it('refreshes the queue on completion and keeps detailed failures in the results', async () => {
  let completed = false;
  mount([account('one')], (url) => {
    if (completed && url.pathname.endsWith('/queue')) return { accounts: [] };
  });
  await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  completed = true;
  act(() => client.setQueryData(['rebind-status', 0], {
    ...idle, total: 2, done: 2, ok: 1, fail: 1, provider: 'fastmail', startedAt: timestamp,
    results: [{ assetId: 'failed', previousEmail: 'failed@icloud.com', newEmail: 'new@example.test', provider: 'fastmail', status: 'error', stage: 'otp', code: 'NO_OTP', error: '验证码超时，请检查邮箱接口', at: timestamp }],
  }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'one@icloud.com' })).not.toBeInTheDocument());
  const results = screen.getByRole('region', { name: '换绑结果' });
  expect(within(results).getByRole('group', { name: '换绑结果统计' })).toHaveTextContent('总计 2成功 1失败 1未完成 0');
  expect(within(results).getByText('验证码超时，请检查邮箱接口')).toBeInTheDocument();
  expect(within(results).getByText('失败·读取验证码')).toBeInTheDocument();
});

it('distinguishes a confirmed rebind that only needs a health refresh', async () => {
  mount([account('one')]);
  await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  act(() => client.setQueryData(['rebind-status', 0], {
    ...idle, total: 1, done: 1, fail: 1, provider: 'fastmail', startedAt: timestamp,
    results: [{ assetId: 'one', previousEmail: 'one@icloud.com', newEmail: 'new@example.test', provider: 'fastmail', status: 'needs_refresh', changeConfirmed: true, stage: 'verify_health', error: 'access token was rejected (HTTP 401)', at: timestamp }],
  }));
  const results = await screen.findByRole('region', { name: '换绑结果' });
  expect(within(results).getByText('已确认换绑·需刷新登录态')).toBeInTheDocument();
});

it('blocks unusable accounts before start and permits retrying failed initial queries', async () => {
  let failed = true;
  mount([{ ...account('one'), hasAccessToken: false, canRefresh: false }], (url) => {
    if (failed && url.pathname.endsWith('/providers')) return new Response(JSON.stringify({ message: '配置暂不可用' }), { status: 503 });
  });
  expect(await screen.findByText(/加载失败：配置暂不可用/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '启动全部' })).toBeDisabled();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('1 个账号缺少可用登录态，请刷新或移出队列')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '启动全部' })).toBeDisabled();
});

it('shows the active stage and elapsed time while stop waits for the current account', async () => {
  let stopping = false;
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/stop')) { stopping = true; return { ok: true, running: true, stopRequested: true }; }
    if (url.pathname.endsWith('/status')) return {
      ...idle, running: true, stopRequested: stopping, total: 1, provider: 'fastmail', workerConcurrency: 1, startedAt: timestamp,
      active: [{ assetId: 'one', email: 'one@icloud.com', stage: 'otp', attempt: 1, stageStartedAt: timestamp, elapsedSeconds: 12 }],
    };
  });
  const row = await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  const card = row.parentElement!;
  expect(within(card).getAllByText('读取验证码').length).toBeGreaterThan(0);
  expect(within(card).getByText(/64% · 本步 12 秒/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '停止任务' }));
  expect(await screen.findByRole('button', { name: '正在停止…' })).toBeDisabled();
  expect(within(card).getAllByText('读取验证码').length).toBeGreaterThan(0);
});

it('shows an individual progress bar on each account while the batch is running', async () => {
  mount([account('one'), account('two')], (url) => {
    if (url.pathname.endsWith('/status')) return {
      ...idle, running: true, total: 2, provider: 'fastmail', workerConcurrency: 1, startedAt: timestamp,
      active: [{ assetId: 'one', email: 'one@icloud.com', stage: 'otp', attempt: 2, stageStartedAt: timestamp, elapsedSeconds: 12 }],
    };
  });

  const first = await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  const second = await screen.findByRole('checkbox', { name: 'two@icloud.com' });
  const firstCard = first.parentElement!;
  const secondCard = second.parentElement!;
  expect(within(firstCard).getByRole('progressbar', { name: 'one@icloud.com换绑进度' })).toHaveAttribute('aria-valuenow', '64');
  expect(within(firstCard).getByText('64% · 本步 12 秒')).toBeInTheDocument();
  fireEvent.click(within(firstCard).getByRole('button', { name: '展开换绑详情' }));
  expect(within(firstCard).getByText('同一代理 · 第 2 次尝试')).toBeInTheDocument();
  expect(within(firstCard).getByText(/最多再等 108 秒/)).toBeInTheDocument();
  expect(within(secondCard).getByRole('progressbar', { name: 'two@icloud.com换绑进度' })).toHaveAttribute('aria-valuenow', '0');
  expect(within(secondCard).getByText('排队中')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar', { name: '换绑进度' })).not.toBeInTheDocument();
});

it('shows the claimed mailbox in the result panel before the account finishes', async () => {
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/status')) return {
      ...idle, running: true, total: 1, provider: 'fastmail', workerConcurrency: 1, startedAt: timestamp,
      active: [{ assetId: 'one', email: 'one@icloud.com', newEmail: 'claimed@example.test', stage: 'change_begin', attempt: 1, stageStartedAt: timestamp, elapsedSeconds: 3 }],
    };
  });

  const results = await screen.findByRole('region', { name: '换绑结果' });
  expect(await within(results).findByText('claimed@example.test')).toBeInTheDocument();
  expect(within(results).getByText('进行中')).toBeInTheDocument();
  expect(within(results).getByText('发起换绑')).toBeInTheDocument();
  expect(within(results).getByText('48% · 本步 3 秒')).toBeInTheDocument();
});

it('shows post-change refresh substeps and keeps the run active until the session is verified', async () => {
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/status')) return {
      ...idle, running: true, total: 1, provider: 'fastmail', workerConcurrency: 1, startedAt: timestamp,
      active: [{ assetId: 'one', email: 'one@icloud.com', newEmail: 'claimed@example.test', stage: 'post_login_refresh', loginStep: 'mfa_verification_pending', attempt: 1, mailboxAttempt: 2, maxMailboxAttempts: 3, retryReason: 'recipient_mismatch', stageStartedAt: timestamp, elapsedSeconds: 8, totalElapsedSeconds: 43 }],
    };
  });
  const row = await screen.findByRole('checkbox', { name: 'one@icloud.com' });
  const card = row.parentElement!;
  expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');
  fireEvent.click(within(card).getByRole('button', { name: '展开换绑详情' }));
  expect(within(card).getByText(/换绑已确认 · 使用同一代理 · 验证 TOTP/)).toBeInTheDocument();
  expect(within(card).getByText(/上次邮件收件人不匹配，已更换邮箱/)).toBeInTheDocument();
  expect(within(card).getByText('邮箱 2/3 · 同一代理 · 第 1 次尝试 · 累计 43 秒')).toBeInTheDocument();
  expect(screen.queryByText('换绑成功')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '加入账号' })).toBeDisabled();
});

it('sends the configured mailbox replacement limit', async () => {
  let body: { otpRetries?: number } | undefined;
  mount([account('one')], (url, init) => {
    if (url.pathname.endsWith('/start')) { body = JSON.parse(String(init?.body)); return { ok: true, total: 1, workerConcurrency: 1 }; }
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '启动全部' })).toBeEnabled());
  fireEvent.click(screen.getByText('高级设置'));
  fireEvent.change(screen.getByRole('spinbutton', { name: '收码异常更换邮箱次数' }), { target: { value: '3' } });
  fireEvent.blur(screen.getByRole('spinbutton', { name: '收码异常更换邮箱次数' }));
  fireEvent.click(screen.getByRole('button', { name: '启动全部' }));
  await waitFor(() => expect(body?.otpRetries).toBe(3));
});

it('starts only the requested account even if another queued account cannot run', async () => {
  let body: { assetIds: string[]; workerConcurrency: number; proxyAssignments: unknown[] } | undefined;
  let release: (value: unknown) => void = () => {};
  let running = false;
  mount([account('one'), { ...account('two'), hasAccessToken: false, canRefresh: false }], (url, init) => {
    if (url.pathname.endsWith('/start')) {
      body = JSON.parse(String(init?.body));
      return new Promise((resolve) => { release = resolve; });
    }
    if (running && url.pathname.endsWith('/status')) return {
      ...idle, running: true, total: 1, assetIds: ['one'], provider: 'fastmail', workerConcurrency: 1, startedAt: timestamp,
      active: [{ assetId: 'one', email: 'one@icloud.com', stage: 'login', attempt: 1, stageStartedAt: timestamp, elapsedSeconds: 0 }],
    };
  });
  const single = await screen.findByRole('button', { name: '启动 one@icloud.com' });
  await waitFor(() => expect(single).toBeEnabled());
  expect(screen.getByRole('button', { name: '启动全部' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '启动 two@icloud.com' })).toBeDisabled();
  fireEvent.click(single);
  await waitFor(() => expect(body?.assetIds).toEqual(['one']));
  expect(body?.workerConcurrency).toBe(1);
  expect(body?.proxyAssignments).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'one@icloud.com' })).not.toBeChecked();
  expect(single).toBeDisabled();
  running = true;
  await act(async () => release({ ok: true, total: 1, provider: 'fastmail', workerConcurrency: 1 }));
  expect(await screen.findByRole('button', { name: '停止任务' })).toBeEnabled();
  expect(within(screen.getByRole('checkbox', { name: 'one@icloud.com' }).parentElement!).getByRole('progressbar')).toBeInTheDocument();
  expect(within(screen.getByRole('checkbox', { name: 'two@icloud.com' }).parentElement!).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByText('未加入本次任务')).toBeInTheDocument();
});

it('restores single-account start after a failed request without selecting the card', async () => {
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/start')) return new Response(JSON.stringify({ message: '账号正被其他任务占用' }), { status: 409 });
  });
  const single = await screen.findByRole('button', { name: '启动 one@icloud.com' });
  await waitFor(() => expect(single).toBeEnabled());
  fireEvent.click(single);
  expect(await screen.findByText('账号正被其他任务占用')).toBeInTheDocument();
  await waitFor(() => expect(single).toBeEnabled());
  expect(screen.getByRole('checkbox', { name: 'one@icloud.com' })).not.toBeChecked();
});

it('keeps claimed progress during reauthentication and makes connection retries explicit', () => {
  const active = {
    assetId: 'one', email: 'one@icloud.com', newEmail: 'new@example.test', stage: 'change_reauth',
    stagesReached: ['login', 'claim', 'change_begin', 'change_reauth'], loginStep: 'mfa_verification_pending',
    attempt: 1, stageStartedAt: timestamp, elapsedSeconds: 5,
  };
  const view = render(<RebindProgress active={active} email={active.email} />);
  expect(screen.getByText('换绑授权验证')).toBeInTheDocument();
  expect(screen.getByText('新邮箱已领取 · 换绑接口要求重新验证登录 · 验证后继续提交')).toBeInTheDocument();
  expect(screen.getByText('验证 TOTP · 保留当前邮箱与代理')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '48');
  expect(screen.queryByText('换绑前自动登录')).not.toBeInTheDocument();
  view.rerender(<RebindProgress active={{ ...active, stage: 'change_begin', loginStep: '' }} email={active.email} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '48');
  view.rerender(<RebindProgress active={{ ...active, stage: 'login', attempt: 2, connectionRetry: { attempt: 1, stage: 'change_begin', code: 'ECONNRESET', error: 'connection reset' } }} email={active.email} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '48');
  expect(screen.getByText('同代理连接重试 · 上次在“发起换绑”失败（ECONNRESET）')).toBeInTheDocument();
});

it('shows a retry waiting at post-login without losing the mailbox or reached progress', () => {
  const active = {
    assetId: 'one', email: 'one@icloud.com', newEmail: 'new@example.test', stage: 'post_login_refresh',
    stagesReached: ['change_verify', 'post_login_refresh'], loginStep: 'nextauth_ready',
    loginStepsReached: ['nextauth_ready', 'password_verified'], attempt: 2,
    stageStartedAt: timestamp, elapsedSeconds: 10,
    connectionRetry: { attempt: 1, stage: 'post_login_refresh', code: 'ETIMEDOUT', error: 'connection timeout', pending: true, retryAttempt: 1, maxRetries: 2, nextRetryAt: new Date(Date.now() + 5000).toISOString() },
  };
  render(<RebindProgress active={active} email={active.email} />);
  expect(screen.getByText('新邮箱登录态刷新')).toBeInTheDocument();
  expect(screen.getByText(/在当前步骤重试（1\/2）· 邮箱及代理保持不变/)).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '88');
});

it('shows the original cause and request step when authorization after claiming fails', async () => {
  mount([account('one')], (url) => {
    if (url.pathname.endsWith('/status')) return {
      ...idle, total: 1, done: 1, fail: 1, startedAt: timestamp, finishedAt: timestamp,
      results: [{ assetId: 'one', previousEmail: 'one@icloud.com', newEmail: 'new@example.test', status: 'needs_refresh', stage: 'change_reauth', code: 'AT_REFRESH_FAILED',
        failure: { code: 'TOKEN_REVOKED', step: 'chatgpt_me', httpStatus: 401, refreshReason: 'change_begin_rejected', resumeStage: 'change_begin' },
        error: '登录态刷新失败', at: timestamp }],
    };
  });
  const results = within(await screen.findByRole('region', { name: '换绑结果' }));
  expect(await results.findByText('未换绑 · 授权验证失败')).toBeInTheDocument();
  expect(results.getByText('失败步骤：换绑授权验证 / chatgpt_me · TOKEN_REVOKED · HTTP 401')).toBeInTheDocument();
  expect(results.getByText('领取邮箱后，提交换绑时要求重新登录；授权验证未通过，尚未确认换绑。')).toBeInTheDocument();
  expect(screen.queryByText('换绑成功')).not.toBeInTheDocument();
});
