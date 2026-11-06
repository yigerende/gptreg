'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cancellationDetailsForBalance,
  summarizeSmsCost,
  summarizeSmsCosts,
} = require('../src/sms-cost-ledger');
const { REPLACE_PHONE_CODES } = require('../src/branch-orchestrator');
test('SMSBower acknowledged cancellation without a code costs zero, but received or explicitly billed numbers still cost money', () => {
  const base={id:'cancel',provider:'smsbower',status:'cancelled',providerStatus:'ACCESS_CANCEL',cost:.03};
  const summary=r=>summarizeSmsCost({sms:{attempts:[r]}});
  for(const providerStatus of ['ACCESS_CANCEL','STATUS_CANCEL']) {
    const s=summary({...base,providerStatus});
    assert.equal(s.confirmedConsumedUsd,0);assert.equal(s.unresolvedUsd,0);assert.equal(s.refundedUsd,0);assert.equal(s.billingComplete,true);
  }
  for(const evidence of [{codeReceived:true},{chargedCost:.03}]) {
    const s=summary({...base,...evidence});assert.equal(s.confirmedConsumedUsd,.03);assert.equal(s.unresolvedUsd,0);
  }
  assert.equal(summary({...base,provider:'other'}).unresolvedUsd,.03);
  assert.equal(summary({...base,providerStatus:''}).unresolvedUsd,.03);
});

