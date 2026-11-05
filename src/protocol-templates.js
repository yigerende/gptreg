'use strict';

const { browserHeaders } = require('./browser-headers');

/**
 * Every request the registration and login flows make, declared here.
 *
 * These used to be indices into a HAR: step "user_register" meant
 * `har.log.entries[146]`, and the whole flow was a set of offsets into one
 * recording of one afternoon. That binding cost more than it gave.
 *
 *  - It expired. The recording the indices point at captured Firefox 153; the
 *    operator's next capture is Firefox 156, and every account had been
 *    announcing the older one for months.
 *  - It replayed one session's identity. The captured block carries that
 *    session's `traceparent`, its datadog ids and its
 *    `x-access-flow-invocation-id`, so every account sent the same ones.
 *  - It carried the recording conditions. That capture was taken with devtools
 *    open, so every entry in it also carries `Pragma: no-cache` and
 *    `Cache-Control: no-cache`, which ordinary browsing does not send at all.
 *  - It broke on arithmetic. Adding one request to the flow renumbered every
 *    index after it, and a second baseline capture in the working directory
 *    made the loader refuse to choose at all.
 *
 * What the recording actually supplied was a method, a URL, the page the
 * request came from, and a browser header block — all of which are shorter
 * written down than looked up. The header block is derived per request from
 * the account's own profile, so it follows the account rather than the
 * recording, and `gpt-re protocol-drift` compares this table against a fresh
 * capture whenever there is reason to think the far side has moved.
 *
 * `index` survives only as a stable identifier for logs, dry-run URLs and the
 * `capture` mode that still replays a recording for that comparison.
 */

const AUTH_ORIGIN = 'https://auth.openai.com';

/** The page each request is made from, as the auth app navigates. */
const PAGES = Object.freeze({
  createAccount: `${AUTH_ORIGIN}/create-account`,
  createAccountPassword: `${AUTH_ORIGIN}/create-account/password`,
  emailVerification: `${AUTH_ORIGIN}/email-verification`,
  addPhone: `${AUTH_ORIGIN}/add-phone`,
  phoneVerification: `${AUTH_ORIGIN}/phone-verification`,
  aboutYou: `${AUTH_ORIGIN}/about-you`,
  consent: `${AUTH_ORIGIN}/sign-in-with-chatgpt/codex/consent`,
  logIn: `${AUTH_ORIGIN}/log-in`,
  logInPassword: `${AUTH_ORIGIN}/log-in/password`,
});

/**
 * The consent page is a Remix route, and its `.data` fetch names the route it
 * is loading. The value is part of the contract with that page, not of the
 * session that was recorded.
 */
const CONSENT_DATA_ROUTE = 'SIGN_IN_WITH_CHATGPT_CODEX_CONSENT';

/**
 * A navigation that a person began, carried through its redirects.
 *
 * Firefox keeps the original navigation's `Sec-Fetch-Site` and
 * `Sec-Fetch-User` across the redirect chain, so the four bootstrap hops all
 * report `none` and `?1` even though only the first was typed. Claiming
 * `same-origin` on the later hops would contradict the chain they came from.
 */
const OPENED_NAVIGATION = Object.freeze({ kind: 'navigate', userActivated: true, referer: '' });

const JSON_POST = Object.freeze({ method: 'POST', kind: 'fetch', accept: 'application/json', contentType: 'application/json', origin: AUTH_ORIGIN });

const TEMPLATES = Object.freeze({
  // The OAuth bootstrap: one navigation the console opens, then its redirects.
  bootstrap_oauth_authorize: { ...OPENED_NAVIGATION, index: 0, method: 'GET', path: '/oauth/authorize' },
  bootstrap_oauth_auth: { ...OPENED_NAVIGATION, index: 1, method: 'GET', path: '/api/oauth/oauth2/auth' },
  bootstrap_accounts_login: { ...OPENED_NAVIGATION, index: 2, method: 'GET', path: '/api/accounts/login' },
  bootstrap_log_in_page: { ...OPENED_NAVIGATION, index: 3, method: 'GET', path: '/log-in' },

  // Registration, in the order the auth app walks its own pages.
  authorize_continue: { ...JSON_POST, index: 137, path: '/api/accounts/authorize/continue', referer: PAGES.createAccount },
  user_register: { ...JSON_POST, index: 146, path: '/api/accounts/user/register', referer: PAGES.createAccountPassword },
  email_otp_send: { index: 150, method: 'GET', kind: 'navigate', userActivated: true, path: '/api/accounts/email-otp/send', referer: PAGES.createAccountPassword },
  email_otp_validate: { ...JSON_POST, index: 258, path: '/api/accounts/email-otp/validate', referer: PAGES.emailVerification },
  phone_otp_send: { ...JSON_POST, index: 279, path: '/api/accounts/add-phone/send', referer: PAGES.addPhone },
  phone_otp_validate: { ...JSON_POST, index: 287, path: '/api/accounts/phone-otp/validate', referer: PAGES.phoneVerification },
  create_account: { ...JSON_POST, index: 299, path: '/api/accounts/create_account', referer: PAGES.aboutYou },

  // Consent and the OAuth tail, shared by registration and login.
  consent_data: {
    index: 302,
    method: 'GET',
    kind: 'fetch',
    accept: '*/*',
    path: '/sign-in-with-chatgpt/codex/consent.data',
    query: { _routes: CONSENT_DATA_ROUTE },
    referer: PAGES.aboutYou,
  },
  workspace_select: { ...JSON_POST, index: 305, path: '/api/accounts/workspace/select', referer: PAGES.consent },
  oauth_auth_login_verifier: { index: 308, method: 'GET', kind: 'navigate', userActivated: true, path: '/api/oauth/oauth2/auth', referer: PAGES.consent },
  oauth_consent: { index: 309, method: 'GET', kind: 'navigate', userActivated: true, path: '/api/accounts/consent', referer: PAGES.consent },
  oauth_auth_consent_verifier: { index: 310, method: 'GET', kind: 'navigate', userActivated: true, path: '/api/oauth/oauth2/auth', referer: PAGES.consent },

  // Login-only. Both reuse the registration endpoints from the sign-in pages.
  login_authorize_continue: { ...JSON_POST, index: -801, path: '/api/accounts/authorize/continue', referer: PAGES.logIn },
  password_verify: { ...JSON_POST, index: -802, path: '/api/accounts/password/verify', referer: PAGES.logInPassword },
});

function templateUrl(template) {
  const url = new URL(template.path, AUTH_ORIGIN);
  for (const [key, value] of Object.entries(template.query || {})) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * A template rendered into the shape a capture entry has.
 *
 * The flows read their templates through the same accessor either way, so
 * presenting a declared request as an entry is what lets the recording become
 * optional without every caller downstream learning a second shape.
 */
function templateEntry(name, options = {}) {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown protocol template: ${name}`);
  const url = options.url || templateUrl(template);
  const headers = browserHeaders(options.profile || {}, {
    url,
    kind: template.kind,
    referer: template.referer,
    origin: template.origin || '',
    accept: template.accept || '',
    contentType: template.contentType || '',
    userActivated: template.userActivated === true,
  });
  return {
    request: {
      method: template.method,
      url,
      headers: Object.entries(headers).map(([header, value]) => ({ name: header, value })),
      cookies: [],
      ...(template.contentType ? { postData: { mimeType: template.contentType, text: '' } } : {}),
    },
    response: { status: 0, headers: [], content: {} },
  };
}

function templateFor(name) {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown protocol template: ${name}`);
  return template;
}

module.exports = {
  TEMPLATES,
  templateEntry,
  templateFor,
  templateUrl,
};
