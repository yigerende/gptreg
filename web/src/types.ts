export type ServiceStatus = {
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'configured' | 'missing';
  httpStatus?: number;
  latencyMs?: number;
  message?: string;
  balance?: number;
  currency?: string;
};

export type SmsMarketOffer = {
  price: number;
  count: number;
  providerId: string;
  country?: string;
};

export type SmsCountryMarket = {
  id: string;
  name?: string;
  country?: { id?: string | number; name?: string; chn?: string; eng?: string };
  service?: { code?: string; name?: string } | null;
  cheapestPrice: number | null;
  offers: number;
  lowestOffers: SmsMarketOffer[];
  eligible: boolean;
  issue?: string;
  message?: string;
};

export type SmsMarketSnapshot = {
  provider: string;
  currency: string;
  service?: { code?: string; name?: string };
  country?: { id?: string | number; name?: string; chn?: string; eng?: string };
  countries?: SmsCountryMarket[];
  availableCountries?: string[];
  ready?: boolean;
  maxPrice?: number | null;
  issue?: string;
  message?: string;
  cheapestPrice: number | null;
  offers: number;
  lowestOffers: SmsMarketOffer[];
  checkedAt: string;
};

export type RobotRun = {
  id: string;
  command: string;
  reason: string;
  status: 'running' | 'success' | 'partial' | 'failed' | string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number;
  result?: {
    requested?: number;
    attempted?: number;
    succeeded?: number;
    failed?: number;
    pulled?: number;
    skipped?: string;
    ok?: boolean;
    status?: string;
    runId?: string;
    provider?: string;
    proxyMode?: string;
    proxyDistribution?: string;
    countryCode?: string;
    iterations?: number;
    completedIterations?: number;
    refreshes?: number;
    reason?: string;
    deletedBanned?: number;
    /** Sold accounts moved out of the login-state listing this run. */
    archivedSettled?: number;
  } | null;
  error?: string;
};

export type RobotCommand = {
  id: string;
  label: string;
};

