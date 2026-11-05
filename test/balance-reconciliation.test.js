'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BALANCE_RECONCILIATION_TOLERANCE,
  balanceAccountFingerprint,
  finalizeBalanceReconciliation,
  recordBalanceStart,
} = require('../src/balance-reconciliation');
const { summarizeSmsCosts } = require('../src/sms-cost-ledger');
const { financialAmounts, stateUsesBalanceAccount } = require('../src/ui-server/run-manager');

function summary(provider, balance, currency = 'USD') {
  return {
    checked: true,
    provider,
    balance,
    currency,
    checkedAt: '2026-08-31T00:00:00.000Z',
    source: 'test',
  };
}

test('balance reconciliation keeps the first snapshot and matches confirmed task charges', () => {
  const state = {};
  const first = recordBalanceStart(state, summary('smsbower', 10), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:test',
  });
  recordBalanceStart(state, summary('smsbower', 8), 1, {
    hasReader: true,
    accountFingerprint: 'smsbower:test',
  });

  assert.equal(first.startBalance, 10);
  assert.equal(state.balanceReconciliation.startBalance, 10);
  const result = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 9.75,
    endAccountFingerprint: 'smsbower:test',
    confirmedConsumed: 0.25,
    unresolved: 0,
    billingComplete: true,
    endCheckedAt: '2026-08-31T00:00:10.000Z',
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.observedDecrease, 0.25);
  assert.equal(result.difference, 0);
  assert.equal(result.accountChanged, false);
});

test('balance reconciliation distinguishes a real mismatch from an unresolved bill', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 2), 0, { hasReader: true });

  const mismatch = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 1.5,
    confirmedConsumed: 0.25,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(mismatch.status, 'mismatch');
  assert.ok(Math.abs(mismatch.difference - 0.25) <= BALANCE_RECONCILIATION_TOLERANCE);

  const pendingState = {};
  recordBalanceStart(pendingState, summary('smsbower', 2), 0, { hasReader: true });
  const pending = finalizeBalanceReconciliation(pendingState.balanceReconciliation, {
    endBalance: 1.75,
    confirmedConsumed: 0,
    unresolved: 0.25,
    billingComplete: false,
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.note, 'billing_incomplete');
});

test('matching confirmed consumption excludes cancellation quotes from the unresolved amount', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 1.009), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:test',
  });

  const result = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 0.679,
    endAccountFingerprint: 'smsbower:test',
    confirmedConsumed: 0.33,
    unresolved: 0.495,
    cancelledUnresolved: 0.495,
    cancellationOnlyUnresolved: true,
    cancelledUnresolvedByJob: { cancelled: 0.495 },
    billingComplete: false,
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.note, 'balance_matched_cancelled_quotes_excluded');
  assert.equal(result.observedDecrease, 0.33);
  assert.equal(result.difference, 0);
  assert.equal(result.unresolved, 0);
  assert.equal(result.billingComplete, true);
  assert.equal(result.cancelledQuotesSettledByBalance, 0.495);
  assert.equal(result.unresolvedBeforeBalanceSettlement, 0.495);
  assert.deepEqual(result.cancelledQuotesSettledByJob, { cancelled: 0.495 });
});

test('an unverified cancellation quote stays pending for supplier review', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 1.009), 0, { hasReader: true });

  const result = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 0.6,
    confirmedConsumed: 0.33,
    unresolved: 0.495,
    cancelledUnresolved: 0.495,
    cancellationOnlyUnresolved: true,
    billingComplete: false,
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.note, 'billing_incomplete');
  assert.equal(result.unresolved, 0.495);
  assert.equal(result.cancelledQuotesSettledByBalance, undefined);
});