test('a cancelled activation is excluded from confirmed consumption and retained for review', () => {
  const ledger = summarizeSmsCost({
    sms: { attempts: [{ id: 'activation-cancelled', status: 'cancelled', cost: 0.03 }] },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0);
  assert.equal(ledger.quotedUsd, 0.03);
  assert.equal(ledger.unresolvedUsd, 0.03);
  assert.equal(ledger.cancelledQuotedUsd, 0.03);
  assert.equal(ledger.billingComplete, false);
  assert.equal(ledger.status, 'needs_review');
});

test('the same activation is counted once even when a stale attempt and current lease coexist', () => {
  const ledger = summarizeSmsCost({
    sms: {
      attempts: [{ id: 'activation-1', status: 'cancelled', cost: 0.07 }],
      current: { id: 'activation-1', status: 'complete', cost: 0.07 },
    },
  });

  assert.equal(ledger.activationCount, 1);
  assert.equal(ledger.confirmedConsumedUsd, 0.07);
  assert.equal(ledger.unresolvedUsd, 0);
});

test('an explicit provider refund closes the cancellation review amount', () => {
  const ledger = summarizeSmsCost({
    sms: { attempts: [{ id: 'activation-refund', status: 'cancelled', cost: 0.02, refundedUsd: 0.02 }] },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0);
  assert.equal(ledger.refundedUsd, 0.02);
  assert.equal(ledger.unresolvedUsd, 0);
  assert.equal(ledger.billingComplete, true);
});

test('an explicit provider charge is counted even if the activation later closes as cancelled', () => {
  const ledger = summarizeSmsCost({
    sms: {
      attempts: [{
        id: 'activation-charged',
        status: 'cancelled',
        cost: 0.02,
        chargedCost: 0.02,
      }],
    },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0.02);
  assert.equal(ledger.unresolvedUsd, 0);
  assert.equal(ledger.billingComplete, true);
});

test('a received code is treated as consumed even if the completion checkpoint was interrupted', () => {
  const ledger = summarizeSmsCost({
    sms: { attempts: [{ id: 'activation-code', status: 'code_received', cost: 0.015, codeReceived: true }] },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0.015);
  assert.equal(ledger.unresolvedUsd, 0);
});

test('an OAuth PHONE_RECENTLY_USED activation is counted as confirmed waste', () => {
  const ledger = summarizeSmsCost({
    taskKind: 'oauth',
    sms: {
      attempts: [
        {
          id: 'oauth-recycled-number',
          scope: 'oauth',
          status: 'complete',
          cost: 0.045,
          codeReceived: true,
          cleanupReason: 'PHONE_RECENTLY_USED',
        },
        {
          id: 'oauth-accepted-number',
          scope: 'oauth',
          status: 'complete',
          cost: 0.045,
          codeReceived: true,
          targetAccepted: true,
        },
        {
          id: 'oauth-number-in-use',
          scope: 'oauth',
          status: 'cancelled',
          cost: 0.045,
          cleanupReason: 'PHONE_NUMBER_IN_USE',
        },
      ],
    },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0.09);
  assert.equal(ledger.wastedConsumedUsd, 0.045);
  assert.equal(ledger.wastedActivationCount, 1);
  assert.equal(ledger.currencyTotals.USD.wastedConsumed, 0.045);
  assert.deepEqual(ledger.wastedReasons.PHONE_RECENTLY_USED, { count: 1, amount: 0.045 });
});

test('every code that means "get another number" is classified as waste when it was charged', () => {
  // The orchestrator's own list of "this number is spent" codes is the source
  // of truth. The waste map used to carry one of them, and it was the one the
  // flow never writes: 2254 releases across four runs came back as
  // PHONE_NUMBER_IN_USE or FRAUD_GUARD, neither of which was listed. They
  // cancel before an SMS is delivered so nothing was charged and no money was
  // lost, but a charged one would have been filed as ordinary spend. This
  // fails when a new replacement code is added without teaching the ledger.
  for (const code of REPLACE_PHONE_CODES) {
    const ledger = summarizeSmsCost({
      taskKind: 'register_session',
      sms: {
        attempts: [{
          id: `charged-${code}`,
          scope: 'oauth',
          status: 'complete',
          cost: 0.04,
          codeReceived: true,
          cleanupReason: code,
        }],
      },
    });
    assert.equal(ledger.wastedConsumedUsd, 0.04, `${code} must count as waste when it was charged`);
    assert.equal(ledger.wastedActivationCount, 1, `${code} must count as one wasted activation`);
  }
});

test('a paid number thrown away by a restart or never used is counted as waste in either leg', () => {
  // Waste used to be read only off `scope: 'oauth'` activations whose reason
  // was one of two rejection codes. A registration that paid for a number and
  // then restarted on a fresh exit reported no waste at all, which on a
  // register-then-OAuth run left 浪费 looking like a mailbox-only figure —
  // $0.06 across two activations went uncounted on one 908-activation run.
  const ledger = summarizeSmsCost({
    taskKind: 'register_session',
    sms: {
      attempts: [
        {
          id: 'session-restarted-number',
          scope: 'session',
          status: 'complete',
          cost: 0.03,
          codeReceived: true,
          cleanupReason: 'proxy_restart',
        },
        {
          id: 'oauth-replaced-number',
          scope: 'oauth',
          status: 'complete',
          cost: 0.045,
          codeReceived: true,
          cleanupReason: 'oauth_phone_validation_recovery_requires_new_phone',
        },
        {
          id: 'oauth-unused-number',
          scope: 'oauth',
          status: 'complete',
          cost: 0.02,
          cleanupReason: 'job_completed_without_phone_challenge',
        },
        {
          id: 'session-verified-number',
          scope: 'session',
          status: 'complete',
          cost: 0.03,
          codeReceived: true,
          targetAccepted: true,
          cleanupReason: 'phone_verified',
        },
        {
          // Cancelled costs nothing, so it is churn rather than waste however
          // it ended.
          id: 'session-cancelled-number',
          scope: 'session',
          status: 'cancelled',
          cost: 0.03,
          cleanupReason: 'proxy_restart',
        },
      ],
    },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0.125);
  assert.equal(ledger.wastedConsumedUsd, 0.095);
  assert.equal(ledger.wastedActivationCount, 3);
  assert.deepEqual(ledger.wastedReasons.PROXY_RESTART, { count: 1, amount: 0.03 });
  assert.deepEqual(ledger.wastedReasons.PHONE_REPLACED, { count: 1, amount: 0.045 });
  assert.deepEqual(ledger.wastedReasons.PHONE_UNUSED, { count: 1, amount: 0.02 });
});

test('an OAuth activation with a received but rejected code is counted as confirmed waste', () => {
  const ledger = summarizeSmsCost({
    taskKind: 'oauth',
    sms: {
      attempts: [{
        id: 'oauth-rejected-code',
        scope: 'oauth',
        status: 'complete',
        cost: 0.045,
        codeReceived: true,
        cleanupReason: 'INVALID_INPUT',
      }],
    },
  });

  assert.equal(ledger.confirmedConsumedUsd, 0.045);
  assert.equal(ledger.wastedConsumedUsd, 0.045);
  assert.equal(ledger.wastedActivationCount, 1);
  assert.equal(ledger.currencyTotals.USD.wastedConsumed, 0.045);
  assert.deepEqual(ledger.wastedReasons.INVALID_INPUT, { count: 1, amount: 0.045 });
});

test('OAuth invalid phone-code variants share the验证码不通过 waste category', () => {
  const ledger = summarizeSmsCost({
    taskKind: 'oauth',
    sms: {
      attempts: [
        { id: 'oauth-invalid-phone-otp', scope: 'oauth', status: 'complete', cost: 0.045, codeReceived: true, cleanupReason: 'INVALID_PHONE_OTP' },
        { id: 'oauth-invalid-otp', scope: 'oauth', status: 'complete', cost: 0.045, codeReceived: true, cleanupReason: 'INVALID_OTP' },
      ],
    },
  });

  assert.deepEqual(ledger.wastedReasons, { INVALID_INPUT: { count: 2, amount: 0.09 } });
});

test('a sparse later snapshot cannot erase the OAuth waste classification', () => {
  const ledger = summarizeSmsCost({
    taskKind: 'oauth',
    sms: {
      attempts: [{
        id: 'oauth-recycled-number',
        scope: 'oauth',
        status: 'complete',
        cost: 0.045,
        codeReceived: true,
        cleanupReason: 'PHONE_RECENTLY_USED',
      }],
      current: {
        id: 'oauth-recycled-number',
        status: 'complete',
        codeReceived: true,
        cleanupReason: '',
      },
    },
  });

  assert.equal(ledger.wastedConsumedUsd, 0.045);
  assert.equal(ledger.wastedActivationCount, 1);
});

test('legacy quote-only checkpoints remain conservative', () => {
  const pending = summarizeSmsCost({ sms: { costUsd: 0.04 } });
  const completed = summarizeSmsCost({ sms: { costUsd: 0.04 }, accountCreatedAt: '2026-08-06T00:00:00.000Z' });

  assert.equal(pending.confirmedConsumedUsd, 0);
  assert.equal(pending.unresolvedUsd, 0.04);
  assert.equal(completed.confirmedConsumedUsd, 0.04);
  assert.equal(completed.unresolvedUsd, 0);
});

test('aggregate billing exposes quoted, confirmed, refunded, and unresolved totals', () => {
  const summary = summarizeSmsCosts([
    { sms: { attempts: [{ id: 'a', status: 'complete', cost: 0.01 }] } },
    { sms: { attempts: [{ id: 'b', status: 'cancelled', cost: 0.02 }] } },
  ]);

  assert.equal(summary.confirmedConsumedUsd, 0.01);
  assert.equal(summary.quotedUsd, 0.03);
  assert.equal(summary.unresolvedUsd, 0.02);
  assert.equal(summary.accountedJobs, 1);
  assert.equal(summary.unresolvedJobs, 1);
  assert.equal(summary.billingComplete, false);
});

test('cancellation balance details identify supplier-settlement quotes without calling them loss', () => {
  const jobs = Array.from({ length: 11 }, (_, index) => ({
    id: `cancelled-${index + 1}`,
    sms: { attempts: [{ id: `activation-${index + 1}`, status: 'cancelled', cost: 0.045 }] },
  }));
  const billing = summarizeSmsCosts(jobs);
  const details = cancellationDetailsForBalance(billing, 'USD');

  assert.equal(billing.cancelledQuotedUsd, 0.495);
  assert.equal(billing.cancelledUnresolvedUsd, 0.495);
  assert.equal(details.unresolved, 0.495);
  assert.equal(details.cancelledUnresolved, 0.495);
  assert.equal(details.cancellationOnlyUnresolved, true);
  assert.equal(Object.keys(details.cancelledUnresolvedByJob).length, 11);
});

test('a balance-settled cancellation quote leaves the audit quote but clears unresolved consumption', () => {
  const jobs = [
    { id: 'cancelled', sms: { attempts: [{ id: 'activation-cancelled', status: 'cancelled', cost: 0.495 }] } },
  ];
  const billing = summarizeSmsCosts(jobs, {
    settledCancelledQuotesCurrency: 'USD',
    settledCancelledQuotesByJob: { cancelled: 0.495 },
  });

  assert.equal(billing.confirmedConsumedUsd, 0);
  assert.equal(billing.unresolvedUsd, 0);
  assert.equal(billing.cancelledUnresolvedUsd, 0);
  assert.equal(billing.cancelledQuotedUsd, 0.495);
  assert.equal(billing.billingComplete, true);
});
