'use strict';

const { tryParseJson } = require('./http-shape');
const { providerApiFetch } = require('./provider-api-egress');
const { text } = require('./util/shared');

/**
 * Mail channel backed by SMSBower's rented mailboxes.
 *
 * Shaped like the xiaopingguo client so the orchestrator does not care which
 * one it is holding, but the model underneath is different in three ways that
 * drive everything here:
 *
 *  - A mailbox is **rented**, not listed. There is no pool to enumerate, so
 *    `rentMailbox` is what produces one and `listAccounts` only reports what
 *    this client has already rented.
 *  - The provider extracts the code server-side. There are no message bodies,
 *    so folders, keywords and message ids have nothing to act on; the boundary
 *    a caller captures is a timestamp and nothing else.
 *  - One rental yields **several** codes, one at a time. `status=5` arms the
 *    next one, so a code must be consumed before the following one can arrive.
 *
 * The activation is only settled (`status=3`) by an explicit `settleMailbox`.
 * Nothing in the read path closes it, because a half-finished account still
 * needs its mailbox.
 */

const DEFAULT_BASE_URL = 'https://smsbower.page/api/mail';
const DEFAULT_SERVICES_URL = 'https://smsbower.page/stubs/handler_api.php';
const DEFAULT_STOCK_RETRY_ATTEMPTS = 3;
const DEFAULT_STOCK_RETRY_DELAY_MS = 350;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// SMSBower mail activations are usable for 25 minutes. Stop holding an
// address one minute before the provider-side limit when registration never
// reached the email OTP boundary.
const DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS = 24 * 60 * 1000;
// Gmail is the only domain that routes `+tag` back to the same inbox, which is
// what lets one rental cover a root account and one alias.
const MAIL_DOMAIN = 'gmail.com';

const STATUS_CANCEL = 2;
const STATUS_SETTLE = 3;
const STATUS_NEXT_CODE = 5;
// Upper bound on stale codes discarded before one new send. A rental only
// ever queues a couple; the cap keeps a misbehaving provider from looping.
const MAX_STALE_CODE_DRAIN = 5;

// The provider says this in prose rather than with a status, so it is matched
// as text. It means "keep polling", not "something went wrong".
const PENDING_CODE_PATTERN = /code has not been received/i;
const MAILBOX_GONE_PATTERN = /unknown (?:mailbox|activation)|(?:mailbox|activation) (?:not found|does not exist)|no such (?:mailbox|activation)/i;
const CANCELLED_PATTERN = /already canceled|already cancelled|activation (?:is )?canceled|activation (?:is )?cancelled/i;
const SETTLED_PATTERN = /already settled|already completed|already complete|activation (?:is )?(?:settled|completed)/i;
const MAILBOX_STATE_ACTIONS = new Set(['getCode', 'setStatus']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function findCaseInsensitiveEntry(container, key) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  const wanted = String(key || '').trim().toLowerCase();
  const match = Object.entries(container).find(([candidate]) => String(candidate).trim().toLowerCase() === wanted);
  return match ? match[1] : null;
}

function providerError(action, message, extra = {}) {
  const error = new Error(`smsbower mail ${action} failed: ${message}`);
  error.provider = 'smsbower-mail';
  error.action = action;
  Object.assign(error, extra);
  return error;
}

