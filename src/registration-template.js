'use strict';

const { HttpError } = require('./ui-server/utils');

const MAX_ROOT_EMAILS = 100;
const MAX_WORKERS = 20;
const MAX_ITERATIONS = 100;
const MAIL_INTERFACES = Object.freeze(['xiaopingguo', 'smsbower', 'mailcom', 'fastmail', 'icloud']);
const PROXY_MODES = Object.freeze(['countryPool', 'local']);
const PROXY_DISTRIBUTIONS = Object.freeze(['single', 'capacity']);
/** The one interface that rents mailboxes, and so the only one 挂租 applies to. */
const RENTAL_MAIL_INTERFACE = 'smsbower';
const MAX_RENTAL_TARGET = 10_000;
const MAX_RENTAL_BATCH_SIZE = 20;
const MIN_RENTAL_POLL_INTERVAL_MS = 1_000;
const MAX_RENTAL_POLL_INTERVAL_MS = 3_600_000;
/** Enough for a few named setups without turning the robot into a job queue. */
const MAX_TEMPLATES = 12;
/** Clock times one template may fire at per day. */
const MAX_SCHEDULE_TIMES = 12;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TEMPLATE_SCHEDULE = Object.freeze({
  enabled: false,
  times: Object.freeze([]),
  weekdays: Object.freeze([]),
});

const DEFAULT_REGISTRATION_TEMPLATE = Object.freeze({
  templateId: 'mail-v1',
  name: '默认模板',
  mailInterface: 'mailcom',
  rootEmailCount: 20,
  workerCount: 20,
  proxyMode: 'countryPool',
  proxyDistribution: 'capacity',
  countryCode: 'GB',
  refreshBeforeEachIteration: true,
  iterations: 1,
  onIterationFailure: 'stop',
  postRegistrationOAuth: false,
  mailRentalWatch: false,
  mailRentalTarget: 200,
  mailRentalBatchSize: 20,
  mailRentalPollIntervalMs: 20_000,
  schedule: DEFAULT_TEMPLATE_SCHEDULE,
});

const REGISTRATION_TEMPLATE_FIELDS = Object.freeze([
  { key: 'proxyDistribution', label: 'Proxy distribution', type: 'select', options: [...PROXY_DISTRIBUTIONS] },
  { key: 'mailInterface', label: '邮箱接口', type: 'select', options: [...MAIL_INTERFACES] },
  { key: 'rootEmailCount', label: '根邮箱数', type: 'number', min: 1, max: MAX_ROOT_EMAILS, step: 1 },
  { key: 'workerCount', label: 'Worker 数', type: 'number', min: 1, max: MAX_WORKERS, step: 1 },
  { key: 'proxyMode', label: '代理模式', type: 'select', options: [...PROXY_MODES] },
  { key: 'countryCode', label: '代理国家池', type: 'country' },
  { key: 'localProxyId', label: '本地代理 ID', type: 'text' },
  { key: 'iterations', label: '执行次数', type: 'number', min: 1, max: MAX_ITERATIONS, step: 1 },
  { key: 'postRegistrationOAuth', label: '注册后 OAuth', type: 'boolean' },
]);

function integer(value, fallback, key, maximum, strict) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum) return parsed;
  if (strict) throw new HttpError(400, `Robot config ${key} must be an integer between 1 and ${maximum}`);
  return fallback;
}

function migrateRegistrationTemplate(value = {}, fallbackMailInterface = DEFAULT_REGISTRATION_TEMPLATE.mailInterface) {
  const input = value && typeof value === 'object' ? value : {};
  const legacyInterface = String(input.mailInterface ?? input.mailProvider ?? '').trim().toLowerCase();
  if (legacyInterface !== 'current') return input;
  const fallback = MAIL_INTERFACES.includes(String(fallbackMailInterface).trim().toLowerCase())
    ? String(fallbackMailInterface).trim().toLowerCase()
    : DEFAULT_REGISTRATION_TEMPLATE.mailInterface;
  return { ...input, mailInterface: fallback };
}