export type RobotConfigField = {
  key: string;
  label: string;
  type: 'number' | 'country' | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

/** When a registration template starts on its own. */
export type RegistrationSchedule = {
  enabled: boolean;
  /** Local clock times, `HH:MM`. */
  times: string[];
  /** 0 (Sunday) to 6; empty means every day. */
  weekdays: number[];
};

export type RegistrationTemplate = {
  templateId: string;
  name: string;
  mailInterface: string;
  rootEmailCount: number;
  workerCount: number;
  proxyMode: string;
  proxyDistribution: string;
  localProxyId: string;
  countryCode: string;
  iterations: number;
  onIterationFailure: string;
  refreshBeforeEachIteration: boolean;
  /** Each round runs register-then-OAuth in one task, producing CPAs rather than login states. */
  postRegistrationOAuth: boolean;
  mailRentalWatch: boolean;
  mailRentalTarget: number;
  mailRentalBatchSize: number;
  mailRentalPollIntervalMs: number;
  schedule: RegistrationSchedule;
};

export type RegistrationRobotConfig = {
  templates: RegistrationTemplate[];
  activeTemplateId: string;
};

/** What the last scheduled start did, and what the next one will be. */
export type RobotScheduleState = {
  next: { templateId: string; name: string; at: string | null } | null;
  upcoming: Array<{ templateId: string; name: string; at: string | null }>;
  last: {
    templateId: string;
    templateName: string;
    scheduledAt: string;
    firedAt: string;
    outcome: 'started' | 'skipped' | 'missed' | string;
    reason: string;
  } | null;
};

export type RobotRecord = {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  schedule?: RobotScheduleState;
  configurable: boolean;
  configFields: RobotConfigField[];
  enabled: boolean;
  intervalMs: number;
  status: string;
  pendingRun: boolean;
  waitingReason?: string;
  waitingDetail?: string;
  /**
   * How far into the current run the robot is, or null when nothing is running.
   *
   * Live only — it is never persisted, because a progress reading from a run
   * that has already ended is worse than none.
   */
  progress?: {
    done: number;
    total: number;
    label: string;
    updatedAt: string;
    mode?: 'progress' | 'countdown' | string;
    startedAt?: string;
    endsAt?: string;
  } | null;
  nextRunAt: string | null;
  lastError: string;
  lastRun: RobotRun | null;
  runs: RobotRun[];
  commands: RobotCommand[];
};

export type RobotSnapshot = {
  schemaVersion: number;
  taskBusy: boolean;
  activeRunId: string;
  activeRunIds?: string[];
  taskCapacity?: TaskCapacitySnapshot | null;
  robots: RobotRecord[];
};

/** Who holds a task slot: a paused or waiting run keeps one without executing. */
export type TaskSlotHolder = { runId: string; status: string; active: boolean };

export type TaskSlotCapacity = {
  capacity: number;
  running: number;
  starting: number;
  available: number;
  holders?: TaskSlotHolder[];
};

export type TaskCapacitySnapshot = {
  main: TaskSlotCapacity;
  auxiliary: TaskSlotCapacity;
  customer?: TaskSlotCapacity;
};

export type PreflightSnapshot = {
  schemaVersion: number;
  ready: boolean;
  taskKind?: RunPlan['taskKind'];
  mail: {
    provider: string;
    kind?: 'unbound_mailboxes' | 'readable_mailboxes' | 'session_assets' | 'rentable_mailboxes';
    /** Rental channel only: current unit price and the configured cap. */
    unitPrice?: number;
    maxPrice?: number;
    stockStatus?: 'ready' | 'error' | string;
    stockError?: { code?: string; message?: string } | null;
    ready?: boolean;
    eligible: number | null;
    requested?: number;
    selected: number;
  };
  sms: {
    provider: string;
    ready: boolean;
    checked?: boolean;
    required?: boolean;
    conditional?: boolean;
    balance: number | null;
    currency: string;
    service: { code?: string; name?: string };
    country: { id?: string | number; name?: string; chn?: string; eng?: string };
    countries?: SmsCountryMarket[];
    availableCountries?: string[];
    maxPrice: number | null;
    concurrency?: number | null;
    requiredBalance?: number | null;
    availableConcurrency?: number | null;
    shortfall?: number;
    balanceBasis?: 'maxPrice' | 'cheapestPrice' | 'none' | string;
    cheapestPrice: number | null;
    offers: number;
    lowestOffers: Array<{
      price: number;
      count: number;
      providerId: string;
    }>;
    issue?: string;
    message?: string;
  };
  proxy: {
    required: boolean;
    requiredCount?: number;
    available: number;
    /** Candidates in the thinnest country pool any Worker is assigned to. */
    leanestLane?: number;
    /** Those candidates at the pass rate these pools actually deliver. */
    expectedYield?: number;
    /** True when the leanest lane cannot be expected to feed its Workers. */
    thin?: boolean;
    ready: boolean;
  };
  checks?: Array<{
    id: 'mail' | 'proxy' | 'sms';
    label: string;
    required: boolean;
    checked: boolean;
    ready: boolean;
    detail: string;
  }>;
  warnings?: string[];
  checkedAt: string;
  plan?: RunPlan | null;
};

export type RunPlan = {
  schemaVersion?: number;
  taskKind?: 'register_oauth' | 'register_session' | 'oauth' | 'session_refresh';
  mailCount: number;
  workerConcurrency: number;
  /** `root_plus` is the alias switch: the root address plus exactly one `+alias`. */
  aliasStrategy: 'plus' | 'root' | 'root_plus';
  /** Whether a pooled mailbox also registers one sub-address of itself. */
  aliasEnabled?: boolean;
  aliasCount: number;
  aliasMaxAttempts: number;
  aliasRunTag: string;
  totalAccounts?: number;
  postRegistrationOAuth?: boolean;
  proxyAssignments: ProxyAssignment[];
  oauthSource?: null | {
    kind: 'session_assets';
    assetIds: string[];
    sourceRunId?: string;
    /** Sign in and save the login state only; no OAuth, no CPA. */
    loginOnly?: boolean;
  } | {
    /** Already-registered accounts that sign in with password + TOTP, no mailbox. */
    kind: 'credentials';
    accounts: Array<{ email: string; password: string; totpSecret: string }>;
    sourceRunId?: string;
    /** Sign in and save the login state only; no OAuth, no CPA. */
    loginOnly?: boolean;
  };
  security?: { setPassword: boolean; enrollTotp: boolean };
  /** Pooled mailboxes (xiaopingguo) or rented ones (smsbower gmail). */
  mailProvider?: 'xiaopingguo' | 'smsbower' | 'mailcom' | 'fastmail' | 'icloud';
  /** SMSBower broker mode: claim stock centrally and feed the Worker queue. */
  mailRentalWatch?: boolean;
  mailRentalTarget?: number;
  mailRentalBatchSize?: number;
  mailRentalPollIntervalMs?: number;
};

export type ProxyAssignment =
  | { workerSlot: number; kind: 'local'; localProxyId: string }
  | { workerSlot: number; kind: 'countryPool'; countryCode: string }
  /** The configured local forwarder, for upkeep on an account that exists. */
  | { workerSlot: number; kind: 'maintenance' };

export type ConfigSnapshot = {
  path: string;
  config: Record<string, any>;
  secrets: {
    mailPasswordConfigured: boolean;
    mailcomAdminTokenConfigured?: boolean;
    smsApiKeyConfigured: boolean;
    heroSmsApiKeyConfigured?: boolean;
    firefoxCredentialsConfigured?: boolean;
  };
};

export type MailcomMailbox = {
  id: string;
  email: string;
  parent: string;
  master: string;
  rootEmail: string;
  kind: 'master' | 'alias' | string;
  status: string;
  lifecycle?: string;
  registrationState?: string;
  reusable?: boolean;
  claimExpiresAt?: number | null;
  registrationStartedAt?: number | null;
  bound: boolean;
  cycle: number;
  generation: number;
  tokenValid: boolean;
  deletable: boolean;
};

export type MailcomStatus = {
  accounts: MailcomMailbox[];
  summary: Record<string, number>;
};

export type MailcomAliasDomains = {
  provider?: 'mailcom' | 'fastmail' | string;
  mode: 'random' | 'selected' | string;
  domains: string[];
  availableDomains?: string[];
  candidateDomains?: string[];
  catalogDomains?: string[];
  selectedDomains: string[];
  deniedDomains: string[];
};

export type MailcomImportProgress = {
  status: 'idle' | 'running' | 'complete' | 'failed';
  id?: string;
  total?: number;
  processed?: number;
  added?: number;
  duplicates?: number;
  aliasesCreated?: number;
  invalidLines?: number[];
  current?: string;
  failures?: { email: string; message: string }[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type WorkerSummary = {
  id: string;
  status: string;
  mailboxId: string | number | null;
  proxyId: string;
  currentJobId: string;
  completedRoots: number;
  updatedAt: string;
};

export type JobSummary = {
  id: string;
  email: string;
  status: string;
  phase: string;
  branch: string;
  aliasIndex: number;
  replacementOf: string;
  proxyId: string;
  smsAttempts: number;
  smsCostUsd?: number | null;
  smsWastedUsd?: number;
  smsWastedAttempts?: number;
  smsCurrency?: string;
  smsQuotedUsd?: number;
  smsRefundedUsd?: number;
  smsUnresolvedUsd?: number;
  /** Portion of the unresolved amount belonging to cancelled activations. */
  smsCancelledUnresolvedUsd?: number;
  /** Cancelled quote removed after the balance decrease matched confirmed use. */
  smsCancelledQuoteExcludedUsd?: number;
  smsCostStatus?: 'not_used' | 'confirmed' | 'partially_refunded' | 'refunded' | 'settled' | 'pending' | 'needs_review' | string;
  accountCreated: boolean;
  workspaceId?: string;
  cpaPath?: string;
  sessionAssetId?: string;
  assetId?: string;
  cpaRevision?: number;
  cpaSuperseded?: boolean;
  /** Human-readable outcome; failed jobs include the error code and message. */
  result?: string;
  error?: { code?: string; message?: string } | null;
  finalization?: { status: string; attempts: number; reason: string; lastError: string } | null;
};

export type MailboxSummary = {
  id: string | number;
  email: string;
  status: string;
  workerId: string;
  targetCount: number;
  maxAttempts: number;
  attemptCount: number;
  createdCount: number;
  cpaCompletedCount: number;
  normalComplete: boolean;
  stopReason?: string;
};

export type BalanceReconciliation = {
  schemaVersion?: number;
  provider: string;
  currency: string;
  startBalance: number | null;
  startCheckedAt: string;
  startSource?: string;
  startError?: string;
  endBalance: number | null;
  accountFingerprint?: string;
  endAccountFingerprint?: string;
  accountChanged?: boolean;
  endCheckedAt: string;
  observedDecrease: number | null;
  confirmedConsumed: number | null;
  unresolved: number | null;
  difference: number | null;
  tolerance: number;
  billingComplete: boolean | null;
  /** True while a balance read can still be retried without repeating the run. */
  retryable?: boolean;
  /** True when the missing start baseline makes automatic reconciliation impossible. */
  manualReviewRequired?: boolean;
  concurrent: boolean;
  concurrentRunIds?: string[];
  /** Cancelled SMS quotes excluded after the balance decrease matched confirmed use. */
  cancelledQuotesSettledByBalance?: number;
  /** Pending amount before those cancelled quotes were excluded. */
  unresolvedBeforeBalanceSettlement?: number;
  cancelledQuotesSettledByJob?: Record<string, number>;
  status: 'pending' | 'matched' | 'mismatch' | 'concurrent' | 'manual_review' | string;
  note?: string;
  error?: { code: string } | null;
  finalizedAt?: string;
};

export type CurrencyBillingTotals = {
  quoted: number;
  grossConsumed: number;
  confirmedConsumed: number;
  refunded: number;
  unresolved: number;
  cancelledUnresolved: number;
  cancelledQuoted: number;
  activeQuoted: number;
  wastedConsumed?: number;
};

export type RegistrationOutcomeCounts = {
  existingAccountRecovered: number;
  mfaTotp: number;
  /** Final authentication callback failures after proxy recovery was exhausted. */
  callbackFailed?: number;
  /** Registered accounts held back from the OAuth leg for missing a password or TOTP. */
  securityIncomplete?: number;
};

export type RegistrationSkippedCounts = {
  emailTimeout: number;
  rentalStartTimeout: number;
  authContinuationOriginInvalid: number;
};

/** Accounts that reached OAuth and came out without a CPA, by reason. */
export type OAuthSkippedCounts = {
  rateLimited: number;
  phoneBudgetExhausted: number;
  loginRequired: number;
};

export type WastedBreakdownItem = {
  kind: 'sms' | 'mail' | string;
  code: string;
  count: number;
  amount?: number;
  currency?: string;
};

export type RunSummary = {
  hasRetainedCpa?: boolean;
  jobsPage?: { items: JobSummary[]; total: number; offset: number; limit: number };
  schemaVersion?: number;
  runId: string;
  taskKind?: RunPlan['taskKind'];
  status: string;
  resumable?: boolean;
  phase?: string;
  updatedAt?: string;
  /** When the run began, for elapsed-time display. */
  startedAt?: string;
  active?: boolean;
  taskSlot?: 'main' | 'auxiliary' | string;
  plan?: RunPlan | null;
  manifestPath?: string;
  normalWait?: { code: string; message: string; at: string; nextRunAt?: string } | null;
  /**
   * Set once the provider reported an empty balance. The run stops renting and
   * buying at that moment and ends with what it holds, so this is the reason a
   * finished task stopped short of its target.
   */
  balanceStop?: { at: string; source: string; message: string; balance: number | null } | null;
  /**
   * The mailbox rental, in whichever mode the run is using it.
   *
   * `mailRentalWatch` below is the unified broker's own machinery and exists
   * only in that mode; everything both modes have in common is here.
   */
  mailRental?: {
    mode: 'normal' | 'watch';
    target: number;
    claimedCount: number;
    activeCount: number;
    /** Mailboxes held but not yet taken into a registration attempt. */
    awaitingStartCount: number;
    expiredCount: number;
    /** How long a rental may sit unstarted before the provider reclaims it. */
    startWindowMs: number;
    nextStartDeadlineAt: string;
    retryAt: string;
    retryAttempts: number;
    /** When the operator stopped renting more, in either mode. Empty if not. */
    stoppedAt: string;
    lastError?: { code?: string; message?: string } | null;
  } | null;
  mailRentalWatch?: {
    enabled: boolean;
    target: number;
    batchSize: number;
    pollIntervalMs: number;
    claimConcurrency?: number;
    claimRetryCount?: number;
    claimedCount: number;
    pollCount: number;
    idleMailboxCount?: number;
    idleMailboxLimit?: number;
    claimPaused?: boolean;
    lastPolledAt?: string;
    nextPollAt?: string;
    lastStockCount?: number | null;
    lastPrice?: number | null;
    lastStockStatus?: 'ok' | 'error' | 'unknown' | string;
    lastError?: { code?: string; message?: string } | null;
    stopRequested: boolean;
    autoStopped: boolean;
    stoppedAt?: string;
  } | null;
  control?: { requestedAction: string | null; requestedAt: string; pausedAt: string; resumedAt: string };
  counts?: {
    workers: { total: number; running: number; idle: number };
    accountsCreated: number;
    cpaCompleted: number;
    sessionsSaved?: number;
    registrationOutcomes?: RegistrationOutcomeCounts;
    registrationSkipped?: RegistrationSkippedCounts;
    oauthSkipped?: OAuthSkippedCounts;
    /** Confirmed SMS/mail resources classified as provider-side waste. */
    wasted?: number;
    /** Waste counts split by the concrete provider-side outcome. */
    wastedBreakdown?: WastedBreakdownItem[];
    /** Accounts OpenAI closed during the run. Reported, never graded: their
     *  jobs end `skipped`, so they do not make the run partial or failed. */
    deactivated?: number;
    finalization: { queued: number; running: number; failed: number };
  };
  costs?: {
    currency: string;
    sms: number;
    /** Rented mailboxes, billed only once settled. */
    mail?: number;
    mailRentals?: number;
    /** Settled rentals consumed by MFA/already-exists or final callback failure. */
    wastedMail?: number;
    wastedMailRentals?: number;
    /** Confirmed OAuth phone activations wasted by recycled numbers or rejected codes. */
    wastedSms?: number;
    wastedSmsAttempts?: number;
    accountedJobs: number;
    /** sms + mail in one number, or null when the two bill in different currencies. */
    total?: number | null;
    /** Numbers actually charged for. Cancelled ones cost nothing and are not counted. */
    smsBilledActivations?: number;
    complete: boolean;
  };
  billing?: {
    currency: string;
    currencyTotals?: Record<string, CurrencyBillingTotals>;
    quotedUsd: number;
    grossConsumedUsd: number;
    confirmedConsumedUsd: number;
    refundedUsd: number;
    unresolvedUsd: number;
    cancelledUnresolvedUsd: number;
    cancelledQuotedUsd: number;
    cancelledQuotesSettledUsd: number;
    activeQuotedUsd: number;
    accountedJobs: number;
    unresolvedJobs: number;
    activationCount: number;
    wastedConsumedUsd?: number;
    wastedActivationCount?: number;
    billingComplete: boolean;
  };
  balanceReconciliation?: BalanceReconciliation | null;
  workers?: WorkerSummary[];
  mailboxes?: MailboxSummary[];
  jobs?: JobSummary[];
  externalCleanup?: Array<{
    type: string;
    jobId?: string;
    acquisitionId?: string;
    provider?: string;
    status: string;
    reason?: string;
    recordedAt?: string;
  }>;
  proxy?: {
    candidates: number;
    leases: number;
    counts: Record<string, number>;
    health: Array<Record<string, any>>;
  };
  error?: string;
};

export type RunListSnapshot = {
  latestRun?: RunSummary | null;
  activeRunId: string;
  activeRunIds?: string[];
  taskCapacity?: TaskCapacitySnapshot | null;
  runs: RunSummary[];
};

export type MailRentalConfigureBody = {
  additional?: number;
  target?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  action?: 'keep' | 'stop' | 'continue';
};

export type CpaArtifact = {
  /** Stable, file-level identity. runId:jobId is NOT unique across rows. */
  key: string;
  runId: string;
  jobId: string;
  aliasIndex: number;
  /** The alias this CPA was registered from — the sub-address, not the root. */
  email: string;
  /** The root mailbox that alias belongs to, when the run recorded one. */
  parentEmail?: string;
  fileName: string;
  size: number;
  modifiedAt: string;
  runStatus: string;
  deletable: boolean;
  assetId?: string;
  superseded?: boolean;
  isPlus?: boolean;
  lifecycle?: string;
  /** ISO country code of the exit the account registered from; empty when unknown. */
  registrationCountry?: string;
  cpaExportedAt?: string;
  sub2ApiExportedAt?: string;
  /** Set once this artifact's current bytes reached the local sub2api gateway. */
  sub2ApiPushedAt?: string;
  nvtokensCardsImportedAt?: string;
  nvtokensMailboxesImportedAt?: string;
  nvtokensCardsPooledAt?: string;
  locked?: boolean;
  lockedAt?: string;
  lockBatchKey?: string;
};

/** One account the sub2api gateway has flagged as broken. */
export type Sub2ApiFailedAccount = {
  id: number;
  email: string;
  status: string;
  reason: string;
};

/**
 * The gateway's error set, with the counts that explain an empty one.
 *
 * `breakdown` holds sub2api's *derived* statuses, which are not the `status`
 * field on an account row: every account can report `active` while the gateway
 * counts most of them as rate-limited. Without it, zero errors is
 * indistinguishable from a broken button.
 */
export type Sub2ApiFailedAccounts = {
  accounts: Sub2ApiFailedAccount[];
  breakdown: Record<string, number>;
  /** The scan stopped at its page cap; more accounts exist than were read. */
  truncated: boolean;
};

export type Sub2ApiDeleteResult = {
  requested: number;
  deleted: number;
  errors: string[];
};

/** What the sub2api gateway reports back after an import. */
export type Sub2ApiPushResult = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  warnings: string[];
  pushed: number;
  artifacts: number;
  classified: string[];
};

/** One record the console held back, with the account it belongs to. */
export type NvtokensSkippedRecord = {
  /** The file-level identity, when the server sent one. */
  key?: string;
  runId: string;
  jobId: string;
  recordIndex?: number;
  email: string;
  reason: string;
};

export type NvtokensPushResult = {
  ok: boolean;
  total: number;
  accepted: number;
  failed: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  pushed: number;
  artifacts: number;
  exported: number;
  /** Records this machine did not send, and why — empty when everything went. */
  skippedDetails?: NvtokensSkippedRecord[];
  kind: 'nvtokens_cards' | 'nvtokens_mailboxes' | 'nvtokens_pool' | string;
};

export type Sub2ApiDocument = {
  exported_at: string;
  proxies: unknown[];
  accounts: Array<Record<string, unknown>>;
};

export type SessionAssetHealthStatus = 'healthy' | 'invalid' | 'uncertain' | 'missing' | 'mismatch' | 'banned';

export type SessionAssetHealth = {
  status: SessionAssetHealthStatus;
  code: string;
  message: string;
  httpStatus: number;
  checkedAt: string;
  latencyMs: number;
  lastHealthyAt: string;
};

/** The exit an account was registered through, recorded on its login state. */
export type SessionAssetSourceProxy = {
  address?: string; exitIp?: string; exitIpCheckedAt?: string; exitIpStatus?: string;
  id: string;
  endpoint: string;
  protocol: string;
  countryCode: string;
  resourceKind: string;
};

export type SessionAssetTrialStatus = 'trial' | 'none' | 'unknown';

/** `free_month` is the only kind the chain can redeem; the rest are discounts. */
export type SessionAssetOfferKind = 'free_month' | 'free_other' | 'discounted' | '';

export type SessionAssetTrialCampaign = {
  key: string;
  id: string;
  planName: string;
  label: string;
  durationPeriods: number;
  durationPeriod: string;
  discountPercentage: number;
  offerKind?: SessionAssetOfferKind;
  offerLabel?: string;
  /** `Plus` / `Go` / `Pro`, derived from `planName`. */
  offerPlanLabel?: string;
};

export type SessionAssetTrial = {
  status: SessionAssetTrialStatus;
  code: string;
  message: string;
  httpStatus: number;
  checkedAt: string;
  latencyMs: number;
  planType: string;
  subscriptionPlan: string;
  hasActiveSubscription: boolean;
  hasPreviouslyPaid: boolean;
  activeTrial: boolean;
  defaultOfferId: string;
  campaigns: SessionAssetTrialCampaign[];
  offerKind?: SessionAssetOfferKind;
  offerLabel?: string;
  /** Raw plan name the headline offer belongs to, e.g. `chatgptgoplan`. */
  offerPlan?: string;
  /** The same plan, as shown: `Plus` / `Go` / `Pro`. */
  offerPlanLabel?: string;
  /** Whether a one-month free campaign is claimable — the chain entry gate. */
  freeMonthOffer?: boolean;
  lastTrialAt: string;
};

export type SessionAssetTrialResult = SessionAssetTrial & {
  assetId: string;
  email: string;
  trialAvailable: boolean;
};

export type SessionAssetTrialBatch = {
  requested: number;
  checked: number;
  results: SessionAssetTrialResult[];
  /** AT probe run over the assets whose promo verdict came back unknown. */
  atProbe?: SessionAssetProbeBatch | null;
};

export type SessionAssetProbeResult = SessionAssetHealth & {
  assetId: string;
  email: string;
  healthy: boolean;
};

export type SessionAssetProbeBatch = {
  requested: number;
  checked: number;
  results: SessionAssetProbeResult[];
};

/**
 * Which inventory pool an account sits in. `banned` is derived, never chosen.
 *
 * `self_use` is graded exactly like `active` server-side — it says who the
 * account is for, not that it has stopped being worked on — so it keeps every
 * queue and it loses to a derived `banned` the same way `active` does.
 */
export type SessionAssetLifecycle = 'active' | 'planned' | 'self_use' | 'sold' | 'banned';
/** The pools an operator can move an account into; `banned` is a probe verdict. */
export type SettableSessionAssetLifecycle = Exclude<SessionAssetLifecycle, 'banned'>;
/** The single next thing to do to an account, resolved by the server's priority table. */
export type SessionAssetNextAction = 'refresh' | 'security' | 'chain' | 'oauth' | 'trial_check' | 'none';

export type SessionAssetQuery = {
  lifecycle?: SessionAssetLifecycle | 'all';
  queue?: SessionAssetNextAction | 'all';
  facets?: string[];
  sourceRun?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  sort?: 'createdAtAsc';
};

export type SessionAssetCounts = {
  lifecycle: Partial<Record<SessionAssetLifecycle, number>>;
  queue: Partial<Record<SessionAssetNextAction, number>>;
  facets: Record<string, number>;
};

export type SessionAssetPage = {
  assets: SessionAssetListRow[];
  total: number;
  offset: number;
  limit: number;
  cursor: string;
  counts: SessionAssetCounts;
  sourceRuns: string[];
};

export type SessionAssetResolveMatch = {
  email: string;
  assetId: string;
  status: string;
  lifecycle: string;
  hasAccessToken: boolean;
  accessTokenExpiresAt: string;
  inUse: boolean;
};

export type SessionAssetResolveResult = {
  matched: SessionAssetResolveMatch[];
  unmatched: string[];
};

export type SessionAssetOAuthCooldown = {
  active: boolean;
  until: string;
  reason: string;
  failureCount: number;
  sourceRunId: string;
  sourceJobId: string;
  setAt: string;
};

/**
 * A login-state record.
 *
 * The list endpoint returns a deliberately narrow projection of this — enough
 * to draw a row — while the detail endpoint returns all of it. Fields only the
 * inspector renders are therefore optional: they are absent from every row in
 * the list, and reading one off a row is a mistake the type should catch.
 */
export type SessionAssetListRow = {
  id: string;
  email: string;
  accountId?: string;
  status?: string;
  lifecycle?: SessionAssetLifecycle;
  nextAction?: SessionAssetNextAction;
  facets?: string[];
  planType?: string;
  sourceRunId?: string;
  createdAt?: string;
  registeredAt?: string;
  updatedAt?: string;
  lastValidatedAt?: string;
  accessTokenExpiresAt?: string;
  hasAccessToken?: boolean;
  hasPassword?: boolean;
  hasTotp?: boolean;
  security?: Record<string, any>;
  health?: SessionAssetHealth | null;
  trial?: SessionAssetTrial | null;
  sourceProxy?: SessionAssetSourceProxy | null;
  rebindProxy?: SessionAssetSourceProxy | null;
  oauth?: {
    successful?: boolean;
    successCount?: number;
    lastSucceededAt?: string;
    lastRunId?: string;
    lastJobId?: string;
  } | null;
  oauthCooldown?: SessionAssetOAuthCooldown | null;
  lastError?: null | { code: string; message?: string };
};

export type SessionAsset = SessionAssetListRow & {
  schemaVersion?: number;
  parentEmail?: string;
  parentMailboxId?: string | number;
  mailProvider?: string;
  classification?: 'active' | 'planned' | 'sold' | string;
  sourceKind?: string;
  createdAt?: string;
  accountId: string;
  status: string;
  lifecycle: SessionAssetLifecycle;
  nextAction: SessionAssetNextAction;
  facets: string[];
  planType: string;
  sourceRunId: string;
  updatedAt: string;
  lastValidatedAt: string;
  accessTokenExpiresAt: string;
  hasAccessToken: boolean;
  hasSessionToken: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  accessToken?: string;
  sessionToken?: string;
  password?: string;
  totpSecret?: string;
  oaiDid?: string;
  cookieJar?: unknown;
  clientProfile?: Record<string, unknown> | null;
  clientProfileFingerprint?: string;
  session?: Record<string, unknown> | null;
  me?: Record<string, unknown> | null;
  security?: Record<string, any> | null;
  securitySummary?: Record<string, any>;
  health: SessionAssetHealth | null;
  trial: SessionAssetTrial | null;
  sourceProxy: SessionAssetSourceProxy | null;
  registeredAt?: string;
  registrationProxyUrl?: string;
  oauth?: {
    successful: boolean;
    successCount: number;
    lastSucceededAt: string;
    lastRunId: string;
    lastJobId: string;
  } | null;
  cpa?: null | { path: string; revision: number; runId: string; jobId: string; updatedAt: string };
  lastError?: null | { code: string; message?: string };
};

export type MailboxOption = {
  id: string | number;
  email: string;
  bound: boolean;
  tokenValid: boolean;
  provider: string;
};

export type ProxyRecord = {
  id: string;
  endpoint: string;
  protocol: string;
  host: string;
  port: string;
  hasCredentials: boolean;
  check: null | {
    status: string;
    checkedAt: string;
    httpStatus: number;
    latencyMs: number | null;
    message?: string;
  };
};

export type DynamicProxyEntry = {
  id: string;
  url: string;
  protocol: string;
  countryCode: string;
  sourceId: string;
};

export type ProxyApiSource = {
  id: string;
  provider: '711proxy' | 'b2proxy' | '1024proxy' | 'cliproxy' | 'iproyal';
  url: string;
  countryCode: string;
  count: number;
  protocol: string;
  sessionType: 'sticky';
  sessionMinutes: number;
  earlyRotation: false;
  entries: DynamicProxyEntry[];
  cachedCount: number;
  lastPulledSettings?: ProxyProviderSettings | null;
  lastPulledAt: string;
  lastPullCount: number;
  lastError: string;
  lastNotice?: string;
};

export type CountryProxyPool = {
  countryCode: string;
  total: number;
  protocols: Record<string, number>;
  entries: DynamicProxyEntry[];
  /** Cached identities retained by compact/paged catalogs for allocation checks. */
  entryIds?: string[];
  manualCount: number;
  sources: ProxyApiSource[];
};

/** Outcome of refreshing every country pool at once. */
export type ProxyRefreshSummary = {
  requested: number;
  succeeded: number;
  failed: number;
  pulled: number;
  results: { ok: boolean; countryCode: string; sourceId: string; pulled: number; error?: string }[];
};

export type ProxyCatalogSnapshot = {
  total: number;
  local: { total: number; errors: unknown[]; proxies: ProxyRecord[] };
  dynamic: { total: number; countryPools: CountryProxyPool[]; providerSettings?: Record<string, ProxyProviderSettings>; settingsRefresh?: ProxySettingsRefresh | null };
  errors: unknown[];
  proxies: ProxyRecord[];
};

export type IPRoyalSettings = { apiToken?: string; whitelistIp?: string };
export type IPRoyalSettingsSnapshot = Omit<IPRoyalSettings, 'apiToken'> & { authMode: 'whitelist'; apiTokenConfigured: boolean };
export type ProxyProviderSettings = { count: number; protocol: string; sessionMinutes: number; apiBaseUrl?: string; iproyal?: IPRoyalSettingsSnapshot };
export type ProxySettingsRefresh = {
  provider: string;
  status: 'running' | 'success' | 'partial' | 'failed';
  done: number;
  total: number;
  startedAt: string;
  finishedAt: string;
  result: ProxyRefreshSummary | null;
  error: string;
};

export type LogRecord = {
  seq: number;
  at: string;
  level: string;
  source: string;
  type: string;
  runId: string;
  workerId: string;
  jobId: string;
  message: string;
  details: Record<string, unknown>;
  logReset?: boolean;
};

export type ChainStage = {
  stage: string;
  method: string;
  url: string;
  status: number;
  elapsedMs: number;
  error?: string;
};

export type ChainBilling = {
  name: string;
  email: string;
  phone: string;
  country: string;
  line1: string;
  city: string;
  state: string;
  postal_code: string;
};

export type ChainProgress = {
  stage: string;
  completed: number;
  total: number;
  startedAt: string;
  lastStatus: number;
  paused?: boolean;
  stopping?: boolean;
  attempt?: number;
  sessionKindLabel?: string;
  checkoutSessionId?: string;
};

export type ChainResult = {
  ok: boolean;
  checkoutSessionId: string;
  sessionKind: string;
  sessionKindLabel: string;
  paymentMethod: string;
  billingCountry: string;
  currency: string;
  amountDue: number;
  amountDueMinor: number;
  accountEmail: string;
  paypalUrl: string;
  providerUrl: string;
  stripeRedirectUrl: string;
  paymentMethodId: string;
  checkoutUpdateApplied: boolean;
  latencyMs?: number;
  transport?: string;
  billing?: ChainBilling;
  stages?: ChainStage[];
};

export type ChainRecord = {
  schemaVersion: number;
  id: string;
  assetId: string;
  email: string;
  accountId: string;
  sourceKind: string;
  sourceCountryCode: string;
  /** Current projection of the linked login-state asset. */
  assetLifecycle?: SessionAssetLifecycle | string;
  /** Server-selected next action for the linked asset. */
  assetNextAction?: 'refresh' | 'security' | 'chain' | 'oauth' | 'trial_check' | 'none' | string;
  /** Additive asset facets used by the inventory page. */
  assetFacets?: string[];
  /** Null means an older chain record did not carry the projection yet. */
  chainEligible?: boolean | null;
  accessTokenPreview: string;
  /** The external engine job producing this row, while it is in flight. */
  /** An explicit provider/route chosen at import, overriding the country rule. */
  routeProvider?: string;
  routeKey?: string;
  linkopsJobId?: string;
  linkopsProvider?: string;
  /** Proxy rotations already spent on this row's current dispatch. */
  linkopsRetryCount?: number;
  /** The payment stage that follows an extracted link, where one exists. */
  paymentJobId?: string;
  paymentProvider?: string;
  paymentPhone?: string;
  hasAccessToken: boolean;
  status: 'pending' | 'running' | 'success' | 'failed' | 'deactivated';
  paymentStatus: 'pending' | 'success' | 'failed' | string;
  sessionKind: string;
  sessionKindLabel: string;
  checkoutUpdateApplied: boolean | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string;
  trialCheckedAt: string;
  /** The promo this row would redeem, e.g. `Go 1个月免费`. */
  offerLabel?: string;
  /** Last independent AT spot check, if one has been run this session. */
  tokenHealth?: ChainTokenHealth | null;
  /** Raw plan the offer sits on, e.g. `chatgptgoplan`. */
  offerPlan?: string;
  result: ChainResult | null;
  lastError: null | { code: string; message: string; at: string; status?: number; stages?: ChainStage[] };
  request: null | { country: string; startedAt: string };
  paymentRefresh?: {
    status: 'idle' | 'pending' | 'queued' | 'running' | 'complete' | 'failed' | string;
    runId?: string;
    requestedAt?: string;
    queuedAt?: string;
    startedAt?: string;
    completedAt?: string;
    lastError?: { code: string; message: string } | null;
  };
  running?: boolean;
  progress?: ChainProgress | null;
};

/** One pasted line's outcome after the free-month screen. */
export type ChainImportRow = {
  line: number;
  email: string;
  imported: boolean;
  code?: string;
  reason?: string;
  offerLabel?: string;
  assetId?: string;
  input?: string;
};

export type ChainImportResult = {
  requested: number;
  imported: number;
  admitted: ChainImportRow[];
  rejected: ChainImportRow[];
};

/** One routing rule, keyed by the country an account was registered from. */
export type ChainCountryRule = {
  /** Billing profile: currency, locale, timezone. */
  billingCountry: string;
  /** Proxy source region the checkout exit is drawn from. */
  checkoutCountry: string;
  /** Proxy source region for the update hop. */
  updateCountry: string;
  applyCheckoutUpdate: boolean;
};

/**
 * A one-off AT verdict for a chain row.
 *
 * Held in memory by the service, never written to the login-state asset: it
 * answers "is this batch worth starting" and stops being true the moment after
 * it is taken.
 */
export type ChainTokenHealth = {
  status: 'healthy' | 'invalid' | 'banned' | 'missing' | 'unknown' | string;
  code?: string;
  message?: string;
  httpStatus?: number;
  latencyMs?: number;
  checkedAt?: string;
};

export type ChainSnapshot = {
  records: ChainRecord[];
  /** Proxy source regions a checkout/update exit can be drawn from. */
  proxyRegions: string[];
  /** Billing profiles the checkout accepts. */
  billingCountries: string[];
  settings: { country: string };
  /** `default` plus one entry per registration country that overrides it. */
  countryRules: Record<string, ChainCountryRule>;
  /** The pools this routing will actually draw from. */
  proxyPools: Array<{ provider: string; country: string; role: string }>;
};

/**
 * Only `ids` is required now: routing comes from the saved per-country rules,
 * and anything supplied here overrides them for this one submission.
 */
export type ChainExtractPlan = {
  ids: string[];
  /** Overrides the per-country routing table for this one dispatch. */
  country?: string;
};

export type ChainDispatchResult = {
  accepted: string[];
  dispatched: Array<{ id: string; provider?: string; country?: string; linkopsJobId?: string; paymentJobId?: string }>;
  skipped: Array<{ id: string; email?: string; provider?: string; country?: string; reason: string }>;
  routes?: Array<{ provider?: string; sourceCountryCode: string; count: number }>;
};

/** The external LinkOps workbench that owns extraction and PayPal payment. */
export type LinkOpsProvider = {
  id: string;
  domain: string;
  name: string;
  description: string;
  countries?: string[];
  capabilities?: string[];
};

export type LinkOpsModule = {
  id: string;
  providers: LinkOpsProvider[];
};

export type LinkOpsStatus = {
  baseUrl: string;
  online: boolean;
  canStart: boolean;
  starting: boolean;
  reason?: string;
  rejected?: boolean;
  health?: Record<string, unknown>;
  modules?: LinkOpsModule[];
};

export type LinkOpsJob = {
  id: string;
  domain: string;
  provider: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | string;
  stage: string;
  stage_label: string;
  progress: number;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  retry_count: number;
  can_retry: boolean;
  awaiting_input: { kind: string; prompt: string } | null;
  // Unix seconds, as the engine's `time.time()` produces them — not ISO.
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration: number | null;
  log_count: number;
};

/** `blocked` are the jobs still running: the engine will not delete those. */
export type LinkOpsJobDeleteResult = {
  ok?: boolean;
  deleted?: string[];
  blocked?: string[];
  missing?: string[];
};

export type LinkOpsJobPage = {
  ok?: boolean;
  jobs: LinkOpsJob[];
  stats?: Record<string, number>;
};

/**
 * Mirrors the engine's public pool payload verbatim: it publishes identity and
 * a health summary only, and names the size `count` (the proxy values, their
 * masks and the upstream source URL never leave the engine).
 */
export type LinkOpsProxyPool = {
  ok?: boolean;
  pool?: {
    id?: string;
    provider?: string;
    country?: string;
    role?: string;
    count?: number;
    fetched_at?: number;
    expires_at?: number;
    expired?: boolean;
  } | null;
};

export type ChainPaymentSettings = {
  /** Roll an extracted link straight into the payment engine. */
  autoContinue: boolean;
  /** The number the payment engine signs with; required to auto-continue. */
  phone: string;
  country: string;
};

/**
 * One row named in a CPA selection. The file key is the row's real identity —
 * runId:jobId is not unique when one job's CPA exists at two paths — and the
 * pair stays addressable because a server that predates the key reports rows
 * by it alone.
 */
export type CpaArtifactSelectionItem = { runId: string; jobId: string; key?: string };

/** Export target: named runs, named artifacts, `unexported` for everything the
 *  ledger has not seen at its current version, or nothing at all for every
 *  retained artifact. The server resolves `unexported` from its own ledger. */
export type CpaExportSelection = {
  runIds?: string[];
  items?: CpaArtifactSelectionItem[];
  unexported?: boolean;
  /** Reject rows already stamped in the selected export ledger. */
  unexportedOnly?: boolean;
  /** Shared by client-side batches that belong to one delivery operation. */
  deliveryAt?: string;
};

/** One row a credential export would refuse, and why. */
export type CpaCredentialGap = { runId: string; jobId: string; key?: string; email: string; reason: string };

/**
 * What a credential export would refuse, asked without exporting anything.
 *
 * The export stays all-or-nothing, so the console checks every batch of a large
 * selection through this before it sends any of them.
 */
export type CpaCredentialPreflight = { requested: number; ready: number; missing: CpaCredentialGap[] };

export type RebindProviderInfo = { id: string; label: string; configured: boolean };

export type RebindProviders = { activeProvider: string; providers: RebindProviderInfo[] };

export type RebindProxyProbeResult = {
  proxy: string;
  status: 'healthy' | 'failed' | string;
  httpStatus: number;
  latencyMs: number | null;
  message?: string;
  checkedAt: string;
};

export type RebindProxyProbe = {
  total: number;
  healthy: number;
  failed: number;
  results: RebindProxyProbeResult[];
};

export type RebindPreflight = {
  schemaVersion: number;
  provider: string;
  checkedAt: string;
  proxy: {
    required: boolean;
    requiredCount: number;
    available: number;
    ready: boolean;
    capacityReady?: boolean;
    maintenanceOnly: boolean;
    probe?: RebindProxyProbe;
  };
  mail: { provider: string; configured: boolean; requested: number; ready: boolean };
  ready: boolean;
};

export type RebindConnectionRetry = {
  attempt: number;
  stage: string;
  code: string;
  error: string;
  retryAttempt?: number;
  maxRetries?: number;
  pending?: boolean;
  nextRetryAt?: string;
};

export type RebindResult = {
  assetId: string;
  previousEmail: string;
  newEmail: string;
  provider: string;
  status: 'ok' | 'error' | 'needs_refresh' | 'upsert_fail' | string;
  stage: string;
  code: string;
  attempts?: number;
  failure?: { code: string; step: string; httpStatus: number; refreshReason: string; resumeStage: string };
  attemptErrors?: RebindConnectionRetry[];
  proxy?: string;
  rebindProxy?: SessionAssetSourceProxy | null;
  changeConfirmed?: boolean;
  postRefreshed?: boolean;
  mailboxAttempts?: number;
  mailboxRetries?: { email: string; mailboxId: string; reason: string }[];
  warning?: string;
  otpDiagnostics?: { recipient: string; checkedEmails: number; listed: number; found: boolean; siblingCount: number; recipientMismatch?: boolean };
  error: string;
  at: string;
};

export type RebindActive = {
  assetId: string;
  email: string;
  newEmail?: string;
  stage: string;
  stagesReached?: string[];
  refreshReason?: string;
  resumeStage?: string;
  connectionRetry?: RebindConnectionRetry;
  attempt: number;
  proxy?: string;
  rebindProxy?: SessionAssetSourceProxy | null;
  proxyCheck?: { status: string; candidateIndex?: number; candidateCount?: number; proxy?: SessionAssetSourceProxy | null; message?: string };
  mailboxAttempt?: number;
  maxMailboxAttempts?: number;
  retryReason?: string;
  willRetry?: boolean;
  loginStep?: string;
  loginStepsReached?: string[];
  timeoutMs?: number;
  otp?: { polls: number; remainingMs: number; elapsedMs: number; retrying: boolean; diagnostics: RebindResult['otpDiagnostics'] | null } | null;
  startedAt?: string;
  stageStartedAt: string;
  elapsedSeconds: number;
  totalElapsedSeconds?: number;
};

export type RebindStatus = {
  running: boolean;
  runId?: string;
  historyWarning?: string;
  starting?: boolean;
  provider: string;
  workerConcurrency: number;
  proxyAssignments?: ProxyAssignment[];
  total: number;
  assetIds?: string[];
  done: number;
  ok: number;
  fail: number;
  needsRefresh: number;
  refreshed: number;
  proxyRetried: number;
  autoRefresh?: boolean;
  alwaysFreshLogin?: boolean;
  proxyRetries?: number;
  otpRetries?: number;
  startedAt: string;
  finishedAt: string;
  error: string;
  reboundEmails: string[];
  results: RebindResult[];
  active?: RebindActive[];
  stopRequested: boolean;
};

export type RebindQueueAccount = {
  id: string;
  email: string;
  accountId: string;
  mailProvider: string;
  planType: string;
  hasAccessToken: boolean;
  canRefresh: boolean;
  health: SessionAssetHealth | null;
  rebind?: { previousEmail?: string; previousProvider?: string; provider?: string; reboundAt?: string } | null;
  createdAt: string;
  ageMs: number | null;
  eligible: boolean;
  eligibleAt: string;
};

export type RebindQueue = { accounts: RebindQueueAccount[] };

export type RebindQueueBlocked = { id: string; email: string; reason: 'already' | 'not_found' | 'not_icloud' | 'too_new' | string; eligibleAt?: string };

export type RebindQueueAddResult = RebindQueue & { added: number; blocked: RebindQueueBlocked[] };

export type RebindStartBody = {
  assetIds: string[];
  provider: string;
  workerConcurrency: number;
  proxyAssignments: ProxyAssignment[];
  /** Auto re-login stale accounts with password + TOTP instead of failing (default true). */
  autoRefresh?: boolean;
  /** Always re-login fresh before rebinding, even when the stored token still works. */
  alwaysFreshLogin?: boolean;
  /** On a transport/proxy failure, retry on the next pool endpoint up to N times (default 2). */
  proxyRetries?: number;
  /** Replace the mailbox after a recipient mismatch or OTP timeout (default 1). */
  otpRetries?: number;
};

export type RebindStartResult = { ok: boolean; total: number; provider: string; workerConcurrency: number };
