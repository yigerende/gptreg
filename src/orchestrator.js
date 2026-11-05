'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildLegacyCpaArtifact, summarizeCpaArtifact } = require('./cpa-output');
const { derivePlusAliases } = require('./email-alias');
const { tryParseJson } = require('./http-shape');
const { exchangeTokens } = require('./oauth-pkce');
const { executePureHttpUrl } = require('./pure-url');
const {
  createProxyAllocator,
  createProxyHealthState,
  isProxyUsable,
  loadProxyPool,
  markProxyFailure,
  markProxySuccess,
  probeProxy,
} = require('./proxy-pool');
const {
  loadRegistrationState,
  makeInitialLoginState,
  makeInitialRegistrationState,
  runLoginFlow,
  runRegistrationFlow,
  saveRegistrationState,
} = require('./registration-runner');
const { createSmsProvider } = require('./sms-provider');
const { defaultLockKey, runWorkerPool } = require('./worker-pool');
const { XiaopingguoClient } = require('./xiaopingguo-client');
const { hashId } = require('./util/shared');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function loadOrchestratorConfig(filePath) {
  if (!filePath) return {};
  return readJson(filePath);
}

function orchestratorStatePath(runId, options = {}) {
  const stateDir = options.stateDir || '.gpt-re-state';
  return path.resolve(options.cwd || process.cwd(), stateDir, `orchestrator-${runId}.json`);
}

function cpaOutputPath(runId, config = {}, options = {}) {
  const configured = config.output?.cpaPath || options.cpaPath;
  if (configured) return path.resolve(options.cwd || process.cwd(), configured);
  const stateDir = config.output?.stateDir || options.stateDir || '.gpt-re-state';
  return path.resolve(options.cwd || process.cwd(), stateDir, `cpa-${runId}.json`);
}

function defaultRunId(config = {}) {
  const seed = [
    config.mail?.email || '',
    (config.mail?.accounts || []).map((account) => account.email).join(','),
    config.aliases?.runTag || '',
    Date.now(),
  ].join('|');
  return `run-${hashId(seed)}`;
}

function makeInitialOrchestratorState(config = {}, options = {}) {
  const runId = options.runId || config.runId || defaultRunId(config);
  return {
    mode: 'gpt-re-orchestrator',
    runId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'initialized',
    mailboxes: [],
    jobs: [],
    proxyLeases: {},
    proxyHealth: {},
    workerStats: {
      maxConcurrency: 1,
      lockMode: 'parent_mailbox',
    },
    cpaPath: '',
    events: [],
  };
}

function stateFileForJob(kind, runId, jobId, config = {}, options = {}) {
  const stateDir = config.output?.stateDir || options.stateDir || '.gpt-re-state';
  return path.resolve(options.cwd || process.cwd(), stateDir, `${kind}-${runId}-${jobId}.json`);
}

function asArrayAccounts(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.accounts)) return value.accounts;
  return [];
}

async function claimMailboxes(state, config = {}, options = {}) {
  if (state.mailboxes?.length) return state.mailboxes;
  const mailConfig = config.mail || {};
  const limit = Number(mailConfig.count || 1);
  let accounts = [];

  if (Array.isArray(mailConfig.accounts) && mailConfig.accounts.length) {
    accounts = mailConfig.accounts;
  } else if (mailConfig.email) {
    accounts = [{ id: mailConfig.accountId || 'configured-1', email: mailConfig.email }];
  } else if (mailConfig.baseUrl && mailConfig.password) {
    const client = options.mailClient || new XiaopingguoClient({
      baseUrl: mailConfig.baseUrl,
      origin: mailConfig.origin,
      fetch: options.fetch,
    });
    await client.login(mailConfig.password);
    const listed = asArrayAccounts(await client.listAccounts());
    accounts = listed.filter((account) => account.tokenValid !== false && account.bound !== true);
  }

  state.mailboxes = accounts.slice(0, limit).map((account, index) => ({
    id: account.id || `mailbox-${index + 1}`,
    email: account.email,
    source: account.source || 'config',
    tokenValid: account.tokenValid !== false,
  }));
  if (state.mailboxes.length === 0) {
    throw new Error('Orchestrator requires at least one mailbox from config.mail.accounts, config.mail.email, or xiaopingguo');
  }
  state.events.push({ at: nowIso(), type: 'mailboxes_claimed', count: state.mailboxes.length });
  return state.mailboxes;
}

