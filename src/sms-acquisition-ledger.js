'use strict';

const { clone } = require('./util/shared');

function timestamp(options = {}) {
  return new Date((options.now || Date.now)()).toISOString();
}

function archiveSmsAcquisitionIntent(state, job, intent, options = {}) {
  if (!intent || !job) return null;
  const at = options.at || timestamp(options);
  const status = String(options.status || 'archived');
  job.sms = job.sms || {};
  job.sms.acquisitions = Array.isArray(job.sms.acquisitions) ? job.sms.acquisitions : [];
  const record = {
    ...clone(intent),
    status,
    ...(options.resolution ? { resolution: String(options.resolution) } : {}),
    ...(options.reason ? { cleanupReason: String(options.reason) } : {}),
    ...(options.externalCleanup ? { externalCleanupRequired: true } : {}),
    finishedAt: at,
  };
  job.sms.acquisitions.push(record);

  let externalCleanup = null;
  if (options.externalCleanup) {
    job.sms.externalCleanupRequired = true;
    state.externalCleanup = Array.isArray(state.externalCleanup) ? state.externalCleanup : [];
    externalCleanup = {
      type: 'sms_activation_unknown',
      jobId: job.id,
      acquisitionId: String(intent.id || intent.acquisitionId || ''),
      provider: String(options.provider || ''),
      request: clone(intent.request || {
        serviceCode: intent.service,
        countryId: intent.country,
        maxPrice: intent.maxPrice,
      }),
      status: 'manual_review_required',
      reason: String(options.reason || ''),
      recordedAt: at,
    };
    state.externalCleanup.push(externalCleanup);
  }
  return { record, externalCleanup };
}

/**
 * Whether an SMS lease has already received its code, by any of the markers a
 * provider or a resumed checkpoint leaves. Both schedulers read leases through
 * this one predicate so they cannot disagree about the same number.
 */
function smsLeaseHasReceivedCode(lease = {}) {
  const status = String(lease.status || '').toLowerCase();
  return lease.targetAccepted === true
    || lease.codeReceived === true
    || Boolean(String(lease.code || '').trim())
    || ['code_received', 'completion_pending', 'closed_after_code'].includes(status);
}

module.exports = {
  archiveSmsAcquisitionIntent,
  smsLeaseHasReceivedCode,
};
