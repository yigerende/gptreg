import '@testing-library/jest-dom/vitest';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from 'radix-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, { pendingRentalRetryAt, rentalRetryReason } from './App';
import { CPA_PUSH_GROUP, SESSION_CHECK_GROUP, localActivity, pageResults } from './local-activity';
import { Router } from './router';
import { MAX_WORKER_CONCURRENCY } from './run-plan-ui';

const payloads: Record<string, unknown> = {
  '/api/v1/services': { services: [{ name: 'mail', status: 'online' }], sms: { name: 'smsbower', status: 'online', balance: 7.547, currency: 'USD' } },
  '/api/v1/health': { ok: true, activeRunId: '', now: new Date().toISOString() },
  '/api/v1/runs': { activeRunId: '', runs: [] },
  '/api/v1/session-assets': { assets: [] },
  '/api/v1/mailboxes': { mailboxes: [] },
  '/api/v1/config': { path: 'gpt-re.config.json', config: { mail: { count: 1 }, workers: { maxConcurrency: 1 }, aliases: { strategy: 'plus', count: 2, maxAttempts: 4, runTag: 'worker' }, proxyPool: { required: false } }, secrets: { mailPasswordConfigured: true, smsApiKeyConfigured: true } },
  '/api/v1/proxies': {
    total: 2,
    local: {
      total: 2,
      errors: [],
      proxies: [
        { id: 'proxy-local-1', endpoint: 'http://127.0.0.1:4001', url: 'http://127.0.0.1:4001', protocol: 'http', host: '127.0.0.1', port: '4001', hasCredentials: false, check: null },
        { id: 'proxy-local-2', endpoint: 'http://127.0.0.1:4002', url: 'http://127.0.0.1:4002', protocol: 'http', host: '127.0.0.1', port: '4002', hasCredentials: false, check: null },
      ],
    },
    dynamic: { total: 0, countryPools: [] },
    errors: [],
    proxies: [],
  },
  '/api/v1/preflight': {
    schemaVersion: 2,
    ready: true,
    mail: { provider: 'xiaopingguo', eligible: 100, selected: 1 },
    sms: { provider: 'smsbower', ready: true, balance: 7.547, service: { code: 'dr', name: 'OpenAI' }, country: { id: 151, name: 'Chile', chn: '智利' }, maxPrice: 0.06, cheapestPrice: 0.04, offers: 13, lowestOffers: [{ providerId: '3170', price: 0.04, count: 22 }, { providerId: '4120', price: 0.041, count: 18 }, { providerId: '6150', price: 0.043, count: 9 }] },
    proxy: { required: false, available: 0, ready: true },
    checks: [
      { id: 'mail', required: true, checked: true, ready: true, detail: '1/1' },
      { id: 'proxy', required: false, checked: true, ready: true, detail: 'Optional' },
      { id: 'sms', required: true, checked: true, ready: true, detail: '13 offers, balance 7.547 USD' },
    ],
    checkedAt: new Date().toISOString(),
  },
};