function ensureJobs(state, config = {}, options = {}) {
  if (state.jobs?.length) return state.jobs;
  const aliasConfig = config.aliases || {};
  const count = Number(aliasConfig.count || 1);
  const runTag = aliasConfig.runTag || state.runId.replace(/^run-/, '').slice(0, 8);
  const jobs = [];

  for (const mailbox of state.mailboxes || []) {
    const aliases = derivePlusAliases(mailbox.email, count, {
      runTag,
      randomInt: options.aliasRandomInt,
    });
    for (const alias of aliases) {
      const jobId = `job-${hashId(`${state.runId}|${mailbox.id}|${alias.email}`)}`;
      jobs.push({
        id: jobId,
        status: 'pending',
        parentAccountId: mailbox.id,
        parentEmail: mailbox.email,
        email: alias.email,
        aliasIndex: alias.index,
        aliasStrategy: alias.strategy,
        registrationStatePath: stateFileForJob('registration', state.runId, jobId, config, options),
        loginStatePath: stateFileForJob('oauth-login', state.runId, jobId, config, options),
        proxy: null,
        smsLease: null,
        worker: null,
        proxyRotations: 0,
        emailWindow: {
          aliasEmail: alias.email,
          parentAccountId: mailbox.id,
          sentAt: '',
          consumedMessageId: '',
        },
        evidence: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }
  state.jobs = jobs;
  state.events.push({ at: nowIso(), type: 'jobs_created', count: jobs.length });
  return state.jobs;
}

function loadOrMakeRegistrationState(har, job, config = {}) {
  try {
    return loadRegistrationState(job.registrationStatePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return makeInitialRegistrationState(har, {
      email: job.email,
      password: job.password || config.registration?.password,
      name: config.registration?.name,
      birthdate: config.registration?.birthdate,
      workspaceId: config.registration?.workspaceId,
    });
  }
}

function loadOrMakeLoginState(har, job, config = {}) {
  try {
    return loadRegistrationState(job.loginStatePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return makeInitialLoginState(har, {
      email: job.email,
      password: job.password,
      workspaceId: job.workspaceId || config.registration?.workspaceId,
    });
  }
}

function lastEvent(state) {
  const events = state.events || [];
  return events[events.length - 1] || null;
}

function eventJson(event) {
  return tryParseJson(event?.textPreview || '') || {};
}

function shouldFallbackToLogin(regState) {
  const event = lastEvent(regState);
  const json = eventJson(event);
  return event?.step === 'workspace_select'
    && event.status === 400
    && json.code === 'login_request_expired'
    && (regState.events || []).some((item) => item.step === 'create_account' && item.status === 200);
}

function runnerOptionsForJob(job, config = {}, options = {}) {
  const registration = config.registration || {};
  return {
    proxy: job.proxy?.url || registration.proxy || '',
    dynamicSentinel: registration.dynamicSentinel !== false,
    cloudflareJsd: Boolean(registration.cloudflareJsd),
    dryRun: Boolean(options.dryRun || registration.dryRun),
    executor: options.executor,
  };
}

function proxyEntriesFromConfig(config = {}, options = {}) {
  const proxyConfig = config.proxyPool || {};
  return options.proxyEntries || (proxyConfig.path ? loadProxyPool(proxyConfig.path, {
    defaultProtocol: proxyConfig.defaultProtocol || 'http',
  }) : []);
}

function proxyHealthOptions(config = {}) {
  const proxyConfig = config.proxyPool || {};
  const health = proxyConfig.healthCheck || {};
  return {
    enabled: Boolean(health.enabled),
    probeUrl: health.probeUrl || proxyConfig.probeUrl || 'https://auth.openai.com/',
    timeoutMs: Number(health.timeoutMs || 15000),
    maxConsecutiveFailures: Number(health.maxConsecutiveFailures || 3),
  };
}

function makeProxyAllocatorForState(state, config = {}, options = {}) {
  const entries = proxyEntriesFromConfig(config, options);
  state.proxyHealth = createProxyHealthState(entries, state.proxyHealth);
  const healthOptions = proxyHealthOptions(config);
  return {
    entries,
    allocator: createProxyAllocator(entries, state.proxyLeases),
    healthOptions,
  };
}

async function checkProxyHealth(proxy, state, config = {}, options = {}) {
  const healthOptions = proxyHealthOptions(config);
  if (!proxy || !healthOptions.enabled || options.dryRun) return true;
  const executor = options.proxyProbeExecutor || (async (request, context) => executePureHttpUrl(request, {
    proxy: context.proxy,
    timeoutMs: context.timeoutMs,
  }));

  try {
    const result = await probeProxy(proxy, {
      probeUrl: healthOptions.probeUrl,
      timeoutMs: healthOptions.timeoutMs,
      executor,
    });
    state.proxyHealth = markProxySuccess(state.proxyHealth, proxy, {
      latencyMs: result.latencyMs,
    });
    return true;
  } catch (error) {
    state.proxyHealth = markProxyFailure(state.proxyHealth, proxy, {
      reason: error.message,
      maxConsecutiveFailures: healthOptions.maxConsecutiveFailures,
    });
    return false;
  }
}

async function acquireProxyForJob(job, state, config = {}, options = {}) {
  const proxyConfig = config.proxyPool || {};
  const { entries, allocator, healthOptions } = makeProxyAllocatorForState(state, config, options);
  if (entries.length === 0) return null;

  const acquireOptions = {
    isUsable: (entry) => isProxyUsable(state.proxyHealth?.[entry.id], healthOptions),
  };
  let proxy = job.proxy
    ? entries.find((entry) => entry.id === job.proxy.id || entry.url === job.proxy.url)
    : allocator.acquire(job.id, acquireOptions);

  const maxRotations = Number(proxyConfig.maxRotations || 2);
  while (proxy) {
    job.proxy = { id: proxy.id, url: proxy.url, source: proxy.source || proxy.raw || '' };
    state.proxyLeases = allocator.snapshot().leases;
    const ok = await checkProxyHealth(proxy, state, config, options);
    if (ok) return proxy;
    job.proxyRotations = Number(job.proxyRotations || 0) + 1;
    job.evidence.push({
      at: nowIso(),
      type: 'proxy_rotated_after_healthcheck',
      proxyId: proxy.id,
      rotations: job.proxyRotations,
    });
    if (job.proxyRotations > maxRotations) break;
    proxy = allocator.rotate(job.id, acquireOptions);
  }

  if (proxyConfig.required) {
    job.status = 'blocked';
    job.blocked = { step: 'proxy_acquire', missing: ['healthy_proxy'] };
  }
  return null;
}

function isProxyLikeError(error) {
  return /proxy|socks|connect|tunnel|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(error?.message || '');
}

function markCurrentProxyFailure(job, state, config = {}, reason = 'proxy_failure') {
  if (!job.proxy) return;
  const entries = proxyEntriesFromConfig(config);
  const proxy = entries.find((entry) => entry.id === job.proxy.id || entry.url === job.proxy.url) || job.proxy;
  const healthOptions = proxyHealthOptions(config);
  state.proxyHealth = markProxyFailure(state.proxyHealth, proxy, {
    reason,
    maxConsecutiveFailures: healthOptions.maxConsecutiveFailures,
  });
  job.evidence.push({ at: nowIso(), type: 'proxy_failure', proxyId: proxy.id, reason });
}

async function readEmailCode(job, config = {}, options = {}) {
  const mailConfig = config.mail || {};
  const configured = mailConfig.codes?.[job.email]
    || mailConfig.codes?.[job.parentEmail]
    || mailConfig.defaultCode;
  if (configured) {
    const code = Array.isArray(configured) ? configured.shift() : configured;
    return { code: String(code), source: 'config' };
  }
  const client = options.mailClient || (mailConfig.baseUrl && mailConfig.password
    ? new XiaopingguoClient({ baseUrl: mailConfig.baseUrl, origin: mailConfig.origin, fetch: options.fetch })
    : null);
  if (!client) return null;
  if (!client.csrfToken && mailConfig.password) await client.login(mailConfig.password);
  const result = await client.pollVerifyCode(job.parentAccountId, {
    recipient: job.email,
    since: job.emailWindow?.sentAt,
    folders: mailConfig.folders || ['inbox', 'junkemail'],
    keyword: mailConfig.keyword || 'openai',
    maxResults: mailConfig.maxResults || 20,
    timeoutMs: mailConfig.timeoutMs || 120000,
    pollIntervalMs: mailConfig.pollIntervalMs || 5000,
  });
  return { ...result, source: 'xiaopingguo' };
}

async function handleRegistrationBlock(job, regState, config = {}, options = {}) {
  const blocked = regState.blocked || {};
  const missing = blocked.missing || [];
  if (missing.includes('emailCode')) {
    const result = await readEmailCode(job, config, options);
    if (!result?.code) return false;
    regState.inputs.emailCode = result.code;
    job.emailOtp = { ...result, code: '<redacted:email_code>' };
    job.evidence.push({ at: nowIso(), type: 'email_code_received', source: result.source });
    return true;
  }

  if (missing.includes('phone')) {
    const provider = options.smsProvider || createSmsProvider(config.sms || {});
    const lease = await provider.acquireNumber({ email: job.email, service: 'openai' });
    job.smsLease = lease;
    regState.inputs.phone = lease.number;
    job.evidence.push({ at: nowIso(), type: 'sms_number_acquired', provider: lease.provider, number: lease.number });
    return true;
  }

  if (missing.includes('phoneCode')) {
    const provider = options.smsProvider || createSmsProvider(config.sms || {});
    const code = await provider.pollCode(job.smsLease, {
      timeoutMs: config.sms?.timeoutMs || 0,
      pollIntervalMs: config.sms?.pollIntervalMs || 1000,
    });
    if (!code?.code) return false;
    regState.inputs.phoneCode = code.code;
    job.smsCode = { ...code, code: '<redacted:phone_code>' };
    job.evidence.push({ at: nowIso(), type: 'sms_code_received', provider: job.smsLease?.provider });
    return true;
  }

  if (missing.includes('workspace_id_from_previous_response') && config.registration?.workspaceId) {
    regState.inputs.workspaceId = config.registration.workspaceId;
    return true;
  }

  return false;
}

function syncJobFromState(job, state, branch) {
  job.password = state.password || job.password;
  job.workspaceId = state.inputs?.workspaceId || job.workspaceId || '';
  job.oauthCode = state.oauthCode || job.oauthCode || '';
  job.oauth = state.oauth || job.oauth;
  job.callbackUrl = state.oauth?.callbackUrl || job.callbackUrl || '';
  job.updatedAt = nowIso();
  const last = lastEvent(state);
  if (last?.step === 'email_otp_send' && !job.emailWindow?.sentAt) {
    job.emailWindow = {
      ...(job.emailWindow || {}),
      aliasEmail: job.email,
      parentAccountId: job.parentAccountId,
      sentAt: nowIso(),
    };
  }
  job.evidence.push({
    at: nowIso(),
    type: `${branch}_state`,
    statePath: branch === 'login' ? job.loginStatePath : job.registrationStatePath,
    next: state.next,
    complete: Boolean(state.complete),
    blocked: state.blocked,
  });
}

async function runRegistrationJob(har, job, config = {}, options = {}) {
  const maxIterations = Number(config.registration?.maxIterations || 24);
  let regState = loadOrMakeRegistrationState(har, job, config);
  for (let index = 0; index < maxIterations; index += 1) {
    await runRegistrationFlow(har, regState, runnerOptionsForJob(job, config, options));
    saveRegistrationState(job.registrationStatePath, regState);
    syncJobFromState(job, regState, 'registration');

    if (regState.complete) {
      job.status = 'callback';
      return regState;
    }
    if (shouldFallbackToLogin(regState)) {
      job.status = 'fallback_login';
      return regState;
    }
    if (!regState.blocked) continue;
    const handled = await handleRegistrationBlock(job, regState, config, options);
    saveRegistrationState(job.registrationStatePath, regState);
    if (!handled) {
      job.status = 'blocked';
      job.blocked = regState.blocked;
      return regState;
    }
  }
  job.status = 'blocked';
  job.blocked = { step: 'registration', missing: ['max_iterations'] };
  return regState;
}

async function runLoginJob(har, job, config = {}, options = {}) {
  const maxIterations = Number(config.registration?.maxIterations || 24);
  let loginState = loadOrMakeLoginState(har, job, config);
  for (let index = 0; index < maxIterations; index += 1) {
    await runLoginFlow(har, loginState, runnerOptionsForJob(job, config, options));
    saveRegistrationState(job.loginStatePath, loginState);
    syncJobFromState(job, loginState, 'login');

    if (loginState.complete) {
      job.status = 'callback';
      return loginState;
    }
    if (loginState.blocked?.missing?.includes('workspace_id_from_previous_response') && config.registration?.workspaceId) {
      loginState.inputs.workspaceId = config.registration.workspaceId;
      saveRegistrationState(job.loginStatePath, loginState);
      continue;
    }
    if (loginState.blocked) {
      job.status = 'blocked';
      job.blocked = loginState.blocked;
      return loginState;
    }
  }
  job.status = 'blocked';
  job.blocked = { step: 'login', missing: ['max_iterations'] };
  return loginState;
}

async function maybeExchangeToken(job, config = {}, options = {}) {
  const enabled = Boolean(options.exchangeToken || config.registration?.exchangeToken);
  if (!enabled || !job.oauthCode || !job.oauth?.codeVerifier) return null;
  const result = await exchangeTokens({
    code: job.oauthCode,
    oauth: job.oauth,
  }, {
    executor: options.tokenExecutor || ((request) => executePureHttpUrl(request, {
      proxy: job.proxy?.url || config.registration?.proxy || '',
      timeoutMs: config.registration?.tokenTimeoutMs || 60000,
    })),
  });
  job.tokens = result.tokens;
  job.tokenRequest = result.request;
  job.tokenResponse = {
    status: result.response.status,
    contentType: result.response.contentType,
  };
  job.status = 'complete';
  job.completedAt = nowIso();
  return result;
}

async function runJob(har, job, config = {}, options = {}) {
  job.status = job.status === 'pending' ? 'registration' : job.status;
  const regState = await runRegistrationJob(har, job, config, options);
  if (job.status === 'fallback_login') {
    await runLoginJob(har, job, config, options);
  } else if (regState.complete) {
    job.status = 'callback';
  }

  if (job.status === 'callback') {
    await maybeExchangeToken(job, config, options);
    if (job.status === 'callback') {
      job.status = config.registration?.exchangeToken || options.exchangeToken ? 'blocked' : 'callback';
      if (job.status === 'blocked') job.blocked = { step: 'oauth_token_exchange', missing: ['tokens'] };
    }
  }
  job.updatedAt = nowIso();
  return job;
}

function assignProxies(state, config = {}, options = {}) {
  const { entries, allocator, healthOptions } = makeProxyAllocatorForState(state, config, options);
  for (const job of state.jobs || []) {
    if (job.proxy || entries.length === 0) continue;
    const proxy = allocator.acquire(job.id, {
      isUsable: (entry) => isProxyUsable(state.proxyHealth?.[entry.id], healthOptions),
    });
    if (proxy) job.proxy = { id: proxy.id, url: proxy.url, source: proxy.source || proxy.raw || '' };
  }
  state.proxyLeases = allocator.snapshot().leases;
}

async function runJobWithProxyPolicy(har, state, job, config = {}, options = {}) {
  const proxyConfig = config.proxyPool || {};
  const maxRotations = Number(proxyConfig.maxRotations || 2);
  for (;;) {
    await acquireProxyForJob(job, state, config, options);
    if (job.status === 'blocked' && job.blocked?.step === 'proxy_acquire') return job;
    try {
      return await runJob(har, job, config, { ...options, orchestratorState: state });
    } catch (error) {
      if (!isProxyLikeError(error) || Number(job.proxyRotations || 0) >= maxRotations) {
        job.status = 'blocked';
        job.blocked = { step: 'job_error', missing: [error.message] };
        job.evidence.push({ at: nowIso(), type: 'job_error', message: error.message });
        return job;
      }
      markCurrentProxyFailure(job, state, config, error.message);
      job.proxy = null;
      job.proxyRotations = Number(job.proxyRotations || 0) + 1;
      state.proxyLeases = { ...(state.proxyLeases || {}) };
      delete state.proxyLeases[job.id];
    }
  }
}

function jobsForCpa(state) {
  return (state.jobs || []).filter((job) => job.tokens || job.oauthCode).map((job) => ({
    jobId: job.id,
    status: job.status,
    workspaceId: job.workspaceId,
    email: job.email,
    name: job.name || 'codex',
    tokens: job.tokens || {},
    tokenResponse: job.tokens || {},
    callbackUrl: job.callbackUrl,
    statePath: job.registrationStatePath,
    evidence: job.evidence,
    completedAt: job.completedAt || job.updatedAt,
  }));
}

async function runOrchestrator(har, state, config = {}, options = {}) {
  state.status = 'running';
  await claimMailboxes(state, config, options);
  ensureJobs(state, config, options);
  assignProxies(state, config, options);
  const workerConfig = config.workers || {};
  state.workerStats = {
    maxConcurrency: Number(workerConfig.maxConcurrency || config.registration?.maxConcurrency || 1),
    lockMode: workerConfig.lockMode || 'parent_mailbox',
    startedAt: nowIso(),
  };

  const pool = await runWorkerPool(state.jobs, (job) => runJobWithProxyPolicy(har, state, job, config, options), {
    maxConcurrency: state.workerStats.maxConcurrency,
    lockKeyForJob: (job) => workerConfig.lockMode === 'none' ? job.id : defaultLockKey(job),
    onJobDone: async () => {
      state.updatedAt = nowIso();
      if (options.saveState) options.saveState(state);
    },
    onJobError: async (job, error) => {
      job.status = 'blocked';
      job.blocked = { step: 'worker', missing: [error.message] };
      state.updatedAt = nowIso();
      if (options.saveState) options.saveState(state);
    },
  });
  state.workerStats.finishedAt = nowIso();
  state.workerStats.completed = pool.results.length;
  state.workerStats.errors = pool.errors.length;

  const cpaPath = cpaOutputPath(state.runId, config, options);
  const artifact = buildLegacyCpaArtifact({
    runId: state.runId,
    jobs: jobsForCpa(state),
  });
  writeJson(cpaPath, artifact);
  state.cpaPath = cpaPath;
  state.updatedAt = nowIso();
  state.status = state.jobs.every((job) => job.status === 'complete' || job.status === 'callback') ? 'complete' : 'blocked';
  state.events.push({ at: nowIso(), type: 'cpa_written', path: cpaPath });
  return state;
}

function summarizeOrchestratorState(state, options = {}) {
  const redact = options.redact !== false;
  const summarizeBlocked = (blocked) => {
    if (!blocked) return null;
    return {
      step: blocked.step,
      missing: blocked.missing,
      pureUrl: redact ? undefined : blocked.pureUrl,
    };
  };
  return {
    mode: state.mode,
    runId: state.runId,
    status: state.status,
    cpaPath: state.cpaPath,
    workerStats: state.workerStats || {},
    proxyHealth: Object.fromEntries(Object.entries(state.proxyHealth || {}).map(([id, record]) => [
      id,
      {
        status: record.status,
        successCount: record.successCount,
        failureCount: record.failureCount,
        consecutiveFailures: record.consecutiveFailures,
        cooldownUntil: record.cooldownUntil,
        latencyMs: record.latencyMs,
        reason: redact ? (record.reason ? '<redacted:proxy_reason>' : '') : record.reason,
      },
    ])),
    mailboxes: (state.mailboxes || []).map((mailbox) => ({
      id: mailbox.id,
      email: redact ? '<redacted:email>' : mailbox.email,
      tokenValid: mailbox.tokenValid,
    })),
    jobs: (state.jobs || []).map((job) => ({
      id: job.id,
      status: job.status,
      email: redact ? '<redacted:email>' : job.email,
      parentAccountId: job.parentAccountId,
      proxy: job.proxy ? { id: job.proxy.id, url: redact ? '<redacted:proxy>' : job.proxy.url } : null,
      workspaceId: job.workspaceId ? (redact ? '<redacted:workspace_id>' : job.workspaceId) : '',
      oauthCode: job.oauthCode ? (redact ? '<redacted:oauth_code>' : job.oauthCode) : '',
      blocked: summarizeBlocked(job.blocked),
    })),
    cpa: state.cpaPath && fs.existsSync(state.cpaPath)
      ? summarizeCpaArtifact(readJson(state.cpaPath), { raw: options.redact === false })
      : null,
  };
}

module.exports = {
  jobsForCpa,
  loadOrchestratorConfig,
  makeInitialOrchestratorState,
  orchestratorStatePath,
  readJson,
  runOrchestrator,
  summarizeOrchestratorState,
  writeJson,
};
