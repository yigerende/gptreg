'use strict';

// SMS providers usually expose a quote when a number is allocated, but the
// quote is not proof that the activation was charged. Keep billing decisions
// in one pure module so registration and OAuth branches use the same rules.

const STATUS_RANK = Object.freeze({
  complete: 100,
  code_received: 90,
  received: 90,
  cancelled: 80,
  canceled: 80,
  missing: 80,
  released: 80,
  banned: 80,
  completion_pending: 60,
  pending_cleanup: 60,
  waiting_code: 40,
  waiting: 40,
  waiting_retry: 40,
  retry_requested: 40,
  sms_sent: 40,
  leased: 40,
  acquired: 20,
  reconciled: 20,
});

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'missing', 'released', 'banned']);
const CONSUMED_BILLING_STATUSES = new Set(['charged', 'consumed', 'complete', 'settled', 'finished']);
const REFUNDED_BILLING_STATUSES = new Set(['refunded', 'reversed', 'voided', 'fully_refunded']);
const CANCELLATION_SETTLEMENT_TOLERANCE = 0.000001;
// Outcomes that consume a settled activation without producing the
// verification it was bought for: the number was recycled, the code it
// delivered was rejected, or the attempt holding it was thrown away.
//
// An allow-list rather than "anything that is not `phone_verified`", because
// the ledger is read live and a record can be charged a moment before its
// terminal reason is written; a new discard path has to be added here to be
// counted.
const WASTED_SMS_REASON_CODES = new Map([
  // The recycled-number family: every member of the orchestrator's
  // `REPLACE_PHONE_CODES`, which is its own definition of "this number is
  // spent, get another one". Only `PHONE_RECENTLY_USED` was listed here, and
  // it is the one the flow never actually writes — 2254 releases across four
  // runs came back as PHONE_NUMBER_IN_USE or FRAUD_GUARD. They all cancel
  // before an SMS is delivered, so none of them was charged and no money was
  // missed; listed anyway so that a charged one lands in 浪费 rather than in
  // ordinary spend.
  ['PHONE_RECENTLY_USED', 'PHONE_RECENTLY_USED'],
  ['PHONE_NUMBER_IN_USE', 'PHONE_RECENTLY_USED'],
  ['PHONE_MAX_USAGE_EXCEEDED', 'PHONE_RECENTLY_USED'],
  ['INVALID_PHONE_NUMBER', 'PHONE_REJECTED'],
  ['FRAUD_GUARD', 'PHONE_REJECTED'],
  // Bought a number and no code ever arrived.
  ['SMS_CODE_TIMEOUT', 'SMS_CODE_TIMEOUT'],
  // The code did arrive, just after the poll deadline, and was found only by
  // the cleanup already cancelling the number. The orchestrator now hands such
  // a code to validation; this is what is left when it lands in the instant
  // between that read and the cancel. Charged, never entered — and not the
  // same thing as a code that never came.
  ['SMS_LATE_CODE', 'SMS_LATE_CODE'],
  // The code arrived and was rejected. Rare — one in 2616 activations — and
  // the only one of these that is regularly charged, because the SMS was
  // actually delivered.
  ['INVALID_INPUT', 'INVALID_INPUT'],
  ['INVALID_PHONE_OTP', 'INVALID_INPUT'],
  ['INVALID_OTP', 'INVALID_INPUT'],
  ['OTP_INVALID', 'INVALID_INPUT'],
  // The attempt restarted on a fresh exit and released the number it had
  // already paid for. Three of these went uncounted across the same four runs.
  ['PROXY_RESTART', 'PROXY_RESTART'],
  // Validation recovery decided the number was spent and asked for another.
  ['OAUTH_PHONE_VALIDATION_RECOVERY_REQUIRES_NEW_PHONE', 'PHONE_REPLACED'],
  // Acquired, charged, and then never needed.
  ['JOB_COMPLETED_WITHOUT_PHONE_CHALLENGE', 'PHONE_UNUSED'],
]);

function amount(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(6));
}