/**
 * When a template starts on its own.
 *
 * Clock times rather than an interval: an operator schedules registration
 * around when numbers and proxies are cheap, which is a time of day, not a
 * period since the robot last happened to run. `weekdays` empty means every
 * day; otherwise it is the ISO-ish set 0..6 with 0 for Sunday, matching
 * `Date#getDay`.
 */
function normalizeTemplateSchedule(value = {}, options = {}) {
  const strict = options.strict === true;
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const times = [...new Set((Array.isArray(input.times) ? input.times : [])
    .map((time) => String(time || '').trim())
    .filter((time) => {
      if (TIME_OF_DAY.test(time)) return true;
      if (strict) throw new HttpError(400, `Schedule time must be HH:MM, received ${time || '(empty)'}`);
      return false;
    }))].sort().slice(0, MAX_SCHEDULE_TIMES);
  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : [])
    .map((day) => Number(day))
    .filter((day) => {
      if (Number.isInteger(day) && day >= 0 && day <= 6) return true;
      if (strict) throw new HttpError(400, 'Schedule weekdays must be integers between 0 (Sunday) and 6');
      return false;
    }))].sort((left, right) => left - right);
  // A schedule with no time to fire at is not a schedule. Saying so here keeps
  // every consumer from having to re-check it.
  const enabled = input.enabled === true && times.length > 0;
  return { enabled, times, weekdays };
}

/**
 * The next moment this schedule fires after `afterMs`, or null.
 *
 * Local time, because the times an operator types are the ones on their own
 * clock — the console binds to loopback and runs on that machine. The search
 * is bounded at eight days, which covers any weekday set.
 */
function nextScheduleFireAt(schedule, afterMs) {
  if (!schedule?.enabled || !schedule.times?.length) return null;
  const from = Number(afterMs);
  if (!Number.isFinite(from)) return null;
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(from + offset * DAY_MS);
    day.setHours(0, 0, 0, 0);
    if (weekdays.length && !weekdays.includes(day.getDay())) continue;
    for (const time of schedule.times) {
      const [hours, minutes] = time.split(':').map(Number);
      const at = new Date(day);
      at.setHours(hours, minutes, 0, 0);
      if (at.getTime() > from) return at.getTime();
    }
  }
  return null;
}

/**
 * Apply the legacy `mailInterface: 'current'` migration across a whole robot
 * config, whichever shape it is in.
 *
 * The flat single-template config and the container both reach this; the
 * container's templates each carry their own interface.
 */
function migrateRegistrationRobotConfig(value = {}, fallbackMailInterface = DEFAULT_REGISTRATION_TEMPLATE.mailInterface) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!Array.isArray(input.templates)) return migrateRegistrationTemplate(input, fallbackMailInterface);
  return {
    ...input,
    templates: input.templates.map((template) => migrateRegistrationTemplate(template, fallbackMailInterface)),
  };
}

