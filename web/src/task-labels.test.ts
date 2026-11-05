import { describe, expect, it } from 'vitest';

import {
  isAuxiliaryRun,
  jobResultLabel,
  phaseLabel,
  runStatusLabel,
  runTaskDescription,
  runTaskSlot,
  taskKindLabel,
  taskKindPurpose,
} from './task-labels';
import type { RunPlan, RunSummary } from './types';

const plan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  mailCount: 20,
  workerConcurrency: 8,
  aliasStrategy: 'plus',
  aliasCount: 4,
  aliasMaxAttempts: 6,
  aliasRunTag: 'gptre',
  proxyAssignments: [],
  ...overrides,
});

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  runId: 'ui-20260910140428-zklooc',
  status: 'running',
  ...overrides,
});

describe('task slot', () => {
  it('trusts the server field over the task kind', () => {
    // The scheduler enforces capacity against `taskSlot`, so a console that
    // re-derives it from `taskKind` can disagree with the thing that decides.
    expect(runTaskSlot(run({ taskSlot: 'auxiliary', taskKind: 'register_session' }))).toBe('auxiliary');
    expect(runTaskSlot(run({ taskSlot: 'main', taskKind: 'oauth' }))).toBe('main');
  });

  it('falls back to the task kind for summaries written before that field', () => {
    expect(runTaskSlot(run({ taskKind: 'oauth' }))).toBe('auxiliary');
    expect(runTaskSlot(run({ taskKind: 'session_refresh' }))).toBe('auxiliary');
    expect(runTaskSlot(run({ taskKind: 'register_session' }))).toBe('main');
    expect(isAuxiliaryRun(run({ taskKind: 'register_session' }))).toBe(false);
  });
});

describe('phase labels', () => {
  it('renders a wait an operator can act on, and keeps the identifier', () => {
    expect(phaseLabel('waiting_sms_acquisition_reconcile')).toEqual({
      label: '取号结果待核对',
      raw: 'waiting_sms_acquisition_reconcile',
    });
    expect(phaseLabel('waiting_proxy_pool').label).toBe('等待代理池补货');
  });

  it('covers both schedulers where they spell the same wait differently', () => {
    // branch-orchestrator and orchestrator-v2 keep separate vocabularies with
    // near-synonyms across them. Mapping both is not the same as declaring one
    // canonical — that consolidation belongs in the schedulers.
    expect(phaseLabel('waiting_sms_acquire_reconcile').label).toBe(phaseLabel('waiting_sms_acquisition_reconcile').label);
    expect(phaseLabel('waiting_code').label).toBe(phaseLabel('waiting_sms_code').label);
  });

  it('falls back to the raw phase so a new wait shows as itself', () => {
    expect(phaseLabel('waiting_something_new')).toEqual({
      label: 'waiting_something_new',
      raw: 'waiting_something_new',
    });
  });

  it('treats an empty phase as ordinary progress', () => {
    expect(phaseLabel('').label).toBe('正常执行');
    expect(phaseLabel(null).raw).toBe('normal');
  });
});

describe('task kind', () => {
  it('names a login-only credential run and says it skips OAuth', () => {
    const loginOnly = plan({ taskKind: 'oauth', oauthSource: { kind: 'credentials', accounts: [], loginOnly: true } });
    expect(taskKindLabel('oauth', loginOnly)).toBe('凭据直登（仅登录）');
    expect(taskKindPurpose('oauth', loginOnly)).toContain('不跑 OAuth');
    expect(taskKindLabel('oauth', plan({ taskKind: 'oauth' }))).toBe('凭据直登 OAuth');
    const description = runTaskDescription(run({ taskKind: 'oauth', plan: { ...loginOnly, oauthSource: { kind: 'session_assets', assetIds: ['a', 'b'], loginOnly: true } } }));
    expect(description).toContain('2 个账号');
    expect(description).toContain('仅登录');
  });
  it('names the OAuth follow-on variant rather than the bare kind', () => {
    expect(taskKindLabel('register_session', plan({ postRegistrationOAuth: true }))).toBe('登录态注册 + OAuth');
    expect(taskKindLabel('register_session', plan())).toBe('登录态注册');
  });

  it('says what the kind does, not only what it is called', () => {
    expect(taskKindPurpose('oauth')).toContain('不注册新账号');
    expect(taskKindPurpose('session_refresh')).toContain('不产出 CPA');
  });

  it('labels a status a person can read', () => {
    expect(runStatusLabel('waiting')).toBe('等待中');
    expect(runStatusLabel('')).toBe('处理中');
  });
});

describe('job results', () => {
  it('shows only the failure reason without duplicating the server projection', () => {
    const result = '失败：RATE_LIMIT_EXCEEDED，oauth_phone_send request was throttled';
    const reason = 'RATE_LIMIT_EXCEEDED，oauth_phone_send request was throttled';
    expect(jobResultLabel('', { code: 'RATE_LIMIT_EXCEEDED', message: 'oauth_phone_send request was throttled' })).toBe(reason);
    expect(jobResultLabel(result, { code: 'RATE_LIMIT_EXCEEDED', message: 'oauth_phone_send request was throttled' })).toBe(reason);
    expect(jobResultLabel(result)).toBe(reason);
  });

  it('names a successful outcome instead of printing its identifier', () => {
    expect(jobResultLabel('session_security_incomplete_oauth_held')).toBe('安全项未完成，已暂停 OAuth');
    expect(jobResultLabel('session_and_cpa_saved')).toBe('CPA 已保存');
    // An outcome nobody has named yet is unreadable rather than invisible.
    expect(jobResultLabel('some_future_result')).toBe('some_future_result');
  });
});

describe('run description', () => {
  it('says how much work, from where, through which exits, at what concurrency', () => {
    const text = runTaskDescription(run({
      taskKind: 'register_session',
      plan: plan({
        mailCount: 20,
        aliasCount: 4,
        totalAccounts: 100,
        mailProvider: 'mailcom',
        workerConcurrency: 12,
        proxyAssignments: [
          { workerSlot: 1, kind: 'countryPool', countryCode: 'VN' },
          { workerSlot: 2, kind: 'countryPool', countryCode: 'US' },
          { workerSlot: 3, kind: 'countryPool', countryCode: 'VN' },
        ],
      }),
    }));
    expect(text).toBe('20 根邮箱 · 每根 4 别名 · 共 100 个账号 · Mail.com API · VN/US 池 · 12 Worker');
  });

  it('counts an auxiliary run by its source accounts, not by mailboxes', () => {
    const text = runTaskDescription(run({
      taskKind: 'session_refresh',
      plan: plan({
        mailCount: 1,
        workerConcurrency: 4,
        oauthSource: { kind: 'session_assets', assetIds: ['a', 'b', 'c'] },
        proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }],
        security: { setPassword: true, enrollTotp: false },
      }),
    }));
    expect(text).toBe('3 个账号 · 登录态资产 · 本机转发 · 4 Worker · 附带密码设置');
  });

  it('names the root-only alias shape, because it changes the account count', () => {
    const text = runTaskDescription(run({
      taskKind: 'register_session',
      plan: plan({ mailCount: 5, aliasStrategy: 'root', totalAccounts: 5, workerConcurrency: 2 }),
    }));
    expect(text).toContain('仅原邮箱');
    expect(text).not.toContain('别名');
  });

  it('is empty rather than misleading when the run carries no plan', () => {
    expect(runTaskDescription(run({ taskKind: 'oauth' }))).toBe('');
  });
});
