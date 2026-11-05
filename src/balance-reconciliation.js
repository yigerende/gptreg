'use strict';

const crypto = require('node:crypto');

const BALANCE_RECONCILIATION_SCHEMA_VERSION = 1;
const BALANCE_RECONCILIATION_TOLERANCE = 0.000001;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value) {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(6));
}

function closeEnough(left, right, tolerance = BALANCE_RECONCILIATION_TOLERANCE) {
  return finiteNumber(left) !== null
    && finiteNumber(right) !== null
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function iso(now = Date.now()) {
  return new Date(typeof now === 'function' ? now() : now).toISOString();
}

function providerName(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'sms-bower') return 'smsbower';
  if (provider === 'firefox-fun' || provider === 'firefox.fun') return 'firefox';
  return provider;
}

function currencyName(value, provider = '') {
  const currency = String(value || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  return providerName(provider) === 'firefox' ? 'CNY' : 'USD';
}

function knownAccountFingerprint(value) {
  const fingerprint = String(value || '').trim();
  return Boolean(fingerprint) && !fingerprint.endsWith(':unknown');
}

function accountFingerprintConflict(existing, incoming) {
  return knownAccountFingerprint(existing)
    && knownAccountFingerprint(incoming)
    && existing !== incoming;
}

function mergedAccountFingerprint(existing, incoming) {
  if (knownAccountFingerprint(existing)) return existing;
  if (knownAccountFingerprint(incoming)) return incoming;
  return existing || incoming || '';
}

/**
 * Returns a process-local account key for concurrency attribution. The secret
 * itself never enters task state or logs; only a short digest is retained in
 * the active run object.
 */
function balanceAccountFingerprint(provider) {
  const name = providerName(provider?.name || provider?.provider);
  if (!name) return '';
  let secret = String(provider?.apiKey || provider?.token || '').trim();
  if (!secret && provider?.apiKeyEnv) secret = String(process.env[provider.apiKeyEnv] || '').trim();
  if (!secret) return `${name}:unknown`;
  const digest = crypto.createHash('sha256').update(`${name}\0${secret}`).digest('hex').slice(0, 24);
  return `${name}:${digest}`;
}

function balanceSnapshot(summary = {}, now = Date.now(), options = {}) {
  if (!summary || summary.checked !== true) return null;
  const provider = providerName(summary.provider);
  if (!provider) return null;
  const startBalance = finiteNumber(summary.balance);
  return {
    schemaVersion: BALANCE_RECONCILIATION_SCHEMA_VERSION,
    provider,
    currency: currencyName(summary.currency, provider),
    accountFingerprint: String(options.accountFingerprint || summary.accountFingerprint || ''),
    startBalance,
    startCheckedAt: String(summary.checkedAt || iso(now)),
    startSource: String(summary.source || 'task_preflight'),
    startError: String(summary.errorCode || ''),
    endBalance: null,
    endAccountFingerprint: '',
    retryable: false,
    accountChanged: false,
    endCheckedAt: '',
    observedDecrease: null,
    confirmedConsumed: null,
    unresolved: null,
    difference: null,
    tolerance: BALANCE_RECONCILIATION_TOLERANCE,
    billingComplete: null,
    concurrent: false,
    concurrentRunIds: [],
    status: 'pending',
    note: startBalance === null ? 'start_balance_unavailable' : '',
    manualReviewRequired: false,
    error: null,
    finalizedAt: '',
  };
}

/** Record the first usable balance; later runtime checks never reset it. */
function recordBalanceStart(state, summary, now = Date.now(), options = {}) {
  const existing = state?.balanceReconciliation;
  if (existing?.finalizedAt) return existing;
  const snapshot = balanceSnapshot(summary, now, options);
  if (!snapshot) return existing || null;
  // A provider without a balance reader (for example the test mock) does not
  // create a meaningless permanent "pending" panel in every task.
  if (snapshot.startBalance === null && options.hasReader === false) return existing || null;
  if (existing && typeof existing === 'object') {
    const existingProvider = providerName(existing.provider);
    if (existingProvider && snapshot.provider && existingProvider !== snapshot.provider) return existing;
    const existingAccount = String(existing.accountFingerprint || '').trim();
    const incomingAccount = String(snapshot.accountFingerprint || '').trim();
    if (accountFingerprintConflict(existingAccount, incomingAccount)) return existing;
    const hasStart = finiteNumber(existing.startBalance) !== null;
    const incomingStart = finiteNumber(snapshot.startBalance);
    state.balanceReconciliation = {
      ...existing,
      provider: existingProvider || snapshot.provider,
      currency: existing.currency || snapshot.currency,
      accountFingerprint: mergedAccountFingerprint(existingAccount, incomingAccount),
      ...(hasStart ? {} : {
        startBalance: snapshot.startBalance,
        startCheckedAt: incomingStart === null
          ? (existing.startCheckedAt || snapshot.startCheckedAt)
          : snapshot.startCheckedAt,
        startSource: incomingStart === null
          ? (existing.startSource || snapshot.startSource)
          : snapshot.startSource,
      }),
      // A later successful read repairs the initial transient failure. Keeping
      // the old error would make finalization report an unavailable start
      // balance even though `startBalance` is now usable.
      startError: hasStart || incomingStart !== null
        ? ''
        : String(snapshot.startError || existing.startError || ''),
      note: hasStart ? existing.note : snapshot.note,
    };
    return state.balanceReconciliation;
  }
  state.balanceReconciliation = snapshot;
  return state.balanceReconciliation;
}

function uniqueRunIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

/**
 * A cancellation quote is not a charge. It can be removed from the pending
 * amount when the task's balance read proves that the only observed decrease
 * is the already confirmed consumption. This deliberately refuses to infer a
 * refund when another unresolved billing item, concurrent run, or account
 * switch could explain the numbers.
 */
function cancellationQuoteSettlementAmount(current, details = {}) {
  const explicit = finiteNumber(current?.cancelledQuotesSettledByBalance);
  const unresolved = finiteNumber(details.unresolved);
  const cancelledUnresolved = finiteNumber(details.cancelledUnresolved);
  if (explicit !== null) return Math.min(Math.max(0, explicit), Math.max(0, cancelledUnresolved || 0));

  const observedDecrease = finiteNumber(details.observedDecrease ?? current?.observedDecrease);
  const confirmedConsumed = finiteNumber(details.confirmedConsumed ?? current?.confirmedConsumed);
  const difference = finiteNumber(details.difference ?? current?.difference)
    ?? (observedDecrease !== null && confirmedConsumed !== null
      ? rounded(observedDecrease - confirmedConsumed)
      : null);
  const endBalanceWasRead = Object.hasOwn(details, 'endBalance')
    ? finiteNumber(details.endBalance) !== null
    : Boolean(current?.finalizedAt || current?.status === 'matched');
  const accountChanged = details.accountChanged === true || current?.accountChanged === true;
  const concurrent = details.concurrent === true || current?.concurrent === true;
  const currencyMismatch = details.currencyMismatch === true;
  const errorCode = String(details.errorCode || '').trim();
  const cancellationOnly = details.cancellationOnlyUnresolved === true;
  if (!endBalanceWasRead
    || errorCode
    || accountChanged
    || concurrent
    || currencyMismatch
    || !cancellationOnly
    || unresolved === null
    || cancelledUnresolved === null
    || cancelledUnresolved <= BALANCE_RECONCILIATION_TOLERANCE
    || !closeEnough(unresolved, cancelledUnresolved)
    || difference === null
    || Math.abs(difference) > BALANCE_RECONCILIATION_TOLERANCE) {
    return 0;
  }
  return rounded(cancelledUnresolved);
}

function normalizedSettledQuotesByJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [jobId, rawAmount] of Object.entries(value)) {
    const normalizedJobId = String(jobId || '').trim();
    const normalizedAmount = finiteNumber(rawAmount);
    if (normalizedJobId && normalizedAmount !== null && normalizedAmount > 0) {
      result[normalizedJobId] = rounded(normalizedAmount);
    }
  }
  return Object.keys(result).length ? result : null;
}

