'use strict';

const { normalizedEmail } = require('./session-asset-store');

/** Verify both immutable account identity and the email observed by the server. */
function verifySessionIdentity(state, emails, accountIds, confirmedEmailChange) {
  const expectedEmail = normalizedEmail(state.email);
  const previousEmail = normalizedEmail(confirmedEmailChange?.previousEmail);
  const changeMatches = Boolean(previousEmail && previousEmail !== expectedEmail
    && normalizedEmail(confirmedEmailChange?.email) === expectedEmail
    && String(confirmedEmailChange?.accountId || '').trim());
  const expectedAccountId = String(state.accountId || (changeMatches ? confirmedEmailChange.accountId : '') || '').trim();
  const diagnostics = { expectedEmail, observedEmails: emails, expectedAccountId, observedAccountIds: accountIds };
  const reject = (code, message) => { throw Object.assign(new Error(message), { code, diagnostics }); };
  if (accountIds.length > 1 || (expectedAccountId && accountIds.some((id) => id !== expectedAccountId))) {
    reject('SESSION_IDENTITY_MISMATCH', 'Verified session account does not match the saved login-state asset');
  }
  if (expectedAccountId && accountIds.length === 0) {
    reject('SESSION_ACCOUNT_UNVERIFIED', 'Verified session did not expose an account identifier for the saved login-state asset');
  }
  const emailMismatch = emails.some((email) => email !== expectedEmail);
  // After a confirmed email change, profile claims may lag behind the current
  // email. Require the saved account ID AND an observation of the new email;
  // unrelated emails, an old-only identity, and missing IDs still fail closed.
  const reconciled = emailMismatch && changeMatches
    && expectedAccountId === String(confirmedEmailChange.accountId).trim()
    && accountIds.length === 1 && accountIds[0] === expectedAccountId
    && emails.includes(expectedEmail)
    && emails.every((email) => email === expectedEmail || email === previousEmail);
  if (emailMismatch && !reconciled) {
    reject('SESSION_IDENTITY_MISMATCH', 'Verified session email does not match the requested account');
  }
  return { accountId: expectedAccountId || accountIds[0] || '', reconciled };
}

module.exports = { verifySessionIdentity };
