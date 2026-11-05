'use strict';

/**
 * HTTP client for a local sub2api gateway's admin account surface.
 *
 * sub2api (github.com/Wei-Shaw/sub2api) is the AI API gateway the self-use
 * accounts are handed to. Three endpoints matter here:
 *
 *   POST /api/v1/admin/accounts/import/codex-session   push accounts in
 *   GET  /api/v1/admin/accounts                        read them back
 *   POST /api/v1/admin/accounts/batch-delete           remove them
 *   GET  /api/v1/admin/groups                          resolve a group name
 *
 * The import takes `content` — one string holding a JSON array of Codex session
 * records — and reads `access_token`, `id_token`, `refresh_token`, `email`,
 * `account_id` and `plan_type` off each entry. That is the shape this repo's
 * CPA artifacts already have (`src/cpa-output.js`), so a CPA record is sent
 * verbatim rather than through `buildSub2ApiDocument`: sub2api's importer does
 * not read that document's nested `credentials` object, and everything the
 * conversion derives (expiry, organization, plan) it derives again itself from
 * the access token's JWT claims.
 *
 * Authentication is `x-api-key` with the gateway's admin API key. That header
 * is a deliberate choice over a `Bearer` JWT: sub2api binds JWT sessions to the
 * caller's IP and user-agent and revokes them when either changes, which no
 * unattended pusher can hold onto.
 *
 * The one rejection worth expecting is an expired access token — sub2api
 * refuses those per-entry rather than failing the batch, and reports them in
 * `errors`.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 30000;
const API_PREFIX = '/api/v1/admin';
// One page of accounts. sub2api paginates, and a gateway with thousands of
// accounts must not be read in one request that times out halfway.
const ACCOUNT_PAGE_SIZE = 200;

/**
 * `status` on a listing query is a *derived* state, not the stored column.
 *
 * This is the trap in sub2api's account API: every row can report
 * `status: "active"` in its body while `?status=active` matches a fraction of
 * them, because the filter also requires the account to be schedulable, off
 * cooldown and not temporarily blocked (`accountListFilteredQuery`). The
 * derived values are `active`, `rate_limited`, `temp_unschedulable` and
 * `unschedulable`; `error`, `disabled` and `expired` fall through to a plain
 * match on the stored column, which is why the error set can be read out of a
 * plain scan and only the derived counts need a query of their own.
 */

