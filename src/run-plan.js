'use strict';

const {
  defaultMailMaxPollAttempts,
  MAX_MAIL_COUNT,
  MAX_WORKER_CONCURRENCY,
} = require('./config-v2');
const {
  providerAliasSettings,
  providerAliasSettingsPatch,
} = require('./mail-provider-settings');

// One rental, one account. Deriving a `+alias` from a rented address was
// dropped: the mailbox is paid for per issue, the alias doubled the codes it had
// to receive, and exhausting its code quota was a real failure mode.
const MAX_RENTAL_ALIASES = 1;
// The pooled channel registers the root address and, when the switch is on, one
// `+alias` of it. Two accounts per mailbox, one attempt each — a mailbox that
// has to receive for more than that becomes the bottleneck, and a failed alias
// is not worth a second address.
const ALIAS_ACCOUNTS_PER_MAILBOX = 2;
const RUN_PLAN_SCHEMA_VERSION = 3;
// Launch, top-up, resume and cancellation must accept the same task budget.
const MAX_RENTAL_WATCH_TARGET = MAX_MAIL_COUNT;
// Pasted lists — asset ids, credential rows — are a page of input rather
// than a rental budget, and stay where they were.
const MAX_SOURCE_ITEMS = 100;
const MAX_RENTAL_WATCH_BATCH_SIZE = 20;
const DEFAULT_RENTAL_WATCH_POLL_INTERVAL_MS = 20_000;
const MIN_RENTAL_WATCH_POLL_INTERVAL_MS = 1_000;
const TASK_KINDS = Object.freeze([
  'register_oauth',
  'register_session',
  'oauth',
  'session_refresh',
]);
// Task kinds that draw from login states that already exist. They register
// nothing, so they never open a mailbox and none of the mail-channel rules
// apply to them.
const SOURCE_TASK_KINDS = new Set(['oauth', 'session_refresh']);

function integer(value, fallback, name, maximum) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

function uniqueStrings(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => String(item || '').trim()).filter(Boolean);
  if (!items.length) throw new Error(`${name} must contain at least one item`);
  if (items.length > MAX_SOURCE_ITEMS) throw new Error(`${name} must contain at most ${MAX_SOURCE_ITEMS} items`);
  if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return items;
}

