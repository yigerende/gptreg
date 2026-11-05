import '@testing-library/jest-dom/vitest';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from 'radix-ui';

import { RobotsPage } from './RobotsPage';
import { Router } from './router';

const robot = {
  id: 'proxy-refresh',
  name: '代理刷新',
  description: '按周期刷新全部国家池 API 来源',
  enabled: true,
  intervalMs: 600000,
  status: 'scheduled',
  pendingRun: false,
  nextRunAt: '2026-08-18T13:10:00.000Z',
  lastError: '',
  lastRun: null,
  runs: [],
  commands: [{ id: 'run_now', label: '立即刷新' }],
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe('robots page', () => {
  it('shows the refresh robot and sends the immediate command', async () => {
    let commands = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/robots/proxy-refresh/commands') commands += 1;
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [robot] }
        : robot;
      return new Response(JSON.stringify(payload), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: '机器人' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '代理刷新' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即刷新' }));
    await waitFor(() => expect(commands).toBe(1));
  });

  it('includes the current registration robot run in the run log', async () => {
    const registration = {
      ...robot,
      id: 'mailcom-register',
      name: '注册机器人',
      status: 'running',
      enabled: true,
      lastRun: {
        id: 'registration-live',
        command: 'start',
        reason: 'start',
        status: 'running',
        startedAt: '2026-08-18T13:00:00.000Z',
        finishedAt: null,
        durationMs: 0,
        result: null,
        error: '',
      },
      runs: [],
      commands: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: true, activeRunId: '', robots: [registration] }
        : url.pathname === '/api/v1/robots/runs' ? { items: [{ robot: registration, run: registration.lastRun }], total: 1, offset: 0, limit: 50 } : registration;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    await screen.findByRole('heading', { name: '运行日志' });
    await waitFor(() => expect(document.querySelector('.robot-history-panel')?.textContent).toContain('注册机器人'));
    expect(document.querySelector('.robot-history-panel')?.textContent).toContain('执行中');
  });

  it('uses a positive tone for enabled robots and keeps stopped robots neutral', async () => {
    const stopped = {
      ...robot,
      id: 'account-maintenance',
      name: '清洗机器人',
      enabled: false,
      status: 'idle',
      nextRunAt: null,
      commands: [{ id: 'run_now', label: '立即执行' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [robot, stopped] }
        : url.pathname.includes('account-maintenance') ? stopped : robot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    await screen.findByRole('heading', { name: '代理刷新' });
    const enabledBadge = screen.getAllByText('已启用').find((element) => element.classList.contains('status-badge'));
    expect(enabledBadge).toHaveClass('status-success');
    expect(screen.getByText('已停止')).toHaveClass('status-neutral');
    expect(screen.getByRole('button', { name: '停止机器人' })).toHaveClass('icon-button-active');
    expect(screen.getByRole('button', { name: '启动机器人' })).not.toHaveClass('icon-button-active');
  });

  it('configures the refresh interval and sends milliseconds to the robot API', async () => {
    let patchBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/robots/proxy-refresh' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body));
      }
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [robot] }
        : robot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: '配置代理刷新机器人' }));
    expect(await screen.findByRole('heading', { name: '代理刷新机器人' })).toBeInTheDocument();
    const interval = screen.getByRole('spinbutton');
    fireEvent.change(interval, { target: { value: '25' } });
    fireEvent.blur(interval);
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(patchBody).toEqual({ intervalMs: 1_500_000 }));
  });

  it('opens the single cleanup rule switch', async () => {
    const maintenance = {
      id: 'account-maintenance',
      name: '清洗机器人',
      description: '清理已注销/封禁的登录态资产',
      config: { deleteBannedAssets: true },
      configurable: true,
      configFields: [],
      enabled: false,
      intervalMs: 60000,
      status: 'idle',
      pendingRun: false,
      nextRunAt: null,
      lastError: '',
      lastRun: null,
      runs: [],
      commands: [{ id: 'run_now', label: '立即执行' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [maintenance] }
        : maintenance;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: '配置清洗机器人' }));
    expect(await screen.findByRole('heading', { name: '清洗机器人' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '清空已注销/封禁组' })).toBeChecked();
    // The four retired rules are gone from the dialog, not merely turned off.
    expect(screen.queryByRole('switch', { name: '清除提链 400/401' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '支付成功后刷新登录态' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '新注册账号自动提链' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '清理 Mail API 低价值组' })).toBeNull();
  });

  it('opens readable details for a robot run', async () => {
    const detailRobot = {
      ...robot,
      runs: [{
        id: 'robot-run-detail',
        command: 'run_now',
        reason: 'run_now',
        status: 'skipped',
        startedAt: '2026-08-18T13:00:00.000Z',
        finishedAt: '2026-08-18T13:00:02.000Z',
        durationMs: 2000,
        result: { runId: 'run-detail', reason: 'mail.com 可用地址长时间不足（14/20），本轮跳过' },
        error: '',
      }],
    };
    const runDetail = {
      runId: 'run-detail',
      jobs: [{
        id: 'job-skipped',
        email: 'skipped@example.test',
        status: 'skipped',
        result: '失败：EMAIL_OTP_TIMEOUT，轮询 15 次仍未收到验证码',
        error: { code: 'EMAIL_OTP_TIMEOUT', message: '轮询 15 次仍未收到验证码' },
      }],
    };
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      requestedUrls.push(url.toString());
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [detailRobot] }
        : url.pathname === '/api/v1/runs/run-detail' ? runDetail : url.pathname === '/api/v1/robots/runs' ? { items: detailRobot.runs.map(run => ({ robot: detailRobot, run })), total: 1, offset: 0, limit: 50 } : detailRobot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><RobotsPage /></Router></Tooltip.Provider></QueryClientProvider>);
    
    fireEvent.click(await screen.findByRole('button', { name: '查看运行详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('机器人运行详情');
    expect(dialog).toHaveTextContent(/14\/20/);
    expect(dialog).toHaveTextContent('关联任务');
    expect(dialog).toHaveTextContent('账号处理');
    expect(dialog).not.toHaveTextContent('原始运行记录');
    await waitFor(() => expect(dialog).toHaveTextContent('EMAIL_OTP_TIMEOUT，轮询 15 次仍未收到验证码'));
    expect(dialog.querySelector('.job-result-failure')).toHaveTextContent('EMAIL_OTP_TIMEOUT，轮询 15 次仍未收到验证码');
    expect(dialog).toHaveTextContent('skipped@example.test');
    expect(requestedUrls.some((url) => url.includes('reveal=1'))).toBe(false);
  });

  it('shows all pool capacities and saves registration settings through smooth selects', async () => {
    let patchBody: Record<string, unknown> | null = null;
    const registrationRobot = {
      ...robot,
      id: 'mailcom-register',
      name: 'Registration Robot',
      description: 'Template registration',
      config: {
        templateId: 'mail-v1',
        mailInterface: 'mailcom',
        rootEmailCount: 4,
        workerCount: 2,
        proxyMode: 'countryPool',
        proxyDistribution: 'capacity',
        countryCode: 'GB',
        iterations: 1,
      },
      configurable: true,
      configFields: [],
      commands: [{ id: 'run_now', label: 'Run now' }],
    };
    const proxyCatalog = {
      local: { total: 0, proxies: [] },
      dynamic: {
        total: 6,
        countryPools: [
          { countryCode: 'US', total: 4 },
          { countryCode: 'GB', total: 2 },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/robots/mailcom-register' && init?.method === 'PATCH') {
        const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBody = parsed;
        return new Response(JSON.stringify({ ...registrationRobot, ...parsed, config: (parsed.config || registrationRobot.config) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [registrationRobot] }
        : url.pathname === '/api/v1/proxies' ? proxyCatalog : registrationRobot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: 'Registration Robot' });
    const row = heading.closest('article');
    const configButton = row?.querySelector('.icon-button');
    expect(configButton).not.toBeNull();
    fireEvent.click(configButton as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2 池 · 6 条');
    expect(dialog).toHaveTextContent('US');
    expect(dialog).toHaveTextContent('GB');

    fireEvent.click(screen.getByRole('combobox', { name: '代理分配' }));
    fireEvent.click(await screen.findByRole('option', { name: '固定单一国家池' }));
    fireEvent.click(await screen.findByRole('combobox', { name: '国家池' }));
    fireEvent.click(await screen.findByRole('option', { name: 'GB · 2 条' }));
    fireEvent.click(dialog.querySelector('.button-primary') as HTMLElement);

    await waitFor(() => expect(patchBody).not.toBeNull());
    // The robot holds a set of templates now. A stored single template is
    // shown, and saved back, as the first of them.
    expect(patchBody!).toMatchObject({
      intervalMs: 600000,
      config: expect.objectContaining({
        activeTemplateId: 'mail-v1',
        templates: [expect.objectContaining({
          templateId: 'mail-v1',
          proxyDistribution: 'single',
          countryCode: 'GB',
        })],
      }),
    });
  });

  it('opens the active template and removes the current interface option', async () => {
    const registrationRobot = {
      ...robot,
      id: 'mailcom-register',
      name: 'Registration Robot',
      description: 'Template registration',
      config: {
        templateId: 'mail-v1',
        mailInterface: 'mailcom',
        rootEmailCount: 4,
        workerCount: 2,
        proxyMode: 'countryPool',
        proxyDistribution: 'capacity',
        countryCode: 'GB',
        iterations: 1,
      },
      configurable: true,
      configFields: [],
      commands: [{ id: 'run_now', label: 'Run now' }],
    };
    const proxyCatalog = { local: { total: 0, proxies: [] }, dynamic: { total: 0, countryPools: [] } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [registrationRobot] }
        : url.pathname === '/api/v1/proxies' ? proxyCatalog : registrationRobot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: 'Registration Robot' });
    fireEvent.click(heading.closest('article')?.querySelector('.icon-button') as HTMLElement);
    await screen.findByRole('dialog');
    // The saved template, not the record of the last round that ran: a
    // scheduled start uses what is saved, so that is what the editor shows.
    const mailSelect = screen.getByRole('combobox', { name: '邮箱接口' });
    expect(mailSelect).toHaveTextContent('Mail.com');
    fireEvent.click(mailSelect);
    expect(screen.queryByRole('option', { name: '当前配置' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Fastmail' })).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(4);
    expect(screen.getAllByRole('spinbutton')[1]).toHaveValue(2);
    expect(screen.getAllByRole('spinbutton')[2]).toHaveValue(1);
  });

  it('adds a second template with 挂租 and a clock schedule, and saves both', async () => {
    let patchBody: Record<string, any> | null = null;
    const registrationRobot = {
      ...robot,
      id: 'mailcom-register',
      name: 'Registration Robot',
      description: 'Template registration',
      config: {
        activeTemplateId: 'day',
        templates: [{
          templateId: 'day',
          name: '白天',
          mailInterface: 'mailcom',
          rootEmailCount: 4,
          workerCount: 2,
          proxyMode: 'countryPool',
          proxyDistribution: 'capacity',
          countryCode: 'GB',
          iterations: 1,
          mailRentalWatch: false,
          mailRentalTarget: 200,
          mailRentalBatchSize: 20,
          mailRentalPollIntervalMs: 20_000,
          schedule: { enabled: false, times: [], weekdays: [] },
        }],
      },
      configurable: true,
      configFields: [],
      commands: [{ id: 'run_now', label: 'Run now' }],
    };
    const proxyCatalog = { local: { total: 0, proxies: [] }, dynamic: { total: 0, countryPools: [] } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/robots/mailcom-register' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, any>;
        return new Response(JSON.stringify(registrationRobot), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [registrationRobot] }
        : url.pathname === '/api/v1/proxies' ? proxyCatalog : registrationRobot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: 'Registration Robot' });
    fireEvent.click(heading.closest('article')?.querySelector('.icon-button') as HTMLElement);
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: '新增模板' }));
    expect(within(dialog).getAllByRole('tab')).toHaveLength(2);
    fireEvent.change(within(dialog).getByLabelText('模板名称'), { target: { value: '夜间挂租' } });

    // 挂租 belongs to the one interface that rents mailboxes, so it only
    // appears once the template points there.
    expect(within(dialog).queryByText('挂租模式')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('combobox', { name: '邮箱接口' }));
    fireEvent.click(await screen.findByRole('option', { name: 'SMSBower' }));
    fireEvent.click(within(dialog).getByRole('switch', { name: /挂租模式/ }));
    fireEvent.change(within(dialog).getByLabelText('新增启动时刻'), { target: { value: '03:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加时刻' }));
    fireEvent.click(within(dialog).getByRole('switch', { name: /定时启动/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '五' }));
    fireEvent.click(dialog.querySelector('.button-primary') as HTMLElement);

    await waitFor(() => expect(patchBody).not.toBeNull());
    const saved = patchBody!.config.templates;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ templateId: 'day', mailRentalWatch: false });
    expect(saved[1]).toMatchObject({
      name: '夜间挂租',
      mailInterface: 'smsbower',
      mailRentalWatch: true,
      schedule: { enabled: true, times: ['03:30'], weekdays: [5] },
    });
    // The new template is a copy, not a blank: the first one stays the active
    // one until it is explicitly changed.
    expect(patchBody!.config.activeTemplateId).toBe('day');
  });

  it('keeps a refused scheduled start on the robot row', async () => {
    const registrationRobot = {
      ...robot,
      id: 'mailcom-register',
      name: 'Registration Robot',
      description: 'Template registration',
      config: { activeTemplateId: 'night', templates: [{ templateId: 'night', name: '夜间挂租', mailInterface: 'smsbower', rootEmailCount: 4, workerCount: 2, mailRentalWatch: true, mailRentalTarget: 80, schedule: { enabled: true, times: ['03:00'], weekdays: [] } }] },
      schedule: {
        next: { templateId: 'night', name: '夜间挂租', at: new Date('2026-09-23T03:00:00Z').toISOString() },
        upcoming: [],
        last: {
          templateId: 'night',
          templateName: '夜间挂租',
          scheduledAt: new Date('2026-09-22T03:00:00Z').toISOString(),
          firedAt: new Date('2026-09-22T03:00:00Z').toISOString(),
          outcome: 'skipped',
          reason: '有任务或其他机器人正在占用主任务位，本次计划未启动',
        },
      },
      configurable: true,
      configFields: [],
      commands: [{ id: 'run_now', label: 'Run now' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/robots'
        ? { schemaVersion: 1, taskBusy: false, activeRunId: '', robots: [registrationRobot] }
        : url.pathname === '/api/v1/proxies' ? { local: { total: 0, proxies: [] }, dynamic: { total: 0, countryPools: [] } } : registrationRobot;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><RobotsPage /></Tooltip.Provider></QueryClientProvider>);

    const row = (await screen.findByRole('heading', { name: 'Registration Robot' })).closest('article') as HTMLElement;
    expect(row.querySelector('.robot-schedule-next')).toHaveTextContent('按「夜间挂租」启动');
    expect(row.querySelector('.robot-schedule-warning')).toHaveTextContent('未启动：有任务或其他机器人正在占用主任务位');
    // The active template's own summary names the 挂租 target rather than the
    // root mailbox count it does not use.
    expect(row.querySelector('.robot-config-summary')).toHaveTextContent('挂租 80');
  });
});