function normalizeRegistrationTemplate(value = {}, options = {}) {
  const strict = options.strict === true;
  const input = value && typeof value === 'object' ? value : {};
  const legacyBatchSize = input.batchSize;
  const legacyWorkerCount = input.workerConcurrency;
  const legacyCountryCode = input.countryCode;
  const proxy = input.proxy && typeof input.proxy === 'object' ? input.proxy : {};

  const rootEmailCount = integer(
    input.rootEmailCount === undefined ? legacyBatchSize : input.rootEmailCount,
    DEFAULT_REGISTRATION_TEMPLATE.rootEmailCount,
    'rootEmailCount',
    MAX_ROOT_EMAILS,
    strict,
  );
  const workerCount = integer(
    input.workerCount === undefined ? legacyWorkerCount : input.workerCount,
    DEFAULT_REGISTRATION_TEMPLATE.workerCount,
    'workerCount',
    MAX_WORKERS,
    strict,
  );

  const rawInterface = String(input.mailInterface ?? input.mailProvider ?? DEFAULT_REGISTRATION_TEMPLATE.mailInterface)
    .trim()
    .toLowerCase();
  if (!MAIL_INTERFACES.includes(rawInterface)) {
    if (strict) throw new HttpError(400, `Robot config mailInterface must be one of ${MAIL_INTERFACES.join(', ')}`);
  }

  const rawMode = String(proxy.mode ?? input.proxyMode ?? DEFAULT_REGISTRATION_TEMPLATE.proxyMode).trim();
  if (!PROXY_MODES.includes(rawMode) && strict) {
    throw new HttpError(400, `Robot config proxyMode must be one of ${PROXY_MODES.join(', ')}`);
  }

  const rawDistribution = String(proxy.distribution ?? input.proxyDistribution ?? DEFAULT_REGISTRATION_TEMPLATE.proxyDistribution)
    .trim()
    .toLowerCase();
  if (!PROXY_DISTRIBUTIONS.includes(rawDistribution) && strict) {
    throw new HttpError(400, `Robot config proxyDistribution must be one of ${PROXY_DISTRIBUTIONS.join(', ')}`);
  }

  const countryCode = String(proxy.countryCode ?? legacyCountryCode ?? DEFAULT_REGISTRATION_TEMPLATE.countryCode)
    .trim()
    .toUpperCase();
  if (rawMode !== 'local' && countryCode !== 'GLOBAL' && !/^[A-Z]{2}$/.test(countryCode)) {
    if (strict) throw new HttpError(400, 'Robot config countryCode must be GLOBAL or a two-letter ISO code');
  }
  const localProxyId = String(proxy.localProxyId ?? input.localProxyId ?? '').trim();
  if (rawMode === 'local' && !localProxyId && strict) {
    throw new HttpError(400, 'Robot config localProxyId is required for local proxy mode');
  }
  if (rawMode === 'local' && workerCount > 1 && strict) {
    throw new HttpError(400, 'Robot config local proxy mode supports one Worker');
  }

  // Each round becomes one register-then-OAuth task rather than two. The plan
  // this compiles into already sets both security features, which is what an
  // OAuth-bearing plan is refused without, so nothing else has to be asked of
  // the operator. A round that carries OAuth does need SMS balance, and the
  // run's own preflight is what refuses it.
  const postRegistrationOAuth = input.postRegistrationOAuth === true;
  const iterations = integer(input.iterations, DEFAULT_REGISTRATION_TEMPLATE.iterations, 'iterations', MAX_ITERATIONS, strict);
  const onIterationFailure = String(input.onIterationFailure || DEFAULT_REGISTRATION_TEMPLATE.onIterationFailure).trim().toLowerCase();
  if (!['stop', 'continue'].includes(onIterationFailure) && strict) {
    throw new HttpError(400, 'Robot config onIterationFailure must be "stop" or "continue"');
  }

  const mailInterface = MAIL_INTERFACES.includes(rawInterface) ? rawInterface : DEFAULT_REGISTRATION_TEMPLATE.mailInterface;
  // Only one interface rents mailboxes, so the unified broker is switched off
  // rather than rejected when the template points anywhere else — an operator
  // changing the interface should not have to clear this too.
  const mailRentalWatch = input.mailRentalWatch === true && mailInterface === RENTAL_MAIL_INTERFACE;
  const mailRentalTarget = integer(
    input.mailRentalTarget,
    DEFAULT_REGISTRATION_TEMPLATE.mailRentalTarget,
    'mailRentalTarget',
    MAX_RENTAL_TARGET,
    strict && mailRentalWatch,
  );
  const mailRentalBatchSize = integer(
    input.mailRentalBatchSize,
    DEFAULT_REGISTRATION_TEMPLATE.mailRentalBatchSize,
    'mailRentalBatchSize',
    MAX_RENTAL_BATCH_SIZE,
    strict && mailRentalWatch,
  );
  // Workers cannot outnumber the mailboxes a round will have, and which
  // number that is depends on the mode: the broker's target under 挂租, the
  // template's roots otherwise. Checking `rootEmailCount` in both left a
  // rental template rejected for a field its plan never reads.
  const mailboxBudget = mailRentalWatch ? mailRentalTarget : rootEmailCount;
  if (workerCount > mailboxBudget && strict) {
    throw new HttpError(400, mailRentalWatch
      ? 'Robot config workerCount must not exceed mailRentalTarget'
      : 'Robot config workerCount must not exceed rootEmailCount');
  }

  const requestedPoll = Number(input.mailRentalPollIntervalMs ?? DEFAULT_REGISTRATION_TEMPLATE.mailRentalPollIntervalMs);
  const pollInRange = Number.isInteger(requestedPoll)
    && requestedPoll >= MIN_RENTAL_POLL_INTERVAL_MS
    && requestedPoll <= MAX_RENTAL_POLL_INTERVAL_MS;
  if (!pollInRange && strict && mailRentalWatch) {
    throw new HttpError(400, `Robot config mailRentalPollIntervalMs must be an integer between ${MIN_RENTAL_POLL_INTERVAL_MS} and ${MAX_RENTAL_POLL_INTERVAL_MS}`);
  }

  return {
    templateId: String(input.templateId || DEFAULT_REGISTRATION_TEMPLATE.templateId).trim() || DEFAULT_REGISTRATION_TEMPLATE.templateId,
    name: String(input.name || '').trim().slice(0, 40) || DEFAULT_REGISTRATION_TEMPLATE.name,
    mailInterface,
    rootEmailCount: mailRentalWatch ? rootEmailCount : Math.max(rootEmailCount, workerCount),
    workerCount,
    proxyMode: PROXY_MODES.includes(rawMode) ? rawMode : DEFAULT_REGISTRATION_TEMPLATE.proxyMode,
    proxyDistribution: PROXY_DISTRIBUTIONS.includes(rawDistribution) ? rawDistribution : DEFAULT_REGISTRATION_TEMPLATE.proxyDistribution,
    localProxyId,
    countryCode: countryCode === 'GLOBAL' || /^[A-Z]{2}$/.test(countryCode)
      ? countryCode
      : DEFAULT_REGISTRATION_TEMPLATE.countryCode,
    // Registration templates always refresh before every iteration. This is
    // deliberately not configurable because a stale proxy snapshot is unsafe.
    refreshBeforeEachIteration: true,
    iterations,
    onIterationFailure: ['stop', 'continue'].includes(onIterationFailure) ? onIterationFailure : DEFAULT_REGISTRATION_TEMPLATE.onIterationFailure,
    postRegistrationOAuth,
    mailRentalWatch,
    mailRentalTarget,
    mailRentalBatchSize,
    mailRentalPollIntervalMs: pollInRange ? requestedPoll : DEFAULT_REGISTRATION_TEMPLATE.mailRentalPollIntervalMs,
    schedule: normalizeTemplateSchedule(input.schedule, options),
  };
}