afterEach(() => {
  localActivity.set(null);
  // Both stores are module-level on purpose — they outlive the component that
  // wrote them — so a test that pushes would otherwise hand its result to the
  // next one.
  pageResults.clear(CPA_PUSH_GROUP);
  pageResults.clear(SESSION_CHECK_GROUP);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('console shell', () => {
  it('preflights and enables launch for a compact country pool without loading address pages', async () => {
    let checked = false;
    vi.stubGlobal('fetch',vi.fn(async (input:RequestInfo|URL, init?:RequestInit) => {
      const url=new URL(String(input),'http://localhost');
      let payload=payloads[url.pathname]||{};
      if(url.pathname==='/api/v1/proxies') {
        expect(url.searchParams.get('compact')).toBe('1');
        payload={total:500,local:{total:0,proxies:[],errors:[]},proxies:[],errors:[],dynamic:{total:500,countryPools:[{countryCode:'PH',total:500,entries:[],entryIds:Array.from({length:500},(_,i)=>`ph-${i}`),protocols:{http:500},sources:[],manualCount:0}]}};
      }
      if(url.pathname==='/api/v1/preflight') {
        expect(JSON.parse(String(init?.body)).plan.proxyAssignments).toEqual([{workerSlot:1,kind:'countryPool',countryCode:'PH'}]);
        checked=true;
      }
      return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
    }));
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App/></Router></Tooltip.Provider></QueryClientProvider>);
    await waitFor(()=>expect(checked).toBe(true));
    expect(await screen.findByRole('button',{name:'仅注册'})).toBeEnabled();
    expect(screen.queryByText(/Worker 代理分配无效/)).not.toBeInTheDocument();
  });

  it('shows the running task badge for an auxiliary run and a progress strip for running robots', async () => {
    window.history.replaceState(null, '', '/');
    vi.useFakeTimers({
      now: new Date('2026-09-02T00:00:00.000Z'),
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    const startedAt = new Date(Date.now() - 95_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/health') {
        // An `oauth` run occupies the auxiliary slot. The badge used to read
        // `runManager.active`, which only ever holds the main slot, so it went
        // blank for exactly the runs the login-state page starts.
        payload = { ok: true, activeRunId: 'ui-aux-run', now: new Date().toISOString() };
      }
      if (url.pathname === '/api/v1/runs') {
        payload = {
          activeRunId: 'ui-aux-run',
          activeRunIds: ['ui-aux-run'],
          runs: [{ runId: 'ui-aux-run', status: 'running', taskKind: 'oauth', taskSlot: 'auxiliary', active: true, startedAt }],
        };
      }
      if (url.pathname === '/api/v1/robots') {
        payload = {
          taskBusy: true,
          activeRunId: 'ui-aux-run',
          robots: [
            {
              id: 'proxy-refresh',
              name: '代理刷新',
              description: '',
              config: {},
              configurable: false,
              configFields: [],
              enabled: true,
              intervalMs: 600_000,
              status: 'running',
              pendingRun: false,
              progress: { done: 3, total: 8, label: 'JP 3/8', updatedAt: new Date().toISOString() },
              nextRunAt: null,
              lastError: '',
              lastRun: { id: 'r1', command: 'proxy.refresh_all', reason: 'interval', status: 'running', startedAt, finishedAt: null, durationMs: 0, result: null, error: '' },
              runs: [],
              commands: [],
            },
            {
              id: 'account-maintenance',
              name: '账号维护',
              description: '',
              config: {},
              configurable: false,
              configFields: [],
              enabled: true,
              intervalMs: 60_000,
              status: 'scheduled',
              pendingRun: false,
              nextRunAt: null,
              lastError: '',
              lastRun: null,
              runs: [],
              commands: [],
            },
          ],
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // The trigger counts what holds a task slot rather than naming one run: the
    // scheduler runs a main task beside several auxiliary ones, and the badge
    // this replaces showed whichever single id `health` happened to report.
    const trigger = await screen.findByRole('button', { name: /任务中心：1 个运行中/ });
    expect(trigger.textContent).toContain('1');
    fireEvent.click(trigger);

    const panel = await screen.findByRole('dialog', { name: '任务中心' });
    const row = within(panel).getByRole('link', { name: /凭据直登 OAuth/ });
    expect(row).toHaveAttribute('href', '/run/ui-aux-run');
    // Elapsed is computed from `startedAt`: a running task reports durationMs 0.
    expect(row.textContent).toContain('1 分 35 秒');
    // The auxiliary slot is named, because which slot a task holds is what
    // decides whether a new task can start beside it.
    expect(row.textContent).toContain('附属任务');

    // Only the running robot occupies the strip, and it carries its N-of-M.
    const strip = document.querySelector('.topbar-activity');
    expect(strip?.textContent).toContain('代理刷新');
    expect(strip?.textContent).toContain('3/8');
    expect(strip?.textContent).not.toContain('账号维护');
    expect(document.querySelector('.topbar-activity-fill')).toHaveStyle({ width: '38%' });
  });

  it('shows a draining next-round countdown for a waiting registration robot', async () => {
    window.history.replaceState(null, '', '/');
    vi.useFakeTimers({
      now: new Date('2026-09-02T00:00:00.000Z'),
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    const startedAt = new Date(Date.now() - 95_000).toISOString();
    const countdownStartedAt = new Date(Date.now() - 30_000).toISOString();
    const countdownEndsAt = new Date(Date.now() + 90_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/robots') {
        payload = {
          taskBusy: true,
          activeRunId: '',
          robots: [{
            id: 'mailcom-register',
            name: '注册机器人',
            description: '',
            config: {},
            configurable: true,
            configFields: [],
            enabled: true,
            intervalMs: 120_000,
            status: 'waiting',
            pendingRun: false,
            waitingReason: 'iteration_interval',
            waitingDetail: '等待下一轮执行',
            progress: {
              done: 120_000,
              total: 120_000,
              label: '下一轮开始',
              mode: 'countdown',
              startedAt: countdownStartedAt,
              endsAt: countdownEndsAt,
              updatedAt: countdownStartedAt,
            },
            nextRunAt: null,
            lastError: '',
            lastRun: { id: 'registration-live', command: 'start', reason: 'start', status: 'running', startedAt, finishedAt: null, durationMs: 0, result: null, error: '' },
            runs: [],
            commands: [],
          }],
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const strip = await screen.findByText('注册机器人 · 下一轮开始');
    expect(strip).toBeInTheDocument();
    expect(strip.closest('.topbar-activity-item')).toHaveTextContent('1 分 30 秒');
    expect(document.querySelector('.topbar-activity-fill')).toHaveStyle({ width: '75%' });

    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(document.querySelector('.topbar-activity-fill')).toHaveStyle({ width: '50%' });
  });

  it('names the parked task that is holding a slot, and the capacity it is holding', async () => {
    // The state this exists for: a paused task keeps its slot so it stays
    // resumable, so `active` is false while the slot is still taken. The badge
    // this replaces rendered only `health.activeRunId`, so the corner went
    // blank, the launch button stayed disabled, and nothing on screen connected
    // the two — the "任务崩了暂停不了" report.
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/health') payload = { ok: true, activeRunId: '', now: new Date().toISOString() };
      if (url.pathname === '/api/v1/runs') {
        payload = {
          activeRunId: '',
          activeRunIds: [],
          taskCapacity: {
            main: { capacity: 1, running: 1, starting: 0, available: 0, holders: [{ runId: 'ui-parked', status: 'paused', active: false }] },
            auxiliary: { capacity: 3, running: 0, starting: 0, available: 3, holders: [] },
          },
          runs: [{
            runId: 'ui-parked',
            status: 'paused',
            phase: 'waiting_sms_acquisition_reconcile',
            taskKind: 'register_session',
            taskSlot: 'main',
            active: false,
            plan: {
              taskKind: 'register_session',
              mailCount: 12,
              workerConcurrency: 6,
              aliasStrategy: 'plus',
              aliasCount: 3,
              aliasMaxAttempts: 5,
              aliasRunTag: 'gptre',
              totalAccounts: 36,
              mailProvider: 'mailcom',
              proxyAssignments: [{ workerSlot: 1, kind: 'countryPool', countryCode: 'VN' }],
            },
          }],
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // Nothing is executing, so the trigger counts the holder rather than going
    // quiet.
    const trigger = await screen.findByRole('button', { name: '任务中心：0 个运行中，1 个占用任务位' });
    fireEvent.click(trigger);
    const panel = await screen.findByRole('dialog', { name: '任务中心' });

    // Both slots are stated against their capacity, which is where the raised
    // auxiliary ceiling becomes visible at all.
    expect(panel.textContent).toContain('主任务');
    expect(panel.textContent).toContain('1/1');
    expect(panel.textContent).toContain('附属任务');
    expect(panel.textContent).toContain('0/3');

    const row = within(panel).getByRole('link', { name: /登录态注册/ });
    expect(row).toHaveAttribute('href', '/run/ui-parked');
    // The plan in words: a list of `ui-<timestamp>` ids is not something an
    // operator can pick a task out of.
    expect(row.textContent).toContain('12 根邮箱');
    expect(row.textContent).toContain('Mail.com API');
    expect(row.textContent).toContain('VN 池');
    // The phase reads as a sentence, not as the identifier the code uses.
    expect(row.textContent).toContain('取号结果待核对');
    expect(row.textContent).not.toContain('waiting_sms_acquisition_reconcile');
    expect(row.textContent).toContain('占用任务位');
  });

  it('keeps parallel auxiliary tasks in the same order when updatedAt changes', async () => {
    const olderStartedAt = '2026-09-11T00:00:00.000Z';
    const newerStartedAt = '2026-09-11T00:01:00.000Z';
    const olderRun = {
      runId: 'ui-aux-old',
      status: 'running',
      taskKind: 'oauth',
      taskSlot: 'auxiliary',
      active: true,
      startedAt: olderStartedAt,
      updatedAt: '2026-09-11T00:02:00.000Z',
    };
    const newerRun = {
      runId: 'ui-aux-new',
      status: 'running',
      taskKind: 'session_refresh',
      taskSlot: 'auxiliary',
      active: true,
      startedAt: newerStartedAt,
      updatedAt: '2026-09-11T00:03:00.000Z',
    };
    const makeRunsPayload = (runs: unknown[]) => ({
      activeRunId: 'ui-aux-new',
      activeRunIds: ['ui-aux-old', 'ui-aux-new'],
      taskCapacity: {
        main: { capacity: 1, running: 0, starting: 0, available: 1, holders: [] },
        auxiliary: { capacity: 3, running: 2, starting: 0, available: 1, holders: [] },
      },
      runs,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/runs'
        ? makeRunsPayload([newerRun, olderRun])
        : (payloads[url.pathname] || {});
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await waitFor(() => expect(document.querySelector('.task-center-trigger:not(.is-idle)')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.task-center-trigger') as HTMLElement);
    const panel = await screen.findByRole('dialog');
    const rowHrefs = () => Array.from(panel.querySelectorAll<HTMLAnchorElement>('.task-center-row'))
      .map((row) => row.getAttribute('href'));
    await waitFor(() => expect(rowHrefs()).toEqual(['/run/ui-aux-new', '/run/ui-aux-old']));

    act(() => {
      client.setQueryData(['runs'], makeRunsPayload([
        { ...olderRun, updatedAt: '2026-09-11T00:04:00.000Z' },
        { ...newerRun, updatedAt: '2026-09-11T00:01:30.000Z' },
      ]));
    });
    await waitFor(() => expect(rowHrefs()).toEqual(['/run/ui-aux-new', '/run/ui-aux-old']));
  });

  it('renders local ports and country pools in independent proxy columns', async () => {
    window.history.replaceState(null, '', '/proxies');
    const sourceUrl = 'http://global.rotgbapi.711proxy.com:8089/gen?zone=custom&ptype=1&region=CL&count=2&proto=http&stype=text&split=%5Cr%5Cn&sessType=sticky&sessTime=180&sessAuto=0';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: any = url.pathname === '/api/v1/proxies' ? {
        total: 4,
        local: (payloads['/api/v1/proxies'] as any).local,
        dynamic: {
          total: 2,
          countryPools: [{
            countryCode: 'CL', total: 2, protocols: { http: 2 }, manualCount: 0,
            entries: [
              { id: 'cl-1', url: 'http://cl-a.example:8001', protocol: 'http', countryCode: 'CL', sourceId: 'source-cl' },
              { id: 'cl-2', url: 'http://cl-b.example:8002', protocol: 'http', countryCode: 'CL', sourceId: 'source-cl' },
            ],
            sources: [{ id: 'source-cl', provider: '711proxy', url: sourceUrl, countryCode: 'CL', count: 2, protocol: 'http', sessionType: 'sticky', sessionMinutes: 180, earlyRotation: false, entries: [], cachedCount: 2, lastPulledAt: new Date().toISOString(), lastPullCount: 2, lastError: '' }],
          }],
        },
        errors: [], proxies: [],
      } : payloads[url.pathname] || {};
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: '代理资源' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '本地端口' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '国家代理池' })).toBeInTheDocument();
    expect(await screen.findByText(/global\.rotgbapi\.711proxy\.com/)).toBeInTheDocument();
    expect(await screen.findByText('2 条 · 固定 180 分钟 · 不提前换 IP')).toBeInTheDocument();
    expect(document.querySelector('.proxy-split-workspace')).toBeInTheDocument();
  });

  it('renders the operational dashboard with live-resource sections', async () => {
    let preflightBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/preflight') preflightBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify(payloads[url.pathname] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: '启动工作台' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '运行概览' })).toBeInTheDocument();
    expect(document.querySelector('.active-run-summary')).toBeNull();
    expect(document.querySelector('.task-slot-board')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '调度器空闲' })).not.toBeInTheDocument();
    expect(document.querySelector('.recent-runs-rail')).toBeInTheDocument();
    expect(await screen.findByText('100')).toBeInTheDocument();
    expect(screen.getByText('$7.547')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '任务预检' })).toBeInTheDocument();
    expect(screen.getByText(/号码市场/)).toBeInTheDocument();
    expect(document.querySelector('.preflight-checks')?.textContent).toContain('可用根邮箱');
    expect(document.querySelector('.preflight-checks')?.textContent).toContain('Worker 代理');
    expect(document.querySelector('.preflight-checks')?.textContent).toContain('短信市场');
    expect(document.querySelectorAll('.preflight-state-dot').length).toBeGreaterThan(0);
    expect(screen.getByText('22')).toBeInTheDocument();
    expect(screen.queryByText('实时运行日志')).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/logs"]')).toBeNull();
    expect(document.querySelector('a[href="/config"]')).toBeNull();
    await waitFor(() => expect(preflightBody?.plan).toMatchObject({ schemaVersion: 3, mailCount: 1, workerConcurrency: 1 }));
    expect(screen.getByRole('group', { name: 'Worker 1 代理类型' })).toBeInTheDocument();
    expect(screen.getByLabelText('Worker 1 代理资源')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '管理代理' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '任务类型' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /登录态注册/ }));
    expect(screen.getByText('设置随机密码')).toBeInTheDocument();
    expect(screen.getByText('启用 TOTP')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '设置随机密码' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 TOTP' })).toBeChecked();
    const oauthMode = screen.getByRole('button', { name: /凭据直登 OAuth/ });
    expect(oauthMode).not.toBeNull();
    fireEvent.click(oauthMode!);
    expect(screen.getByText('账号凭据')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'OAuth 账号来源' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.preflight-checks')?.textContent).toContain('请粘贴账号凭据，或每行一个已保存登录态的邮箱'));
    expect(document.querySelector('.preflight-checks .spin')).toBeNull();
    expect(document.querySelector('.conditional-market')?.textContent).toContain('手机验证资源在实际出现挑战时按需获取');
  });

  it('restores the mailbox channel used by the latest task', async () => {
    const baseConfig = payloads['/api/v1/config'] as any;
    const configPayload = {
      ...baseConfig,
      config: {
        ...baseConfig.config,
        mail: { ...baseConfig.config.mail, provider: 'mailcom' },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/config') payload = configPayload;
      if (url.pathname === '/api/v1/runs') {
        // Keep the older task first to verify that recency, rather than array
        // position, decides which channel is restored.
        payload = {
          activeRunId: '',
          runs: [
            { runId: 'run-old-mail', status: 'complete', startedAt: '2026-09-12T08:00:00.000Z', updatedAt: '2026-09-12T08:10:00.000Z', plan: { mailProvider: 'mailcom' } },
            { runId: 'run-latest-sms', status: 'complete', startedAt: '2026-09-13T08:00:00.000Z', updatedAt: '2026-09-13T08:10:00.000Z', plan: { mailProvider: 'smsbower' } },
          ],
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByRole('radio', { name: /SMSBower Gmail/ })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: /Mail API/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('removes the OAuth mailbox quick picker and keeps manual entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/mailboxes'
        ? { mailboxes: [
          { id: 'bound-mail', email: 'bound@example.test', bound: true, tokenValid: true, provider: 'xiaopingguo' },
          { id: 'free-mail', email: 'free@example.test', bound: false, tokenValid: true, provider: 'xiaopingguo' },
        ] }
        : payloads[url.pathname] || {};
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    await screen.findByLabelText(/根邮箱数量（mail\.count）/);
    fireEvent.click(await screen.findByRole('button', { name: /凭据直登 OAuth/ }));
    expect(await screen.findByLabelText('账号凭据')).toBeInTheDocument();
    expect(document.querySelector('.mailbox-quick-list')).toBeNull();
    // 仅登录 sits beside the OAuth launch, the same way 仅注册 does for registration.
    expect(screen.getByRole('button', { name: /仅登录/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /启动凭据 OAuth|启动登录态直登/ })).toBeInTheDocument();
    expect(screen.queryByText('free@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('bound@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('已使用')).not.toBeInTheDocument();
  });

  it('renders login-state assets in an independently scrollable list and inspector', async () => {
    window.history.replaceState(null, '', '/sessions');
    window.scrollTo = vi.fn();
    const asset: any = {
      schemaVersion: 1,
      id: 'asset-ui-fixture',
      email: 'session@example.test',
      parentEmail: 'root@example.test',
      parentMailboxId: 'mail-1',
      accountId: 'account-session-ui',
      status: 'valid',
      planType: 'free',
      sourceKind: 'register_session',
      sourceRunId: 'ui-session-run',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      hasAccessToken: true,
      hasSessionToken: true,
      hasPassword: true,
      hasTotp: true,
      accessToken: 'access-ui-fixture',
      sessionToken: 'session-ui-fixture',
      password: 'password-ui-fixture',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      security: { passwordStatus: 'configured', totpStatus: 'configured' },
      health: null,
      trial: {
        status: 'trial',
        code: 'TRIAL_OFFER_AVAILABLE',
        message: 'The account can still claim a promo trial',
        httpStatus: 200,
        checkedAt: new Date().toISOString(),
        latencyMs: 24,
        planType: 'free',
        subscriptionPlan: 'chatgptfreeplan',
        hasActiveSubscription: false,
        hasPreviouslyPaid: false,
        activeTrial: false,
        defaultOfferId: 'chatgptplusplan',
        campaigns: [{ key: 'plus', id: 'plus-1-month-free', planName: 'chatgptplusplan', label: '1-month free trial', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100, offerKind: 'free_month', offerLabel: '1个月免费' }],
        offerKind: 'free_month',
        offerLabel: '1个月免费',
        freeMonthOffer: true,
        lastTrialAt: new Date().toISOString(),
      },
      cpa: { revision: 2, runId: 'ui-session-run', jobId: 'job-session', path: 'session-assets/asset-ui-fixture.json', updatedAt: new Date().toISOString() },
      oauth: { successful: true, successCount: 2, lastSucceededAt: new Date().toISOString(), lastRunId: 'ui-session-run', lastJobId: 'job-session' },
      lastError: null,
    };
    const second: any = {
      ...asset,
      id: 'asset-ui-second',
      email: 'second@example.test',
      accountId: 'account-session-second',
      security: { passwordStatus: 'configured', totpStatus: 'retry_pending', securityReauthStatus: 'required' },
      trial: { ...asset.trial, status: 'none', code: 'TRIAL_UNAVAILABLE', message: 'no promo', campaigns: [], offerKind: '', offerLabel: '', freeMonthOffer: false },
    };
    // A discounted campaign is still a trial, but it can never be 提链'd, so it
    // has to be tagged apart from the free month rather than sharing its label.
    const discounted: any = {
      ...asset,
      id: 'asset-ui-discounted',
      email: 'discounted@example.test',
      accountId: 'account-session-discounted',
      trial: {
        ...asset.trial,
        campaigns: [{ key: 'go', id: 'go-3-month-half-off', planName: 'chatgptgoplan', label: '3-month 50% off', durationPeriods: 3, durationPeriod: 'month', discountPercentage: 50, offerKind: 'discounted', offerLabel: '3个月半价' }],
        offerKind: 'discounted',
        offerLabel: '3个月半价',
        freeMonthOffer: false,
      },
    };
    const sessionRows = [asset, second, discounted];
    const probeRequests: string[][] = [];
    const trialRequests: string[][] = [];
    const oauthRequests: string[][] = [];
    let holdBulkProbe = false;
    let releaseBulkProbe: () => void = () => {};
    const bulkProbeGate = new Promise<void>((resolve) => { releaseBulkProbe = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/session-assets' && String(init?.method || 'GET').toUpperCase() === 'GET') payload = { assets: sessionRows };
      if (url.pathname === '/api/v1/runs' && String(init?.method || 'GET').toUpperCase() === 'GET') payload = { activeRunId: '', runs: [{ runId: 'ui-session-run', status: 'complete', updatedAt: new Date().toISOString() }] };
      if (url.pathname.startsWith('/api/v1/session-assets/') && String(init?.method || 'GET').toUpperCase() === 'GET') {
        payload = sessionRows.find((item) => url.pathname.endsWith(item.id)) || {};
      }
      if (url.pathname === '/api/v1/session-assets/probe') {
        const ids = JSON.parse(String(init?.body || '{}')).assetIds as string[];
        probeRequests.push(ids);
        if (holdBulkProbe && ids.length === 2) await bulkProbeGate;
        const checkedAt = new Date().toISOString();
        const results = ids.map((id) => {
          const item = sessionRows.find((candidate) => candidate.id === id)!;
          item.health = { status: 'healthy', code: 'AT_VALID', message: 'ok', httpStatus: 200, checkedAt, latencyMs: 18, lastHealthyAt: checkedAt };
          return { assetId: id, email: item.email, healthy: true, ...item.health };
        });
        payload = { requested: ids.length, checked: ids.length, results };
      }
      if (url.pathname === '/api/v1/session-assets/trial-check') {
        const ids = JSON.parse(String(init?.body || '{}')).assetIds as string[];
        trialRequests.push(ids);
        const checkedAt = new Date().toISOString();
        const results = ids.map((id) => {
          const item = sessionRows.find((candidate) => candidate.id === id)!;
          return { assetId: id, email: item.email, trialAvailable: item.trial.status === 'trial', ...item.trial, checkedAt };
        });
        payload = { requested: ids.length, checked: ids.length, results };
      }
      if (url.pathname === '/api/v1/runs' && String(init?.method || 'GET').toUpperCase() === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        oauthRequests.push(body.plan.oauthSource.assetIds);
        payload = { runId: 'ui-session-oauth', status: 'running', active: true };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: '登录态资产' })).toBeInTheDocument();
    expect((await screen.findAllByText('session@example.test')).length).toBeGreaterThan(0);
    expect(document.querySelector('.session-email-latest')).toHaveTextContent('session@example.test');
    expect(await screen.findByText('待安全重认证')).toBeInTheDocument();
    expect(await screen.findByText('登录凭据')).toBeInTheDocument();
    expect(screen.getByText('会话身份')).toBeInTheDocument();
    expect(await screen.findByText('OAuth 已成功')).toBeInTheDocument();
    expect(screen.getAllByText('有效').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^OAuth 当前账号$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: new RegExp(`^OAuth ${asset.email}$`) })).toBeEnabled();
    expect(document.querySelector('.sessions-workspace')).toBeInTheDocument();
    expect(document.querySelector('.session-list-scroll')).toBeInTheDocument();
    expect(document.querySelector('.session-inspector')).toBeInTheDocument();
    expect(screen.getAllByText('1个月免费').length).toBeGreaterThan(0);
    expect(screen.getByText('3个月半价')).toBeInTheDocument();
    expect(screen.getByText('无试用')).toBeInTheDocument();
    // The two promo kinds must not share a colour class: only the free month is
    // the one the chain page will accept.
    expect(document.querySelector('.trial-badge.trial-free')).toBeInTheDocument();
    expect(document.querySelector('.trial-badge.trial-promo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `AT 测活 ${asset.email}` }));
    await waitFor(() => expect(probeRequests).toContainEqual([asset.id]));
    // The outcome lands on a line that stays, not in a notice that dismisses
    // itself: a check of forty accounts used to announce its result for a few
    // seconds and leave nothing behind.
    // The line names the check once and reports the findings beside it; the
    // full sentence lives where the name is not already on screen — the top
    // bar's tooltip, and the floating notice on any other page.
    expect(await screen.findByText('有效 1')).toBeInTheDocument();
    expect(document.querySelector('.topbar-activity-item')).toHaveAttribute('title', 'AT 测活完成：有效 1');
    const checkResult = await waitFor(() => {
      const element = document.querySelector('.session-check-result-success') as HTMLElement | null;
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(checkResult.querySelector('strong')).toHaveTextContent('AT 测活');
    expect(checkResult.querySelector('time')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `优惠检测 ${asset.email}` }));
    await waitFor(() => expect(trialRequests).toContainEqual([asset.id]));
    // The next check replaces it rather than stacking a second line.
    expect(await screen.findByText('一个月免费 1')).toBeInTheDocument();
    expect(document.querySelectorAll('.session-check-result')).toHaveLength(1);
    expect(document.querySelector('.session-check-result strong')).toHaveTextContent('优惠检测');
    // And it can be cleared once it has been read.
    fireEvent.click(screen.getByRole('button', { name: '清除上次检测结果' }));
    expect(document.querySelector('.session-check-result')).toBeNull();

    const refreshConcurrency = screen.getByLabelText('刷新并发');
    await waitFor(() => expect(refreshConcurrency).toHaveValue(20));
    fireEvent.wheel(refreshConcurrency, { deltaY: 100 });
    expect(refreshConcurrency).toHaveValue(19);
    fireEvent.click(screen.getByLabelText(`选择 ${asset.email}`));
    fireEvent.click(screen.getByLabelText(`选择 ${second.email}`));
    await waitFor(() => expect(refreshConcurrency).toHaveValue(19));
    fireEvent.wheel(refreshConcurrency, { deltaY: -100 });
    expect(refreshConcurrency).toHaveValue(20);
    holdBulkProbe = true;
    fireEvent.click(screen.getByRole('button', { name: '批量 AT 测活 (2)' }));
    // Two surfaces while it runs, each for a different reader: the top bar,
    // which follows you off the page, and the page's own line.
    const topbar = await waitFor(() => {
      const element = document.querySelector('.topbar-activity') as HTMLElement | null;
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(within(topbar).getByText('AT 测活')).toBeInTheDocument();
    expect(topbar).toHaveTextContent('0/2');
    const runningLine = document.querySelector('.session-check-result-running') as HTMLElement;
    expect(runningLine).toHaveTextContent('0/2');
    fireEvent.click(screen.getByRole('link', { name: '启动工作台' }));
    expect(await screen.findByRole('heading', { name: '启动工作台' })).toBeInTheDocument();
    const activityAfterNavigation = document.querySelector('.topbar-activity') as HTMLElement;
    expect(activityAfterNavigation).toBeTruthy();
    expect(activityAfterNavigation).toHaveTextContent('0/2');
    releaseBulkProbe();
    await waitFor(() => expect(probeRequests).toContainEqual([asset.id, second.id]));
    // Off the session page there is no line to carry the name, so the floating
    // notice spells the whole thing out.
    expect(await screen.findByText('AT 测活完成：有效 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '登录态' }));
    expect(await screen.findByRole('heading', { name: '登录态资产' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `OAuth ${asset.email}` }));
    const confirmProxy = await screen.findByRole('button', { name: '确认代理并继续' });
    await waitFor(() => expect(confirmProxy).toBeEnabled());
    fireEvent.click(confirmProxy);
    await waitFor(() => expect(oauthRequests).toContainEqual([asset.id]));
  });

  it('filters and bulk-selects actionable login-state queues', async () => {
    window.history.replaceState(null, '', '/sessions');
    window.scrollTo = vi.fn();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const base: any = {
      schemaVersion: 1,
      parentEmail: 'root@example.test',
      parentMailboxId: 'mail-filter',
      status: 'valid',
      planType: 'free',
      sourceKind: 'register_session',
      sourceRunId: 'run-filter',
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
      accessTokenExpiresAt: future,
      hasAccessToken: true,
      hasSessionToken: true,
      hasPassword: true,
      hasTotp: true,
      accessToken: 'access-filter',
      sessionToken: 'session-filter',
      security: { passwordStatus: 'configured', totpStatus: 'configured' },
      health: { status: 'healthy', code: 'AT_VALID', message: 'ok', httpStatus: 200, checkedAt: now, latencyMs: 12, lastHealthyAt: now },
      trial: { status: 'none', code: 'TRIAL_UNAVAILABLE', message: 'no promo', httpStatus: 200, checkedAt: now, latencyMs: 9, planType: 'free', subscriptionPlan: 'chatgptfreeplan', hasActiveSubscription: false, hasPreviouslyPaid: false, activeTrial: false, defaultOfferId: '', campaigns: [], lastTrialAt: '' },
      oauth: { successful: true, successCount: 1, lastSucceededAt: now, lastRunId: 'run-filter', lastJobId: 'job-filter' },
      cpa: null,
      lastError: null,
      lifecycle: 'active',
      facets: [],
    };
    const security = { ...base, id: 'asset-filter-security', email: 'security-needed@example.test', accountId: 'account-security', hasPassword: false, hasTotp: false, nextAction: 'security', security: { passwordStatus: 'retry_pending', totpStatus: 'not_requested' } };
    const oauth = { ...base, id: 'asset-filter-oauth', email: 'oauth-needed@example.test', accountId: 'account-oauth', nextAction: 'oauth', oauth: { successful: false, successCount: 0, lastSucceededAt: '', lastRunId: '', lastJobId: '' } };
    const refresh = { ...base, id: 'asset-filter-refresh', email: 'refresh-needed@example.test', accountId: 'account-refresh', nextAction: 'refresh', health: { status: 'invalid', code: 'AT_UNAUTHORIZED', message: 'probe rejected the token', httpStatus: 401, checkedAt: now, latencyMs: 10, lastHealthyAt: '' } };
    const expired = { ...base, id: 'asset-filter-expired', email: 'expired-naturally@example.test', accountId: 'account-expired', nextAction: 'none', accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() };
    const plus = { ...base, id: 'asset-filter-plus', email: 'plus@example.test', accountId: 'account-plus', planType: 'plus', nextAction: 'oauth', facets: ['plus'], oauth: { successful: false, successCount: 0, lastSucceededAt: '', lastRunId: '', lastJobId: '' }, trial: { ...base.trial, status: 'none', code: 'TRIAL_NOT_NEEDED', message: 'Plus account', campaigns: [] } };
    const discounted = { ...base, id: 'asset-filter-discounted', email: 'discounted@example.test', accountId: 'account-discounted', nextAction: 'oauth', oauth: { successful: false, successCount: 0, lastSucceededAt: '', lastRunId: '', lastJobId: '' }, trial: { ...base.trial, status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'half-price promo', offerKind: 'discounted', offerLabel: '3个月半价', campaigns: [{ key: 'plus', id: 'plus-half-price', planName: 'chatgptplusplan', label: '3 months half price', durationPeriods: 3, durationPeriod: 'month', discountPercentage: 50, offerKind: 'discounted', offerLabel: '3个月半价' }] } };
    const goFree = { ...base, id: 'asset-filter-go-free', email: 'go-free@example.test', accountId: 'account-go-free', nextAction: 'oauth', oauth: { successful: false, successCount: 0, lastSucceededAt: '', lastRunId: '', lastJobId: '' }, trial: { ...base.trial, status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'Go free promo', offerKind: 'free_month', offerLabel: '1个月免费', freeMonthOffer: true, campaigns: [{ key: 'go', id: 'go-1-month-free', planName: 'chatgptgoplan', label: '1 month free', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100, offerKind: 'free_month', offerLabel: '1个月免费' }] } };
    const ready = { ...base, id: 'asset-filter-ready', email: 'plus-complete@example.test', accountId: 'account-plus-complete', planType: 'plus', nextAction: 'none', facets: ['plus'], cpa: { path: 'cpa/plus-complete.json' } };
    const planned = { ...plus, id: 'asset-filter-planned', email: 'planned-account@example.test', accountId: 'account-planned-plus', lifecycle: 'planned', nextAction: 'none' };
    const sold = { ...plus, id: 'asset-filter-sold', email: 'sold-account@example.test', accountId: 'account-sold-plus', lifecycle: 'sold', nextAction: 'none' };
    const rows = [security, oauth, refresh, expired, plus, discounted, goFree, ready, planned, sold];
    const matches = (url: URL) => {
      const lifecycle = url.searchParams.get('lifecycle') || 'all';
      const queue = url.searchParams.get('queue') || 'all';
      const sourceRun = url.searchParams.get('sourceRun') || '';
      const search = (url.searchParams.get('q') || '').trim().toLowerCase();
      const facets = url.searchParams.getAll('facet');
      const hasFacet = (asset: any, facet: string) => facet === 'atExpired'
        ? Date.parse(asset.accessTokenExpiresAt) <= Date.now()
        : asset.facets.includes(facet);
      return rows.filter((asset) => (!sourceRun || asset.sourceRunId === sourceRun)
        && (!search || [asset.email, asset.accountId, asset.id, asset.planType, asset.sourceRunId].some((value) => String(value || '').toLowerCase().includes(search)))
        && (lifecycle === 'all' || asset.lifecycle === lifecycle)
        && (queue === 'all' || asset.nextAction === queue)
        && facets.every((facet) => hasFacet(asset, facet)));
    };
    const pageFor = (url: URL) => {
      const lifecycle = url.searchParams.get('lifecycle') || 'all';
      const queue = url.searchParams.get('queue') || 'all';
      const facets = url.searchParams.getAll('facet');
      const scoped = rows.filter((asset) => {
        const sourceRun = url.searchParams.get('sourceRun') || '';
        const search = (url.searchParams.get('q') || '').trim().toLowerCase();
        return (!sourceRun || asset.sourceRunId === sourceRun)
          && (!search || [asset.email, asset.accountId, asset.id, asset.planType, asset.sourceRunId].some((value) => String(value || '').toLowerCase().includes(search)));
      });
      const hasFacet = (asset: any, facet: string) => facet === 'atExpired'
        ? Date.parse(asset.accessTokenExpiresAt) <= Date.now()
        : asset.facets.includes(facet);
      const byLifecycle = (asset: any) => lifecycle === 'all' || asset.lifecycle === lifecycle;
      const byQueue = (asset: any) => queue === 'all' || asset.nextAction === queue;
      const byFacets = (asset: any) => facets.every((facet) => hasFacet(asset, facet));
      const facetNames = new Set(['atExpired', ...scoped.flatMap((asset) => asset.facets)]);
      const counts: any = { lifecycle: {}, queue: {}, facets: {} };
      for (const facet of facetNames) counts.facets[facet] = 0;
      const matched: any[] = [];
      for (const asset of scoped) {
        if (byQueue(asset) && byFacets(asset)) counts.lifecycle[asset.lifecycle] = (counts.lifecycle[asset.lifecycle] || 0) + 1;
        if (byLifecycle(asset) && byFacets(asset)) counts.queue[asset.nextAction] = (counts.queue[asset.nextAction] || 0) + 1;
        if (byLifecycle(asset) && byQueue(asset) && byFacets(asset)) {
          matched.push(asset);
          for (const facet of facetNames) if (hasFacet(asset, facet)) counts.facets[facet] += 1;
        }
      }
      return {
        assets: matched,
        total: matched.length,
        offset: 0,
        limit: 200,
        cursor: '',
        counts,
        sourceRuns: ['run-filter'],
      };
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/session-assets') payload = pageFor(url);
      if (url.pathname === '/api/v1/session-assets/ids') {
        const matched = matches(url);
        payload = { ids: matched.map((asset) => asset.id), total: matched.length };
      }
      if (url.pathname.startsWith('/api/v1/session-assets/') && url.pathname !== '/api/v1/session-assets/ids') payload = rows.find((asset) => url.pathname.endsWith(asset.id)) || {};
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const queue = await screen.findByRole('combobox', { name: '账号队列筛选' });
    const lifecycle = await screen.findByRole('combobox', { name: '库存状态筛选' });

    fireEvent.click(queue);
    expect(await screen.findByRole('option', { name: '全部待办 · 8' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'AT 需刷新 · 1' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '待补 PW/OTP · 1' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '待 OAuth · 4' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '无待办 · 2' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: '待 OAuth · 4' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(oauth.email);
      expect(text).toContain(plus.email);
      expect(text).toContain(discounted.email);
      expect(text).toContain(goFree.email);
      expect(text).not.toContain(ready.email);
    });

    fireEvent.click(queue);
    fireEvent.click(await screen.findByRole('option', { name: '全部待办 · 8' }));
    fireEvent.click(lifecycle);
    expect(await screen.findByRole('option', { name: '在库 · 8' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '计划卖出 · 1' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '已卖出 · 1' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: '已卖出 · 1' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(sold.email);
      expect(text).not.toContain(plus.email);
    });
    fireEvent.click(lifecycle);
    fireEvent.click(await screen.findByRole('option', { name: '计划卖出 · 1' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(planned.email);
      expect(text).not.toContain(sold.email);
    });
    expect(document.querySelector('.session-classification-planned')).toHaveTextContent('计划卖出');

    fireEvent.click(lifecycle);
    fireEvent.click(await screen.findByRole('option', { name: '在库 · 8' }));
    const plusFacet = await screen.findByRole('button', { name: /^Plus 2$/ });
    fireEvent.click(plusFacet);
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(plus.email);
      expect(text).toContain(ready.email);
      expect(text).not.toContain(oauth.email);
    });
    const clearFacets = await screen.findByRole('button', { name: '清除 1 项属性' });
    fireEvent.click(clearFacets);

    fireEvent.click(queue);
    fireEvent.click(await screen.findByRole('option', { name: '待补 PW/OTP · 1' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(security.email);
      expect(text).not.toContain(oauth.email);
    });
    const selectAll = screen.getByLabelText('全选匹配 1');
    fireEvent.click(selectAll);
    await waitFor(() => expect(selectAll).toBeChecked());
    fireEvent.click(selectAll);
    await waitFor(() => expect(selectAll).not.toBeChecked());

    fireEvent.click(queue);
    fireEvent.click(await screen.findByRole('option', { name: '待 OAuth · 4' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(oauth.email);
      expect(text).not.toContain(security.email);
    });
    expect(screen.getByLabelText('全选匹配 4')).not.toBeChecked();

    fireEvent.click(queue);
    fireEvent.click(await screen.findByRole('option', { name: 'AT 需刷新 · 1' }));
    await waitFor(() => {
      const text = document.querySelector('.session-list-scroll')?.textContent || '';
      expect(text).toContain(refresh.email);
      expect(text).not.toContain(expired.email);
    });
    const refreshRow = [...document.querySelectorAll('.session-list-row')].find((row) => row.textContent?.includes(refresh.email));
    expect(refreshRow?.textContent).toContain('已失效');
  }, 15000);

  it('starts OTP and password recovery for an incomplete login-state asset', async () => {
    window.history.replaceState(null, '', '/sessions');
    window.scrollTo = vi.fn();
    const asset: any = {
      schemaVersion: 1,
      id: 'asset-security-recovery',
      email: 'recovery@example.test',
      parentEmail: 'recovery@example.test',
      parentMailboxId: 'mail-recovery',
      accountId: 'account-recovery',
      status: 'partial',
      planType: 'free',
      sourceKind: 'register_session',
      sourceRunId: 'run-recovery',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      hasAccessToken: true,
      hasSessionToken: true,
      hasPassword: false,
      hasTotp: false,
      security: { passwordStatus: 'retry_pending', totpStatus: 'not_requested' },
      health: null,
      cpa: null,
      lastError: null,
    };
    let recoveryBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = String(init?.method || 'GET').toUpperCase();
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/session-assets' && method === 'GET') payload = { assets: [asset] };
      if (url.pathname === `/api/v1/session-assets/${asset.id}` && method === 'GET') payload = asset;
      if (url.pathname === '/api/v1/session-assets/refresh' && method === 'POST') {
        recoveryBody = JSON.parse(String(init?.body || '{}'));
        payload = { runId: 'ui-security-recovery', status: 'running', active: true };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const recover = await screen.findByRole('button', { name: /^OTP\/PW 恢复$/ });
    await waitFor(() => expect(recover).toBeEnabled());
    expect(screen.getAllByText('未 OAuth').length).toBeGreaterThan(0);
    fireEvent.click(recover);
    await waitFor(() => expect(recoveryBody).toMatchObject({
      assetIds: [asset.id],
      workerConcurrency: 1,
      security: { setPassword: true, enrollTotp: true },
    }));
    expect(recoveryBody.proxyAssignments).toHaveLength(1);
  });

  it('increasing Worker count expands root mail and synchronizes proxy rows and preflight', async () => {
    const preflightPlans: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/preflight') preflightPlans.push(JSON.parse(String(init?.body || '{}')).plan);
      return new Response(JSON.stringify(payloads[url.pathname] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const workerCount = await screen.findByLabelText(/Worker 并发/);
    fireEvent.focus(workerCount);
    fireEvent.change(workerCount, { target: { value: '2' } });
    fireEvent.blur(workerCount);

    await waitFor(() => expect(screen.getByLabelText(/根邮箱数量（mail\.count）/)).toHaveValue(2));
    expect(screen.getByRole('group', { name: 'Worker 2 代理类型' })).toBeInTheDocument();
    expect(screen.getByLabelText('Worker 2 代理资源')).toBeInTheDocument();
    await waitFor(() => expect(preflightPlans.some((plan) => plan?.workerConcurrency === 2
      && plan?.mailCount === 2
      && plan?.proxyAssignments?.length === 2)).toBe(true));
  });

  it('starts a task with an independent run plan without rewriting global configuration', async () => {
    window.scrollTo = vi.fn();
    let submitted: any = null;
    const calls: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = String(init?.method || 'GET').toUpperCase();
      calls.push({ path: url.pathname, method });
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs' && method === 'POST') {
        submitted = JSON.parse(String(init?.body || '{}'));
        payload = { runId: 'ui-independent-plan', status: 'running', active: true };
      }
      return new Response(JSON.stringify(payload), { status: method === 'POST' && url.pathname === '/api/v1/runs' ? 202 : 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const mailCount = await screen.findByLabelText(/根邮箱数量（mail\.count）/);
    fireEvent.focus(mailCount);
    fireEvent.change(mailCount, { target: { value: '4' } });
    fireEvent.blur(mailCount);
    expect(screen.getByRole('radiogroup', { name: '邮箱接口模式' })).toBeInTheDocument();
    expect(document.querySelector('.launch-mail-channel-row')?.parentElement).toHaveClass('task-input-column');
    expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /SMSBower Gmail/ }));
    const smsSettingsDialog = await screen.findByRole('dialog', { name: 'SMSBower Gmail 设置' });
    expect(smsSettingsDialog.querySelector('.sms-mail-current-mode')).toHaveTextContent('普通租约');
    expect(within(smsSettingsDialog).queryAllByRole('spinbutton')).toHaveLength(0);
    fireEvent.click(within(smsSettingsDialog).getByRole('radio', { name: /挂租模式/ }));
    expect(within(smsSettingsDialog).getAllByRole('spinbutton')).toHaveLength(3);
    fireEvent.click(within(smsSettingsDialog).getByRole('radio', { name: /普通租约/ }));
    expect(within(smsSettingsDialog).queryAllByRole('spinbutton')).toHaveLength(0);
    fireEvent.click(within(smsSettingsDialog).getByRole('button', { name: '应用配置' }));
    expect(screen.getByText(/当前：普通租约/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).toBeDisabled());
    expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /小苹果池/ }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).toBeChecked());
    expect(screen.queryByLabelText('每根目标账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('最大别名尝试')).not.toBeInTheDocument();
    const startTask = screen.getByRole('button', { name: /^注册后 OAuth$/ });
    await waitFor(() => expect(startTask).toBeEnabled());
    fireEvent.click(startTask);

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted.plan).toMatchObject({ mailCount: 4, workerConcurrency: 1, aliasStrategy: 'root_plus', aliasCount: 2, aliasRunTag: 'worker', postRegistrationOAuth: true, security: { setPassword: true, enrollTotp: true } });
    expect(submitted.plan.totalAccounts).toBe(8);
    expect(calls.some((call) => call.path === '/api/v1/config' && call.method === 'PUT')).toBe(false);
  });

  it('allows ordinary tasks above 200 up to 1000 and caps the launch input', async () => {
    window.scrollTo = vi.fn();
    let submitted: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/config') {
        const base = payloads[url.pathname] as any;
        payload = { ...base, config: { ...base.config, mail: { ...base.config.mail, provider: 'smsbower' } } };
      }
      if (url.pathname === '/api/v1/runs' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body));
        payload = { runId: 'ui-thousand', status: 'running', active: true };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    const mailCount = await screen.findByLabelText(/根邮箱数量（mail\.count）/);
    expect(mailCount).toHaveAttribute('max', '1000');
    const startTask = screen.getByRole('button', { name: /^仅注册$/ });
    for (const value of ['271', '1000', '1001']) {
      fireEvent.focus(mailCount);
      fireEvent.change(mailCount, { target: { value } });
      fireEvent.blur(mailCount);
      await waitFor(() => expect(mailCount).toHaveValue(Math.min(Number(value), 1000)));
      await waitFor(() => expect(startTask).toBeEnabled());
    }
    fireEvent.click(startTask);
    await waitFor(() => expect(submitted?.plan.mailCount).toBe(1000));
    expect(submitted.plan.totalAccounts).toBe(1000);
    expect(submitted.plan.mailRentalWatch).not.toBe(true);
  });

  it('switches mail-channel defaults and preflight state with the selected provider', async () => {
    const preflightPlans: any[] = [];
    const baseConfig = payloads['/api/v1/config'] as any;
    const configPayload = {
      ...baseConfig,
      config: {
        ...baseConfig.config,
        mail: { ...baseConfig.config.mail, provider: 'smsbower', maxPrice: 0.2 },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/config') payload = configPayload;
      if (url.pathname === '/api/v1/preflight') preflightPlans.push(JSON.parse(String(init?.body || '{}')).plan);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).toBeDisabled());
    expect(screen.getByText('按次租用，只有根邮箱')).toBeInTheDocument();
    await waitFor(() => expect(preflightPlans.some((plan) => plan?.mailProvider === 'smsbower'
      && plan?.postRegistrationOAuth === false
      && plan?.security?.setPassword === true
      && plan?.security?.enrollTotp === true)).toBe(true));
    fireEvent.click(await screen.findByRole('radio', { name: /小苹果池/ }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 Plus 别名' })).toBeChecked());
    await waitFor(() => expect(preflightPlans.some((plan) => plan?.mailProvider === 'xiaopingguo' && plan?.postRegistrationOAuth === false)).toBe(true));
  });

  it('keeps Mail.com and Fastmail inside one Mail API configuration dialog', async () => {
    const providerRequests: Array<{ path: string; provider: string }> = [];
    const preflightProviders: string[] = [];
    let savedConfig: any = null;
    const baseConfig = payloads['/api/v1/config'] as any;
    const configPayload = {
      ...baseConfig,
      config: {
        ...baseConfig.config,
        mail: {
          ...baseConfig.config.mail,
          provider: 'mailcom',
          mailcomBaseUrl: 'http://127.0.0.1:8001',
          fastmailBaseUrl: 'http://127.0.0.1:8001',
          providerSettings: {
            mailcom: { aliasBatchSize: 9, aliasDomainMode: 'selected', aliasDomains: ['mail.example'] },
            fastmail: { aliasDomainMode: 'selected', aliasDomains: ['fast.example'] },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = String(init?.method || 'GET').toUpperCase();
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/config') {
        if (method === 'PUT') {
          savedConfig = JSON.parse(String(init?.body || '{}')).config;
          payload = { ...configPayload, config: savedConfig };
        } else {
          payload = configPayload;
        }
      }
      if (url.pathname === '/api/v1/preflight') {
        preflightProviders.push(JSON.parse(String(init?.body || '{}')).plan?.mailProvider || '');
      }
      if (url.pathname === '/api/v1/mailcom/status' || url.pathname === '/api/v1/mailcom/domains') {
        providerRequests.push({ path: url.pathname, provider: url.searchParams.get('provider') || '' });
        payload = url.pathname.endsWith('/status')
          ? { accounts: [], summary: { masters: 1, mailboxes: 50, available: 50 } }
          : { provider: url.searchParams.get('provider'), domains: ['example.com'] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('radio', { name: /Mail API/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Mail\.com API/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Mail API/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Mail API 邮箱商' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Mail.com' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(providerRequests.some(({ path, provider }) => path.endsWith('/status') && provider === 'mailcom')).toBe(true));
    expect(screen.getByDisplayValue('9')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '邮箱商开关' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('管理令牌')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Fastmail' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Fastmail' })).toHaveAttribute('aria-checked', 'true'));
    await waitFor(() => expect(providerRequests.some(({ path, provider }) => path.endsWith('/status') && provider === 'fastmail')).toBe(true));
    await waitFor(() => expect(providerRequests.some(({ path, provider }) => path.endsWith('/domains') && provider === 'fastmail')).toBe(true));
    expect(screen.getByDisplayValue('http://127.0.0.1:8001')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByDisplayValue('1')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('fast.example')).toBeInTheDocument();
    expect(preflightProviders).not.toContain('fastmail');

    fireEvent.click(within(dialog).getByRole('button', { name: '保存配置并切换' }));
    await waitFor(() => expect(savedConfig?.mail?.provider).toBe('fastmail'));
    expect(savedConfig.mail.providerSettings.fastmail).toMatchObject({ aliasDomainMode: 'selected', aliasDomains: ['fast.example'] });
    await waitFor(() => expect(preflightProviders).toContain('fastmail'));

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('radio', { name: /Mail API/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Fastmail' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps live Mail.com alias edits when task data refreshes', async () => {
    const baseConfig = payloads['/api/v1/config'] as any;
    const configPayload = {
      ...baseConfig,
      config: {
        ...baseConfig.config,
        mail: {
          ...baseConfig.config.mail,
          provider: 'mailcom',
          providerSettings: {
            mailcom: { aliasBatchSize: 9, aliasDomainMode: 'random', aliasDomains: ['teachers.org'] },
            fastmail: { aliasBatchSize: 1, aliasDomainMode: 'random', aliasDomains: [] },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/config') payload = configPayload;
      if (url.pathname === '/api/v1/mailcom/status') payload = { summary: { masters: 1, mailboxes: 1, available: 1 } };
      if (url.pathname === '/api/v1/mailcom/domains') payload = { provider: 'mailcom', domains: ['teachers.org', 'example.com'] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('radio', { name: /Mail API/ }));
    const dialog = await screen.findByRole('dialog');
    const domainInput = within(dialog).getByDisplayValue('teachers.org');
    fireEvent.change(domainInput, { target: { value: '' } });
    expect(domainInput).toHaveValue('');

    // A task poll updates the shared runs snapshot while the dialog remains open.
    // This used to rerun config hydration and restore the old provider setting.
    act(() => {
      client.setQueryData(['runs'], { activeRunId: '', activeRunIds: [], runs: [{ runId: 'live-refresh', status: 'complete' }] });
    });
    await waitFor(() => expect(domainInput).toHaveValue(''));
  });

  it('keeps iCloud in its own mailbox dialog without Mail API provider controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/icloud/status'
        ? { accounts: [], summary: { masters: 1, mailboxes: 1, available: 1 } }
        : (payloads[url.pathname] || {});
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('radio', { name: /iCloud/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('iCloud mailbox API')).toBeInTheDocument();
    expect(within(dialog).getByText('No aliases')).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: 'Mail.com' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: 'Fastmail' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('iCloud mailbox API')).toBeInTheDocument());
  });

  it('tests the selected SMS vendor with its own balance and selectable countries', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: any = payloads[url.pathname] || {};
      if (url.pathname.startsWith('/api/v1/sms/settings/')) {
        const provider = url.pathname.includes('/firefox') ? 'firefox' : 'smsbower';
        if (url.pathname.endsWith('/test')) {
          requests.push(provider);
          payload = { ok: true, message: '连接成功', balance: provider === 'firefox' ? 1.234 : 7.547, currency: provider === 'firefox' ? 'CNY' : 'USD', countries: [{ id: 'usa', code: 'usa', name: '美国' }], market: null };
        } else payload = { provider, baseUrl: 'https://example.test/sms', apiKeyConfigured: true, service: 'dr', countries: [], maxPrice: 0.03 };
      }
      return new Response(JSON.stringify(payload));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '短信配置' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('短信 API Key');
    fireEvent.click(within(dialog).getByRole('button', { name: '测试连接' }));
    expect(await within(dialog).findByText('7.547 USD')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: '火狐狸' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('radio', { name: '火狐狸' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '测试连接' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '测试连接' }));
    expect(await within(dialog).findByText('1.234 CNY')).toBeInTheDocument();
    expect(requests).toEqual(['smsbower', 'firefox']);
    expect(within(dialog).queryByText('7.547 USD')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /美国/ }));
    expect(within(dialog).getByRole('checkbox', { name: /美国/ })).toBeChecked();
  });

  it('switches proxy API providers and builds the selected source from country, count, and protocol controls', async () => {
    window.history.replaceState(null, '', '/proxies');
    let buildRequest: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/proxies/api/build-pull') {
        buildRequest = JSON.parse(String(init?.body || '{}'));
        payload = {
          ...(payloads['/api/v1/proxies'] as any),
          total: 3,
          dynamic: { total: 1, countryPools: [{ countryCode: 'US', total: 1, protocols: { socks5: 1 }, manualCount: 0, entries: [], sources: [] }] },
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: '代理资源' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '代理商' }));
    fireEvent.click(await screen.findByRole('option', { name: '1024 Proxy' }));
    expect(screen.getByRole('combobox', { name: '国家' })).toHaveTextContent(/US/);
    expect(screen.getByRole('combobox', { name: '协议' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: '协议' })).toHaveTextContent('SOCKS5');
    expect(screen.getByText(/协议 · 120 分钟/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '代理商' }));
    fireEvent.click(await screen.findByRole('option', { name: 'B2Proxy' }));
    expect(screen.getByRole('combobox', { name: '国家' })).toHaveTextContent(/US/);
    expect(screen.getByRole('combobox', { name: '协议' })).toHaveTextContent('SOCKS5');
    expect(screen.getByLabelText('数量')).toHaveValue(600);
    expect(screen.getByText(/协议 · 60 分钟/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '代理商' }));
    fireEvent.click(await screen.findByRole('option', { name: 'CLI Proxy' }));
    expect(screen.getByRole('combobox', { name: '协议' })).toHaveTextContent('HTTP');
    expect(screen.getByText(/协议 · 15 分钟/)).toBeInTheDocument();
    const count = screen.getByLabelText('数量');
    fireEvent.focus(count);
    fireEvent.change(count, { target: { value: '3' } });
    fireEvent.blur(count);
    fireEvent.click(screen.getByRole('button', { name: '构建并拉取' }));

    await waitFor(() => expect(buildRequest).toEqual({ provider: 'cliproxy', countryCode: 'US', count: 3, protocol: 'http' }));
    expect(await screen.findByText('已拉取 US 国家池，目标 3 条')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('已拉取 US 国家池，目标 3 条')).not.toBeInTheDocument(), { timeout: 4000 });
  });

  it('opens /run directly with no runs without crashing the console', async () => {
    // The run list is still loading on the first render, so the page used to
    // run one more hook than on the render after it loaded empty: React #300
    // and a blank console.
    window.history.replaceState(null, '', '/run');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/runs') await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify(payloads[url.pathname] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByText('没有可查看的任务')).toBeInTheDocument();
  });

  it('places task activity and live logs in a two-column workspace', async () => {
    window.history.replaceState(null, '', '/run/ui-layout-run');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-layout-run',
      taskKind: 'register_session',
      status: 'running',
      phase: 'normal',
      active: true,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'register_session', postRegistrationOAuth: false, mailCount: 2, totalAccounts: 2, workerConcurrency: 1 },
      counts: { workers: { total: 1, running: 1, idle: 0 }, accountsCreated: 1, cpaCompleted: 1, registrationOutcomes: { existingAccountRecovered: 3, mfaTotp: 1 }, registrationSkipped: { emailTimeout: 2, rentalStartTimeout: 1, authContinuationOriginInvalid: 4 }, finalization: { queued: 0, running: 0, failed: 0 } },
      costs: { currency: 'USD', sms: 0.04, mail: 0.2, mailRentals: 1, accountedJobs: 1, complete: true },
      workers: [{ id: 'worker-1', status: 'running', mailboxId: 'mail-1', proxyId: '', currentJobId: 'job-1', completedRoots: 0, updatedAt: new Date().toISOString() }],
      jobs: [
        { id: 'job-1', email: 'ChaneyDerck98975@outlook.com', status: 'complete', phase: 'complete', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 1, smsCostUsd: 0.04, smsCostStatus: 'confirmed', accountCreated: true },
        { id: 'job-2', email: 'second-account@example.com', status: 'waiting', phase: 'queued', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 0, smsCostUsd: 0, smsCostStatus: 'not_used', accountCreated: false },
        { id: 'job-3', email: 'failed-account@example.com', status: 'failed', phase: 'failed', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 1, smsCostUsd: 0, smsCostStatus: 'refunded', accountCreated: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'oauth_phone_send request was throttled' } },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: run.runId, runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [{ seq: 1, at: new Date().toISOString(), level: 'info', source: 'scheduler', type: 'job.waiting', runId: run.runId, workerId: 'worker-1', jobId: 'job-1', message: '等待邮箱验证码', details: {} }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    // The heading names the task rather than the page: every task detail page
    // was titled "任务详情", which told an operator with two tasks open nothing
    // about which one they were looking at.
    expect(await screen.findByRole('heading', { name: '登录态注册' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '实时运行日志' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Worker 泳道' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清空该任务日志' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭实时跟随' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到日志底部' })).toBeInTheDocument();
    expect(within(document.querySelector('.jobs-table') as HTMLElement).getByText('ChaneyDerck98975@outlook.com')).toBeInTheDocument();
    expect(within(document.querySelector('.jobs-table') as HTMLElement).getByText('RATE_LIMIT_EXCEEDED，oauth_phone_send request was throttled')).toHaveClass('job-result-failure');
    expect(screen.getByText('当前账号')).toBeInTheDocument();
    const jobRows = document.querySelectorAll('.jobs-table .table-row');
    expect(jobRows[0].querySelector('.job-sequence')).toHaveTextContent('1');
    expect(jobRows[1].querySelector('.job-sequence')).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: '揭示信息' })).not.toBeInTheDocument();
    expect(screen.getByText('任务总金额')).toBeInTheDocument();
    expect(screen.getByText('$0.04 + $0.200')).toBeInTheDocument();
    expect(screen.getByText(/邮箱 1 个已结算/)).toBeInTheDocument();
    expect(screen.getByText('邮箱超时')).toBeInTheDocument();
    expect(screen.getByText('租约超时')).toBeInTheDocument();
    expect(screen.getByText('已有账号恢复')).toBeInTheDocument();
    // Named for the operator, with the protocol codes kept in the tooltip.
    expect(screen.getByText('账号已存在')).toHaveAttribute('title', 'MFA_TOTP / USER_ALREADY_EXISTS');
    expect(document.querySelector('[aria-label="注册结果"] .metric-outcome-email-timeout')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-label="跳过任务"]')).toHaveClass('metric-outcomes');
    expect(document.querySelector('[aria-label="跳过任务"] .metric-outcome-email-timeout')).toHaveTextContent('2');
    expect(document.querySelector('[aria-label="跳过任务"] .metric-outcome-rental-timeout')).toHaveTextContent('1');
    expect(document.querySelector('[aria-label="跳过任务"] .metric-outcome-origin-invalid')).toHaveTextContent('4');
    // No OAuth stage, no OAuth tile.
    expect(document.querySelector('[aria-label="OAuth 跳过"]')).not.toBeInTheDocument();
    expect(document.querySelector('.metric-outcome-existing-account')).toHaveTextContent('3');
    expect(document.querySelector('.metric-outcome-mfa-totp')).toHaveTextContent('1');
    expect(document.querySelector('.metric-outcome-callback-failed')).not.toBeInTheDocument();
    expect(screen.queryByText('CPA 完成')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.metrics-compact .metric')).toHaveLength(5);
    const overview = document.querySelector('.run-overview-details') as HTMLDetailsElement;
    expect(overview).not.toHaveAttribute('open');
    fireEvent.click(overview.querySelector('summary') as HTMLElement);
    expect(overview).toHaveAttribute('open');
    expect(document.querySelector('.run-workspace-grid')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认取消' }));
    expect(await screen.findByText('取消请求已提交，正在清理任务资源')).toBeInTheDocument();
  });

  it('counts registrations on a run that also does OAuth, and names the mailbox half of the total', async () => {
    window.history.replaceState(null, '', '/run/ui-register-oauth');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-register-oauth',
      taskKind: 'register_session',
      status: 'complete',
      phase: 'complete',
      active: false,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 2, totalAccounts: 2, workerConcurrency: 1 },
      counts: {
        workers: { total: 1, running: 0, idle: 1 },
        accountsCreated: 2,
        cpaCompleted: 2,
        registrationOutcomes: { existingAccountRecovered: 1 },
        registrationSkipped: { emailTimeout: 3 },
        oauthSkipped: { rateLimited: 5, phoneBudgetExhausted: 14, loginRequired: 2 },
        finalization: { queued: 0, running: 0, failed: 0 },
      },
      costs: { currency: 'USD', sms: 0.04, mail: 0.2, mailRentals: 2, total: 0.24, smsBilledActivations: 21, accountedJobs: 2, complete: true },
      workers: [],
      jobs: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // A run that registers and then signs in is still a registration run. Its
    // outcomes and its skips used to sit behind a gate that opened only for
    // registration with no OAuth stage, so a run that did both reported its
    // CPA artifacts and nothing about the registrations that produced them —
    // no timeouts, no recovered accounts, no skips.
    expect(await screen.findByLabelText('注册结果')).toBeInTheDocument();
    expect(document.querySelector('[aria-label="跳过任务"] .metric-outcome-email-timeout')).toHaveTextContent('3');
    // OAuth skips sit on their own tile, by the three reasons an operator acts on.
    expect(document.querySelector('[aria-label="OAuth 跳过"] .metric-outcome-oauth-rate-limit')).toHaveTextContent('速率限制5');
    expect(document.querySelector('[aria-label="OAuth 跳过"] .metric-outcome-oauth-phone-budget')).toHaveTextContent('号码用尽14');
    expect(document.querySelector('[aria-label="OAuth 跳过"] .metric-outcome-oauth-login-required')).toHaveTextContent('跳登录页2');
    // ...and the CPA count stays, because this run does produce artifacts.
    expect(screen.getByText('CPA 完成')).toBeInTheDocument();

    // One total with the mailbox half named beside it rather than left in a
    // tooltip, and a line that counts what the money bought. A cancelled
    // number costs nothing, so 21 activations behind $0.04 is the part that
    // says how hard the run had to work.
    const totalMetric = (await screen.findByText('任务总金额')).closest('.metric') as HTMLElement;
    expect(totalMetric.querySelector('strong')).toHaveTextContent('$0.240（邮箱 $0.200）');
    expect(totalMetric.querySelector('small')).toHaveTextContent('号码 21 个 · 邮箱 2 个已结算');
  });

  it('separates wasted rental cost and renders final callback failures only when present', async () => {
    window.history.replaceState(null, '', '/run/ui-callback-waste');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-callback-waste',
      taskKind: 'register_session',
      status: 'complete',
      phase: 'complete',
      active: false,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'register_session', postRegistrationOAuth: false, totalAccounts: 3, workerConcurrency: 1 },
      counts: {
        workers: { total: 1, running: 0, idle: 1 },
        accountsCreated: 0,
        cpaCompleted: 0,
        registrationOutcomes: { existingAccountRecovered: 0, mfaTotp: 1, callbackFailed: 2 },
        registrationSkipped: { emailTimeout: 0, rentalStartTimeout: 0, authContinuationOriginInvalid: 0 },
        finalization: { queued: 0, running: 0, failed: 0 },
      },
      costs: { currency: 'USD', sms: 0.04, mail: 0.2, mailRentals: 2, wastedMail: 0.14, wastedMailRentals: 1, accountedJobs: 3, complete: true },
      workers: [],
      jobs: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // The headline is everything the task confirmed — wasted rentals included,
    // because that money left the account — and the line under it says how
    // much of the total was wasted rather than quietly subtracting it.
    const totalMetric = (await screen.findByText('任务总金额')).closest('.metric') as HTMLElement;
    expect(totalMetric.querySelector('strong')).toHaveTextContent('$0.04 + $0.200');
    expect(document.querySelector('.run-waste-strip')).toHaveTextContent('浪费 $0.140');
    expect(document.querySelector('.metric-outcome-callback-failed')).toHaveTextContent('2');
  });

  it('shows OAuth PHONE_RECENTLY_USED waste separately from normal SMS cost', async () => {
    window.history.replaceState(null, '', '/run/ui-oauth-waste');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-oauth-waste',
      taskKind: 'oauth',
      status: 'complete',
      phase: 'complete',
      active: false,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'oauth', mailCount: 14, totalAccounts: 14, workerConcurrency: 14 },
      counts: {
        workers: { total: 14, running: 0, idle: 14 },
        accountsCreated: 14,
        cpaCompleted: 14,
        wasted: 8,
        wastedBreakdown: [
          { kind: 'sms', code: 'PHONE_RECENTLY_USED', count: 5, amount: 0.225, currency: 'USD' },
          { kind: 'sms', code: 'INVALID_INPUT', count: 3, amount: 0.135, currency: 'USD' },
        ],
        finalization: { queued: 0, running: 0, failed: 0 },
      },
      costs: { currency: 'USD', sms: 0.81, wastedSms: 0.36, wastedSmsAttempts: 8, accountedJobs: 14, complete: true },
      workers: [],
      jobs: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // Cost and waste are one tile: the amount, the wasted share of it, and the
    // reasons for that waste read together instead of across two tiles and a
    // tooltip.
    await waitFor(() => expect(document.querySelectorAll('.metrics-compact .metric')).toHaveLength(4));
    const totalMetric = document.querySelectorAll('.metrics-compact .metric')[3] as HTMLElement;
    expect(totalMetric).toHaveClass('metric-cost');
    expect(totalMetric.querySelector('strong')).toHaveTextContent('$0.81');
    const waste = document.querySelector('.run-waste-strip') as HTMLElement;
    expect(waste).toHaveTextContent('浪费 $0.360');
    expect(waste).toHaveTextContent('8 次');
    expect(waste.querySelector('[data-wasted-code="PHONE_RECENTLY_USED"]')).toHaveTextContent('号码已被占用5');
    expect(waste.querySelector('[data-wasted-code="PHONE_RECENTLY_USED"]')).toHaveAttribute('title', 'PHONE_RECENTLY_USED');
    expect(waste.querySelector('[data-wasted-code="INVALID_INPUT"]')).toHaveTextContent('验证码被拒3');
    expect(waste.querySelector('[data-wasted-code="UNCLASSIFIED"]')).toBeNull();
  });

  it('does not turn a legacy waste total into a fake breakdown row', async () => {
    window.history.replaceState(null, '', '/run/ui-legacy-waste-total');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-legacy-waste-total',
      taskKind: 'oauth',
      status: 'complete',
      phase: 'complete',
      active: false,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'oauth', mailCount: 1, totalAccounts: 1, workerConcurrency: 1 },
      counts: {
        workers: { total: 1, running: 0, idle: 1 },
        accountsCreated: 1,
        cpaCompleted: 1,
        wasted: 2,
        finalization: { queued: 0, running: 0, failed: 0 },
      },
      costs: { currency: 'USD', sms: 0.09, wastedSms: 0.09, wastedSmsAttempts: 2, accountedJobs: 1, complete: true },
      workers: [],
      jobs: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const payload = url.pathname === '/api/v1/runs'
        ? { activeRunId: '', runs: [run] }
        : url.pathname === `/api/v1/runs/${run.runId}`
          ? run
          : { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const metrics = await waitFor(() => {
      const value = document.querySelectorAll('.metrics-compact .metric');
      expect(value).toHaveLength(4);
      return value;
    });
    // A legacy run carries a bare `wasted` count and no breakdown. The money
    // it wasted is known and is reported; the reasons are not, and no row is
    // invented to stand in for them.
    expect(metrics[3]).toHaveClass('metric-cost');
    const waste = document.querySelector('.run-waste-strip') as HTMLElement;
    expect(waste).toHaveTextContent('浪费 $0.090');
    expect(waste).toHaveTextContent('2 次');
    expect(waste.querySelector('[data-wasted-code]')).toBeNull();
  });

  it('explains unified mailbox polling without presenting a normal wait as an error', async () => {
    window.history.replaceState(null, '', '/run/ui-rental-wait');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const nextPollAt = new Date(Date.now() + 20_000).toISOString();
    const run = {
      runId: 'ui-rental-wait',
      status: 'running',
      phase: 'waiting_mail_rental_watch',
      active: true,
      updatedAt: new Date().toISOString(),
      normalWait: {
        code: 'MAIL_RENTAL_WATCH',
        message: 'Unified broker found 12 mailbox(es), but all Workers are busy',
        at: new Date().toISOString(),
        nextRunAt: nextPollAt,
      },
      plan: { taskKind: 'register_session', mailCount: 50, totalAccounts: 50, workerConcurrency: 10, mailProvider: 'smsbower' },
      // The shape the orchestrator now sends for every rental run, in either
      // mode; the broker's own machinery stays in `mailRentalWatch`.
      mailRental: {
        mode: 'watch',
        target: 50,
        claimedCount: 10,
        activeCount: 10,
        awaitingStartCount: 2,
        expiredCount: 0,
        startWindowMs: 24 * 60 * 1000,
        nextStartDeadlineAt: new Date(Date.now() + 18 * 60 * 1000).toISOString(),
        retryAt: '',
        retryAttempts: 0,
        lastError: null,
      },
      mailRentalWatch: {
        enabled: true,
        target: 50,
        batchSize: 10,
        pollIntervalMs: 20_000,
        claimedCount: 10,
        pollCount: 4,
        lastStockCount: 12,
        lastPrice: 0.05,
        lastStockStatus: 'ok',
        lastError: null,
        nextPollAt,
        stopRequested: false,
        autoStopped: false,
      },
      counts: { workers: { total: 10, running: 10, idle: 0 }, accountsCreated: 0, sessionsSaved: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [{ id: 'worker-01', status: 'running', mailboxId: 'mail-1', proxyId: '', currentJobId: 'job-1', completedRoots: 0, updatedAt: new Date().toISOString() }],
      jobs: [{ id: 'job-1', email: 'busy@example.test', status: 'running', phase: 'registration', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 0, accountCreated: false }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: run.runId, runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByText('调度等待')).toBeInTheDocument();
    expect(screen.getByText(/库存 12/)).toBeInTheDocument();
    expect(screen.getAllByText(/统一 Broker/).length).toBeGreaterThan(0);
    expect(document.querySelector('.wait-reason-normal')).toBeInTheDocument();
    expect(document.querySelector('.wait-reason-warning')).toBeNull();
    expect(screen.getByRole('progressbar', { name: '任务进度' })).toHaveAttribute('aria-valuenow', '10');
    expect(screen.queryByText(/Unified broker found/)).toBeNull();
    const operations = document.querySelector('.run-operations-details') as HTMLDetailsElement;
    expect(operations.open).toBe(false);
    fireEvent.click(within(operations).getByText('点击展开详情'));
    await waitFor(() => expect(operations.open).toBe(true));
    fireEvent.click(within(operations).getByText('点击展开详情'));
    await waitFor(() => expect(operations.open).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '邮箱租约' }));
    expect(await screen.findByRole('heading', { name: '邮箱租约' })).toBeInTheDocument();
    expect(screen.getByText('本次追加租用数量')).toBeInTheDocument();
  });

  it('shows the rental panel for an ordinary rental run, not only for the unified broker', async () => {
    window.history.replaceState(null, '', '/run/ui-plain-rental');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const retryAt = new Date(Date.now() + 90_000).toISOString();
    const run = {
      runId: 'ui-plain-rental',
      taskKind: 'register_session',
      status: 'running',
      phase: 'registration',
      active: true,
      updatedAt: new Date().toISOString(),
      plan: { taskKind: 'register_session', mailCount: 6, totalAccounts: 6, workerConcurrency: 2, mailProvider: 'smsbower' },
      // No `mailRentalWatch`: this is the per-task rental, which reported
      // nothing at all before the two modes shared one panel.
      mailRental: {
        mode: 'normal',
        target: 6,
        claimedCount: 4,
        activeCount: 4,
        awaitingStartCount: 1,
        expiredCount: 1,
        startWindowMs: 24 * 60 * 1000,
        nextStartDeadlineAt: new Date(Date.now() + 121_000).toISOString(),
        retryAt,
        retryAttempts: 2,
        lastError: { code: 'MAIL_RENTAL_SOLD_OUT', message: 'no stock' },
      },
      counts: { workers: { total: 2, running: 2, idle: 0 }, accountsCreated: 0, sessionsSaved: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [],
      jobs: [],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: run.runId, runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await screen.findByText('邮箱租约与费用');
    const operations = document.querySelector('.run-operations-details') as HTMLDetailsElement;
    expect(operations.querySelector('.run-operations-summary-item')).toHaveTextContent('租约进度4/6');
    expect(operations.querySelector('.run-operations-summary-rental-status')).toHaveTextContent('等待重试（库存不足）');
    const strip = operations.querySelector('.mail-rental-strip') as HTMLElement;
    // The window every rental runs under, counted down rather than only
    // reported after the fact as a skipped job.
    expect(strip).toHaveTextContent('24 分钟起跑窗口');
    expect(strip).toHaveTextContent('1 个待起跑 · 已超时 1');
    expect(strip).toHaveTextContent('待补租用');
    expect(strip).toHaveTextContent('库存不足');
    // The reason comes from the error the provider actually returned, so a
    // transport failure is not reported as an empty shelf.
    expect(rentalRetryReason({ ...run.mailRental, lastError: { code: 'MAIL_PROVIDER_TIMEOUT' } } as never)).toBe('供应商超时');
    // A backoff whose clock has already come due is not a wait: the next
    // scheduler pass rents on it. Reading the field's presence alone left
    // 等待库存 on screen with a retry time in the past while mailboxes went on
    // being claimed.
    expect(pendingRentalRetryAt(run.mailRental as never, Date.now())).not.toBeNull();
    expect(pendingRentalRetryAt({ ...run.mailRental, retryAt: new Date(Date.now() - 60_000).toISOString() } as never, Date.now())).toBeNull();
    // The broker-only cells stay out of an ordinary rental's strip.
    expect(strip).not.toHaveTextContent('单批 / 间隔');
    // The dialog is offered in both modes — an ordinary rental spends the same
    // money — but only the broker gets the broker's knobs.
    fireEvent.click(screen.getByRole('button', { name: '邮箱租约' }));
    const rentalDialog = await screen.findByRole('dialog', { name: '邮箱租约' });
    expect(within(rentalDialog).getByText('本次追加租用数量')).toBeInTheDocument();
    expect(within(rentalDialog).getByRole('radio', { name: /停止后续租用/ })).toBeInTheDocument();
    expect(within(rentalDialog).queryByText('单批领取数量')).not.toBeInTheDocument();
    expect(within(rentalDialog).queryByText('轮询间隔（秒）')).not.toBeInTheDocument();
  });

  it('updates the hang-rental status immediately after stopping future claims', async () => {
    window.history.replaceState(null, '', '/run/ui-rental-stop');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const runId = 'ui-rental-stop';
    const at = new Date().toISOString();
    const run = {
      runId,
      taskKind: 'register_session',
      status: 'running',
      phase: 'waiting_mail_rental_watch',
      active: true,
      updatedAt: at,
      normalWait: { code: 'MAIL_RENTAL_WATCH', message: 'Unified broker is polling mailbox stock', at, nextRunAt: at },
      plan: { taskKind: 'register_session', mailCount: 50, totalAccounts: 50, workerConcurrency: 1, mailProvider: 'smsbower', mailRentalWatch: true },
      // The shape the orchestrator now sends for every rental run, in either
      // mode; the broker's own machinery stays in `mailRentalWatch`.
      mailRental: {
        mode: 'watch',
        target: 50,
        claimedCount: 10,
        activeCount: 10,
        awaitingStartCount: 2,
        expiredCount: 0,
        startWindowMs: 24 * 60 * 1000,
        nextStartDeadlineAt: new Date(Date.now() + 18 * 60 * 1000).toISOString(),
        retryAt: '',
        retryAttempts: 0,
        lastError: null,
      },
      mailRentalWatch: {
        enabled: true,
        target: 50,
        batchSize: 10,
        pollIntervalMs: 20_000,
        claimedCount: 10,
        pollCount: 4,
        lastStockCount: 12,
        lastPrice: 0.05,
        lastStockStatus: 'ok',
        lastError: null,
        nextPollAt: at,
        stopRequested: false,
        autoStopped: false,
        stoppedAt: '',
      },
      counts: { workers: { total: 1, running: 1, idle: 0 }, accountsCreated: 0, sessionsSaved: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [{ id: 'worker-01', status: 'running', mailboxId: 'mail-1', proxyId: '', currentJobId: 'job-1', completedRoots: 0, updatedAt: at }],
      jobs: [{ id: 'job-1', email: 'busy@example.test', status: 'running', phase: 'registration', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 0, accountCreated: false }],
    };
    let current = run;
    let stopRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === `/api/v1/runs/${runId}/mail-rental/configure`) {
        stopRequests += 1;
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body || '{}')).action).toBe('stop');
        const stoppedAt = new Date().toISOString();
        current = {
          ...current,
          updatedAt: stoppedAt,
          normalWait: { code: 'MAIL_RENTAL_WATCH', message: '已停止后续领取，已领取邮箱继续完成任务', at: stoppedAt, nextRunAt: '' },
          mailRentalWatch: { ...current.mailRentalWatch, stopRequested: true, nextPollAt: '', stoppedAt },
        };
      }
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: current.active ? runId : '', runs: [current] };
      if (url.pathname === `/api/v1/runs/${runId}`) payload = current;
      if (url.pathname === `/api/v1/runs/${runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await screen.findByText('邮箱租约与费用');
    const operations = document.querySelector('.run-operations-details') as HTMLDetailsElement;
    expect(operations.querySelector('.run-operations-summary-rental-status')).toHaveTextContent('领取中');
    expect(operations.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '邮箱租约' }));
    const dialog = await screen.findByRole('dialog', { name: '邮箱租约' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /停止后续领取/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(stopRequests).toBe(1));
    await waitFor(() => expect(operations.querySelector('.run-operations-summary-rental-status')).toHaveTextContent('已停止领取'));
    expect(operations.open).toBe(true);
    expect(operations.querySelector('.mail-rental-strip')).toHaveTextContent('已停止领取');
  });

  it('labels cancelled SMS quotes as supplier settlement instead of confirmed loss', async () => {
    window.history.replaceState(null, '', '/run/ui-billing-run');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const run = {
      runId: 'ui-billing-run',
      status: 'complete',
      phase: 'complete',
      active: false,
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      costs: { currency: 'USD', sms: 0.33, accountedJobs: 1, complete: true },
      billing: {
        currency: 'USD',
        currencyTotals: { USD: { quoted: 0.825, grossConsumed: 0.33, confirmedConsumed: 0.33, refunded: 0, unresolved: 0.495, cancelledUnresolved: 0.495, cancelledQuoted: 0.495, activeQuoted: 0 } },
        quotedUsd: 0.825,
        grossConsumedUsd: 0.33,
        confirmedConsumedUsd: 0.33,
        refundedUsd: 0,
        unresolvedUsd: 0.495,
        cancelledUnresolvedUsd: 0.495,
        cancelledQuotedUsd: 0.495,
        cancelledQuotesSettledUsd: 0,
        activeQuotedUsd: 0,
        accountedJobs: 1,
        unresolvedJobs: 11,
        activationCount: 12,
        billingComplete: false,
      },
      balanceReconciliation: {
        provider: 'smsbower',
        currency: 'USD',
        startBalance: 1.009,
        startCheckedAt: new Date().toISOString(),
        endBalance: 0.679,
        endCheckedAt: new Date().toISOString(),
        observedDecrease: 0.33,
        confirmedConsumed: 0.33,
        unresolved: 0.495,
        difference: 0,
        tolerance: 0.000001,
        billingComplete: false,
        concurrent: false,
        concurrentRunIds: [],
        status: 'pending',
        note: 'billing_incomplete',
        finalizedAt: new Date().toISOString(),
      },
      workers: [],
      jobs: [{
        id: 'job-cancelled-quote',
        email: 'cancelled@example.test',
        status: 'complete',
        phase: 'complete',
        branch: 'register',
        aliasIndex: 1,
        replacementOf: '',
        proxyId: '',
        smsAttempts: 2,
        smsCostUsd: 0.33,
        smsCurrency: 'USD',
        smsQuotedUsd: 0.825,
        smsRefundedUsd: 0,
        smsUnresolvedUsd: 0.495,
        smsCancelledUnresolvedUsd: 0.495,
        smsCostStatus: 'needs_review',
        accountCreated: true,
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === `/api/v1/runs/${run.runId}`) payload = run;
      if (url.pathname === `/api/v1/runs/${run.runId}/logs`) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: '费用核对' })).toBeInTheDocument();
    expect(document.querySelector('.run-operations-details')).not.toBeInTheDocument();
    expect(screen.queryByText('邮箱租约与费用')).not.toBeInTheDocument();
    expect(within(document.querySelector('.jobs-table') as HTMLElement).getByText('$0.33 已确认')).toBeInTheDocument();
    expect(within(document.querySelector('.run-balance-status') as HTMLElement).getByText(/等待供应商结算，不等于已确认损失/)).toBeInTheDocument();
    expect(screen.getByText('待供应商结算')).toBeInTheDocument();
    expect(screen.queryByText('未决费用')).not.toBeInTheDocument();
  });

  it('switches between the main and auxiliary task while both are active', async () => {
    window.history.replaceState(null, '', '/run/ui-main-run');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const makeRun = (runId: string, taskKind: 'register_session' | 'session_refresh', taskSlot: 'main' | 'auxiliary') => ({
      runId,
      taskKind,
      taskSlot,
      status: 'running',
      active: true,
      phase: 'normal',
      updatedAt: new Date().toISOString(),
      plan: { taskKind, workerConcurrency: 1, mailCount: 1, totalAccounts: 1 },
      counts: { workers: { total: 1, running: 1, idle: 0 }, accountsCreated: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [],
      jobs: [],
    });
    const mainRun = makeRun('ui-main-run', 'register_session', 'main');
    const auxiliaryRun = makeRun('ui-aux-run', 'session_refresh', 'auxiliary');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: mainRun.runId, activeRunIds: [mainRun.runId, auxiliaryRun.runId], runs: [mainRun, auxiliaryRun] };
      if (url.pathname === `/api/v1/runs/${mainRun.runId}`) payload = mainRun;
      if (url.pathname === `/api/v1/runs/${auxiliaryRun.runId}`) payload = auxiliaryRun;
      if (url.pathname.endsWith('/logs')) payload = { logs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByRole('navigation', { name: '并行任务切换' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /附属任务.*登录态刷新/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开任务' }));
    const auxiliaryLink = screen.getByRole('link', { name: /附属任务.*登录态刷新/ });
    expect(screen.getByRole('link', { name: /主任务.*登录态注册/ })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(auxiliaryLink);
    await waitFor(() => expect(window.location.pathname).toBe('/run/ui-aux-run'));
    expect(auxiliaryLink).toHaveAttribute('aria-current', 'page');
  });

  it('allows task values to be edited directly and exposes shared resources without another page', async () => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      return new Response(JSON.stringify(payloads[url.pathname] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    const input = await screen.findByLabelText(/根邮箱数量（mail\.count）/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: '12' } });
    expect(input).toHaveValue(12);
    fireEvent.blur(input);
    expect(input).toHaveValue(12);
    fireEvent.wheel(input, { deltaY: -100 });
    expect(input).toHaveValue(13);
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input).toHaveValue(12);
    expect(screen.getByRole('radiogroup', { name: '邮箱接口模式' })).toBeInTheDocument();
    expect(screen.queryByLabelText('每根目标账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('最大别名尝试')).not.toBeInTheDocument();
    const resourcesTab = screen.getByRole('tab', { name: '全局资源' });
    fireEvent.mouseDown(resourcesTab, { button: 0, ctrlKey: false });
    fireEvent.click(resourcesTab);
    await waitFor(() => expect(resourcesTab).toHaveAttribute('data-state', 'active'));
    expect(await screen.findByRole('heading', { name: '全局资源' })).toBeInTheDocument();
    expect(document.querySelector('.launch-resource-grid')).toBeInTheDocument();
  });

  it('refills every country pool from the launch page through the robot that reports progress', async () => {
    window.history.replaceState(null, '', '/');
    let commands: Array<{ id: string; command: string }> = [];
    let catalogReads = 0;
    // Starts drained, so the assignment the plan needs is not selectable yet —
    // which is the state that used to force a walk to the proxy page.
    let poolTotal = 0;
    let robotStatus = 'idle';
    let lastRun: Record<string, unknown> | null = null;
    const catalog = () => ({
      total: poolTotal,
      local: { total: 0, errors: [], proxies: [] },
      dynamic: { total: poolTotal, countryPools: [{ countryCode: 'US', total: poolTotal, sourceId: 'src-us', entries: [], updatedAt: new Date().toISOString() }] },
      errors: [],
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/proxies') {
        catalogReads += 1;
        payload = catalog();
      }
      if (url.pathname === '/api/v1/robots') {
        payload = {
          schemaVersion: 1,
          taskBusy: false,
          activeRunId: '',
          robots: [{
            id: 'proxy-refresh',
            name: '代理刷新',
            description: '',
            status: robotStatus,
            enabled: true,
            intervalMs: 600000,
            running: robotStatus === 'running',
            // The bar the top bar draws comes from here, which is the whole
            // reason a manual refresh goes through the robot.
            progress: robotStatus === 'running' ? { done: 1, total: 2, label: 'US 1/2' } : null,
            lastRun,
            runs: [],
            commands: [{ id: 'run_now', label: '立即刷新' }],
          }],
        };
      }
      if (/^\/api\/v1\/robots\/[^/]+\/commands$/.test(url.pathname) && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        commands.push({ id: url.pathname.split('/')[4], command: body.command });
        robotStatus = 'running';
        payload = { robotId: 'proxy-refresh', command: body.command, queued: true };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const readsBeforePull = await waitFor(() => {
      expect(catalogReads).toBeGreaterThan(0);
      return catalogReads;
    });
    fireEvent.click(await screen.findByRole('button', { name: '立即刷新全部国家池' }));
    // The robot's own command, not the plain pull-all route: only this path
    // reports per-source progress.
    await waitFor(() => expect(commands).toEqual([{ id: 'proxy-refresh', command: 'run_now' }]));
    // While it runs, the top bar shows the shared activity strip.
    expect(await screen.findByTitle(/代理刷新/)).toBeInTheDocument();

    // Finish it the way the service would, then stand in for the 2.5s poll
    // that would otherwise be the only thing to notice.
    poolTotal = 12;
    robotStatus = 'idle';
    lastRun = { id: 'run-1', command: 'run_now', reason: 'run_now', status: 'partial', startedAt: new Date().toISOString(), result: { requested: 2, succeeded: 1, failed: 1, pulled: 12 } };
    await act(async () => { await client.invalidateQueries({ queryKey: ['robots'] }); });

    // Completion is observed rather than awaited, and reported from the run.
    expect(await screen.findByText(/国家池刷新完成：成功 1 · 共 12 条 · 失败 1/)).toBeInTheDocument();
    // The catalog is re-read, which is what turns the refilled pool back into a
    // valid worker assignment without a manual reload — the point of the button.
    await waitFor(() => expect(catalogReads).toBeGreaterThan(readsBeforePull));
  });

  it('adjusts OAuth Worker concurrency while keeping country/fixed proxy selection visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      return new Response(JSON.stringify(payloads[url.pathname] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    await screen.findByLabelText(/根邮箱数量（mail\.count）/);
    fireEvent.click(await screen.findByRole('button', { name: /凭据直登 OAuth/ }));
    const mailboxInput = await screen.findByLabelText('账号凭据');
    const workerInput = await screen.findByLabelText(/Worker 并发/);
    // The OAuth editor holds a requested ceiling, not the effective count.
    await waitFor(() => expect(workerInput).toHaveValue(MAX_WORKER_CONCURRENCY));

    const parent = workerInput.parentElement?.parentElement;
    const page = document.querySelector('.launch-config-column');
    const beforeScroll = page?.scrollTop || 0;
    fireEvent.wheel(workerInput, { deltaY: 100 });
    expect(workerInput).toHaveValue(MAX_WORKER_CONCURRENCY - 1);
    expect(screen.queryByRole('group', { name: 'Worker 2 代理类型' })).not.toBeInTheDocument();
    fireEvent.change(mailboxInput, { target: { value: ['one', 'two', 'three'].map((n) => `${n}@example.test----ExamplePassword!----JBSWY3DPEHPK3PXP`).join('\n') } });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Worker 2 代理类型' })).toBeInTheDocument());
    expect(workerInput).toHaveValue(MAX_WORKER_CONCURRENCY - 1);
    fireEvent.wheel(workerInput, { deltaY: -100 });
    expect(workerInput).toHaveValue(MAX_WORKER_CONCURRENCY);
    expect(page?.scrollTop || 0).toBe(beforeScroll);
    expect(parent).toBeTruthy();
  });

  it('renders the CPA artifact workspace with task history in a drawer', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifact = { key: 'ui-artifact-run/accounts/job-artifact.json', runId: run.runId, jobId: 'job-artifact', aliasIndex: 1, email: 'd***@outlook.com', fileName: 'job-artifact.json', size: 2048, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, isPlus: true };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts: [artifact] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'CPA 产物' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'CPA 文件' })).toBeInTheDocument();
    expect(document.querySelector('.history-drawer-title')?.textContent).toContain('任务历史');
    expect(screen.getByText('job-artifact.json')).toBeInTheDocument();
    expect(screen.getByText('job-artifact.json')).toHaveClass('artifact-name-pending');
    expect(screen.getByRole('tab', { name: /^最新/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox', { name: '类型筛选' })).toHaveTextContent('全部类型');
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '导出上次任务 CPA' })).toHaveAttribute('href', `/api/v1/runs/${run.runId}/cpa`);
    expect(screen.getByRole('link', { name: `下载 ${run.runId} 的 CPA` })).toHaveAttribute('href', `/api/v1/runs/${run.runId}/cpa`);
    expect(screen.getByRole('link', { name: `下载 ${artifact.fileName}` })).toHaveAttribute('href', `/api/v1/artifacts/cpa/download?key=${encodeURIComponent(artifact.key)}`);
    expect(document.querySelector('.history-drawer')).toBeInTheDocument();
    expect(document.querySelector('.artifact-scroll')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('选择 job-artifact.json'));
    expect(screen.getByRole('button', { name: '导出选中 CPA (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '导出选中账号：邮箱----密码----2FA (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '清理选中 CPA (1)' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText(`选择历史 ${run.runId}`));
    expect(screen.getByRole('button', { name: '导出选中任务 CPA (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除选中任务历史 (1)' })).toBeEnabled();
  });

  it('loads unlocked CPA artifacts first and fetches locked snapshots only for all', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-query-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifact = { runId: run.runId, jobId: 'job-artifact-query', aliasIndex: 1, email: 'query@example.test', fileName: 'query.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true };
    const cpaSearches: string[] = [];
    let releaseLocked: () => void = () => {};
    const lockedGate = new Promise<void>((resolve) => { releaseLocked = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') {
        cpaSearches.push(url.search);
        if (url.search === '?reveal=1&paged=1&offset=0&limit=50&lifecycle=all&type=all') await lockedGate;
        payload = { artifacts: [artifact] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    expect(await screen.findByText('query.cpa.json')).toBeInTheDocument();
    expect(cpaSearches).toEqual(['?reveal=1&locked=0&paged=1&offset=0&limit=50&lifecycle=fresh&type=all']);

    fireEvent.click(screen.getAllByRole('tab')[0]);
    await waitFor(() => expect(document.querySelector('.artifact-panel')).toHaveClass('artifact-panel-refreshing'));
    expect(document.querySelector('.artifact-panel')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: '正在刷新 CPA 文件' })).toBeInTheDocument();
    expect(screen.getByText('query.cpa.json')).toBeInTheDocument();
    releaseLocked();
    await waitFor(() => expect(cpaSearches).toContain('?reveal=1&paged=1&offset=0&limit=50&lifecycle=all&type=all'));
    expect(cpaSearches).toEqual(['?reveal=1&locked=0&paged=1&offset=0&limit=50&lifecycle=fresh&type=all', '?reveal=1&paged=1&offset=0&limit=50&lifecycle=all&type=all']);
    await waitFor(() => expect(document.querySelector('.artifact-panel')).not.toHaveClass('artifact-panel-refreshing'));
    expect(document.querySelector('.artifact-panel')).toHaveAttribute('aria-busy', 'false');
  });

  it('offers nvtokens as one picker and one button on the sold shelf, pool price in the dialog', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-nvtokens-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifact = {
      runId: run.runId,
      jobId: 'job-nvtokens',
      aliasIndex: 1,
      email: 'sold@example.test',
      fileName: 'sold-nvtokens.cpa.json',
      size: 2048,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: 'asset-nvtokens',
      lifecycle: 'sold',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts: [artifact] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开批次 未导出' }));
    fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`));
    // One picker, defaulting to 入池, and one button — not three.
    expect(screen.getByRole('combobox', { name: 'nvtokens 推送方式' })).toHaveTextContent('nv 入池');
    expect(screen.queryByRole('button', { name: /推送 nvtokens JSON/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '推送 nv (1)' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '推送 nv (1)' }));
    const dialog = await screen.findByRole('dialog', { name: '推送并入 nvtokens 号池' });
    const price = within(dialog).getByRole('spinbutton', { name: '价格（元/个）' });
    expect(price).toHaveValue(1);
    fireEvent.change(price, { target: { value: '2.5' } });
    expect(price).toHaveValue(2.5);
    expect(within(dialog).getByRole('button', { name: '确认入池' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '返回' }));
    expect(screen.queryByRole('dialog', { name: '推送并入 nvtokens 号池' })).not.toBeInTheDocument();
  });

  it('marks sold artifacts pushed to nvtokens with the nv tag', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-nvtokens-tag-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifact = {
      runId: run.runId,
      jobId: 'job-nvtokens-tag',
      aliasIndex: 1,
      email: 'sold-nvtokens@example.test',
      fileName: 'sold-nvtokens-tag.cpa.json',
      size: 2048,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: 'asset-nvtokens-tag',
      lifecycle: 'sold',
      nvtokensCardsImportedAt: '2026-09-13T10:00:00.000Z',
      nvtokensCardsPooledAt: '2026-09-13T10:01:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts: [artifact] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    fireEvent.click(document.querySelector('.artifact-delivery-toggle') as HTMLElement);
    expect(screen.getByText('已推送 nv')).toBeInTheDocument();
    expect(screen.getByTitle('已推送到 nvtokens')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`));
    expect(screen.getByRole('button', { name: '推送 nv' })).toBeDisabled();
  });

  it('uses one delivery timestamp for every nvtokens request in a large push', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-nvtokens-batch-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 30, cpaCompleted: 30, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = Array.from({ length: 30 }, (_, index) => ({
      runId: run.runId,
      jobId: `job-nvtokens-batch-${index}`,
      aliasIndex: index + 1,
      email: `sold-batch-${index}@example.test`,
      fileName: `sold-nvtokens-batch-${index}.cpa.json`,
      size: 2048,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: `asset-nvtokens-batch-${index}`,
      lifecycle: 'sold',
    }));
    const pushBodies: Array<{ items: unknown[]; deliveryAt?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/nvtokens/cards/import') {
        const body = JSON.parse(String(init?.body || '{}')) as { items?: unknown[]; deliveryAt?: string };
        pushBodies.push({ items: body.items || [], deliveryAt: body.deliveryAt });
        payload = {
          ok: true,
          total: body.items?.length || 0,
          accepted: body.items?.length || 0,
          failed: 0,
          skipped: 0,
          errors: [],
          warnings: [],
          pushed: body.items?.length || 0,
          artifacts: body.items?.length || 0,
          exported: body.items?.length || 0,
          kind: 'nvtokens_cards',
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /已卖出/ }));
    fireEvent.click(document.querySelector('.artifact-delivery-toggle') as HTMLElement);
    for (const artifact of artifacts) fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`));
    fireEvent.click(screen.getByRole('combobox', { name: 'nvtokens 推送方式' }));
    fireEvent.click(await screen.findByRole('option', { name: 'nv JSON' }));
    fireEvent.click(screen.getByRole('button', { name: /推送 nv \(30\)/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /确认/ }));

    await waitFor(() => expect(pushBodies).toHaveLength(2));
    expect(pushBodies.map(({ items }) => items.length)).toEqual([25, 5]);
    expect(pushBodies[0].deliveryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pushBodies[1].deliveryAt).toBe(pushBodies[0].deliveryAt);
  });

  // The 67-account pool push that landed 50: batches of 25, one account in
  // the third batch without a long-lived 2FA secret, a 422 for that batch,
  // and the loop threw out of the push. The other 16 never left, no account
  // was named, and the only report was a notice that dismissed itself.
  it('keeps pushing after a batch the server refuses, and names the accounts that did not go', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-nvtokens-partial-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 30, cpaCompleted: 30, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = Array.from({ length: 30 }, (_, index) => ({
      runId: run.runId,
      jobId: `job-partial-${index}`,
      aliasIndex: index + 1,
      email: `partial-${index}@example.test`,
      fileName: `partial-${index}.cpa.json`,
      size: 2048,
      modifiedAt: new Date(Date.now() - index * 1000).toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: `asset-partial-${index}`,
      lifecycle: 'sold',
    }));
    const batchSizes: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      let status = 200;
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/nvtokens/pool') {
        const body = JSON.parse(String(init?.body || '{}')) as { items: Array<{ jobId: string }> };
        batchSizes.push(body.items.length);
        if (batchSizes.length === 2) {
          // The whole second batch refused for one incomplete account.
          status = 422;
          payload = {
            error: 'Cannot push credentials',
            message: 'Cannot push credentials for 1 selected CPA record(s)：partial-25@example.test：缺少长期 2FA 密钥',
            details: { skipped: [{ runId: run.runId, jobId: 'job-partial-25', email: 'partial-25@example.test', reason: '缺少长期 2FA 密钥' }] },
          };
        } else {
          payload = {
            ok: true,
            total: body.items.length,
            accepted: body.items.length,
            failed: 0,
            skipped: 0,
            errors: [],
            warnings: [],
            pushed: body.items.length,
            artifacts: body.items.length,
            exported: body.items.length,
            kind: 'nvtokens_pool',
          };
        }
      }
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /已卖出/ }));
    fireEvent.click(document.querySelector('.artifact-delivery-toggle') as HTMLElement);
    for (const artifact of artifacts) fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`));
    fireEvent.click(screen.getByRole('button', { name: /推送 nv \(30\)/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /确认入池/ }));

    // Both batches were attempted: the refusal no longer ends the push.
    await waitFor(() => expect(batchSizes).toEqual([25, 5]));
    const result = (await screen.findByText('已推送 25/30 · 未发出 5')).closest('.push-result') as HTMLElement;
    expect(result).toHaveClass('push-result-warning');
    // And the account that caused it is named, with the reason, on a line the
    // operator can still read a minute later.
    expect(within(result).getByText('partial-25@example.test')).toBeInTheDocument();
    expect(within(result).getByText('缺少长期 2FA 密钥')).toBeInTheDocument();
  });

  it('pools a requested count from the sold undelivered group only after a priced confirmation', async () => {
    window.history.replaceState(null, '', '/history');
    const base = { runId: 'sold-pool-run', size: 1024, modifiedAt: '2026-09-30T12:00:00.000Z', runStatus: 'complete', deletable: true, lifecycle: 'sold' };
    // Newest first on the shelf: first (12:00), second (11:00), third (10:00).
    const artifacts = ['first', 'second', 'third'].map((name, index) => ({ ...base, modifiedAt: `2026-09-30T1${2 - index}:00:00.000Z`, key: `${name}.json`, jobId: `job-${name}`, email: `${name}@example.test`, fileName: `${name}.cpa.json` }));
    const pooled: Array<{ items: unknown[]; priceYuan?: number; unexportedOnly?: boolean }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/nvtokens/pool') {
        const body = JSON.parse(String(init?.body || '{}'));
        pooled.push(body);
        payload = { ok: true, total: body.items.length, accepted: body.items.length, failed: 0, skipped: 0, errors: [], warnings: [], pushed: body.items.length, artifacts: body.items.length, exported: body.items.length, kind: 'nvtokens_pool' };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    const quantity = await screen.findByRole('spinbutton', { name: '导出数量' });
    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
    fireEvent.click(await screen.findByRole('option', { name: 'nv 入池' }));
    const poolButton = await screen.findByRole('button', { name: '按数量入池 nv' });

    // Enter in the count box must not sell anything without the price dialog.
    fireEvent.submit(poolButton.closest('form')!);
    expect(pooled).toHaveLength(0);

    fireEvent.click(poolButton);
    const dialog = await screen.findByRole('dialog', { name: '按数量推入 nvtokens 号池' });
    expect(dialog).toHaveTextContent('库存最久的 2 个账号');
    const price = within(dialog).getByRole('spinbutton', { name: '价格（元/个）' });
    fireEvent.change(price, { target: { value: '3.5' } });
    // The field commits on blur, which a real click on the confirm button causes.
    fireEvent.blur(price);
    fireEvent.click(within(dialog).getByRole('button', { name: '确认入池' }));

    await waitFor(() => expect(pooled).toHaveLength(1));
    // The pool takes the longest-held stock, oldest first — not the newest two
    // the download formats would take.
    expect(pooled[0].items).toEqual(['third', 'second'].map((name) => ({ runId: base.runId, jobId: `job-${name}`, key: `${name}.json` })));
    expect(pooled[0].priceYuan).toBe(3.5);
    expect(pooled[0].unexportedOnly).toBe(true);
    expect(await screen.findByText('已推送 2/2')).toBeInTheDocument();
  });

  it('never resends an account already pushed the chosen way, and says so', async () => {
    window.history.replaceState(null, '', '/history');
    const base = { runId: 'sold-dedupe-run', size: 1024, modifiedAt: '2026-09-30T12:00:00.000Z', runStatus: 'complete', deletable: true, lifecycle: 'sold' };
    const artifacts = [
      { ...base, key: 'fresh.json', jobId: 'job-fresh', email: 'fresh@example.test', fileName: 'fresh.cpa.json' },
      // Already imported as a mailbox, so the mailbox push leaves it alone.
      { ...base, key: 'sent.json', jobId: 'job-sent', email: 'sent@example.test', fileName: 'sent.cpa.json', nvtokensMailboxesImportedAt: '2026-09-30T11:00:00.000Z' },
    ];
    const bodies: Array<{ items: Array<{ jobId: string }>; unexportedOnly?: boolean }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/nvtokens/mailboxes/import') {
        const body = JSON.parse(String(init?.body || '{}'));
        bodies.push(body);
        payload = { ok: true, total: body.items.length, accepted: body.items.length, failed: 0, skipped: 0, errors: [], warnings: [], pushed: body.items.length, artifacts: body.items.length, exported: body.items.length, kind: 'nvtokens_mailboxes' };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    for (const toggle of document.querySelectorAll('.artifact-delivery-toggle')) {
      if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    }
    for (const artifact of artifacts) fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`));
    fireEvent.click(screen.getByRole('combobox', { name: 'nvtokens 推送方式' }));
    fireEvent.click(await screen.findByRole('option', { name: 'nv 邮箱凭证' }));
    // Two selected, one already sent this way: the button counts what will go.
    fireEvent.click(screen.getByRole('button', { name: '推送 nv (1)' }));
    const dialog = await screen.findByRole('dialog', { name: '推送邮箱----密码----2FA' });
    expect(dialog).toHaveTextContent('另有 1 个已推送过，跳过');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认推送' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].items.map((item) => item.jobId)).toEqual(['job-fresh']);
    expect(bodies[0].unexportedOnly).toBe(true);
    const result = (await screen.findByText('已推送 1/2 · 未发出 1')).closest('.push-result') as HTMLElement;
    expect(within(result).getByText('sent@example.test')).toBeInTheDocument();
    expect(within(result).getByText('已推送过，未重复推送')).toBeInTheDocument();
  });

  it('separates Plus and ordinary OAuth CPA artifacts with the type filter', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-tabs-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 2, cpaCompleted: 2, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = [
      { runId: run.runId, jobId: 'job-plus', aliasIndex: 1, email: 'plus@example.test', fileName: 'plus.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, isPlus: true, sub2ApiExportedAt: new Date().toISOString() },
      { runId: run.runId, jobId: 'job-oauth', aliasIndex: 2, email: 'oauth@example.test', fileName: 'oauth.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, isPlus: false, cpaExportedAt: new Date().toISOString() },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    // The page opens on 最新 (unexported); both fixtures carry an export marker.
    fireEvent.click(await screen.findByRole('tab', { name: /^全部/ }));
    expect(await screen.findByText('plus.cpa.json')).toBeInTheDocument();
    expect(document.querySelector('.artifact-card-plus .artifact-name-exported')).toBeInTheDocument();
    expect(screen.getByText('oauth.cpa.json')).toBeInTheDocument();
    expect(document.querySelector('.artifact-card:not(.artifact-card-plus) .artifact-name-exported')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '类型筛选' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Plus/ }));
    expect(screen.getByText('plus.cpa.json')).toBeInTheDocument();
    expect(screen.queryByText('oauth.cpa.json')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '类型筛选' }));
    fireEvent.click(await screen.findByRole('option', { name: /^普通 OAuth/ }));
    expect(screen.queryByText('plus.cpa.json')).not.toBeInTheDocument();
    expect(screen.getByText('oauth.cpa.json')).toBeInTheDocument();
  });

  it('drops artifacts shelved as planned, self-use or sold from 最新, exported or not', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-sale-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 4, cpaCompleted: 4, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    // Only the last one carries an export marker, so what separates the other
    // four is the shelf their login-state asset sits on.
    const base = { runId: run.runId, size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true };
    const artifacts = [
      { ...base, jobId: 'job-shipped', aliasIndex: 5, email: 'shipped@example.test', fileName: 'shipped.cpa.json', assetId: 'asset-shipped', lifecycle: 'active', cpaExportedAt: new Date().toISOString() },
      { ...base, jobId: 'job-planned', aliasIndex: 2, email: 'planned@example.test', fileName: 'planned.cpa.json', assetId: 'asset-planned', lifecycle: 'planned' },
      { ...base, jobId: 'job-stock', aliasIndex: 1, email: 'stock@example.test', fileName: 'stock.cpa.json', assetId: 'asset-stock', lifecycle: 'active' },
      { ...base, jobId: 'job-mine', aliasIndex: 3, email: 'mine@example.test', fileName: 'mine.cpa.json', assetId: 'asset-mine', lifecycle: 'self_use' },
      { ...base, jobId: 'job-sold', aliasIndex: 4, email: 'sold@example.test', fileName: 'sold.cpa.json', assetId: 'asset-sold', lifecycle: 'sold' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    // The page opens on 最新: an account promised to a buyer, handed over, or
    // kept for our own use is settled, so only the one still in stock is left
    // to look at.
    expect(await screen.findByText('stock.cpa.json')).toBeInTheDocument();
    expect(screen.queryByText('planned.cpa.json')).toBeNull();
    expect(screen.queryByText('mine.cpa.json')).toBeNull();
    expect(screen.queryByText('sold.cpa.json')).toBeNull();
    // The tab's own count agrees, so the missing rows are not a filter bug.
    expect(screen.getByRole('tab', { name: /^最新/ }).textContent).toBe('最新1');
    // They are still kept, and still on their own shelves.
    fireEvent.click(screen.getByRole('tab', { name: /^计划卖出/ }));
    expect(await screen.findByText('planned.cpa.json')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^自用/ }));
    const selfUnexportedToggle = screen.getByRole('button', { name: '展开批次 未导出' });
    expect(selfUnexportedToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(selfUnexportedToggle);
    expect(await screen.findByText('mine.cpa.json')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^已卖出/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开批次 未导出' }));
    expect(await screen.findByText('sold.cpa.json')).toBeInTheDocument();
    // ...and 全部 still shows all five, with the settled and the already
    // exported ones sorted below the one row that is genuinely new.
    fireEvent.click(screen.getByRole('tab', { name: /^全部/ }));
    await waitFor(() => expect(Array.from(document.querySelectorAll('.artifact-card-head strong'), (node) => node.textContent)).toEqual(['mine.cpa.json', 'planned.cpa.json', 'sold.cpa.json', 'stock.cpa.json', 'shipped.cpa.json']));
    fireEvent.click(screen.getByLabelText('选择 planned.cpa.json'));
    expect(screen.getByLabelText('全选本页（1）')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('全选本页（1）'));
    expect(screen.getByLabelText('全选本页')).toBeChecked();
  });

  it('separates self-use and sold artifacts by their latest delivery time', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-delivery-groups-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 5, cpaCompleted: 5, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const base = { runId: run.runId, size: 1024, runStatus: 'complete', deletable: true };
    const artifacts = [
      { ...base, jobId: 'job-self-pending', aliasIndex: 1, email: 'self-pending@example.test', fileName: 'self-pending.cpa.json', modifiedAt: '2026-09-12T12:00:04.000Z', lifecycle: 'self_use' },
      { ...base, jobId: 'job-self-new', aliasIndex: 2, email: 'self-new@example.test', fileName: 'self-new.cpa.json', modifiedAt: '2026-09-12T12:00:00.000Z', lifecycle: 'self_use', cpaExportedAt: '2026-09-12T12:00:01.000Z', sub2ApiPushedAt: '2026-09-12T12:00:02.000Z' },
      { ...base, jobId: 'job-self-old-a', aliasIndex: 3, email: 'self-old-a@example.test', fileName: 'self-old-a.cpa.json', modifiedAt: '2026-09-12T12:00:03.000Z', lifecycle: 'self_use', sub2ApiPushedAt: '2026-09-12T11:00:00.000Z' },
      { ...base, jobId: 'job-self-old-b', aliasIndex: 4, email: 'self-old-b@example.test', fileName: 'self-old-b.cpa.json', modifiedAt: '2026-09-12T12:00:02.000Z', lifecycle: 'self_use', sub2ApiPushedAt: '2026-09-12T11:00:00.000Z' },
      { ...base, jobId: 'job-sold', aliasIndex: 5, email: 'sold@example.test', fileName: 'sold.cpa.json', modifiedAt: '2026-09-12T12:00:01.000Z', lifecycle: 'sold', cpaExportedAt: '2026-09-12T10:00:00.000Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    expect(document.querySelectorAll('.artifact-delivery-divider')).toHaveLength(3);
    const unexportedToggle = document.querySelector('.artifact-delivery-toggle') as HTMLButtonElement;
    expect(unexportedToggle).toHaveAttribute('aria-label', '展开批次 未导出');
    expect(unexportedToggle).toHaveAttribute('aria-expanded', 'false');
    expect(Array.from(document.querySelectorAll('.artifact-delivery-toggle'), (toggle) => toggle.getAttribute('aria-expanded')))
      .toEqual(['false', 'false', 'false']);
    expect(screen.queryByText('self-pending.cpa.json')).not.toBeInTheDocument();
    fireEvent.click(unexportedToggle);
    expect(unexportedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelectorAll('.artifact-delivery-toggle')[1]).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelectorAll('.artifact-delivery-toggle')[2]).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.artifact-delivery-divider time')).toHaveAttribute('datetime', '2026-09-12T12:00:02.000Z');
    expect(document.querySelectorAll('.artifact-delivery-divider time')[1]).toHaveAttribute('datetime', '2026-09-12T11:00:00.000Z');
    expect(document.querySelectorAll('.artifact-delivery-divider time')[0]).toHaveTextContent('1 个');
    expect(document.querySelectorAll('.artifact-delivery-divider time')[1]).toHaveTextContent('2 个');
    const deliveryNotes = document.querySelectorAll('.artifact-delivery-note') as NodeListOf<HTMLInputElement>;
    expect(deliveryNotes).toHaveLength(2);
    fireEvent.change(deliveryNotes[0], { target: { value: '客户 A' } });
    expect(deliveryNotes[0]).toHaveValue('客户 A');
    expect(JSON.parse(window.localStorage.getItem('gpt-re.cpa-delivery-notes') || '{}')).toMatchObject({ '2026-09-12T12:00:02.000Z': '客户 A' });
    expect(document.querySelector('.artifact-scroll .artifact-card .artifact-name-pending')).toHaveTextContent('self-pending.cpa.json');
    expect(screen.getByText('self-pending.cpa.json')).toBeInTheDocument();
    const batchCheckboxes = document.querySelectorAll('.artifact-batch-select input');
    expect(batchCheckboxes).toHaveLength(3);
    fireEvent.click(batchCheckboxes[2]);
    expect(batchCheckboxes[2]).toBeChecked();
    expect(screen.getByLabelText('全选本页（2）')).not.toBeChecked();
    const oldBatchToggle = document.querySelectorAll('.artifact-delivery-toggle')[2] as HTMLButtonElement;
    expect(oldBatchToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(oldBatchToggle);
    expect(oldBatchToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('选择 self-old-a.cpa.json')).toBeChecked();
    expect(screen.getByLabelText('选择 self-old-b.cpa.json')).toBeChecked();
    expect(screen.getByText('self-old-a.cpa.json')).toBeInTheDocument();
    expect(screen.getByText('self-old-b.cpa.json')).toBeInTheDocument();
    fireEvent.click(oldBatchToggle);
    expect(oldBatchToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('self-old-a.cpa.json')).not.toBeInTheDocument();
    expect(screen.queryByText('self-old-b.cpa.json')).not.toBeInTheDocument();
    fireEvent.click(oldBatchToggle);
    expect(oldBatchToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('self-old-a.cpa.json')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    expect(document.querySelectorAll('.artifact-delivery-divider')).toHaveLength(1);
    expect(document.querySelector('.artifact-delivery-divider time')).toHaveAttribute('datetime', '2026-09-12T10:00:00.000Z');
  });

  it('locks a delivered self-use batch and leaves its cards read-only', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-lock-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const item = {
      runId: run.runId,
      jobId: 'job-locked',
      aliasIndex: 1,
      email: 'locked@example.test',
      fileName: 'locked.cpa.json',
      size: 1024,
      modifiedAt: '2026-09-12T12:00:01.000Z',
      runStatus: 'complete',
      deletable: true,
      assetId: 'asset-locked',
      lifecycle: 'self_use',
      cpaExportedAt: '2026-09-12T12:00:00.000Z',
    };
    let locked = false;
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts: [locked ? { ...item, locked: true, lockedAt: '2026-09-12T12:01:00.000Z', lockBatchKey: item.cpaExportedAt } : item] };
      if (url.pathname === '/api/v1/artifacts/cpa/lock') {
        requests.push(JSON.parse(String(init?.body || '{}')));
        locked = true;
        payload = { requested: 1, locked: [{ runId: item.runId, jobId: item.jobId }], alreadyLocked: [], batchKey: item.cpaExportedAt };
      }
      if (url.pathname === '/api/v1/artifacts/cpa/unlock') {
        requests.push(JSON.parse(String(init?.body || '{}')));
        locked = false;
        payload = { requested: 1, unlocked: [{ runId: item.runId, jobId: item.jobId }], alreadyUnlocked: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    const groupToggle = await screen.findByRole('button', { name: /展开批次/ });
    fireEvent.click(groupToggle);
    expect(await screen.findByText(item.fileName)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /锁定批次/ }));
    const lockDialog = await screen.findByRole('dialog', { name: '锁定 CPA 批次' });
    expect(lockDialog).toHaveTextContent('不会删除文件');
    fireEvent.click(within(lockDialog).getByRole('button', { name: '确认锁定' }));
    await waitFor(() => expect(requests).toEqual([{ items: [{ runId: item.runId, jobId: item.jobId }], batchKey: item.cpaExportedAt }]));
    expect(await screen.findByText('已锁定')).toBeInTheDocument();
    expect(screen.getByLabelText(`选择 ${item.fileName}`)).toBeDisabled();
    expect(screen.queryByRole('link', { name: `下载 ${item.fileName}` })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /解锁批次/ }));
    const unlockDialog = await screen.findByRole('dialog', { name: '解锁 CPA 批次' });
    expect(unlockDialog).toHaveTextContent('恢复可选');
    fireEvent.click(within(unlockDialog).getByRole('button', { name: '确认解锁' }));
    await waitFor(() => expect(requests).toEqual([
      { items: [{ runId: item.runId, jobId: item.jobId }], batchKey: item.cpaExportedAt },
      { items: [{ runId: item.runId, jobId: item.jobId }] },
    ]));
    expect(await screen.findByRole('button', { name: /锁定批次/ })).toBeInTheDocument();
    expect(screen.getByLabelText(`选择 ${item.fileName}`)).toBeEnabled();
    expect(screen.getByRole('link', { name: `下载 ${item.fileName}` })).toBeInTheDocument();
  });

  it('exports the unexported files of the category on screen, not the whole store', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-scope-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 3, cpaCompleted: 3, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const base = { runId: run.runId, size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true };
    const artifacts = [
      { ...base, jobId: 'job-stock', aliasIndex: 1, email: 'stock@example.test', fileName: 'stock.cpa.json', assetId: 'asset-stock', lifecycle: 'active' },
      { ...base, jobId: 'job-planned', aliasIndex: 2, email: 'planned@example.test', fileName: 'planned.cpa.json', assetId: 'asset-planned', lifecycle: 'planned' },
      { ...base, jobId: 'job-shipped', aliasIndex: 3, email: 'shipped@example.test', fileName: 'shipped.cpa.json', assetId: 'asset-shipped', lifecycle: 'planned', cpaExportedAt: new Date().toISOString() },
    ];
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/export') {
        requests.push(JSON.parse(String(init?.body || '{}')));
        payload = [];
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const NativeUrl = URL;
    class DownloadUrl extends NativeUrl {
      static createObjectURL = vi.fn(() => 'blob:export-scope-test');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', DownloadUrl);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
      // 最新 holds the one unshelved, unexported file.
      expect(await screen.findByText('stock.cpa.json')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: '导出本页未导出 (1)' })).toBeEnabled();
      // Standing on 计划卖出 the button follows the tab: the shelf's unexported
      // file, and not the 在库 one sitting outside the filter.
      fireEvent.click(screen.getByRole('tab', { name: /^计划卖出/ }));
      expect(await screen.findByText('planned.cpa.json')).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: '导出本页未导出 (1)' }));
      await waitFor(() => expect(requests).toEqual([{ items: [{ runId: run.runId, jobId: 'job-planned' }] }]));
      // 全部 offers both unexported files and still leaves the exported one out.
      fireEvent.click(screen.getByRole('tab', { name: /^全部/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^导出本页未导出/ })).toHaveTextContent('导出本页未导出 (2)'));
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('exports a requested count from the sold undelivered group with validation and retry', async () => {
    window.history.replaceState(null, '', '/history');
    const base = { runId: 'sold-count-run', size: 1024, modifiedAt: '2026-09-29T12:00:00.000Z', runStatus: 'complete', deletable: true, lifecycle: 'sold', isPlus: true };
    const artifacts = [
      ...['first', 'second', 'third'].map((name) => ({ ...base, key: `${name}.json`, jobId: `job-${name}`, fileName: `${name}.cpa.json` })),
      { ...base, key: 'oauth.json', jobId: 'job-oauth', fileName: 'oauth.cpa.json', isPlus: false },
      { ...base, key: 'stock.json', jobId: 'job-stock', fileName: 'stock.cpa.json', lifecycle: 'active' },
      { ...base, key: 'self.json', jobId: 'job-self', fileName: 'self.cpa.json', lifecycle: 'self_use' },
      { ...base, key: 'exported.json', jobId: 'job-exported', fileName: 'exported.cpa.json', cpaExportedAt: base.modifiedAt },
      { ...base, key: 'pushed.json', jobId: 'job-pushed', fileName: 'pushed.cpa.json', sub2ApiPushedAt: base.modifiedAt },
      { ...base, key: 'locked.json', jobId: 'job-locked', fileName: 'locked.cpa.json', locked: true },
    ];
    const requests: Array<{ items: Array<{ runId: string; jobId: string; key: string }> }> = [];
    const exported = new Set<string>();
    let failExport = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') payload = {
        artifacts: artifacts.map((artifact) => exported.has(artifact.key) ? { ...artifact, cpaExportedAt: base.modifiedAt } : artifact),
      };
      if (url.pathname === '/api/v1/artifacts/cpa/export') {
        const selection = JSON.parse(String(init?.body || '{}'));
        requests.push(selection);
        if (failExport) return new Response(JSON.stringify({ error: 'Export failed' }), { status: 500 });
        selection.items.forEach((item: { key: string }) => exported.add(item.key));
        payload = selection.items;
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const NativeUrl = URL;
    class DownloadUrl extends NativeUrl {
      static createObjectURL = vi.fn(() => 'blob:sold-count-test');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', DownloadUrl);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
      fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
      expect(screen.queryByRole('spinbutton', { name: '导出数量' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: /^已卖出/ }));
      const quantity = await screen.findByRole('spinbutton', { name: '导出数量' });
      // Credentials is the default; this case is about the CPA endpoint, so
      // the format picker moves off it first.
      expect(screen.getByRole('button', { name: '按数量导出邮箱凭证' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
      fireEvent.click(await screen.findByRole('option', { name: 'CPA' }));
      const exportButton = await screen.findByRole('button', { name: '按数量导出CPA' });
      expect(quantity).toHaveAttribute('max', '4');
      expect(screen.getByRole('button', { name: '展开批次 未导出' })).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(screen.getByRole('combobox', { name: '类型筛选' }));
      fireEvent.click(await screen.findByRole('option', { name: /^Plus/ }));
      expect(quantity).toHaveAttribute('max', '3');
      for (const value of ['', '0', '-1', '1.5', '4']) {
        fireEvent.change(quantity, { target: { value } });
        expect(quantity).toHaveAttribute('aria-invalid', 'true');
        expect(exportButton).toBeDisabled();
        fireEvent.submit(exportButton.closest('form')!);
      }
      expect(requests).toHaveLength(0);
      fireEvent.change(quantity, { target: { value: '2' } });
      await waitFor(() => expect(exportButton).toBeEnabled());
      fireEvent.click(exportButton);
      const expectedSelection = { items: ['first', 'second'].map((name) => ({ runId: base.runId, jobId: `job-${name}`, key: `${name}.json` })), unexportedOnly: true };
      await waitFor(() => expect(requests).toEqual([expectedSelection]));
      await waitFor(() => expect(exportButton).toBeEnabled());
      expect(exported.size).toBe(0);
      expect(clickSpy).not.toHaveBeenCalled();
      failExport = false;
      fireEvent.click(exportButton);
      await waitFor(() => expect(requests).toEqual([expectedSelection, expectedSelection]));
      await waitFor(() => expect(quantity).toHaveAttribute('max', '1'));
      expect(exportButton).toBeDisabled();
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      fireEvent.change(quantity, { target: { value: '1' } });
      await waitFor(() => expect(exportButton).toBeEnabled());
      fireEvent.click(exportButton);
      await waitFor(() => expect(requests[2]).toEqual({ items: [{ runId: base.runId, jobId: 'job-third', key: 'third.json' }], unexportedOnly: true }));
      await waitFor(() => expect(screen.queryByRole('button', { name: '按数量导出CPA' })).not.toBeInTheDocument());
      expect(clickSpy).toHaveBeenCalledTimes(2);
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('limits the sold undelivered count export to one registration country', async () => {
    window.history.replaceState(null, '', '/history');
    const base = { runId: 'sold-country-run', size: 1024, modifiedAt: '2026-09-29T12:00:00.000Z', runStatus: 'complete', deletable: true, lifecycle: 'sold' };
    const artifacts = [
      { ...base, key: 'us-one.json', jobId: 'job-us-one', fileName: 'us-one.cpa.json', registrationCountry: 'US' },
      { ...base, key: 'in-one.json', jobId: 'job-in-one', fileName: 'in-one.cpa.json', registrationCountry: 'IN' },
      { ...base, key: 'us-two.json', jobId: 'job-us-two', fileName: 'us-two.cpa.json', registrationCountry: 'US' },
      { ...base, key: 'none.json', jobId: 'job-none', fileName: 'none.cpa.json' },
      { ...base, key: 'us-locked.json', jobId: 'job-us-locked', fileName: 'us-locked.cpa.json', registrationCountry: 'US', locked: true },
    ];
    const requests: Array<{ items: Array<{ key: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/export') {
        const selection = JSON.parse(String(init?.body || '{}'));
        requests.push(selection);
        payload = selection.items.map((item: { key: string }) => ({ email: item.key }));
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const downloads: string[] = [];
    const NativeUrl = URL;
    class DownloadUrl extends NativeUrl {
      static createObjectURL = vi.fn(() => 'blob:sold-country-test');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', DownloadUrl);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
    const quantity = await screen.findByRole('spinbutton', { name: '导出数量' });
    fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
    fireEvent.click(await screen.findByRole('option', { name: 'CPA' }));
    expect(quantity).toHaveAttribute('max', '4');

    fireEvent.click(screen.getByRole('combobox', { name: '注册国' }));
    expect(await screen.findByRole('option', { name: /全部注册国（4）/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /未知注册国（1）/ })).toBeInTheDocument();
    // Locked rows are not stock: US offers the two unlocked accounts only.
    fireEvent.click(screen.getByRole('option', { name: /US（2）/ }));
    await waitFor(() => expect(quantity).toHaveAttribute('max', '2'));

    fireEvent.change(quantity, { target: { value: '3' } });
    expect(quantity).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(quantity, { target: { value: '2' } });
    const exportButton = screen.getByRole('button', { name: '按数量导出CPA' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].items.map((item) => item.key)).toEqual(['us-one.json', 'us-two.json']);
    // The file says which country it holds.
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatch(/^CPA-US-已OAuth-2个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);

    fireEvent.click(screen.getByRole('combobox', { name: '注册国' }));
    fireEvent.click(await screen.findByRole('option', { name: /未知注册国（1）/ }));
    await waitFor(() => expect(quantity).toHaveAttribute('max', '1'));
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('exports the sold undelivered count as credentials by default and remembers another format', async () => {
    window.history.replaceState(null, '', '/history');
    const base = { runId: 'sold-format-run', size: 1024, modifiedAt: '2026-09-29T12:00:00.000Z', runStatus: 'complete', deletable: true, lifecycle: 'sold' };
    const artifacts = ['first', 'second'].map((name) => ({ ...base, key: `${name}.json`, jobId: `job-${name}`, fileName: `${name}.cpa.json` }));
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (['/api/v1/artifacts/cpa/credentials', '/api/v1/artifacts/cpa/sub2api'].includes(url.pathname)) {
        calls.push({ path: url.pathname, body: JSON.parse(String(init?.body || '{}')) });
        if (url.pathname === '/api/v1/artifacts/cpa/credentials') {
          const content = 'a@b.com----pw----SECRET\nc@d.com----pw----SECRET\n';
          const response = new Response(content, {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="gpt-re-selected-cpa-credentials.txt"' },
          });
          // jsdom's Blob lacks text(); provide the browser method used by batching.
          const blob = await response.blob();
          Object.assign(blob, { text: async () => content });
          response.blob = async () => blob;
          return response;
        }
        payload = { accounts: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const NativeUrl = URL;
    class DownloadUrl extends NativeUrl {
      static createObjectURL = vi.fn(() => 'blob:sold-format-test');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', DownloadUrl);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
      fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
      const quantity = await screen.findByRole('spinbutton', { name: '导出数量' });
      fireEvent.change(quantity, { target: { value: '2' } });
      // Nothing was picked, so the default hands over credentials.
      fireEvent.click(await screen.findByRole('button', { name: '按数量导出邮箱凭证' }));
      const selection = { items: ['first', 'second'].map((name) => ({ runId: base.runId, jobId: `job-${name}`, key: `${name}.json` })), unexportedOnly: true };
      await waitFor(() => expect(calls).toEqual([{ path: '/api/v1/artifacts/cpa/credentials', body: selection }]));
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
      fireEvent.click(await screen.findByRole('option', { name: 'sub' }));
      fireEvent.change(await screen.findByRole('spinbutton', { name: '导出数量' }), { target: { value: '1' } });
      fireEvent.click(await screen.findByRole('button', { name: '按数量导出sub' }));
      await waitFor(() => expect(calls[1]).toEqual({ path: '/api/v1/artifacts/cpa/sub2api', body: { items: [selection.items[0]], unexportedOnly: true } }));

      // The format an operator sells in is a standing choice, not a per-visit one.
      view.unmount();
      render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
      fireEvent.click(await screen.findByRole('tab', { name: /^已卖出/ }));
      expect(await screen.findByRole('button', { name: '按数量导出sub' })).toBeInTheDocument();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('downloads one or multiple selected Codex CPA files as sub2api JSON', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-sub2api-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 2, cpaCompleted: 2, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = ['first', 'second'].map((name, index) => ({
      key: `session-assets/${name}@example.test-cpa.json`,
      runId: run.runId,
      jobId: `job-${name}`,
      aliasIndex: index + 1,
      email: `${name}@example.test`,
      fileName: `${name}.cpa.json`,
      size: 1024,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
    }));
    const requests: unknown[] = [];
    const exported = new Set<string>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = {
        artifacts: artifacts.map((artifact) => exported.has(artifact.key)
          ? { ...artifact, sub2ApiExportedAt: '2026-08-07T12:00:00.000Z' }
          : artifact),
      };
      if (url.pathname === '/api/v1/artifacts/cpa/sub2api') {
        const selection = JSON.parse(String(init?.body || '{}'));
        requests.push(selection);
        selection.items.forEach((item: { key?: string }) => { if (item.key) exported.add(item.key); });
        payload = {
          exported_at: new Date().toISOString(),
          proxies: [],
          accounts: selection.items.map((item: { jobId: string }) => ({ name: item.jobId })),
        };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const downloads: string[] = [];
    const NativeUrl = URL;
    class DownloadUrl extends NativeUrl {
      static createObjectURL = vi.fn(() => 'blob:sub2api-test');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', DownloadUrl);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

      // These rows are asserted to stay visible after they are exported, so
      // leave the 最新 tab, which by definition drops them once marked.
      fireEvent.click(await screen.findByRole('tab', { name: /^全部/ }));
      await screen.findByText('first.cpa.json');
      fireEvent.click(screen.getByRole('button', { name: '下载 first.cpa.json 的 sub2api' }));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toEqual({ items: [{ runId: run.runId, jobId: 'job-first', key: artifacts[0].key }] });
      await waitFor(() => expect(downloads).toContain('first.cpa.sub2api.json'));
      await waitFor(() => expect(screen.getByText('first.cpa.json')).toHaveClass('artifact-name-exported'));
      expect(Array.from(document.querySelectorAll('.artifact-card-head strong'), (node) => node.textContent)).toEqual(['second.cpa.json', 'first.cpa.json']);

      artifacts.forEach((artifact) => fireEvent.click(screen.getByLabelText(`选择 ${artifact.fileName}`)));
      fireEvent.click(screen.getByRole('button', { name: '导出选中 sub2api (2)' }));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({ items: [...artifacts].reverse().map(({ runId, jobId, key }) => ({ runId, jobId, key })) });
      await waitFor(() => expect(downloads.some((name) => /^sub2api-已OAuth-\d+个-\d{2}(-\d{2}){4}\.json$/.test(name))).toBe(true));
      await waitFor(() => expect(document.querySelectorAll('.artifact-name-exported')).toHaveLength(2));
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('offers the sub2api push only on the self-use shelf, and reports a partial import', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-push-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 2, cpaCompleted: 2, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = [
      { runId: run.runId, jobId: 'job-mine', aliasIndex: 1, email: 'mine@example.test', fileName: 'mine.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, assetId: 'asset-mine', lifecycle: 'self_use' },
      { runId: run.runId, jobId: 'job-stock', aliasIndex: 2, email: 'stock@example.test', fileName: 'stock.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, assetId: 'asset-stock', lifecycle: 'active' },
    ];
    const pushes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/sub2api/push') {
        pushes.push(JSON.parse(String(init?.body || '{}')));
        // One landed, one was refused for a stale token: the console has to
        // report both halves rather than only the count that succeeded.
        payload = { total: 2, created: 1, updated: 0, skipped: 0, failed: 1, errors: ['access_token 已过期'], warnings: [], pushed: 1, artifacts: 2, classified: ['asset-mine'] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // The push is a self-use action, so it is absent from every other shelf.
    fireEvent.click(await screen.findByRole('tab', { name: /^全部/ }));
    await screen.findByText('mine.cpa.json');
    expect(screen.queryByRole('button', { name: /发送到 sub2api/ })).toBeNull();

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开批次 未导出' }));
    await waitFor(() => expect(screen.queryByText('stock.cpa.json')).toBeNull());
    expect(screen.getByText('mine.cpa.json')).toBeInTheDocument();
    // Disabled until something is selected — the gateway takes a selection,
    // not "whatever the tab happens to show".
    expect(screen.getByRole('button', { name: /发送到 sub2api/ })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('选择 mine.cpa.json'));
    fireEvent.click(screen.getByRole('button', { name: '发送到 sub2api (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认发送' }));
    await waitFor(() => expect(pushes).toHaveLength(1));
    expect(pushes[0]).toEqual({ items: [{ runId: run.runId, jobId: 'job-mine' }] });
    // The outcome lands on a line that stays put — both halves of it. The old
    // notice said the same thing and then dismissed itself, which is how a
    // refused batch went unnoticed.
    const result = (await screen.findByText('已推送 1/1 · 平台拒收 1')).closest('.push-result') as HTMLElement;
    expect(within(result).getByText('推送 sub2api')).toBeInTheDocument();
    expect(within(result).getByText('access_token 已过期')).toBeInTheDocument();
  });

  it('pulls the sub2api error set on the self-use shelf and hands its addresses to the launch page', async () => {
    window.history.replaceState(null, '', '/history');
    window.sessionStorage.clear();
    const run = {
      runId: 'ui-rail-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = [
      { runId: run.runId, jobId: 'job-mine', aliasIndex: 1, email: 'mine@example.test', fileName: 'mine.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, assetId: 'asset-mine', lifecycle: 'self_use' },
    ];
    let failedSet = {
      accounts: [
        { id: 7, email: 'broken-one@example.test', status: 'error', reason: 'token revoked' },
        { id: 9, email: 'broken-two@example.test', status: 'active', reason: 'refresh failed' },
      ],
      breakdown: { total: 40, active: 30, rate_limited: 8 },
      truncated: false,
    };
    const deletes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/sub2api/accounts/failed') payload = failedSet;
      if (url.pathname === '/api/v1/sub2api/accounts' && init?.method === 'DELETE') {
        deletes.push(JSON.parse(String(init?.body || '{}')));
        failedSet = { ...failedSet, accounts: [] };
        payload = { requested: 2, deleted: 2, errors: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    // The rail belongs to the self-use shelf and nowhere else.
    fireEvent.click(await screen.findByRole('tab', { name: /^全部/ }));
    await screen.findByText('mine.cpa.json');
    expect(screen.queryByRole('button', { name: '拉取' })).toBeNull();

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    const rail = await screen.findByRole('complementary', { name: 'sub2api 错误账号' });
    // Nothing is read until asked: this scans every account on the gateway.
    expect(within(rail).queryByText(/broken-one/)).toBeNull();

    fireEvent.click(within(rail).getByRole('button', { name: '拉取' }));
    const emails = await within(rail).findByLabelText('2 个错误账号邮箱，每行一个');
    expect(emails).toHaveValue('broken-one@example.test\nbroken-two@example.test');
    // The counts ride along so that zero errors reads as a fact, not a bug.
    // 错误 is the list's own length; only the derived pair costs a query.
    expect(within(rail).getByText(/可用 30 · 限流 8 · 错误 2 · 共 40/)).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole('button', { name: '去直登 OAuth' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    // The launch page opens on OAuth with the addresses already pasted, so the
    // operator only has to press start.
    const credentials = await screen.findByLabelText('账号凭据');
    expect(credentials).toHaveValue('broken-one@example.test\nbroken-two@example.test');
    expect(window.sessionStorage.getItem('gpt-re.oauth-relogin-emails')).toBeNull();
  });

  it('deletes the pulled sub2api accounts only behind an explicit confirmation', async () => {
    window.history.replaceState(null, '', '/history');
    window.sessionStorage.clear();
    const run = {
      runId: 'ui-rail-delete-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 1, cpaCompleted: 1, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = [
      { runId: run.runId, jobId: 'job-mine', aliasIndex: 1, email: 'mine@example.test', fileName: 'mine.cpa.json', size: 1024, modifiedAt: new Date().toISOString(), runStatus: 'complete', deletable: true, assetId: 'asset-mine', lifecycle: 'self_use' },
    ];
    const deletes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/sub2api/accounts/failed') {
        payload = { accounts: [{ id: 7, email: 'broken-one@example.test', status: 'error', reason: 'token revoked' }], breakdown: { total: 40, active: 30, rate_limited: 9 }, truncated: false };
      }
      if (url.pathname === '/api/v1/sub2api/accounts' && init?.method === 'DELETE') {
        deletes.push(JSON.parse(String(init?.body || '{}')));
        payload = { requested: 1, deleted: 1, errors: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    const rail = await screen.findByRole('complementary', { name: 'sub2api 错误账号' });
    fireEvent.click(within(rail).getByRole('button', { name: '拉取' }));
    fireEvent.click(await within(rail).findByRole('button', { name: '从 sub2api 删除 (1)' }));
    // Opening the dialog is not the deletion; the gateway is untouched here.
    expect(deletes).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toEqual({ accountIds: [7] });
    expect(await screen.findByText(/已从 sub2api 删除 1 个账号/)).toBeInTheDocument();
    // The list described accounts that no longer exist, so it is cleared.
    await waitFor(() => expect(within(rail).queryByText(/broken-one/)).toBeNull());
  });

  it('pushes in batches with a real progress bar, and a pushed artifact stops being new', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-batch-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 30, cpaCompleted: 30, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    // 30 artifacts against a batch size of 25: two requests, so the bar has a
    // step to take rather than jumping straight to done.
    const artifacts = Array.from({ length: 30 }, (_value, index) => ({
      runId: run.runId,
      jobId: `job-${index}`,
      aliasIndex: index + 1,
      email: `mine-${index}@example.test`,
      fileName: `mine-${index}.cpa.json`,
      size: 1024,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: `asset-${index}`,
      lifecycle: 'self_use',
    }));
    const pushed = new Set<string>();
    const batchSizes: number[] = [];
    // The second batch is held open so the bar is observable mid-push; without
    // a gate the mocked requests resolve in microtasks and it never paints.
    let releaseSecond: () => void = () => {};
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') {
        payload = {
          // A delivered artifact carries every marker, the way the server
          // stamps them: the push ledger and both export ledgers.
          artifacts: artifacts.map((artifact) => pushed.has(artifact.jobId)
            ? { ...artifact, sub2ApiPushedAt: '2026-09-09T00:00:00.000Z', cpaExportedAt: '2026-09-09T00:00:00.000Z', sub2ApiExportedAt: '2026-09-09T00:00:00.000Z' }
            : artifact),
        };
      }
      if (url.pathname === '/api/v1/artifacts/cpa/sub2api/push') {
        const body = JSON.parse(String(init?.body || '{}'));
        batchSizes.push(body.items.length);
        if (batchSizes.length === 2) await secondBatchGate;
        body.items.forEach((item: { jobId: string }) => pushed.add(item.jobId));
        payload = { total: body.items.length, created: body.items.length, updated: 0, skipped: 0, failed: 0, errors: [], warnings: [], pushed: body.items.length, artifacts: body.items.length, classified: body.items.map((item: { jobId: string }) => item.jobId) };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开批次 未导出' }));
    await screen.findByText('mine-0.cpa.json');
    fireEvent.click(screen.getByLabelText('全选本页'));
    fireEvent.click(screen.getByRole('button', { name: '发送到 sub2api (30)' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认发送' }));

    // Mid-push: the first batch landed, the second is held. The bar is a real
    // count of artifacts, not an animation — 25 of 30 done.
    const bar = await screen.findByRole('progressbar', { name: '推送 sub2api 进度' });
    expect(bar).toHaveAttribute('aria-valuemax', '30');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '25'));
    expect(within(bar).getByText('25/30')).toBeInTheDocument();
    // The top bar carries the same count. That strip is otherwise fed only by
    // the server's robot poll, and a push has no robot to poll — so it is the
    // one indicator an operator is looking at when the page one is missed.
    const strip = document.querySelector('.topbar-activity') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(within(strip).getByText('推送 sub2api')).toBeInTheDocument();
    expect(within(strip).getByText('25/30')).toBeInTheDocument();

    releaseSecond();
    await waitFor(() => expect(batchSizes).toEqual([25, 5]));
    const result = await screen.findByText('已推送 30/30');
    expect(result.closest('.push-result')).toHaveClass('push-result-success');
    // The in-panel bar clears when the push ends rather than sitting at 100%;
    // the top bar holds its outcome briefly and carries the summary in its
    // tooltip, and the result line on the page outlives both — and outlives
    // the page itself, which is the point of keeping it outside the component.
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: '推送 sub2api 进度' })).toBeNull(), { timeout: 3000 });
    const settled = document.querySelector('.topbar-activity-item') as HTMLElement;
    expect(settled).toHaveAttribute('title', '推送 sub2api：已推送 30/30');
    expect(within(settled).getByText('完成')).toBeInTheDocument();

    // A pushed artifact has gone somewhere, so 最新 no longer claims it. These
    // fixtures sit on the 自用 shelf, which already keeps them out on its own —
    // the export-marker half of that rule is what the planned/self-use/sold
    // test covers on an 在库 row.
    const freshTab = await screen.findByRole('tab', { name: /^最新/ });
    fireEvent.click(freshTab);
    await waitFor(() => expect(screen.queryByText('mine-0.cpa.json')).toBeNull());
    // ...and the tab's own count agrees, so the empty view is not a filter bug.
    await waitFor(() => expect(freshTab.textContent).toBe('最新0'));
    // Nothing is left to export either: a pushed artifact has been delivered,
    // so the header button stops offering to send the same files again.
    await waitFor(() => expect(screen.getByRole('button', { name: /^导出本页未导出/ })).toBeDisabled());
  });

  it('states the outcome when the gateway answers too fast for a progress bar', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-fast-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 2, cpaCompleted: 2, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    // One batch, answered with no delay — the real gateway imports 25 accounts
    // in tens of milliseconds, so the bar can be created and destroyed inside
    // one frame. What the operator is owed is the outcome, not the bar.
    const artifacts = [0, 1].map((index) => ({
      runId: run.runId,
      jobId: `job-${index}`,
      aliasIndex: index + 1,
      email: `fast-${index}@example.test`,
      fileName: `fast-${index}.cpa.json`,
      size: 1024,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
      assetId: `asset-${index}`,
      lifecycle: 'self_use',
    }));
    let pushes = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      if (url.pathname === '/api/v1/artifacts/cpa/sub2api/push') {
        pushes += 1;
        const body = JSON.parse(String(init?.body || '{}'));
        payload = { total: body.items.length, created: body.items.length, updated: 0, skipped: 0, failed: 0, errors: [], warnings: [], pushed: body.items.length, artifacts: body.items.length, classified: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /^自用/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开批次 未导出' }));
    await screen.findByText('fast-0.cpa.json');
    fireEvent.click(screen.getByLabelText('全选本页'));
    fireEvent.click(screen.getByRole('button', { name: '发送到 sub2api (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认发送' }));

    await waitFor(() => expect(pushes).toBe(1));
    // The result takes the bar's place in the same tick and then stays put: no
    // timer holds it, and nothing dismisses it but the operator.
    const result = await screen.findByText('已推送 2/2');
    expect(result.closest('.push-result')).toHaveClass('push-result-success');
    // The card grid is a sibling that stays rendered alongside it, not replaced.
    expect(screen.getByText('fast-0.cpa.json')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: '推送 sub2api 进度' })).toBeNull());
    // Leaving the page and coming back does not throw the outcome away. It
    // used to live in component state, and the floating notice that would have
    // repeated it is suppressed on this page precisely because this line
    // exists — so a navigation lost the result twice over.
    fireEvent.click(screen.getByRole('link', { name: '登录态' }));
    await waitFor(() => expect(screen.queryByText('fast-0.cpa.json')).toBeNull());
    fireEvent.click(screen.getByRole('link', { name: '历史与产物' }));
    expect(await screen.findByText('已推送 2/2')).toBeInTheDocument();
  });

  it('selects a continuous CPA range by long-pressing and dragging across rows', async () => {
    window.history.replaceState(null, '', '/history');
    const run = {
      runId: 'ui-artifact-range-run',
      status: 'complete',
      phase: 'finalization',
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 0, idle: 1 }, accountsCreated: 3, cpaCompleted: 3, finalization: { queued: 0, running: 0, failed: 0 } },
    };
    const artifacts = ['first', 'second', 'third'].map((name, index) => ({
      runId: run.runId,
      jobId: `job-${name}`,
      aliasIndex: index + 1,
      email: `${name}@example.test`,
      fileName: `${name}.cpa.json`,
      size: 1024,
      modifiedAt: new Date().toISOString(),
      runStatus: 'complete',
      deletable: true,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: '', runs: [run] };
      if (url.pathname === '/api/v1/artifacts/cpa') payload = { artifacts };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const firstRow = (await screen.findByText('first.cpa.json')).closest('.artifact-card') as HTMLDivElement;
    const thirdRow = screen.getByText('third.cpa.json').closest('.artifact-card') as HTMLDivElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => thirdRow) });
    try {
      fireEvent.pointerDown(firstRow, { pointerId: 31, pointerType: 'mouse', button: 0, clientX: 12, clientY: 12 });
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 55)); });
      fireEvent.pointerMove(window, { pointerId: 31, pointerType: 'mouse', clientX: 12, clientY: 180 });
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 205)); });
      fireEvent.pointerUp(window, { pointerId: 31, pointerType: 'mouse', button: 0, clientX: 12, clientY: 180 });
    } finally {
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: originalElementFromPoint });
    }

    await waitFor(() => expect(screen.getByRole('button', { name: '导出选中 CPA (3)' })).toBeEnabled());
    artifacts.forEach((artifact) => expect(screen.getByLabelText(`选择 ${artifact.fileName}`)).toBeChecked());
    expect(document.querySelector('.artifact-range-selecting')).toBeNull();
  });

  it('confirms multiple waiting SMS acquisitions in one request', async () => {
    window.history.replaceState(null, '', '/run/ui-batch-waiting-run');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const waitingRun: any = {
      runId: 'ui-batch-waiting-run',
      status: 'running',
      phase: 'waiting_sms_acquisition_reconcile',
      active: true,
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 2, running: 0, idle: 2 }, accountsCreated: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [],
      jobs: [
        { id: 'job-batch-1', email: 'first@example.test', status: 'waiting', phase: 'waiting_sms_acquisition_reconcile', smsAttempts: 1, accountCreated: false, error: { code: 'SMS_ACQUISITION_UNCERTAIN', message: 'provider response was unclear' } },
        { id: 'job-batch-2', email: 'second@example.test', status: 'waiting', phase: 'waiting_sms_acquisition_reconcile', smsAttempts: 1, accountCreated: false, error: { code: 'SMS_ACQUISITION_UNCERTAIN', message: 'provider response was unclear' } },
      ],
    };
    let retryPayload: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: waitingRun.runId, activeRunIds: [waitingRun.runId], runs: [waitingRun] };
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}`) payload = waitingRun;
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}/logs`) payload = { logs: [] };
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}/jobs/retry` && init?.method === 'POST') {
        retryPayload = JSON.parse(String(init.body || '{}'));
        payload = { ...waitingRun, jobs: waitingRun.jobs.map((job: any) => ({ ...job, status: 'queued', phase: 'queued', error: null })) };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);

    const batchButton = await screen.findByRole('button', { name: '批量核对并继续（2）' });
    expect(screen.getAllByRole('button', { name: /核对无误后继续此账号/ })).toHaveLength(2);
    fireEvent.click(batchButton);
    const dialog = await screen.findByRole('dialog', { name: '批量确认账号继续' });
    expect(dialog.textContent).toContain('这 2 个账号');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认全部无号并继续' }));

    await waitFor(() => expect(retryPayload).toEqual({ jobIds: ['job-batch-1', 'job-batch-2'], resolveSmsAcquisition: 'retry' }));
  });

  it('shows immediate feedback when a resumable failed task continues from its checkpoint', async () => {
    window.history.replaceState(null, '', '/run/ui-waiting-run');
    class MockEventSource {
      constructor(_url: string) {}
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const waitingRun = {
      runId: 'ui-waiting-run',
      status: 'failed',
      resumable: true,
      phase: 'normal',
      active: false,
      updatedAt: new Date().toISOString(),
      counts: { workers: { total: 1, running: 1, idle: 0 }, accountsCreated: 0, cpaCompleted: 0, finalization: { queued: 0, running: 0, failed: 0 } },
      workers: [],
      jobs: [{ id: 'job-1', email: 'd***@outlook.com', status: 'waiting', phase: 'blocked_phone_otp_send', branch: 'register', aliasIndex: 1, replacementOf: '', proxyId: '', smsAttempts: 1, accountCreated: false, error: { code: 'invalid_phone_number', message: 'Invalid phone number' } }],
    };
    let resumed = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/runs') payload = { activeRunId: resumed ? waitingRun.runId : '', runs: [{ ...waitingRun, status: resumed ? 'running' : 'failed', active: resumed }] };
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}`) payload = { ...waitingRun, status: resumed ? 'running' : 'failed', active: resumed };
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}/logs`) payload = { logs: [] };
      if (url.pathname === `/api/v1/runs/${waitingRun.runId}/resume` && init?.method === 'POST') {
        resumed = true;
        payload = { ...waitingRun, status: 'running', active: true };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    const continueButton = await screen.findByRole('button', { name: '从检查点继续' });
    fireEvent.click(continueButton);
    expect(await screen.findByText('任务已重新启动，正在处理上次未完成的步骤')).toBeInTheDocument();
    expect(await screen.findByText('后台执行中')).toBeInTheDocument();
  });
  it('requests separate CPA pages and resets pagination when the shelf changes', async () => {
    window.history.replaceState(null, '', '/history');
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      let payload: unknown = payloads[url.pathname] || {};
      if (url.pathname === '/api/v1/artifacts/cpa') {
        requested.push(url.search);
        const offset = Number(url.searchParams.get('offset') || 0);
        const shelf = url.searchParams.get('lifecycle') || 'fresh';
        payload = { total: 123, offset, limit: 50, artifacts: Array.from({ length: Math.min(50, 123 - offset) }, (_, i) => ({ key: `${shelf}-${offset + i}`, runId: 'paged', jobId: `job-${offset+i}`, fileName: `${shelf}-${offset+i}.json`, email: `${offset+i}@example.test`, modifiedAt: '2026-11-05T00:00:00Z', lifecycle: shelf === 'sold' ? 'sold' : 'active', size: 1 })) };
      }
      return new Response(JSON.stringify(payload));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Tooltip.Provider><Router><App /></Router></Tooltip.Provider></QueryClientProvider>);
    await screen.findByText('fresh-0.json');
    const pager = screen.getByRole('navigation', { name: 'CPA 文件分页' });
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
    await screen.findByText('fresh-50.json');
    expect(screen.queryByText('fresh-0.json')).not.toBeInTheDocument();
    expect(requested.some(search => search.includes('offset=50'))).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /^已卖出/ }));
    await waitFor(() => expect(requested.at(-1)).toContain('offset=0&limit=50&lifecycle=sold'));
    await waitFor(() => expect(pager).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByText('fresh-50.json')).not.toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(requested.at(-1)).toContain('offset=0');
    client.clear();
  });

});