class Sub2ApiError extends Error {
  constructor(message, { status = 0, code = 'SUB2API_ERROR', cause } = {}) {
    super(message);
    this.name = 'Sub2ApiError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * The per-entry outcomes, flattened to the few fields the console shows.
 *
 * sub2api answers with a `{ code, message, data }` envelope whose `data` is the
 * import result. A partial success is the normal case — one dead token in a
 * batch of thirty — so the counts and the failing entries both come back and
 * the caller decides what to do about them.
 */
function importSummary(data = {}) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const messages = (list) => (Array.isArray(list) ? list : [])
    .map((entry) => String(entry?.message || entry?.error || '').trim())
    .filter(Boolean);
  return {
    total: number(data.total),
    created: number(data.created),
    updated: number(data.updated),
    skipped: number(data.skipped),
    failed: number(data.failed),
    errors: messages(data.errors),
    warnings: messages(data.warnings),
  };
}

class Sub2ApiClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.adminApiKey = String(options.adminApiKey || '').trim();
    this.timeoutMs = Number(options.requestTimeoutMs || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  /**
   * One authenticated call, with transport and HTTP failures collapsed into
   * `Sub2ApiError` so callers never inspect `fetch` internals to tell a dead
   * gateway apart from a rejected payload.
   */
  async request(path, { method = 'GET', body, timeoutMs } = {}) {
    if (!this.adminApiKey) {
      throw new Sub2ApiError('\u672a\u914d\u7f6e sub2api \u7ba1\u7406\u5458 API Key\uff08sub2api.adminApiKey\uff09', { code: 'SUB2API_UNCONFIGURED' });
    }
    const controller = new AbortController();
    const budget = Number(timeoutMs || this.timeoutMs);
    const timer = setTimeout(() => controller.abort(), budget);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${API_PREFIX}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'x-api-key': this.adminApiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A refused connection and an abort both mean "no gateway answered".
      // Callers surface this as \u672a\u542f\u52a8 rather than as a rejected call.
      throw new Sub2ApiError(
        error?.name === 'AbortError'
          ? `sub2api \u65e0\u54cd\u5e94\uff08${budget}ms \u8d85\u65f6\uff09\uff1a${this.baseUrl}`
          : `\u65e0\u6cd5\u8fde\u63a5 sub2api \u670d\u52a1\uff1a${this.baseUrl}`,
        { code: 'SUB2API_OFFLINE', cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.message || payload?.reason || payload?.error || `HTTP ${response.status}`;
      // 401 is the one an operator can fix without reading a log: it means the
      // admin API key is missing or wrong, not that the call was malformed.
      throw new Sub2ApiError(
        response.status === 401
          ? `sub2api \u62d2\u7edd\u4e86\u7ba1\u7406\u5458 API Key\uff1a${typeof detail === 'string' ? detail : 'unauthorized'}`
          : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
        { status: response.status, code: response.status === 401 ? 'SUB2API_UNAUTHORIZED' : 'SUB2API_REJECTED' },
      );
    }
    return payload?.data === undefined ? payload : payload.data;
  }

  /** The gateway's account groups, for resolving a configured name to an id. */
  async listGroups() {
    const body = await this.request('/groups?page=1&page_size=200');
    return (Array.isArray(body?.items) ? body.items : []).map((group) => ({
      id: Number(group?.id),
      name: String(group?.name || ''),
      platform: String(group?.platform || ''),
    })).filter((group) => Number.isInteger(group.id));
  }

  /**
   * @param {object[]} records  CPA account records, sent as one JSON array.
   * @param {object}   options  `updateExisting` re-points an account sub2api
   *                            already holds at the new tokens instead of
   *                            skipping it; that is what a re-pushed account
   *                            after an AT refresh needs. Defaults on.
   *                            `groupIds` files the accounts into those groups;
   *                            on the update path the gateway *replaces* an
   *                            account's groups with them, which is how a
   *                            re-push also rehomes what was imported before.
   */
  async importCodexSessions(records = [], options = {}) {
    if (!Array.isArray(records) || !records.length) {
      throw new Sub2ApiError('\u81f3\u5c11\u9700\u8981\u4e00\u4e2a CPA \u8d26\u53f7', { code: 'SUB2API_EMPTY' });
    }
    const groupIds = (Array.isArray(options.groupIds) ? options.groupIds : [])
      .map(Number).filter((id) => Number.isInteger(id) && id > 0);
    return importSummary(await this.request('/accounts/import/codex-session', {
      method: 'POST',
      body: {
        // One string holding a JSON array: the importer decodes it as a JSON
        // stream and flattens arrays, so this is N entries, not one.
        content: JSON.stringify(records),
        update_existing: options.updateExisting !== false,
        ...(groupIds.length ? { group_ids: groupIds } : {}),
      },
    }));
  }

  /**
   * How many accounts each derived status holds, without reading the rows.
   *
   * One request per status, so callers ask only for the ones they render:
   * these exist because the derived state cannot be recomputed from a row
   * without duplicating the gateway's own predicate, which would then drift.
   * `page_size=1` makes each a count query rather than a page of data.
   */
  async accountCounts(filters = []) {
    const counts = {};
    for (const status of filters) {
      const page = await this.request(`/accounts?page=1&page_size=1&status=${encodeURIComponent(status)}`);
      counts[status] = Number(page?.total || 0);
    }
    return counts;
  }

  /**
   * Every account matching a derived status, paged to the end.
   *
   * `maxPages` is a stop, not a page size: a gateway holding more accounts than
   * that returns what it read and says so, rather than looping indefinitely
   * against a service that is also serving traffic.
   */
  async listAccounts({ status = '', maxPages = 10, lite = true } = {}) {
    const accounts = [];
    let total = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page += 1) {
      // `lite` drops the group joins from every row and halves the payload
      // (486KB → 215KB for 101 accounts). It keeps status, error message and
      // credential metadata; access tokens are not in the listing at all.
      const query = `page=${page}&page_size=${ACCOUNT_PAGE_SIZE}${lite ? '&lite=1' : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`;
      const body = await this.request(`/accounts?${query}`);
      const items = Array.isArray(body?.items) ? body.items : [];
      total = Number(body?.total ?? accounts.length + items.length);
      accounts.push(...items);
      if (!items.length || accounts.length >= total) break;
      if (page === maxPages) truncated = true;
    }
    return { accounts, total, truncated };
  }

  /** Permanently removes accounts. sub2api reports per-account failures. */
  async deleteAccounts(ids = []) {
    const accountIds = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!accountIds.length) throw new Sub2ApiError('\u81f3\u5c11\u9700\u8981\u4e00\u4e2a\u8d26\u53f7 id', { code: 'SUB2API_EMPTY' });
    const body = await this.request('/accounts/batch-delete', { method: 'POST', body: { account_ids: accountIds } });
    const failures = Array.isArray(body?.errors) ? body.errors : [];
    return {
      requested: accountIds.length,
      deleted: Number(body?.deleted ?? accountIds.length - failures.length),
      errors: failures.map((entry) => String(entry?.error || '').trim()).filter(Boolean),
    };
  }
}

module.exports = {
  Sub2ApiClient,
  Sub2ApiError,
};