function fallbackCountryAssignments(workerCount, countryCode) {
  return Array.from({ length: workerCount }, (_unused, index) => ({
    workerSlot: index + 1,
    kind: 'countryPool',
    countryCode,
  }));
}

/** Allocate Worker slots across country pools in proportion to available capacity. */
function balancedProxyAssignments(workerCount, proxyCatalog, fallbackCountryCode) {
  const pools = (proxyCatalog?.dynamic?.countryPools || [])
    .map((pool) => ({
      countryCode: String(pool.countryCode || '').trim().toUpperCase(),
      total: Number(pool.total || pool.entries?.length || 0),
      taken: 0,
    }))
    .filter((pool) => pool.countryCode && pool.total > 0);
  if (!pools.length) return fallbackCountryAssignments(workerCount, fallbackCountryCode);

  return Array.from({ length: workerCount }, (_unused, index) => {
    const selected = pools.reduce((best, candidate) => {
      const candidateScore = candidate.total / (candidate.taken + 1);
      const bestScore = best.total / (best.taken + 1);
      if (candidateScore > bestScore) return candidate;
      // Equal scores are common at the start of a proportional allocation.
      // Spread those slots before giving the next one to the larger pool.
      if (candidateScore === bestScore && candidate.taken < best.taken) return candidate;
      return best;
    }, pools[0]);
    selected.taken += 1;
    return { workerSlot: index + 1, kind: 'countryPool', countryCode: selected.countryCode };
  });
}