function normalizeCredentialInputs(value) {
  if (!Array.isArray(value)) throw new Error('plan.oauthSource.accounts must be an array');
  const seen = new Set();
  const items = value.map((item) => {
    const record = item && typeof item === 'object' ? item : {};
    const email = String(record.email || '').trim();
    const password = String(record.password || '');
    const totpSecret = String(record.totpSecret || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Invalid OAuth credential email: ${email || '<empty>'}`);
    }
    if (!password) throw new Error(`OAuth credential is missing a password: ${email}`);
    // The whole point of this source is that the account is already secured,
    // so a missing TOTP secret is a broken input rather than an optional field.
    if (!/^[A-Z2-7]{16,}$/.test(totpSecret)) {
      throw new Error(`OAuth credential has an invalid TOTP secret: ${email}`);
    }
    const key = email.toLowerCase();
    if (seen.has(key)) throw new Error('plan.oauthSource.accounts must not contain duplicates');
    seen.add(key);
    return { email, password, totpSecret };
  });
  if (!items.length || items.length > MAX_SOURCE_ITEMS) {
    throw new Error(`plan.oauthSource.accounts must contain between 1 and ${MAX_SOURCE_ITEMS} items`);
  }
  return items;
}

function normalizeOAuthSource(input, taskKind) {
  if (!['oauth', 'session_refresh'].includes(taskKind)) return null;
  const source = input.oauthSource || {};
  const kind = taskKind === 'session_refresh'
    ? 'session_assets'
    : String(source.kind || '').trim();
  if (!['session_assets', 'credentials'].includes(kind)) {
    throw new Error('plan.oauthSource.kind must be "session_assets" or "credentials"');
  }
  // `loginOnly`: sign in and save the login state, then stop — no OAuth, no
  // CPA. Only meaningful on an `oauth` task; a refresh never runs OAuth.
  const loginOnly = taskKind === 'oauth' && source.loginOnly === true
    ? { loginOnly: true }
    : {};
  if (kind === 'session_assets') {
    return {
      kind,
      assetIds: uniqueStrings(source.assetIds, 'plan.oauthSource.assetIds'),
      sourceRunId: String(source.sourceRunId || ''),
      ...loginOnly,
    };
  }
  return {
    kind,
    accounts: normalizeCredentialInputs(source.accounts),
    sourceRunId: String(source.sourceRunId || ''),
    ...loginOnly,
  };
}

function requiresSmsPreflight(plan = {}) {
  return plan.taskKind === 'register_oauth'
    || (plan.taskKind === 'register_session' && plan.postRegistrationOAuth === true);
}

function normalizeSecurity(input, taskKind) {
  const enabledByDefault = ['register_oauth', 'register_session'].includes(taskKind);
  return {
    setPassword: input?.setPassword === undefined
      ? enabledByDefault
      : input.setPassword === true,
    enrollTotp: input?.enrollTotp === undefined
      ? enabledByDefault
      : input.enrollTotp === true,
  };
}

function normalizeRunPlan(input = {}, defaults = {}) {
  const taskKind = String(input.taskKind || 'register_session').trim();
  if (!TASK_KINDS.includes(taskKind)) throw new Error(`Unsupported plan.taskKind: ${taskKind}`);
  const oauthSource = normalizeOAuthSource(input, taskKind);
  const sourceCount = oauthSource?.kind === 'session_assets'
    ? oauthSource.assetIds.length
    : oauthSource?.kind === 'credentials'
      ? oauthSource.accounts.length
      : 0;
  const aliases = defaults.aliases || {};
  const sourceTask = SOURCE_TASK_KINDS.has(taskKind);
  const mailProvider = String(input.mailProvider || defaults.mail?.provider || 'xiaopingguo').toLowerCase();
  const mailRentalWatch = input.mailRentalWatch === true;
  if (mailRentalWatch && (!['register_oauth', 'register_session'].includes(taskKind) || mailProvider !== 'smsbower')) {
    throw new Error('mailRentalWatch is only available for SMSBower registration tasks');
  }
  const mailRentalTarget = mailRentalWatch
    ? integer(input.mailRentalTarget, MAX_RENTAL_WATCH_TARGET, 'plan.mailRentalTarget', MAX_RENTAL_WATCH_TARGET)
    : 0;
  const mailRentalBatchSize = mailRentalWatch
    ? integer(input.mailRentalBatchSize, MAX_RENTAL_WATCH_BATCH_SIZE, 'plan.mailRentalBatchSize', MAX_RENTAL_WATCH_BATCH_SIZE)
    : 0;
  const mailRentalPollIntervalMs = mailRentalWatch
    ? Number(input.mailRentalPollIntervalMs ?? DEFAULT_RENTAL_WATCH_POLL_INTERVAL_MS)
    : 0;
  if (mailRentalWatch && (!Number.isInteger(mailRentalPollIntervalMs)
    || mailRentalPollIntervalMs < MIN_RENTAL_WATCH_POLL_INTERVAL_MS
    || mailRentalPollIntervalMs > 3_600_000)) {
    throw new Error(`plan.mailRentalPollIntervalMs must be an integer between ${MIN_RENTAL_WATCH_POLL_INTERVAL_MS} and 3600000`);
  }
  const requestedStrategy = sourceTask ? 'root' : String(input.aliasStrategy || aliases.strategy || 'plus').toLowerCase();
  if (!['plus', 'root', 'root_plus'].includes(requestedStrategy)) throw new Error('plan.aliasStrategy must be "plus", "root" or "root_plus"');
  // One boolean replaced the strategy/count/attempts trio: the only choice left
  // is whether a pooled mailbox also registers one `+alias` of itself. A stored
  // plan that predates the switch is read through its old strategy so it keeps
  // starting instead of erroring.
  // Only an explicit `plan.aliasStrategy` counts as a legacy request. Reading
  // the stored `aliases.strategy` here is what made the switch default to ON:
  // a saved `plus` silently doubled the account count of every new task.
  const legacyAliasStrategy = ['plus', 'root_plus'].includes(String(input.aliasStrategy || '').toLowerCase());
  // iCloud is a pooled inbox like Xiaopingguo: the console derives the
  // `root+tag@` address itself and the 8001 service matches it by recipient.
  const aliasEnabled = mailProvider === 'smsbower'
    || mailProvider === 'mailcom'
    || mailProvider === 'fastmail'
    || sourceTask
    // A rental's code quota cannot serve two accounts, and a source task
    // registers nothing at all.
    ? false
    : (input.aliasEnabled === undefined
      // iCloud registers its root and one `+alias` unless told otherwise.
      ? (legacyAliasStrategy || mailProvider === 'icloud')
      : input.aliasEnabled === true);
  const strategy = aliasEnabled ? 'root_plus' : 'root';

  const mailCount = sourceTask
    ? sourceCount
    : mailRentalWatch
      ? mailRentalTarget
      : integer(input.mailCount, defaults.mail?.count || 1, 'plan.mailCount', MAX_MAIL_COUNT);
  const workerFallback = Math.min(Number(defaults.workers?.maxConcurrency || 1), mailCount);
  const workerConcurrency = integer(
    input.workerConcurrency,
    workerFallback,
    'plan.workerConcurrency',
    MAX_WORKER_CONCURRENCY,
  );
  if (workerConcurrency > mailCount) throw new Error('plan.workerConcurrency must not exceed plan.mailCount');

  // Fixed by the switch rather than typed in: one account without it, two with
  // it, and no second attempt at the alias either way. `aliasMaxAttempts` used
  // to allow replacement addresses beyond the target count; a mailbox that has
  // to receive for more accounts than that is the bottleneck, so the ceiling is
  // now the target itself.
  const aliasCount = aliasEnabled ? ALIAS_ACCOUNTS_PER_MAILBOX : 1;
  const aliasMaxAttempts = aliasCount;

  const aliasRunTag = String(input.aliasRunTag || aliases.runTag || 'gptre').trim();
  if (!aliasRunTag) throw new Error('plan.aliasRunTag is required');

  const security = normalizeSecurity(input.security, taskKind);

  const hasProxyAssignments = Array.isArray(input.proxyAssignments) && input.proxyAssignments.length > 0;
  const inferredSchema = hasProxyAssignments ? 2 : (sourceTask ? RUN_PLAN_SCHEMA_VERSION : 1);
  const inputSchema = Number(input.schemaVersion || inferredSchema);
  if (![1, 2, RUN_PLAN_SCHEMA_VERSION].includes(inputSchema)) {
    throw new Error(`Unsupported plan.schemaVersion: ${input.schemaVersion}`);
  }
  // Existing-account work always uses the stable local forwarder. Keep the
  // default in the plan itself so API callers and resumed legacy plans cannot
  // start a Worker with an empty proxy snapshot.
  const defaultProxyAssignments = sourceTask && !hasProxyAssignments
    ? Array.from({ length: workerConcurrency }, (_unused, index) => ({ workerSlot: index + 1, kind: 'maintenance' }))
    : [];
  const requestedSchema = sourceTask ? Math.max(inputSchema, RUN_PLAN_SCHEMA_VERSION) : inputSchema;
  const proxyAssignments = (hasProxyAssignments ? input.proxyAssignments : defaultProxyAssignments)
    .map((assignment, index) => {
      const workerSlot = Number(assignment?.workerSlot ?? index + 1);
      if (!Number.isInteger(workerSlot) || workerSlot < 1 || workerSlot > workerConcurrency) {
        throw new Error(`plan.proxyAssignments[${index}].workerSlot must be between 1 and ${workerConcurrency}`);
      }
      const kind = String(assignment?.kind || '').trim();
      if (kind === 'local') {
        const localProxyId = String(assignment.localProxyId || '').trim();
        if (!localProxyId) throw new Error(`plan.proxyAssignments[${index}].localProxyId is required`);
        return { workerSlot, kind, localProxyId };
      }
      if (kind === 'countryPool') {
        const countryCode = String(assignment.countryCode || '').trim().toUpperCase();
        if (countryCode !== 'GLOBAL' && !/^[A-Z]{2}$/.test(countryCode)) {
          throw new Error(`plan.proxyAssignments[${index}].countryCode must be GLOBAL or a two-letter ISO code`);
        }
        return { workerSlot, kind, countryCode };
      }
      // Upkeep on an existing account goes out through the configured local
      // forwarder. Every Worker shares it on purpose — it is one process on the
      // host, not a pool endpoint that has to be reserved.
      if (kind === 'maintenance') return { workerSlot, kind };
      throw new Error(`plan.proxyAssignments[${index}].kind must be "local", "countryPool" or "maintenance"`);
    });
  if (requestedSchema >= 2) {
    if (proxyAssignments.length !== workerConcurrency) {
      throw new Error('plan.proxyAssignments must contain exactly one assignment per Worker');
    }
    const slots = new Set(proxyAssignments.map((assignment) => assignment.workerSlot));
    if (slots.size !== workerConcurrency) throw new Error('plan.proxyAssignments must use every Worker slot exactly once');
    const localIds = proxyAssignments.filter((assignment) => assignment.kind === 'local').map((assignment) => assignment.localProxyId);
    if (new Set(localIds).size !== localIds.length) throw new Error('A local proxy endpoint cannot be assigned to multiple Workers');
  }

  const plan = {
    schemaVersion: requestedSchema,
    taskKind,
    mailCount,
    workerConcurrency,
    aliasStrategy: strategy,
    aliasEnabled,
    aliasCount,
    aliasMaxAttempts,
    aliasRunTag,
    proxyAssignments: proxyAssignments.sort((left, right) => left.workerSlot - right.workerSlot),
    totalAccounts: sourceTask ? sourceCount : mailCount * aliasCount,
    oauthSource,
    postRegistrationOAuth: taskKind === 'register_oauth'
      || (taskKind === 'register_session' && input.postRegistrationOAuth === true),
    security,
    mailProvider,
    mailRentalWatch,
    ...(mailRentalWatch ? {
      mailRentalTarget,
      mailRentalBatchSize,
      mailRentalPollIntervalMs,
    } : {}),
  };
  assertRentalMailPlanIsSafe(plan);
  assertOAuthSecurityPlanIsSafe(plan);
  return plan;
}

/**
 * A rented mailbox closes when the run does, so an account built through one
 * has to leave the run able to log in without it. That means password and TOTP
 * must be enrolled; OAuth is optional, and exactly the one address the
 * provider issued is allowed.
 *
 * Enforced here rather than at the provider so a task is refused before it
 * spends anything.
 */
function assertRentalMailPlanIsSafe(plan) {
  // A task that runs against login states which already exist opens no mailbox,
  // so there is no rental to recycle and nothing here can apply. It used to run
  // regardless, and since `mailProvider` is read from the config file whether
  // or not the task will ever use mail, selecting a rental channel made every
  // login-state OAuth and every session refresh fail preflight — asked to
  // enable a password and TOTP it was never going to set, for a mailbox it was
  // never going to open.
  if (SOURCE_TASK_KINDS.has(plan.taskKind)) return;
  if (plan.mailProvider === 'mailcom' || plan.mailProvider === 'fastmail' || plan.mailProvider === 'icloud') {
    const providerLabel = plan.mailProvider === 'mailcom'
      ? 'mail.com'
      : (plan.mailProvider === 'fastmail' ? 'Fastmail' : 'iCloud');
    if (!plan.security.setPassword || !plan.security.enrollTotp) {
      throw new Error(`The ${providerLabel} API channel requires both security.setPassword and security.enrollTotp before a mailbox cycle can be recycled`);
    }
    if (plan.aliasCount > 1 && plan.mailProvider !== 'icloud') {
      throw new Error(`The ${providerLabel} API channel provides remote aliases; local alias generation must remain disabled`);
    }
    return;
  }
  if (plan.mailProvider !== 'smsbower') return;
  if (!plan.security.setPassword || !plan.security.enrollTotp) {
    throw new Error('The SMSBower mail channel requires both security.setPassword and security.enrollTotp: without them the account can never log in again once the mailbox is gone');
  }
  if (plan.aliasCount > MAX_RENTAL_ALIASES) {
    throw new Error('The SMSBower mail channel registers only the address it issued: one account per rented mailbox');
  }
}

/**
 * A run that goes on to OAuth has to leave every account able to log in alone.
 *
 * The OAuth leg turns a login state into a product someone else signs into,
 * and the only credentials that outlive the run are the password and the TOTP
 * secret: the mailbox closes with the run and the session cookies expire. A
 * CPA minted from an account that got neither is a product nobody can use, and
 * the phone numbers the OAuth leg spends to mint it are spent for nothing.
 *
 * The rental mail channels already refuse this, but for their own reason — the
 * mailbox is recycled — so a register-then-OAuth run on an ordinary channel
 * had no such rule. It would start, and then hold its accounts back one at a
 * time at the registration boundary, which is the right outcome discovered in
 * the most expensive possible way. Refused here instead, before the run opens
 * a single mailbox.
 *
 * Registration on its own is untouched: an account with no TOTP is a thin
 * asset, not a broken one, and 登录态资产 can finish it later.
 */
function assertOAuthSecurityPlanIsSafe(plan) {
  if (plan.postRegistrationOAuth !== true) return;
  if (plan.security.setPassword && plan.security.enrollTotp) return;
  throw new Error('A task that continues into OAuth requires both security.setPassword and security.enrollTotp: a CPA minted from an account with neither can never be signed into once the mailbox and the session are gone');
}

function providerBaseUrl(mail = {}, provider = '') {
  const normalizedProvider = String(provider || '').toLowerCase();
  const field = normalizedProvider === 'mailcom'
    ? 'mailcomBaseUrl'
    : (normalizedProvider === 'fastmail'
      ? 'fastmailBaseUrl'
      : (normalizedProvider === 'icloud' ? 'icloudBaseUrl' : 'xiaopingguoBaseUrl'));
  return String(mail[field] || mail.baseUrl || '').replace(/\/+$/, '');
}

function applyRunPlan(config, input = {}) {
  const plan = normalizeRunPlan(input, config);
  const remoteProvider = plan.mailProvider === 'mailcom' || plan.mailProvider === 'fastmail';
  const activeAliasSettings = remoteProvider
    ? providerAliasSettings(config.mail, plan.mailProvider)
    : plan.mailProvider === 'icloud'
      ? { aliasDomainMode: 'random', aliasDomains: [] }
      : {
        aliasDomainMode: config.mail.aliasDomainMode || 'random',
        aliasDomains: Array.isArray(config.mail.aliasDomains) ? config.mail.aliasDomains : [],
      };
  const mailAliasDomains = plan.mailProvider === 'icloud'
    ? []
    : Array.isArray(input.mailAliasDomains)
    ? [...new Set(input.mailAliasDomains
      .map((value) => String(value || '').trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean))]
    : activeAliasSettings.aliasDomains;
  const providerSettings = remoteProvider
    ? providerAliasSettingsPatch(config.mail, plan.mailProvider, {
      aliasDomains: mailAliasDomains,
    })
    : config.mail.providerSettings;
  const selectedAliasSettings = remoteProvider
    ? { ...activeAliasSettings, aliasDomains: mailAliasDomains }
    : activeAliasSettings;
  return {
    ...config,
    // A run may persist the live-filtered selected-domain whitelist so a
    // restart/resume does not restore a domain that preflight already removed.
    mail: {
      ...config.mail,
      count: plan.mailCount,
      provider: plan.mailProvider,
      // A resumed task keeps the provider recorded in its plan even when the
      // global dialog has since switched providers. Keep the compatibility
      // `baseUrl` in step with that snapshot too; otherwise separate endpoints
      // would send an old Mail.com task to the current Fastmail endpoint.
      baseUrl: providerBaseUrl(config.mail, plan.mailProvider),
      maxPollAttempts: plan.mailProvider === 'smsbower'
        ? Math.max(defaultMailMaxPollAttempts('smsbower'), config.mail.maxPollAttempts || 0)
        : plan.mailProvider !== config.mail.provider
        ? defaultMailMaxPollAttempts(plan.mailProvider)
        : config.mail.maxPollAttempts,
      aliasBatchSize: remoteProvider ? selectedAliasSettings.aliasBatchSize : config.mail.aliasBatchSize,
      aliasDomainMode: selectedAliasSettings.aliasDomainMode,
      aliasDomains: mailAliasDomains,
      ...(providerSettings ? { providerSettings } : {}),
    },
    aliases: {
      ...config.aliases,
      strategy: plan.aliasStrategy,
      count: plan.aliasCount,
      maxAttempts: plan.aliasMaxAttempts,
      runTag: plan.aliasRunTag,
      plusAddressingEnabled: plan.aliasStrategy !== 'root',
    },
    workers: {
      ...config.workers,
      maxConcurrency: plan.workerConcurrency,
      proxyAssignments: plan.proxyAssignments,
    },
    proxyPool: {
      ...config.proxyPool,
      required: plan.schemaVersion >= 2 ? true : config.proxyPool?.required,
    },
  };
}

module.exports = {
  MIN_RENTAL_WATCH_POLL_INTERVAL_MS,
  MAX_RENTAL_WATCH_TARGET,
  applyRunPlan,
  providerBaseUrl,
  normalizeRunPlan,
  requiresSmsPreflight,
};
