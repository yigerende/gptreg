'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { text } = require('./util/shared');

function mailboxEmail(row) {
  return text(row?.email || row?.address || row?.mailbox).toLowerCase();
}

function compactOtpDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    recipient: text(value.recipient),
    checkedEmails: Number(value.checkedEmails ?? value.checked_emails ?? 0) || 0,
    listed: Number(value.listed ?? 0) || 0,
    found: Boolean(value.found),
    siblingCount: Number(value.siblingCount ?? value.siblings?.count ?? 0) || 0,
    ...(typeof value.recipientMismatch === 'boolean' ? { recipientMismatch: value.recipientMismatch }
      : value.dropped && typeof value.dropped === 'object' ? {
        recipientMismatch: Number(value.dropped.recipient ?? value.dropped.recipient_mismatch ?? value.dropped.recipientMismatch ?? 0) > 0,
      } : {}),
  };
}

function recipientMismatch(diagnostics) {
  return Boolean(diagnostics && !diagnostics.found && diagnostics.checkedEmails === 0
    && (diagnostics.siblingCount > 0 || (diagnostics.recipientMismatch ?? diagnostics.listed > 0)));
}

/** Batch-scoped mailbox allocation; account workers only share this short lane. */
function createRebindMailChannel(provider, client, options = {}) {
  const remotePool = provider === 'mailcom' || provider === 'fastmail';
  const requestMs = options.requestTimeoutMs ?? 15000;
  const refillMs = options.refillTimeoutMs ?? 8000;
  const fetcher = client.fetch || globalThis.fetch;
  client.fetch = (url, init = {}) => {
    const timeout = AbortSignal.timeout(String(url).includes('/api/pool/ensure') ? refillMs : requestMs);
    return fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
  let allocation = Promise.resolve();
  let available = [];
  let refilled = false;
  let loggedIn = false;
  const used = new Set();

  const loadAvailable = async () => {
    available = (await client.listAccounts()).filter((row) => row.status === 'available' && row.bound !== true && !used.has(String(row.id)));
  };
  const claim = async () => {
    if (provider === 'smsbower') {
      const row = await client.rentMailbox();
      return row ? { mailboxId: String(row.id), email: mailboxEmail(row) } : null;
    }
    if (provider === 'xiaopingguo' && !loggedIn) {
      await client.login(options.password);
      loggedIn = true;
    }
    if (remotePool && !available.length) {
      await loadAvailable();
      if (!available.length && !refilled) {
        refilled = true;
        await client.ensurePool(1);
        await loadAvailable();
      }
    }
    for (;;) {
      const row = remotePool ? available.shift() : await client.randomUnbound();
      if (!row) return null;
      const id = text(row.id);
      const email = mailboxEmail(row);
      if (!id || !email || used.has(id)) throw new Error('邮箱接口返回了无效或重复的邮箱');
      used.add(id);
      try {
        await client.reserveMailbox(id);
      } catch (error) {
        if (remotePool && error.status === 409) continue;
        throw error;
      }
      return { mailboxId: id, email };
    }
  };

  return {
    claim() {
      const flight = allocation.then(claim);
      allocation = flight.catch(() => {});
      return flight;
    },
    readOtp: async (mailboxId, opts) => {
      let diagnostics = null;
      const deadlineSignal = AbortSignal.timeout(opts.timeoutMs ?? 120000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, deadlineSignal]) : deadlineSignal;
      let found;
      try {
        found = await pollOtp(async ({ remainingMs }) => {
          const otp = await client.findVerificationCode(mailboxId, {
            recipient: opts.recipient, since: opts.since,
            signal,
            maxWaitMs: Math.min(opts.pollIntervalMs ?? 4000, remainingMs),
            ...(provider === 'xiaopingguo' ? { folders: ['inbox', 'junkemail'] } : {}),
          });
          // Never borrow the last poll of another concurrent mailbox.
          const raw = typeof client.lastOtpDiagnostics === 'function'
            ? client.lastOtpDiagnostics(mailboxId)
            : client.lastOtpFetchByMailbox ? client.lastOtpFetchByMailbox.get(String(mailboxId))
              : String(client.lastOtpFetch?.mailboxId) === String(mailboxId) ? client.lastOtpFetch : null;
          diagnostics = compactOtpDiagnostics(raw);
          const code = typeof otp === 'string' ? text(otp) : text(otp?.code || otp?.otp || otp?.verificationCode);
          return { code, diagnostics, reason: !code && recipientMismatch(diagnostics) ? 'recipient_mismatch' : '' };
        }, { ...opts, signal });
      } catch (error) {
        opts.signal?.throwIfAborted();
        if (!deadlineSignal.aborted) throw error;
        found = '';
      }
      if (typeof found === 'object') return found;
      return { code: found, diagnostics, reason: found ? '' : 'otp_timeout' };
    },
    release: (mailboxId) => provider === 'smsbower' ? client.cancelMailbox(mailboxId) : client.releaseMailbox(mailboxId),
    consume: (mailboxId) => remotePool ? client.consumeMailbox(mailboxId, {})
      : provider === 'xiaopingguo' ? client.markBound(mailboxId, true) : client.settleMailbox(mailboxId),
  };
}

async function pollOtp(fetchOnce, options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? 120000);
  const interval = options.pollIntervalMs ?? 4000;
  let polls = 0;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    let found;
    let retrying = false;
    try {
      found = await fetchOnce({ remainingMs: deadline - started });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.fatal || error.retryable === false || [401, 403].includes(error.status || error.statusCode)) throw error;
      retrying = true;
    }
    options.signal?.throwIfAborted();
    options.onPoll?.({ polls: ++polls, elapsedMs: Date.now() - startedAt, remainingMs: Math.max(0, deadline - Date.now()), diagnostics: found?.diagnostics || null, retrying });
    const code = typeof found === 'string' ? text(found) : text(found?.code || found?.otp || found?.verificationCode);
    if (code) return code;
    if (found?.reason === 'recipient_mismatch') return found;
    // Remote OTP reads already long-poll; only wait out the remainder.
    const delay = Math.min(deadline - Date.now(), Math.max(0, interval - (Date.now() - started)));
    if (delay > 0) await sleep(delay, undefined, { signal: options.signal });
  }
  return '';
}

module.exports = { createRebindMailChannel, pollOtp, compactOtpDiagnostics, recipientMismatch };
