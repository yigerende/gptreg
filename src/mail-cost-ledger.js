'use strict';

const amount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

// A refused cancellation is not proof of a free rental. Older checkpoints
// wrote an explicit zero in that case; retain the quote as uncertain spend.
function mailRentalCost(mailbox = {}) {
  const confirmed = amount(mailbox.costUsd);
  const status = String(mailbox.rentalClosed || '').toLowerCase();
  const uncertain = !['settled', 'cancelled'].includes(status) && (
    mailbox.rentalBillingUncertain === true
    || ['settlement_unknown', 'cleanup_manual_review'].includes(status)
    || mailbox.rentalCleanup?.status === 'pending'
  );
  const pending = uncertain
    ? Math.max(0, amount(mailbox.rentalUnresolvedUsd || mailbox.quotedPriceUsd) - confirmed)
    : 0;
  return { confirmed, pending, refunded: 0, billingPending: uncertain || !status };
}

module.exports = { mailRentalCost };