test('balance reconciliation requires manual review when the start snapshot is unavailable', () => {
  const startState = {};
  recordBalanceStart(startState, {
    ...summary('firefox', null, 'CNY'),
    errorCode: 'FIREFOX_RATE_LIMIT',
  }, 0, { hasReader: true });
  const startUnavailable = finalizeBalanceReconciliation(startState.balanceReconciliation, {
    endBalance: 1,
    confirmedConsumed: 0,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(startUnavailable.status, 'manual_review');
  assert.equal(startUnavailable.note, 'start_balance_unavailable');
  assert.equal(startUnavailable.manualReviewRequired, true);
  assert.equal(startUnavailable.retryable, false);
  assert.notEqual(startUnavailable.finalizedAt, '');
  assert.equal(startUnavailable.error.code, 'FIREFOX_RATE_LIMIT');

  const endState = {};
  recordBalanceStart(endState, summary('firefox', 1, 'CNY'), 0, { hasReader: true });
  const endUnavailable = finalizeBalanceReconciliation(endState.balanceReconciliation, {
    endBalance: null,
    errorCode: 'FIREFOX_RATE_LIMIT',
    confirmedConsumed: 0,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(endUnavailable.status, 'pending');
  assert.equal(endUnavailable.note, 'end_balance_unavailable');
  assert.equal(endUnavailable.retryable, true);
  assert.equal(endUnavailable.finalizedAt, '');
});

test('an unreadable end balance stays retryable instead of freezing as a verdict', () => {
  const state = {};
  recordBalanceStart(state, summary('firefox', 12, 'CNY'), 0, { hasReader: true });
  const stalled = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: null,
    errorCode: 'FIREFOX_RATE_LIMIT',
    confirmedConsumed: 0.5,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(stalled.status, 'pending');
  assert.equal(stalled.note, 'end_balance_unavailable');
  // The finalize path refuses to run on an already finalized record, so
  // stamping this one would have made a transient read failure permanent.
  assert.equal(stalled.retryable, true);
  assert.equal(stalled.finalizedAt, '');

  const retried = finalizeBalanceReconciliation(stalled, {
    endBalance: 11.5,
    confirmedConsumed: 0.5,
    unresolved: 0,
    billingComplete: true,
    endCheckedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(retried.status, 'matched');
  assert.equal(retried.retryable, false);
  assert.equal(retried.finalizedAt, '2026-01-01T00:00:00.000Z');
  // A settled verdict is still write-once.
  assert.equal(finalizeBalanceReconciliation(retried, { endBalance: 1 }), retried);
});

test('a later successful start read clears the earlier transient error', () => {
  const state = {};
  recordBalanceStart(state, {
    ...summary('firefox', null, 'CNY'),
    errorCode: 'FIREFOX_RATE_LIMIT',
  }, 0, { hasReader: true, accountFingerprint: 'firefox:test' });
  recordBalanceStart(state, summary('firefox', 12, 'CNY'), 1, {
    hasReader: true,
    accountFingerprint: 'firefox:test',
  });

  assert.equal(state.balanceReconciliation.startBalance, 12);
  assert.equal(state.balanceReconciliation.startError, '');
  assert.equal(state.balanceReconciliation.startCheckedAt, summary('firefox', 12, 'CNY').checkedAt);

  const result = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 11.5,
    endAccountFingerprint: 'firefox:test',
    confirmedConsumed: 0.5,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.note, 'balance_decrease_matches_confirmed_consumption');
});

test('a top-up during the run is reported as a deposit, not as a mismatch', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 2), 0, { hasReader: true });
  const toppedUp = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 20,
    confirmedConsumed: 0.25,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(toppedUp.observedDecrease, -18);
  // Comparing a deposit against the task's charges yields a large negative
  // difference, which used to be announced as "金额不一致".
  assert.equal(toppedUp.status, 'pending');
  assert.equal(toppedUp.note, 'balance_increased_during_run');
});

test('a clean pair of balances with no confirmed charge is not called a mismatch', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 5), 0, { hasReader: true });
  const noCharge = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 4.5,
    confirmedConsumed: null,
    unresolved: 0,
    billingComplete: true,
  });
  assert.equal(noCharge.difference, null);
  assert.equal(noCharge.status, 'pending');
  assert.equal(noCharge.note, 'confirmed_amount_unavailable');
});

test('balance reconciliation refuses to compare balances after the account changes', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 10), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:original',
  });

  const result = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: 9.75,
    endAccountFingerprint: 'smsbower:replacement',
    confirmedConsumed: 0.25,
    unresolved: 0,
    billingComplete: true,
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.note, 'balance_account_changed');
  assert.equal(result.accountChanged, true);
  assert.equal(result.endAccountFingerprint, 'smsbower:replacement');
  assert.equal(result.observedDecrease, null);
  assert.equal(result.difference, null);
});

test('task financial amounts include settled mail rentals and exclude open or cancelled rentals', () => {
  const amounts = financialAmounts({
    jobs: [{ sms: { attempts: [{ id: 'sms-1', status: 'complete', cost: 0.12, currency: 'USD' }] } }],
    mailboxes: [
      { rented: true, rentalClosed: 'settled', costUsd: 0.08, quotedPriceUsd: 0.08 },
      { rented: true, rentalClosed: 'cancelled', costUsd: 0, quotedPriceUsd: 0.08 },
      { rented: true, rentalClosed: '', costUsd: 0, quotedPriceUsd: 0.08 },
    ],
  }, 'USD');

  assert.equal(amounts.confirmed, 0.2);
  assert.equal(amounts.unresolved, 0.08);
  assert.equal(amounts.billingComplete, false);
  assert.equal(amounts.currencyMismatch, false);
});