function applyBalanceCancellationSettlement(current, details = {}) {
  if (!current || typeof current !== 'object') return current;
  const unresolved = finiteNumber(details.unresolved ?? current.unresolved);
  const settled = cancellationQuoteSettlementAmount(current, {
    ...details,
    unresolved,
  });
  if (settled <= BALANCE_RECONCILIATION_TOLERANCE) return current;

  const byJob = normalizedSettledQuotesByJob(
    details.cancelledUnresolvedByJob || current.cancelledQuotesSettledByJob,
  );
  return {
    ...current,
    unresolved: 0,
    billingComplete: true,
    status: 'matched',
    note: 'balance_matched_cancelled_quotes_excluded',
    cancelledQuotesSettledByBalance: settled,
    unresolvedBeforeBalanceSettlement: unresolved,
    ...(byJob ? { cancelledQuotesSettledByJob: byJob } : {}),
  };
}

function finalizeBalanceReconciliation(current, details = {}, now = Date.now()) {
  if (!current || typeof current !== 'object') return null;
  if (current.finalizedAt) return current;

  const startBalance = finiteNumber(current.startBalance);
  const endBalance = finiteNumber(details.endBalance);
  const startAccountFingerprint = String(current.accountFingerprint || '').trim();
  const endAccountFingerprint = String(details.endAccountFingerprint || '').trim();
  const accountChanged = knownAccountFingerprint(startAccountFingerprint)
    && knownAccountFingerprint(endAccountFingerprint)
    && startAccountFingerprint !== endAccountFingerprint;
  const confirmedConsumed = rounded(details.confirmedConsumed);
  const unresolved = rounded(details.unresolved);
  const concurrentRunIds = uniqueRunIds(details.concurrentRunIds);
  const concurrent = details.concurrent === true || concurrentRunIds.length > 0;
  const billingComplete = details.billingComplete === true;
  const currencyMismatch = details.currencyMismatch === true;
  const observedDecrease = !accountChanged && startBalance !== null && endBalance !== null
    ? rounded(startBalance - endBalance)
    : null;
  // A balance that went up is a top-up, not spending. Comparing it against the
  // task's confirmed charges produces a large negative difference, which the
  // final branch below would have reported as "金额不一致" — an alarm about a
  // deposit. It gets its own verdict instead.
  const balanceIncreased = observedDecrease !== null && observedDecrease < -BALANCE_RECONCILIATION_TOLERANCE;
  const difference = !accountChanged && observedDecrease !== null && confirmedConsumed !== null
    ? rounded(observedDecrease - confirmedConsumed)
    : null;
  const cancelledUnresolved = rounded(details.cancelledUnresolved);
  const cancellationOnlyUnresolved = details.cancellationOnlyUnresolved === true;
  const cancelledQuotesSettledByBalance = cancellationQuoteSettlementAmount(current, {
    ...details,
    endBalance,
    accountChanged,
    concurrent,
    observedDecrease,
    confirmedConsumed,
    difference,
    unresolved,
    cancelledUnresolved,
    cancellationOnlyUnresolved,
  });
  const effectiveUnresolved = cancelledQuotesSettledByBalance > BALANCE_RECONCILIATION_TOLERANCE
    ? 0
    : unresolved;
  const effectiveBillingComplete = cancelledQuotesSettledByBalance > BALANCE_RECONCILIATION_TOLERANCE
    ? true
    : billingComplete;
  const endCheckedAt = String(details.endCheckedAt || iso(now));
  const startError = String(current.startError || '').trim();
  const endError = String(details.errorCode || '').trim();
  let status = 'pending';
  let note = '';
  let manualReviewRequired = false;
  if (endError) {
    note = 'end_balance_unavailable';
  } else if (startError || startBalance === null) {
    status = 'manual_review';
    manualReviewRequired = true;
    note = 'start_balance_unavailable';
  } else if (endBalance === null) {
    note = 'end_balance_unavailable';
  } else if (accountChanged) {
    note = 'balance_account_changed';
  } else if (concurrent) {
    status = 'concurrent';
    note = 'shared_balance_account_during_run';
  } else if (currencyMismatch) {
    note = 'task_amount_currency_mismatch';
  } else if (!effectiveBillingComplete || (effectiveUnresolved !== null && effectiveUnresolved > BALANCE_RECONCILIATION_TOLERANCE)) {
    note = 'billing_incomplete';
  } else if (balanceIncreased) {
    note = 'balance_increased_during_run';
  } else if (difference === null) {
    // Nothing to compare against: the balances read cleanly but the task
    // recorded no confirmed charge. Calling that a mismatch invents a
    // disagreement between one number and no number.
    note = 'confirmed_amount_unavailable';
  } else if (Math.abs(difference) <= BALANCE_RECONCILIATION_TOLERANCE) {
    status = 'matched';
    note = 'balance_decrease_matches_confirmed_consumption';
  } else {
    status = 'mismatch';
    note = 'balance_decrease_differs_from_confirmed_consumption';
  }
  if (cancelledQuotesSettledByBalance > BALANCE_RECONCILIATION_TOLERANCE && status === 'matched') {
    note = 'balance_matched_cancelled_quotes_excluded';
  }
  // A balance the reader could not return is not a verdict, and stamping
  // `finalizedAt` on it made the record permanent: the finalize path refuses to
  // run twice, so one transient API failure at task end froze the panel on
  // "待核对" for good — while its own copy promised a later reconciliation that
  // nothing could ever perform. Left unfinalized, the record stays honest and a
  // retry remains possible.
  const retryable = Boolean(endError) || (endBalance === null && !accountChanged && startBalance !== null);
  return {
    ...current,
    endAccountFingerprint,
    accountChanged,
    endBalance,
    endCheckedAt,
    retryable,
    observedDecrease,
    confirmedConsumed,
    unresolved: effectiveUnresolved,
    difference,
    tolerance: BALANCE_RECONCILIATION_TOLERANCE,
    billingComplete: effectiveBillingComplete,
    concurrent,
    concurrentRunIds,
    status,
    note,
    manualReviewRequired,
    error: endError || startError ? { code: endError || startError } : null,
    finalizedAt: retryable ? '' : endCheckedAt,
    ...(cancelledQuotesSettledByBalance > BALANCE_RECONCILIATION_TOLERANCE ? {
      cancelledQuotesSettledByBalance,
      unresolvedBeforeBalanceSettlement: unresolved,
      ...(normalizedSettledQuotesByJob(details.cancelledUnresolvedByJob)
        ? { cancelledQuotesSettledByJob: normalizedSettledQuotesByJob(details.cancelledUnresolvedByJob) }
        : {}),
    } : {}),
  };
}

module.exports = {
  BALANCE_RECONCILIATION_TOLERANCE,
  balanceAccountFingerprint,
  applyBalanceCancellationSettlement,
  currencyName,
  cancellationQuoteSettlementAmount,
  finalizeBalanceReconciliation,
  finiteNumber,
  providerName,
  recordBalanceStart,
};
