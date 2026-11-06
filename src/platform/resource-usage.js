"use strict";
const { createHash } = require("node:crypto");
const { mailRentalCost } = require("../mail-cost-ledger");
const { summarizeSmsCosts } = require("../sms-cost-ledger");
const { isTerminalJobStatus } = require("../job-lifecycle");

const rounded = n => Math.round(Number(n || 0) * 1e6) / 1e6;
const safeCode = value => /^[A-Z][A-Z0-9_]{1,95}$/.test(String(value || "").toUpperCase()) ? String(value).toUpperCase() : "UNKNOWN";
const key = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const terminalRun = state => ["complete", "partial", "failed", "cancelled"].includes(state.status);

// Persist only operational facts. Never copy checkpoint objects, addresses,
// telephone numbers, provider responses, OTPs or arbitrary error messages.
function resourceRecords(state, summary, options = {}) {
  const mail = (state.mailboxes || []).filter(m => m.rented).map((m, index) => {
    const jobs = (state.jobs || []).filter(j => String(j.mailboxId) === String(m.id));
    const cost = mailRentalCost(m, state), cleanup = m.rentalCleanup || {};
    let outcome = jobs.some(j => j.status === "complete") ? "succeeded"
      : jobs.some(j => !isTerminalJobStatus(j.status)) && !terminalRun(state) ? "active"
      : jobs.length || m.rentalClosed === "cancelled" ? "failed" : "unknown";
    const reason = jobs.find(j => j.error?.code)?.error?.code || (outcome === "failed" ? "EXECUTION_INCOMPLETE" : "");
    const review = ["cleanup_manual_review", "settlement_unknown"].includes(m.rentalClosed);
    const cleanupState = m.rentalClosed === "cancelled" ? "cancelled"
      : m.rentalClosed === "settled" ? "settled"
      : cleanup.action === "cancel" && (review || cleanup.lastError) ? "cancel_failed"
      : review ? "review" : cleanup.status === "pending" ? "pending" : "none";
    return {
      key: key("mail", m.provider || state.runPlan?.mailProvider || "mail", m.id || [state.runId, index]),
      outcome, cleanup: cleanupState, reason: reason ? safeCode(reason) : "",
      cleanup_reason: cleanup.lastError?.code ? safeCode(cleanup.lastError.code) : "",
      currency: "USD", confirmed: cost.confirmed, pending: cost.pending, refunded: cost.refunded,
      billing_pending: cost.billingPending,
      price_unknown: cost.billingPending && m.quotedPriceUsd == null && m.rentalUnresolvedUsd == null,
      counted: true,
    };
  });
  const settled = summary.billing.cancelledQuotesSettledUsd;
  const ledgers = summarizeSmsCosts(state.jobs || [], {
    includeRecords: true,
    ...(settled > 0 ? {
      settledCancelledQuotesCurrency: state.balanceReconciliation?.currency || summary.billing.currency,
      ...(state.balanceReconciliation?.cancelledQuotesSettledByJob
        ? { settledCancelledQuotesByJob: state.balanceReconciliation.cancelledQuotesSettledByJob }
        : { settledCancelledQuotesUsd: settled }),
    } : {}),
  }).ledgers;
  const sms = ledgers.flatMap(({ job, ledger }) => ledger.records.map((r, index) => {
    const raw = r.record || {};
    const reason = String(raw.cleanupReason || raw.cancelReason || "").toUpperCase();
    const success = raw.targetAccepted === true || reason === "PHONE_VERIFIED";
    const failed = r.cancelled || r.wasted || raw.cleanupAction === "cancel"
      || (raw.targetAccepted === false && (r.terminal || isTerminalJobStatus(job.status) || terminalRun(state)));
    const outcome = success ? "succeeded" : failed ? "failed"
      : !r.terminal && !isTerminalJobStatus(job.status) && !terminalRun(state) ? "active" : "unknown";
    const cleanupPending = ["pending_cleanup", "completion_pending", "cleanup_pending", "abandoned_unresolved"].includes(r.status);
    const cleanup = r.cancelled ? "cancelled"
      : cleanupPending && raw.cleanupAction === "cancel" && raw.cleanupError ? "cancel_failed"
      : cleanupPending ? "pending" : raw.terminalReviewRequired ? "review"
      : r.status === "complete" ? "settled" : "none";
    return {
      key: key("sms", raw.provider || raw.providerName || "sms", r.id || [state.runId, job.id, index]),
      outcome, cleanup,
      reason: outcome === "failed" ? safeCode(reason || job.error?.code || "VERIFICATION_INCOMPLETE") : "",
      cleanup_reason: cleanup === "cancel_failed" ? "SMS_CANCEL_FAILED" : "",
      currency: r.currency, confirmed: r.confirmedConsumedUsd, pending: r.unresolvedUsd, refunded: r.refundedUsd,
      billing_pending: r.billingUnresolved, price_unknown: !r.hasAmount,
      counted: Boolean(r.record),
    };
  }));
  const resources = { mail, sms };
  return options.suppliers ? { resources, suppliers: require("./supplier-facts").supplierRecords(state, resources, ledgers) } : resources;
}

function emptyUsage() {
  return { total: 0, succeeded: 0, failed: 0, active: 0, unknown: 0,
    cancelled: 0, cancel_failed: 0, cleanup_pending: 0, review: 0,
    billing_pending: 0, price_unknown: 0, uncounted: 0, missing_attempts: 0,
    failed_cost: {}, reasons: [], cleanup_reasons: [] };
}
function summarizeResources(records, missing = 0) {
  const result = emptyUsage(), reasons = new Map(), cleanupReasons = new Map();
  result.missing_attempts = missing;
  // Current/archived copies and resumed attempts may reference one lease.
  const distinct = new Map();
  for (const r of records) distinct.set(r.key, r);
  for (const r of distinct.values()) {
    if (!r.counted) { result.uncounted++; continue; }
    result.total++;
    result[r.outcome]++;
    if (r.cleanup === "pending") result.cleanup_pending++;
    else if (["cancelled", "cancel_failed", "review"].includes(r.cleanup)) result[r.cleanup]++;
    if (r.billing_pending) result.billing_pending++;
    if (r.price_unknown) result.price_unknown++;
    if (r.outcome === "failed") {
      const costs = result.failed_cost[r.currency] ||= { confirmed: 0, pending: 0, refunded: 0 };
      for (const k of ["confirmed", "pending", "refunded"]) costs[k] = rounded(costs[k] + r[k]);
      if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    }
    if (r.cleanup_reason) cleanupReasons.set(r.cleanup_reason, (cleanupReasons.get(r.cleanup_reason) || 0) + 1);
  }
  result.reasons = [...reasons].map(([code, count]) => ({ code, count }));
  result.cleanup_reasons = [...cleanupReasons].map(([code, count]) => ({ code, count }));
  return result;
}

module.exports = { resourceRecords, summarizeResources };
