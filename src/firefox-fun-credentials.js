'use strict';

// Server-side only. The UI and config snapshots never expose this value. The
// Firefox.fun integration is token-only; do not add an account/password login
// fallback here because the supplied credential is already an API token.
const FIREFOX_FUN_TOKEN = '1f3cea09bced461f8d62be19087d61f8_307427';

function getFirefoxFunCredentials(env = process.env) {
  return {
    token: FIREFOX_FUN_TOKEN || String(env.FIREFOX_FUN_TOKEN || '').trim(),
  };
}

module.exports = {
  getFirefoxFunCredentials,
};