class SmsbowerMailClient {
  constructor(options = {}) {
    this.mailProvider = 'smsbower';
    this.apiKey = text(options.apiKey);
    this.baseUrl = text(options.baseUrl) ? text(options.baseUrl).replace(/\/+$/, '') : DEFAULT_BASE_URL;
    this.servicesUrl = text(options.servicesUrl) || DEFAULT_SERVICES_URL;
    this.service = text(options.service) || 'dr';
    this.domain = text(options.domain) || MAIL_DOMAIN;
    this.maxPrice = Number(options.maxPrice || 0) || 0;
    this.stockRetryAttempts = Number.isInteger(Number(options.stockRetryAttempts))
      ? Math.max(1, Number(options.stockRetryAttempts))
      : DEFAULT_STOCK_RETRY_ATTEMPTS;
    this.stockRetryDelayMs = Number.isFinite(Number(options.stockRetryDelayMs))
      ? Math.max(0, Number(options.stockRetryDelayMs))
      : DEFAULT_STOCK_RETRY_DELAY_MS;
    const requestTimeoutMs = Number(options.requestTimeoutMs);
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs)
      ? Math.max(1_000, requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const unstartedRentalTimeoutMs = Number(
      options.unstartedRentalTimeoutMs ?? options.registrationStartTimeoutMs,
    );
    this.unstartedRentalTimeoutMs = Number.isFinite(unstartedRentalTimeoutMs)
      ? Math.max(0, unstartedRentalTimeoutMs)
      : DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS;
    // Last unit price seen from `getPriceRests`. `getActivation` does not quote
    // one, so this is what a rental's cost is stamped from.
    this.unitPrice = Number(options.unitPrice || 0) || 0;
    // The console routes vendor API traffic through rotating local forwarders
    // (see provider-api-egress); anything else keeps the plain fetch.
    this.fetch = options.fetch || providerApiFetch() || globalThis.fetch;
    this.now = options.now || Date.now;
    // Rentals this client is holding, keyed by the provider's mailId as a
    // string so it can be used as a mailbox id everywhere else.
    this.rentals = new Map();
    this.expiryTimers = new Map();
    this.expiryFlights = new Map();
    this.priceRestsFlight = null;
  }

  // Rental state belongs to the task checkpoint, so do not copy this client's
  // rentals when a cached preflight is used by another task.
  fork() {
    return new SmsbowerMailClient({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      servicesUrl: this.servicesUrl,
      service: this.service,
      domain: this.domain,
      maxPrice: this.maxPrice,
      stockRetryAttempts: this.stockRetryAttempts,
      stockRetryDelayMs: this.stockRetryDelayMs,
      requestTimeoutMs: this.requestTimeoutMs,
      unstartedRentalTimeoutMs: this.unstartedRentalTimeoutMs,
      unitPrice: this.unitPrice,
      fetch: this.fetch,
      now: this.now,
    });
  }

  rentalStartDeadlineAt(rentedAt) {
    const started = Date.parse(String(rentedAt || ''));
    if (!Number.isFinite(started)) return '';
    return new Date(started + this.unstartedRentalTimeoutMs).toISOString();
  }