function closeEnough(left, right, tolerance = CANCELLATION_SETTLEMENT_TOLERANCE) {
  return Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function readAmount(record, keys) {
  const sources = [record, record?.billing, record?.providerBilling, record?.costs]
    .filter((source) => source && typeof source === 'object');
  for (const source of sources) {
    for (const key of keys) {
      const value = amount(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function readBoolean(record, keys) {
  const sources = [record, record?.billing, record?.providerBilling, record?.costs]
    .filter((source) => source && typeof source === 'object');
  let foundFalse = false;
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] === true) return true;
      if (source[key] === false) foundFalse = true;
    }
  }
  return foundFalse ? false : null;
}

function readText(record, keys) {
  const sources = [record, record?.billing, record?.providerBilling, record?.costs]
    .filter((source) => source && typeof source === 'object');
  for (const source of sources) {
    for (const key of keys) {
      const value = String(source[key] ?? '').trim();
      if (value) return value;
    }
  }
  return '';
}

function normalizedCurrency(value, fallback = 'USD') {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function currencyForTotals(currencyTotals, fallback = 'USD') {
  const currencies = Object.keys(currencyTotals || {})
    .map((currency) => String(currency || '').trim().toUpperCase())
    .filter((currency) => /^[A-Z]{3}$/.test(currency));
  if (currencies.length === 1) return currencies[0];
  if (currencies.length > 1) return 'MIXED';
  return normalizedCurrency(fallback);
}

function recordCurrency(record, fallback = 'USD') {
  const explicit = readText(record, ['currency', 'currencyCode', 'currency_code']);
  if (explicit) return normalizedCurrency(explicit, fallback);
  const provider = readText(record, ['provider', 'providerName', 'provider_name']).toLowerCase();
  return normalizedCurrency(provider === 'firefox' || provider === 'firefox-fun' || provider === 'firefox.fun' ? 'CNY' : fallback, fallback);
}

function normalizedStatus(record) {
  const value = String(record?.status || record?.providerStatus || '').trim().toLowerCase();
  return {
    access_cancel: 'cancelled',
    status_cancel: 'cancelled',
    status_finish: 'complete',
    access_activation: 'complete',
    status_ok: 'code_received',
  }[value] || value;
}

function billingStatus(record) {
  return String(
    record?.billingStatus
      ?? record?.billing_state
      ?? record?.billing?.status
      ?? record?.providerBilling?.status
      ?? '',
  ).trim().toLowerCase();
}

function activationId(record) {
  const value = record?.activationId ?? record?.activation_id ?? record?.id;
  return value === undefined || value === null || String(value).trim() === '' ? '' : String(value).trim();
}

function quotedAmount(record) {
  return readAmount(record, [
    'quotedUsd', 'quotedCostUsd', 'quotedCost', 'cost', 'price', 'activationCost',
    'activation_cost', 'amount',
  ]);
}

function chargedAmount(record) {
  return readAmount(record, [
    'consumedUsd', 'consumedCost', 'chargedUsd', 'chargedCost', 'actualCost',
    'actualCostUsd', 'finalCost', 'amountCharged', 'amount_charged',
  ]);
}

function refundAmount(record, quote) {
  const explicit = readAmount(record, [
    'refundedUsd', 'refundUsd', 'refundAmount', 'refund_amount', 'refundedAmount',
    'creditUsd', 'credit', 'returnedAmount', 'returned_amount',
  ]);
  if (explicit !== null) return explicit;
  const refunded = readBoolean(record, [
    'refunded', 'refundConfirmed', 'refund_confirmed', 'cancelRefunded',
    'cancel_refunded',
  ]);
  const state = billingStatus(record);
  if (refunded === true || REFUNDED_BILLING_STATUSES.has(state)) return quote ?? 0;
  return 0;
}

function hasFullRefundFlag(record) {
  const state = billingStatus(record);
  return readBoolean(record, [
    'refunded', 'refundConfirmed', 'refund_confirmed', 'cancelRefunded',
    'cancel_refunded',
  ]) === true || REFUNDED_BILLING_STATUSES.has(state);
}

function statusRank(status) {
  return STATUS_RANK[status] || 0;
}

function isConsumed(record, status, state) {
  if (readBoolean(record, ['consumed', 'charged', 'chargeConfirmed', 'charge_confirmed']) === true) return true;
  if (chargedAmount(record) !== null) return true;
  if (CONSUMED_BILLING_STATUSES.has(state)) return true;
  if (status === 'complete' || status === 'code_received' || status === 'received') return true;
  // Once the target accepted the code, cancellation is no longer a refund
  // path in either orchestrator; treat that activation as consumed.
  return record?.targetAccepted === true || record?.codeReceived === true;
}

function isCancelled(record, status, state) {
  if (CANCELLED_STATUSES.has(status)) return true;
  if (REFUNDED_BILLING_STATUSES.has(state)) return true;
  return readBoolean(record, ['cancelled', 'canceled']) === true;
}

function isTerminal(record, status, state) {
  return isConsumed(record, status, state) || isCancelled(record, status, state);
}

/**
 * Money spent on a number that bought no verification, in either leg.
 *
 * This used to return nothing unless the activation was `scope: 'oauth'`, so a
 * registration that hit a phone challenge and threw the paid number away was
 * charged for it and reported no waste at all — and on a register-then-OAuth
 * run that made 浪费 look like a mailbox-only figure.
 */
function wastedSmsReason(record, consumed) {
  if (!consumed) return '';
  const reason = String(record?.cleanupReason || record?.cancelReason || '').trim().toUpperCase();
  return WASTED_SMS_REASON_CODES.get(reason) || '';
}

function mergeRecords(previous, next) {
  const previousStatus = normalizedStatus(previous);
  const nextStatus = normalizedStatus(next);
  const previousRank = statusRank(previousStatus);
  const nextRank = statusRank(nextStatus);
  const selectedStatus = nextRank >= previousRank ? nextStatus : previousStatus;
  const merged = { ...previous, ...next };
  if (selectedStatus) merged.status = selectedStatus;

  // A later checkpoint can contain null/empty billing fields. Never discard a
  // usable quote or refund observed earlier for the same activation.
  const amountKeys = [
    'cost', 'price', 'activationCost', 'activation_cost', 'quotedUsd', 'quotedCostUsd',
    'consumedUsd', 'consumedCost', 'chargedUsd', 'chargedCost', 'actualCost',
    'actualCostUsd', 'finalCost', 'amountCharged', 'amount_charged', 'refundedUsd',
    'refundUsd', 'refundAmount', 'refund_amount', 'refundedAmount', 'creditUsd',
    'credit', 'returnedAmount', 'returned_amount',
  ];
  for (const key of amountKeys) {
    if (amount(next?.[key]) === null && amount(previous?.[key]) !== null) merged[key] = previous[key];
  }
  for (const key of ['consumed', 'charged', 'chargeConfirmed', 'charge_confirmed', 'refunded', 'refundConfirmed', 'refund_confirmed', 'cancelRefunded', 'cancel_refunded', 'targetAccepted', 'codeReceived']) {
    if (previous?.[key] === true) merged[key] = true;
  }
  // The terminal attempt can be followed by a sparse current snapshot for
  // the same activation. Keep the classification fields from the terminal
  // record so a later save cannot erase a confirmed waste reason.
  for (const key of ['scope', 'cleanupReason', 'cancelReason']) {
    if (!String(merged[key] || '').trim() && String(previous?.[key] || '').trim()) merged[key] = previous[key];
  }
  return merged;
}

function collectRecords(job = {}) {
  const sms = job.sms || {};
  const archivedAcquisitions = (Array.isArray(sms.acquisitions) ? sms.acquisitions : [])
    .filter((record) => {
      if (record?.activationId || record?.activation_id || quotedAmount(record) !== null) return true;
      const status = normalizedStatus(record);
      return record?.externalCleanup === true || ['abandoned_unresolved', 'cleanup_pending'].includes(status);
    });
  return [
    sms.acquisition,
    ...archivedAcquisitions,
    ...(Array.isArray(sms.attempts) ? sms.attempts : []),
    ...(Array.isArray(sms.pendingCleanup) ? sms.pendingCleanup : []),
    sms.current,
  ].filter((record) => record && typeof record === 'object');
}

function canonicalRecords(job = {}) {
  const byId = new Map();
  let anonymousIndex = 0;
  for (const record of collectRecords(job)) {
    const id = activationId(record) || `anonymous-${anonymousIndex += 1}`;
    const previous = byId.get(id);
    byId.set(id, previous ? mergeRecords(previous, record) : { ...record });
  }
  return [...byId.values()];
}

function summarizeRecord(record, options = {}) {
  const status = normalizedStatus(record);
  const state = billingStatus(record);
  const quoted = quotedAmount(record);
  const charged = chargedAmount(record);
  const base = charged ?? quoted;
  const refunded = Math.min(base ?? 0, Math.max(0, refundAmount(record, base)));
  const consumed = isConsumed(record, status, state);
  const cancelled = isCancelled(record, status, state);
  const terminal = isTerminal(record, status, state);
  const grossConsumed = consumed ? (charged ?? quoted ?? 0) : 0;
  const netConsumed = Math.max(0, grossConsumed - refunded);
  const unresolved = consumed || (cancelled && refunded >= (base ?? 0))
    ? 0
    : Math.max(0, (base ?? 0) - refunded);
  const billingUnresolved = consumed
    ? base === null
    : cancelled
      ? (base === null ? !hasFullRefundFlag(record) : refunded < base)
      : true;
  const cancelledUnresolved = cancelled ? unresolved : 0;
  const wastedReason = wastedSmsReason(record, consumed);
  const wasted = Boolean(wastedReason);
  return {
    id: activationId(record),
    currency: recordCurrency(record, normalizedCurrency(options.defaultCurrency)),
    status,
    quotedUsd: quoted ?? 0,
    grossConsumedUsd: grossConsumed,
    confirmedConsumedUsd: netConsumed,
    refundedUsd: refunded,
    unresolvedUsd: unresolved,
    cancelledUnresolvedUsd: cancelledUnresolved,
    cancelledQuotedUsd: cancelled ? (quoted ?? 0) : 0,
    activeQuotedUsd: !terminal ? (quoted ?? 0) : 0,
    billingUnresolved,
    terminal,
    consumed,
    cancelled,
    wasted,
    wastedReason,
    wastedConsumedUsd: wasted ? netConsumed : 0,
    hasAmount: base !== null,
    record,
  };
}

function emptyCurrencyTotals() {
  return {
    quoted: 0,
    grossConsumed: 0,
    confirmedConsumed: 0,
    refunded: 0,
    unresolved: 0,
    cancelledUnresolved: 0,
    cancelledQuoted: 0,
    activeQuoted: 0,
    wastedConsumed: 0,
  };
}

function addCurrencyTotals(target, record) {
  const currency = normalizedCurrency(record.currency);
  const bucket = target[currency] || (target[currency] = emptyCurrencyTotals());
  for (const [targetKey, sourceKey] of [
    ['quoted', 'quotedUsd'],
    ['grossConsumed', 'grossConsumedUsd'],
    ['confirmedConsumed', 'confirmedConsumedUsd'],
    ['refunded', 'refundedUsd'],
    ['unresolved', 'unresolvedUsd'],
    ['cancelledUnresolved', 'cancelledUnresolvedUsd'],
    ['cancelledQuoted', 'cancelledQuotedUsd'],
    ['activeQuoted', 'activeQuotedUsd'],
    ['wastedConsumed', 'wastedConsumedUsd'],
  ]) {
    bucket[targetKey] += Number(record[sourceKey] || 0);
  }
}

function roundCurrencyTotals(totals) {
  for (const bucket of Object.values(totals)) {
    for (const key of Object.keys(bucket)) bucket[key] = rounded(bucket[key]);
  }
  return totals;
}

function summarizeSmsCost(job = {}, options = {}) {
  const defaultCurrency = normalizedCurrency(options.defaultCurrency);
  const records = canonicalRecords(job).map((record) => summarizeRecord(record, { defaultCurrency }));
  const legacyCost = amount(job.sms?.costUsd) ?? 0;
  if (!records.length && legacyCost > 0) {
    // Older checkpoints only persisted costUsd. It was a quote accumulator,
    // so keep it conservative unless the job has success evidence.
    const legacyConsumed = Boolean(job.accountCreatedAt || job.sessionAssetId || job.cpaPath);
    records.push({
      id: '',
      currency: defaultCurrency,
      status: legacyConsumed ? 'complete' : 'unresolved',
      quotedUsd: legacyCost,
      grossConsumedUsd: legacyConsumed ? legacyCost : 0,
      confirmedConsumedUsd: legacyConsumed ? legacyCost : 0,
      refundedUsd: 0,
      unresolvedUsd: legacyConsumed ? 0 : legacyCost,
      cancelledUnresolvedUsd: 0,
      cancelledQuotedUsd: 0,
      activeQuotedUsd: legacyConsumed ? 0 : legacyCost,
      wastedConsumedUsd: 0,
      billingUnresolved: !legacyConsumed,
      terminal: legacyConsumed,
      consumed: legacyConsumed,
      cancelled: false,
      hasAmount: true,
      record: null,
    });
  } else if (records.length && legacyCost > 0) {
    // Keep old cost information visible when a provider omitted the quote in
    // its status response. Do not silently call it consumed.
    const missing = Math.max(0, legacyCost - records.reduce((sum, record) => sum + record.quotedUsd, 0));
    if (missing > 0) {
      records.push({
        id: '',
        currency: defaultCurrency,
        status: 'unresolved',
        quotedUsd: missing,
        grossConsumedUsd: 0,
        confirmedConsumedUsd: 0,
        refundedUsd: 0,
        unresolvedUsd: missing,
        cancelledUnresolvedUsd: 0,
        cancelledQuotedUsd: 0,
        activeQuotedUsd: missing,
        wastedConsumedUsd: 0,
        billingUnresolved: true,
        terminal: false,
        consumed: false,
        cancelled: false,
        hasAmount: true,
        record: null,
      });
    }
  }

  const totals = records.reduce((result, record) => {
    for (const key of ['quotedUsd', 'grossConsumedUsd', 'confirmedConsumedUsd', 'refundedUsd', 'unresolvedUsd', 'cancelledUnresolvedUsd', 'cancelledQuotedUsd', 'activeQuotedUsd', 'wastedConsumedUsd']) {
      result[key] += Number(record[key] || 0);
    }
    result.activationCount += 1;
    if (record.consumed && !record.billingUnresolved) result.confirmedActivationCount += 1;
    if (record.billingUnresolved) result.unresolvedActivationCount += 1;
    if (record.cancelled && record.billingUnresolved) result.cancelledUnresolvedActivationCount += 1;
    if (record.consumed) result.hasConsumed = true;
    if (record.cancelled) result.hasCancelled = true;
    if (record.wasted && record.wastedConsumedUsd > 0) {
      result.wastedActivationCount += 1;
      const reason = record.wastedReason || 'UNKNOWN';
      const entry = result.wastedReasons[reason] || { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += Number(record.wastedConsumedUsd || 0);
      result.wastedReasons[reason] = entry;
    }
    return result;
  }, {
    quotedUsd: 0,
    grossConsumedUsd: 0,
    confirmedConsumedUsd: 0,
    refundedUsd: 0,
    unresolvedUsd: 0,
    cancelledUnresolvedUsd: 0,
    cancelledQuotedUsd: 0,
    activeQuotedUsd: 0,
    activationCount: 0,
    confirmedActivationCount: 0,
    unresolvedActivationCount: 0,
    cancelledUnresolvedActivationCount: 0,
    wastedActivationCount: 0,
    wastedConsumedUsd: 0,
    wastedReasons: {},
    hasConsumed: false,
    hasCancelled: false,
  });
  for (const key of ['quotedUsd', 'grossConsumedUsd', 'confirmedConsumedUsd', 'refundedUsd', 'unresolvedUsd', 'cancelledUnresolvedUsd', 'cancelledQuotedUsd', 'activeQuotedUsd', 'wastedConsumedUsd']) {
    totals[key] = rounded(totals[key]);
  }
  for (const entry of Object.values(totals.wastedReasons)) entry.amount = rounded(entry.amount);
  const currencyTotals = {};
  for (const record of records) addCurrencyTotals(currencyTotals, record);
  roundCurrencyTotals(currencyTotals);
  const currency = currencyForTotals(currencyTotals, defaultCurrency);
  const hasData = totals.activationCount > 0;
  const billingComplete = !hasData || (
    totals.unresolvedUsd === 0
    && totals.unresolvedActivationCount === 0
    && totals.activeQuotedUsd === 0
  );
  const cancellationOnlyUnresolved = totals.unresolvedActivationCount > 0
    && totals.unresolvedActivationCount === totals.cancelledUnresolvedActivationCount
    && closeEnough(totals.unresolvedUsd, totals.cancelledUnresolvedUsd);
  let status = 'not_used';
  if (totals.unresolvedActivationCount > 0) status = totals.hasCancelled ? 'needs_review' : 'pending';
  else if (totals.confirmedConsumedUsd > 0) status = totals.refundedUsd > 0 ? 'partially_refunded' : 'confirmed';
  else if (hasData && totals.refundedUsd > 0) status = 'refunded';
  else if (hasData) status = 'settled';
  return { ...totals, currency, currencyTotals, hasData, billingComplete, cancellationOnlyUnresolved, status,
    ...(options.includeRecords ? { records } : {}) };
}

/**
 * Build the cancellation-only portion of a balance reconciliation from one
 * SMS aggregate. Keeping this mapping here prevents the two orchestrators and
 * the UI run manager from quietly applying different currency or job rules.
 */
function cancellationDetailsForBalance(smsBilling = {}, currency = 'USD') {
  const requestedCurrency = String(currency || '').trim().toUpperCase();
  // MIXED (or an absent currency) must never be treated as a real account
  // currency; otherwise a malformed reconciliation could settle a quote from
  // the wrong bucket.
  if (!/^[A-Z]{3}$/.test(requestedCurrency)) {
    return {
      unresolved: 0,
      cancelledUnresolved: 0,
      cancellationOnlyUnresolved: false,
      cancelledUnresolvedByJob: {},
    };
  }
  const expectedCurrency = requestedCurrency;
  const canAttribute = String(smsBilling?.currency || '').toUpperCase() === expectedCurrency;
  const current = smsBilling?.currencyTotals?.[expectedCurrency] || {};
  const unresolved = canAttribute
    ? Number(smsBilling?.unresolvedUsd || 0)
    : 0;
  const cancelledUnresolved = canAttribute
    ? Number(smsBilling?.cancelledUnresolvedUsd || current.cancelledUnresolved || 0)
    : 0;
  const cancelledUnresolvedByJob = canAttribute
    ? Object.fromEntries((Array.isArray(smsBilling?.ledgers) ? smsBilling.ledgers : [])
      .filter(({ ledger }) => ledger?.currency === expectedCurrency && Number(ledger?.cancelledUnresolvedUsd || 0) > 0)
      .map(({ job, ledger }) => [String(job?.id || ''), Number(ledger.cancelledUnresolvedUsd || 0)])
      .filter(([jobId]) => jobId))
    : {};
  return {
    unresolved,
    cancelledUnresolved,
    cancellationOnlyUnresolved: canAttribute
      && smsBilling?.cancellationOnlyUnresolved === true
      && unresolved > CANCELLATION_SETTLEMENT_TOLERANCE
      && closeEnough(unresolved, cancelledUnresolved),
    cancelledUnresolvedByJob,
  };
}

function settleCancelledQuotes(ledger, requestedAmount) {
  const requested = amount(requestedAmount) ?? 0;
  const available = Number(ledger?.cancelledUnresolvedUsd || 0);
  const applied = Math.min(requested, Math.max(0, available));
  if (applied <= CANCELLATION_SETTLEMENT_TOLERANCE) return ledger;

  const remaining = rounded(Math.max(0, available - applied));
  const fullySettled = remaining <= CANCELLATION_SETTLEMENT_TOLERANCE;
  const next = {
    ...ledger,
    unresolvedUsd: rounded(Math.max(0, Number(ledger.unresolvedUsd || 0) - applied)),
    cancelledUnresolvedUsd: remaining,
    unresolvedActivationCount: fullySettled
      ? Math.max(0, Number(ledger.unresolvedActivationCount || 0) - Number(ledger.cancelledUnresolvedActivationCount || 0))
      : Number(ledger.unresolvedActivationCount || 0),
    cancelledUnresolvedActivationCount: fullySettled
      ? 0
      : Number(ledger.cancelledUnresolvedActivationCount || 0),
  };
  // Consumers requesting operational statistics must see the same reconciled
  // amounts as the totals, including cancelled quotes proven not to be billed.
  if (ledger.records) {
    let remainingApplied = applied;
    next.records = ledger.records.map(record => {
      if (record.currency !== ledger.currency || !record.cancelled || !record.billingUnresolved) return record;
      const settled = Math.min(remainingApplied, record.cancelledUnresolvedUsd);
      remainingApplied = rounded(Math.max(0, remainingApplied - settled));
      if (!settled) return record;
      const unresolvedUsd = rounded(Math.max(0, record.unresolvedUsd - settled));
      return { ...record, unresolvedUsd, cancelledUnresolvedUsd: unresolvedUsd,
        billingUnresolved: unresolvedUsd > CANCELLATION_SETTLEMENT_TOLERANCE };
    });
  }
  if (next.currencyTotals && typeof next.currencyTotals === 'object') {
    const bucket = next.currencyTotals[next.currency];
    if (bucket) {
      next.currencyTotals = {
        ...next.currencyTotals,
        [next.currency]: {
          ...bucket,
          unresolved: rounded(Math.max(0, Number(bucket.unresolved || 0) - applied)),
          cancelledUnresolved: rounded(Math.max(0, Number(bucket.cancelledUnresolved || 0) - applied)),
        },
      };
    }
  }
  next.cancellationOnlyUnresolved = false;
  next.billingComplete = !next.activationCount || (
    next.unresolvedUsd <= CANCELLATION_SETTLEMENT_TOLERANCE
    && next.unresolvedActivationCount === 0
    && Number(next.activeQuotedUsd || 0) <= CANCELLATION_SETTLEMENT_TOLERANCE
  );
  if (next.unresolvedActivationCount > 0) next.status = next.hasCancelled ? 'needs_review' : 'pending';
  else if (next.confirmedConsumedUsd > 0) next.status = next.refundedUsd > 0 ? 'partially_refunded' : 'confirmed';
  else if (next.hasData && next.refundedUsd > 0) next.status = 'refunded';
  else if (next.hasData) next.status = 'settled';
  else next.status = 'not_used';
  return next;
}

function summarizeSmsCosts(jobs = [], options = {}) {
  const defaultCurrency = normalizedCurrency(options.defaultCurrency);
  const rawLedgers = (Array.isArray(jobs) ? jobs : []).map((job) => ({ job, ledger: summarizeSmsCost(job, { defaultCurrency, includeRecords: options.includeRecords }) }));
  const settledByJob = options.settledCancelledQuotesByJob && typeof options.settledCancelledQuotesByJob === 'object'
    ? options.settledCancelledQuotesByJob
    : null;
  const hasSettledByJob = Boolean(settledByJob);
  const settlementCurrency = normalizedCurrency(options.settledCancelledQuotesCurrency || defaultCurrency);
  let remainingSettlement = amount(options.settledCancelledQuotesUsd) ?? 0;
  const ledgers = rawLedgers.map(({ job, ledger }) => {
    if (hasSettledByJob) {
      return {
        job,
        ledger: settleCancelledQuotes(ledger, settledByJob[String(job?.id || '')]),
      };
    }
    if (remainingSettlement <= CANCELLATION_SETTLEMENT_TOLERANCE || ledger.currency !== settlementCurrency) {
      return { job, ledger };
    }
    const applied = Math.min(remainingSettlement, Number(ledger.cancelledUnresolvedUsd || 0));
    remainingSettlement = rounded(Math.max(0, remainingSettlement - applied));
    return { job, ledger: settleCancelledQuotes(ledger, applied) };
  });
  const currencyTotals = {};
  const aggregate = ledgers.reduce((result, { ledger }) => {
    for (const key of ['quotedUsd', 'grossConsumedUsd', 'confirmedConsumedUsd', 'refundedUsd', 'unresolvedUsd', 'cancelledUnresolvedUsd', 'cancelledQuotedUsd', 'activeQuotedUsd', 'wastedConsumedUsd']) {
      result[key] += ledger[key];
    }
    result.activationCount += ledger.activationCount;
    result.confirmedActivationCount += ledger.confirmedActivationCount;
    result.unresolvedActivationCount += ledger.unresolvedActivationCount;
    result.cancelledUnresolvedActivationCount += ledger.cancelledUnresolvedActivationCount;
    result.wastedActivationCount += ledger.wastedActivationCount;
    for (const [reason, entry] of Object.entries(ledger.wastedReasons || {})) {
      const target = result.wastedReasons[reason] || { count: 0, amount: 0 };
      target.count += Number(entry.count || 0);
      target.amount += Number(entry.amount || 0);
      result.wastedReasons[reason] = target;
    }
    if (ledger.confirmedActivationCount > 0) result.accountedJobs += 1;
    if (ledger.unresolvedActivationCount > 0) result.unresolvedJobs += 1;
    if (ledger.hasData) result.jobsWithSms += 1;
    for (const [currency, bucket] of Object.entries(ledger.currencyTotals || {})) {
      const target = currencyTotals[currency] || (currencyTotals[currency] = emptyCurrencyTotals());
      for (const key of Object.keys(target)) target[key] += Number(bucket[key] || 0);
    }
    return result;
  }, {
    quotedUsd: 0,
    grossConsumedUsd: 0,
    confirmedConsumedUsd: 0,
    refundedUsd: 0,
    unresolvedUsd: 0,
    cancelledUnresolvedUsd: 0,
    cancelledQuotedUsd: 0,
    activeQuotedUsd: 0,
    activationCount: 0,
    confirmedActivationCount: 0,
    unresolvedActivationCount: 0,
    cancelledUnresolvedActivationCount: 0,
    wastedActivationCount: 0,
    wastedConsumedUsd: 0,
    wastedReasons: {},
    accountedJobs: 0,
    unresolvedJobs: 0,
    jobsWithSms: 0,
  });
  for (const key of ['quotedUsd', 'grossConsumedUsd', 'confirmedConsumedUsd', 'refundedUsd', 'unresolvedUsd', 'cancelledUnresolvedUsd', 'cancelledQuotedUsd', 'activeQuotedUsd', 'wastedConsumedUsd']) {
    aggregate[key] = rounded(aggregate[key]);
  }
  for (const entry of Object.values(aggregate.wastedReasons)) entry.amount = rounded(entry.amount);
  roundCurrencyTotals(currencyTotals);
  aggregate.billingComplete = ledgers.every(({ ledger }) => ledger.billingComplete);
  aggregate.cancellationOnlyUnresolved = aggregate.unresolvedActivationCount > 0
    && aggregate.unresolvedActivationCount === aggregate.cancelledUnresolvedActivationCount
    && closeEnough(aggregate.unresolvedUsd, aggregate.cancelledUnresolvedUsd);
  return {
    ...aggregate,
    currency: currencyForTotals(currencyTotals, defaultCurrency),
    currencyTotals,
    ledgers,
  };
}

module.exports = {
  WASTED_SMS_REASON_CODES,
  cancellationDetailsForBalance,
  summarizeSmsCost,
  summarizeSmsCosts,
};
