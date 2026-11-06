'use strict';

const amount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

// SMSBower bills a rented mailbox when it delivers a code, even if registration
// later fails. Only evidence belonging to this rental can establish receipt.
function receivedMailCode(mailbox, state = {}) {
  if (mailbox.codeReceived === true || mailbox.mailCodeReceivedAt) return true;
  if (mailbox.id == null || mailbox.id === '') return false;
  const jobs = (state.jobs || []).filter(j => j.mailboxId != null && String(j.mailboxId) === String(mailbox.id));
  if (jobs.some(j => Boolean(j.emailMessageId))) return true;
  const ids = new Set(jobs.map(j => j.id).filter(Boolean));
  return (state.events || []).some(e => e.type === 'email_otp_received' && (ids.has(e.jobId) || (e.mailboxId != null && String(e.mailboxId) === String(mailbox.id))));
}
function mailRentalCost(mailbox = {}, state = {}) {
  const provider = String(mailbox.provider || state.runPlan?.mailProvider || '').trim().toLowerCase();
  const billedOnReceipt = mailbox.billingRule === 'on_code' || ['smsbower','sms-bower','smsbower_mail'].includes(provider);
  const received = billedOnReceipt && receivedMailCode(mailbox, state);
  const confirmed = Math.max(amount(mailbox.costUsd), received ? amount(mailbox.quotedPriceUsd) : 0);
  const status = String(mailbox.rentalClosed || '').toLowerCase();
  const uncertain = !received && !['settled', 'cancelled'].includes(status) && (
    mailbox.rentalBillingUncertain === true
    || ['settlement_unknown', 'cleanup_manual_review'].includes(status)
    || mailbox.rentalCleanup?.status === 'pending'
  );
  const pending = uncertain
    ? Math.max(0, amount(mailbox.rentalUnresolvedUsd || mailbox.quotedPriceUsd) - confirmed)
    : 0;
  return { confirmed, pending, refunded: 0, billingPending: received ? mailbox.quotedPriceUsd == null && !confirmed : uncertain || !status };
}

module.exports = { mailRentalCost, receivedMailCode };