function compileRegistrationPlan(config, mailProvider, proxyCatalog = null) {
  const settings = normalizeRegistrationTemplate(config, { strict: true });
  const provider = String(mailProvider || '').trim().toLowerCase();
  const proxyAssignments = settings.proxyMode === 'local'
    ? Array.from({ length: settings.workerCount }, (_unused, index) => ({
      workerSlot: index + 1,
      kind: 'local',
      localProxyId: settings.localProxyId,
    }))
    : settings.proxyDistribution === 'capacity'
      ? balancedProxyAssignments(settings.workerCount, proxyCatalog, settings.countryCode)
      : fallbackCountryAssignments(settings.workerCount, settings.countryCode);
  // The unified broker sets the mailbox target, and the run plan reads that
  // target as its mail count; an ordinary rental keeps the template's roots.
  const rentalWatch = settings.mailRentalWatch === true && provider === RENTAL_MAIL_INTERFACE;
  return {
    schemaVersion: 3,
    taskKind: 'register_session',
    mailProvider: provider,
    mailCount: rentalWatch ? settings.mailRentalTarget : settings.rootEmailCount,
    workerConcurrency: settings.workerCount,
    aliasStrategy: 'root',
    aliasEnabled: false,
    postRegistrationOAuth: settings.postRegistrationOAuth === true,
    security: { setPassword: true, enrollTotp: true },
    aliasRunTag: `${provider}-robot`,
    proxyAssignments,
    ...(rentalWatch ? {
      mailRentalWatch: true,
      mailRentalTarget: settings.mailRentalTarget,
      mailRentalBatchSize: settings.mailRentalBatchSize,
      mailRentalPollIntervalMs: settings.mailRentalPollIntervalMs,
    } : {}),
  };
}

/**
 * The registration robot's whole configuration: several named templates and
 * which one a manual run uses.
 *
 * It used to hold one template inline. That shape is still accepted and
 * becomes the first entry here, so an existing robots.json keeps working and
 * keeps its settings; anything that reads a single template reads
 * `activeTemplate` below.
 */
function normalizeRegistrationRobotConfig(value = {}, options = {}) {
  const strict = options.strict === true;
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawTemplates = Array.isArray(input.templates) && input.templates.length
    ? input.templates
    : [input];
  if (rawTemplates.length > MAX_TEMPLATES && strict) {
    throw new HttpError(400, `At most ${MAX_TEMPLATES} registration templates`);
  }
  const seen = new Set();
  const templates = rawTemplates.slice(0, MAX_TEMPLATES).map((template, index) => {
    const normalized = normalizeRegistrationTemplate(template, options);
    // Ids must be unique for a schedule or a run request to name one. A
    // duplicate is renumbered rather than rejected, because the only way to
    // get one is an edited file.
    let id = normalized.templateId;
    while (seen.has(id)) id = `${normalized.templateId}-${index + 1}`;
    seen.add(id);
    return { ...normalized, templateId: id };
  });
  const requestedActive = String(input.activeTemplateId || '').trim();
  const activeTemplateId = templates.some((template) => template.templateId === requestedActive)
    ? requestedActive
    : templates[0].templateId;
  return { templates, activeTemplateId };
}

/** The template a manual run uses, or the one a schedule named. */
function registrationTemplate(config, templateId = '') {
  const normalized = normalizeRegistrationRobotConfig(config);
  const wanted = String(templateId || '').trim() || normalized.activeTemplateId;
  return normalized.templates.find((template) => template.templateId === wanted) || normalized.templates[0];
}

module.exports = {
  DEFAULT_REGISTRATION_TEMPLATE,
  MAIL_INTERFACES,
  REGISTRATION_TEMPLATE_FIELDS,
  compileRegistrationPlan,
  migrateRegistrationRobotConfig,
  migrateRegistrationTemplate,
  nextScheduleFireAt,
  normalizeRegistrationRobotConfig,
  normalizeRegistrationTemplate,
  normalizeTemplateSchedule,
  registrationTemplate,
};