  clearRentalExpiryTimer(mailboxId) {
    const id = text(mailboxId);
    const timer = this.expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  scheduleRentalExpiry(rental) {
    this.clearRentalExpiryTimer(rental?.id);
    if (!rental || rental.settled || rental.registrationStarted === true) return;
    const deadline = Date.parse(String(rental.registrationStartDeadlineAt || ''));
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(0, deadline - this.now());
    const timer = setTimeout(() => {
      this.expireUnstartedMailboxes({ onlyId: rental.id }).catch(() => {
        // The orchestrator's persisted cleanup pass retries provider failures.
      });
    }, delay);
    // A stale rental lock must not keep a CLI process alive after its run ended.
    if (typeof timer.unref === 'function') timer.unref();
    this.expiryTimers.set(rental.id, timer);
  }

  unstartedRentalExpired(rental, now = this.now()) {
    if (!rental || rental.settled || rental.registrationStarted === true) return false;
    const deadline = Date.parse(String(rental.registrationStartDeadlineAt || ''));
    return Number.isFinite(deadline) && now >= deadline;
  }

  async request(action, path, params = {}, options = {}) {
    if (!this.apiKey) throw providerError(action, 'no API key is configured');
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const requestedTimeoutMs = Number(options.timeoutMs ?? this.requestTimeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(1_000, requestedTimeoutMs)
      : this.requestTimeoutMs;
    const controller = new AbortController();
    const parentSignal = options.signal;
    const onParentAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    let body;
    try {
      response = await this.fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      body = await response.text();
    } catch (error) {
      const parentAborted = Boolean(parentSignal?.aborted);
      const details = {
        retryable: !parentAborted,
        cause: error,
        ...(timedOut ? { code: 'MAIL_PROVIDER_TIMEOUT' } : {}),
        ...(parentAborted ? { code: 'MAIL_PROVIDER_ABORTED' } : {}),
      };
      const message = timedOut
        ? `timed out after ${timeoutMs} ms`
        : (parentAborted ? 'request aborted' : error.message);
      throw providerError(action, message, details);
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
    const json = tryParseJson(body) || {};
    if (response.status >= 400) {
      const message = text(json.error) || `HTTP ${response.status}`;
      const mailboxGone = MAILBOX_STATE_ACTIONS.has(action) && MAILBOX_GONE_PATTERN.test(message);
      throw providerError(action, message, {
        status: response.status,
        ...(mailboxGone ? {
          mailboxGone: true,
          code: 'MAILBOX_GONE',
        } : {}),
        // 5xx and throttling are worth another attempt; a 4xx is an answer.
        retryable: response.status >= 500 || response.status === 429,
        response: json,
      });
    }
    return json;
  }

  /** Availability and unit price, for the preflight that runs before a task starts. */
  async priceRests(options = {}) {
    // Seven concurrent claimers can all arrive before the first quote is
    // cached. Share that read so a slow catalogue response cannot multiply
    // into seven identical provider requests.
    if (this.priceRestsFlight) return this.priceRestsFlight;
    const flight = (async () => {
      let lastError;
      for (let attempt = 1; attempt <= this.stockRetryAttempts; attempt += 1) {
        try {
          const json = await this.request(
            'getPriceRests',
            'getPriceRests',
            { service: this.service, domain: this.domain },
            options,
          );
          if (Number(json?.status) !== 1) {
            throw providerError('getPriceRests', text(json?.error) || 'provider returned an unsuccessful stock response', {
              code: 'MAIL_STOCK_RESPONSE_REJECTED',
              retryable: true,
              response: json,
            });
          }
          const serviceData = findCaseInsensitiveEntry(json.data, this.service);
          const entry = findCaseInsensitiveEntry(serviceData, this.domain);
          const price = Number(entry?.price);
          const count = Number(entry?.count);
          // A successful HTTP response with no matching service/domain is not an
          // empty inventory. SMSBower occasionally returns an incomplete data
          // object while its mail catalogue is refreshing; turning that into
          // `{ price: 0, count: 0 }` makes the UI report a false sold-out state.
          if (!entry || !Number.isFinite(price) || price < 0 || !Number.isFinite(count) || count < 0) {
            throw providerError('getPriceRests', `incomplete stock response for ${this.service}/${this.domain}`, {
              code: 'MAIL_STOCK_RESPONSE_INVALID',
              retryable: true,
              response: json,
            });
          }
          this.unitPrice = price;
          return {
            service: this.service,
            domain: this.domain,
            price,
            count,
          };
        } catch (error) {
          lastError = error;
          if (attempt >= this.stockRetryAttempts || error?.retryable === false) throw error;
          await sleep(this.stockRetryDelayMs * attempt);
        }
      }
      throw lastError;
    })();
    this.priceRestsFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.priceRestsFlight === flight) this.priceRestsFlight = null;
    }
  }

  /** The provider's own service catalogue, so the console can offer real codes. */
  async services() {
    const url = new URL(this.servicesUrl);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('action', 'getMailServicesList');
    const response = await this.fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
    const json = tryParseJson(await response.text()) || {};
    const services = Array.isArray(json.services) ? json.services : [];
    return services.map((entry) => ({ code: text(entry?.code), name: text(entry?.name) })).filter((entry) => entry.code);
  }

  /**
   * Rents one mailbox.
   *
   * Called when a lane is about to start rather than up front: a task that dies
   * on proxies before it ever reaches a mailbox should not have paid for one.
   */
  async rentMailbox(options = {}) {
    // The rental response carries no price, so the current quote is read once
    // and reused. Without it a settled mailbox would be billed at zero and the
    // run would under-report what it actually spent.
    if (!this.unitPrice) {
      try { await this.priceRests({ signal: options.signal }); } catch { /* cost stays unknown rather than blocking a rental */ }
    }
    const json = await this.request(
      'getActivation',
      'getActivation',
      {
        service: text(options.service) || this.service,
        domain: text(options.domain) || this.domain,
        ...(this.maxPrice > 0 ? { maxPrice: this.maxPrice } : {}),
      },
      options,
    );
    if (Number(json.status) !== 1) {
      const message = text(json.error) || 'mailbox was not issued';
      throw providerError('getActivation', message, {
        // "No mails yet" is inventory, not a broken request: the caller can
        // wait and ask again rather than failing the whole run.
        soldOut: /no mails/i.test(message),
        insufficientBalance: /insufficient balance/i.test(message),
        response: json,
      });
    }
    const id = text(json.mailId);
    const email = text(json.mail);
    if (!id || !email) throw providerError('getActivation', 'response did not contain a mailbox', { response: json });
    const rentedAt = new Date(this.now()).toISOString();
    const rental = {
      id,
      email,
      rentedAt,
      registrationStartDeadlineAt: this.rentalStartDeadlineAt(rentedAt),
      registrationStarted: false,
      registrationStartedAt: '',
      codesRead: 0,
      settled: false,
      armed: true,
      // Quoted now, charged only if this rental is settled.
      quotedPrice: this.unitPrice,
      costUsd: 0,
    };
    this.rentals.set(id, rental);
    this.scheduleRentalExpiry(rental);
    return { ...rental };
  }

  /** Mailboxes this client is currently holding, in the orchestrator's shape. */
  async listAccounts() {
    await this.expireUnstartedMailboxes();
    return [...this.rentals.values()]
      .filter((rental) => !rental.settled)
      .map((rental) => ({ id: rental.id, email: rental.email, tokenValid: true, bound: false }));
  }

  rental(mailboxId, options = {}) {
    const id = text(mailboxId);
    if (!id) throw providerError('rental', 'mailbox id is required', { status: 400, retryable: false });
    let rental = this.rentals.get(id);
    if (!rental) {
      // A run checkpoint is the source of truth for an issued mailId. The map
      // is only a process-local cache, so a resumed run must still be able to
      // read or close the provider rental before this process has seen it.
      const rentedAt = text(options.rentedAt) || new Date(this.now()).toISOString();
      const registrationStarted = options.registrationStarted === true
        || Boolean(text(options.registrationStartedAt));
      rental = {
        id,
        email: text(options.email),
        rentedAt,
        registrationStartDeadlineAt: text(options.registrationStartDeadlineAt)
          || this.rentalStartDeadlineAt(rentedAt),
        registrationStarted,
        registrationStartedAt: text(options.registrationStartedAt),
        codesRead: Math.max(0, Number(options.codesRead || 0)),
        settled: options.settled === true,
        cancelled: options.cancelled === true,
        armed: options.armed !== false,
        quotedPrice: Number(options.quotedPrice || 0) || 0,
        costUsd: Number(options.costUsd || 0) || 0,
      };
      this.rentals.set(id, rental);
    } else {
      if (!rental.email && options.email) rental.email = text(options.email);
      if (!rental.quotedPrice && options.quotedPrice) rental.quotedPrice = Number(options.quotedPrice) || 0;
      if (!rental.rentedAt && options.rentedAt) rental.rentedAt = text(options.rentedAt);
      if (!rental.registrationStartDeadlineAt) {
        rental.registrationStartDeadlineAt = text(options.registrationStartDeadlineAt)
          || this.rentalStartDeadlineAt(rental.rentedAt);
      }
      if (options.registrationStarted === true || options.registrationStartedAt) {
        rental.registrationStarted = true;
        rental.registrationStartedAt = rental.registrationStartedAt || text(options.registrationStartedAt);
      }
    }
    if (rental.registrationStarted === true || rental.settled) this.clearRentalExpiryTimer(id);
    else this.scheduleRentalExpiry(rental);
    return rental;
  }

  /** Hydrates one persisted rental without making a provider request. */
  restoreMailbox(record = {}) {
    const id = text(record.id);
    if (!id) return null;
    const closed = text(record.rentalClosed).toLowerCase();
    const registrationStarted = record.registrationStarted === true
      || record.targetTouched === true
      || String(record.registrationState || '').toLowerCase() === 'started'
      || Boolean(text(record.registrationStartedAt));
    return this.rental(id, {
      email: record.email,
      rentedAt: record.rentedAt || record.reservedAt,
      registrationStartDeadlineAt: record.registrationStartDeadlineAt,
      registrationStarted,
      registrationStartedAt: record.registrationStartedAt || record.targetTouchedAt,
      quotedPrice: record.quotedPriceUsd ?? record.quotedPrice,
      costUsd: record.costUsd,
      settled: Boolean(closed) || record.settled === true,
      cancelled: closed === 'cancelled',
    });
  }

  /** Marks a rental as having entered registration and releases its start lock. */
  markRegistrationStarted(mailboxId, options = {}) {
    const rental = this.rental(mailboxId, options);
    if (rental.settled) return false;
    if (rental.registrationStarted === true) return false;
    rental.registrationStarted = true;
    rental.registrationStartedAt = text(options.startedAt) || new Date(this.now()).toISOString();
    this.clearRentalExpiryTimer(rental.id);
    return true;
  }

  // Older orchestrator builds used the longer method name.
  markMailboxRegistrationStarted(mailboxId, options = {}) {
    return this.markRegistrationStarted(mailboxId, options);
  }

  async expireUnstartedMailbox(rental, options = {}) {
    const existing = this.expiryFlights.get(rental.id);
    if (existing) return existing;

    const flight = (async () => {
      try {
        await this.cancelMailbox(rental.id, options);
        return { id: rental.id, email: rental.email, cancelled: true };
      } catch (error) {
        return {
          id: rental.id,
          email: rental.email,
          cancelled: false,
          error: { code: error.code || 'MAIL_RENTAL_START_TIMEOUT_CANCEL_FAILED', message: error.message },
        };
      }
    })();
    this.expiryFlights.set(rental.id, flight);
    try {
      return await flight;
    } finally {
      if (this.expiryFlights.get(rental.id) === flight) this.expiryFlights.delete(rental.id);
    }
  }

  /** Cancels rentals whose registration never reached the start boundary. */
  async expireUnstartedMailboxes(options = {}) {
    const onlyId = text(options.onlyId);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : this.now();
    const expired = [];
    for (const rental of this.rentals.values()) {
      if (onlyId && rental.id !== onlyId) continue;
      if (!this.unstartedRentalExpired(rental, now)) continue;
      expired.push(await this.expireUnstartedMailbox(rental, options));
    }
    return expired;
  }

  /**
   * Codes come out of one rental strictly in arrival order, so a boundary
   * cannot be "messages newer than X": the next read is simply the oldest
   * code nobody has consumed yet.
   */
  get sequentialCodes() { return true; }

  /**
   * There is no inbox to snapshot, only a queue of extracted codes. Before a
   * new OTP is sent on a rental that has already produced a code, anything
   * still queued belongs to an earlier transaction (a duplicate registration
   * mail, the send of an abandoned login). Reading it after the new send
   * hands the stale value to validation, so a pre-send boundary drains it now
   * and the first read after the send is the new code.
   *
   * Draining is best effort and only runs when the caller says no send is in
   * flight yet (`drainStaleCodes`); a failure leaves the queue untouched.
   */
  async snapshotMailbox(mailboxId, options = {}) {
    const rental = this.rental(mailboxId);
    const capturedAt = new Date(this.now()).toISOString();
    if (options.drainStaleCodes !== true || rental.settled || Number(rental.codesRead || 0) < 1) {
      return { messageIds: [], capturedAt };
    }
    const staleIds = [];
    let drainError = '';
    for (let index = 0; index < MAX_STALE_CODE_DRAIN; index += 1) {
      let found = null;
      try {
        found = await this.findVerificationCode(mailboxId, options);
      } catch (error) {
        drainError = String(error?.message || error);
        break;
      }
      if (!found) break;
      staleIds.push(found.messageId);
    }
    return {
      messageIds: staleIds,
      capturedAt,
      ...(staleIds.length ? { drainedStaleCodes: staleIds.length } : {}),
      ...(drainError ? { drainError } : {}),
    };
  }

  /**
   * Reads the next code, or null while the provider says it has not arrived.
   *
   * Returning null rather than throwing is what the caller's polling loop
   * expects, and it is the difference between "wait" and "this mailbox is
   * broken" — only the latter should surface as an error.
   */
  async findVerificationCode(mailboxId, options = {}) {
    const rental = this.rental(mailboxId);
    if (rental.settled) throw providerError('getCode', 'mailbox was already settled', { status: 409 });
    if (this.unstartedRentalExpired(rental)) {
      await this.expireUnstartedMailboxes({ onlyId: rental.id });
      throw providerError('getCode', 'registration did not start before the mailbox rental expired', {
        code: 'MAIL_RENTAL_START_TIMEOUT',
        retryable: false,
        status: 410,
      });
    }
    if (!rental.armed) await this.armNextCode(mailboxId, options);
    const json = await this.request('getCode', 'getCode', { mailId: rental.id }, options);
    if (Number(json.status) !== 1) {
      const message = text(json.error) || 'code was not returned';
      if (PENDING_CODE_PATTERN.test(message)) return null;
      const mailboxGone = MAILBOX_GONE_PATTERN.test(message);
      throw providerError('getCode', message, {
        cancelled: CANCELLED_PATTERN.test(message),
        ...(mailboxGone ? { status: 404, mailboxGone: true, code: 'MAILBOX_GONE' } : {}),
        response: json,
      });
    }
    const code = text(json.code);
    if (!code) return null;
    rental.codesRead += 1;
    rental.armed = false;
    // Armed immediately, not on the next read. The provider only forwards a
    // message that arrives while the activation is waiting for one, and the
    // next email is usually triggered seconds after this code is consumed —
    // arming lazily loses that message and costs a full poll timeout before
    // anything can retry. Best effort: a failure here just leaves the lazy
    // path to arm on the next read.
    try {
      await this.armNextCode(mailboxId, options);
    } catch (error) {
      rental.armError = error.message;
    }
    return {
      code,
      messageId: `${rental.id}#${rental.codesRead}`,
      consumedMessageId: `${rental.id}#${rental.codesRead}`,
      sender: '',
      subject: '',
      receivedAt: new Date(this.now()).toISOString(),
      folder: '',
      source: 'smsbower_mail',
    };
  }

  /** Arms the next code on a rental that already produced one. */
  async armNextCode(mailboxId, options = {}) {
    const rental = this.rental(mailboxId);
    if (rental.armed || rental.settled) return false;
    await this.setStatus(rental.id, STATUS_NEXT_CODE, options);
    rental.armed = true;
    return true;
  }

  /** Closes the rental and accepts the charge. Only the caller decides when. */
  async settleMailbox(mailboxId, options = {}) {
    const rental = this.rental(mailboxId);
    if (rental.settled) return false;
    try {
      await this.setStatus(rental.id, STATUS_SETTLE, options);
    } catch (error) {
      // A provider restart can report that the terminal mutation was already
      // accepted. Treat that as idempotent success; a missing mailbox is kept
      // as an error so the orchestrator can preserve billing uncertainty.
      if (!error.alreadySettled) throw error;
    }
    rental.settled = true;
    rental.cancelled = false;
    // Settling is what accepts the charge; a cancelled rental stays at zero.
    rental.costUsd = Number(rental.quotedPrice || 0);
    this.clearRentalExpiryTimer(rental.id);
    return true;
  }

  /** Drops the rental without accepting it, for a mailbox that produced nothing. */
  async cancelMailbox(mailboxId, options = {}) {
    const rental = this.rental(mailboxId);
    if (rental.settled) return false;
    let providerMissing = false;
    try {
      await this.setStatus(rental.id, STATUS_CANCEL, options);
    } catch (error) {
      // Cancellation is a discard operation. If the provider has already
      // forgotten or cancelled the activation, the requested end state is
      // already true and retrying only creates noise.
      if (!error.mailboxGone && !error.alreadyCancelled) throw error;
      providerMissing = error.mailboxGone === true;
    }
    rental.settled = true;
    rental.cancelled = true;
    rental.providerMissing = providerMissing;
    this.clearRentalExpiryTimer(rental.id);
    return true;
  }

  /** What this client has actually been charged for so far. */
  costSummary() {
    const rentals = [...this.rentals.values()];
    return {
      currency: 'USD',
      rented: rentals.length,
      settled: rentals.filter((rental) => rental.costUsd > 0).length,
      cancelled: rentals.filter((rental) => rental.cancelled === true).length,
      totalUsd: Number(rentals.reduce((sum, rental) => sum + Number(rental.costUsd || 0), 0).toFixed(6)),
      unitPrice: this.unitPrice,
    };
  }

  async setStatus(mailId, status, options = {}) {
    const json = await this.request('setStatus', 'setStatus', { id: mailId, status }, options);
    if (Number(json.status) !== 1) {
      const message = text(json.error) || `status ${status} was rejected`;
      const mailboxGone = MAILBOX_GONE_PATTERN.test(message);
      const alreadyCancelled = status === STATUS_CANCEL && CANCELLED_PATTERN.test(message);
      const alreadySettled = status === STATUS_SETTLE && SETTLED_PATTERN.test(message);
      throw providerError('setStatus', message, {
        ...(mailboxGone ? { status: 404, mailboxGone: true, code: 'MAILBOX_GONE' } : {}),
        ...(alreadyCancelled ? { alreadyCancelled: true, code: 'MAILBOX_ALREADY_CANCELLED' } : {}),
        ...(alreadySettled ? { alreadySettled: true, code: 'MAILBOX_ALREADY_SETTLED' } : {}),
        // SMSBower returns these state-transition rejections with HTTP 200 and
        // `status: 0`. Repeating the same mutation cannot change the provider
        // state; cleanup must record the external ambiguity and release the
        // local task instead of retrying forever.
        ...(mailboxGone || alreadyCancelled || alreadySettled ? {} : {
          code: 'MAILBOX_STATE_REJECTED',
          providerStateRejected: true,
          retryable: false,
        }),
        response: json,
      });
    }
    return true;
  }

  /**
   * No-ops kept so this client satisfies the same interface as the pooled one.
   * A rental is opened by `rentMailbox` and closed by settle/cancel.
   */
  async reserveMailbox() { return true; }
  async releaseMailbox(mailboxId) { return this.cancelMailbox(mailboxId); }
  async markBound() { return true; }
  async checkAuth() { return { ok: Boolean(this.apiKey) }; }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS,
  SmsbowerMailClient,
};