test('cancelled mail rentals do not create a currency mismatch from retained quotes', () => {
  const amounts = financialAmounts({
    jobs: [{ sms: { attempts: [{ id: 'sms-cny-cancelled-mail', provider: 'firefox', status: 'complete', cost: 0.28, currency: 'CNY' }] } }],
    mailboxes: [{ rented: true, rentalClosed: 'cancelled', costUsd: 0, quotedPriceUsd: 0.08 }],
  }, 'CNY');

  assert.equal(amounts.confirmed, 0.28);
  assert.equal(amounts.unresolved, 0);
  assert.equal(amounts.currencyMismatch, false);
  assert.equal(amounts.billingComplete, true);
});

test('task financial amounts refuse to combine different currencies', () => {
  const amounts = financialAmounts({
    jobs: [{ sms: { attempts: [{ id: 'sms-cny', provider: 'firefox', status: 'complete', cost: 0.28, currency: 'CNY' }] } }],
    mailboxes: [{ rented: true, rentalClosed: 'settled', costUsd: 0.08, quotedPriceUsd: 0.08 }],
  }, 'CNY');

  assert.equal(amounts.confirmed, 0.28);
  assert.equal(amounts.currencyMismatch, true);
  assert.equal(amounts.billingComplete, false);
});

test('currency-aware SMS totals preserve the provider currency', () => {
  const totals = summarizeSmsCosts([
    { sms: { attempts: [{ id: 'usd', provider: 'smsbower', status: 'complete', cost: 0.1, currency: 'USD' }] } },
    { sms: { attempts: [{ id: 'cny', provider: 'firefox', status: 'complete', cost: 0.28, currency: 'CNY' }] } },
  ]);

  assert.equal(totals.currencyTotals.USD.confirmedConsumed, 0.1);
  assert.equal(totals.currencyTotals.CNY.confirmedConsumed, 0.28);
});

test('balance account fingerprints distinguish credentials without persisting them', () => {
  const first = balanceAccountFingerprint({ name: 'smsbower', apiKey: 'one' });
  const same = balanceAccountFingerprint({ name: 'smsbower', apiKey: 'one' });
  const other = balanceAccountFingerprint({ name: 'smsbower', apiKey: 'two' });
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.doesNotMatch(first, /one|two/);
});

test('balance snapshots do not switch to a different account with the same provider', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 10), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:one',
  });
  recordBalanceStart(state, summary('smsbower', 8), 1, {
    hasReader: true,
    accountFingerprint: 'smsbower:two',
  });
  assert.equal(state.balanceReconciliation.startBalance, 10);
  assert.equal(state.balanceReconciliation.accountFingerprint, 'smsbower:one');
});

test('an unknown account fingerprint upgrades to a known account without resetting the baseline', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 10), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:unknown',
  });
  recordBalanceStart(state, summary('smsbower', 8), 1, {
    hasReader: true,
    accountFingerprint: 'smsbower:known',
  });

  assert.equal(state.balanceReconciliation.startBalance, 10);
  assert.equal(state.balanceReconciliation.accountFingerprint, 'smsbower:known');
});

test('a known account fingerprint is never downgraded by an unknown read', () => {
  const state = {};
  recordBalanceStart(state, summary('smsbower', 10), 0, {
    hasReader: true,
    accountFingerprint: 'smsbower:known',
  });
  recordBalanceStart(state, summary('smsbower', 8), 1, {
    hasReader: true,
    accountFingerprint: 'smsbower:unknown',
  });

  assert.equal(state.balanceReconciliation.startBalance, 10);
  assert.equal(state.balanceReconciliation.accountFingerprint, 'smsbower:known');
});

test('balance account activity requires a matching provider before it can affect attribution', () => {
  const smsRun = {
    preflight: { sms: { provider: 'smsbower' } },
    jobs: [{ sms: { attempts: [{ id: 'activation', status: 'complete', cost: 0.1 }] } }],
  };
  assert.equal(stateUsesBalanceAccount(smsRun, 'smsbower'), true);
  assert.equal(stateUsesBalanceAccount(smsRun, 'firefox'), false);
  assert.equal(stateUsesBalanceAccount({ jobs: [] }, 'smsbower'), false);
});

test('active provider wins over an old persisted provider during resume attribution', () => {
  const resumed = {
    balanceReconciliation: { provider: 'smsbower' },
    config: { sms: { provider: 'firefox' } },
    jobs: [],
  };
  const active = { config: resumed.config };
  assert.equal(stateUsesBalanceAccount(resumed, 'firefox', active), true);
  assert.equal(stateUsesBalanceAccount(resumed, 'smsbower', active), false);
});
