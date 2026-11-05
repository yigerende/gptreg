'use strict';

const DEFINITIVE_SECURITY_CODES = new Set([
  'MFA_ALREADY_ENABLED',
  'MFA_NOT_ELIGIBLE',
]);

function normalizedCode(error = {}) {
  return String(error?.code || '').trim().toUpperCase();
}

function normalizedMessage(error = {}) {
  return String(error?.message || '').trim().toLowerCase();
}

function isDefinitiveSecurityFailure(error = {}) {
  return DEFINITIVE_SECURITY_CODES.has(normalizedCode(error));
}

function isTlsTransportError(error = {}) {
  const code = normalizedCode(error);
  const message = normalizedMessage(error);
  return /^(?:ERR_SSL_|ERR_TLS_)/.test(code)
    || code === 'EPROTO'
    || /(?:tls_get_more_records|packet length too long|wrong version number|secure tls connection|ssl routines)/.test(message);
}

function isEmailDeliveryFailure(error = {}) {
  return ['EMAIL_OTP_TIMEOUT', 'EMAIL_NOT_DELIVERED_TO_TARGET'].includes(normalizedCode(error));
}

function isRetryableTransportError(error = {}) {
  if (isEmailDeliveryFailure(error)) return false;
  if (isDefinitiveSecurityFailure(error)) return false;
  if (error?.retryable === true) return true;
  const code = normalizedCode(error);
  const message = normalizedMessage(error);
  return isTlsTransportError(error)
    || /(?:EAI_AGAIN|UND_ERR_|TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|NETWORK|SOCKET)/.test(code)
    || /timed out|timeout|connection reset|socket hang up|network error|fetch failed|connection refused|host unreachable/.test(message)
    // The proxy dropped the connection before the request was sent (SOCKS or
    // CONNECT handshake). It carries only a generic REQUEST_FAILED code, so it
    // used to read as a real refusal: a TOTP setup that hit one dead exit was
    // marked `failed` and never retried on another.
    || /proxy socket closed|closed during handshake|proxy handshake/.test(message);
}

function isRetryableSecurityFailure(error = {}) {
  if (isDefinitiveSecurityFailure(error)) return false;
  const code = normalizedCode(error);
  const message = normalizedMessage(error);
  if (code === 'SECURITY_REAUTH_REQUIRED' || code === 'MFA_ENROLL_REAUTH_REQUIRED'
    || /re[-\s]?authenticate|reauthenticate|recently authenticate/.test(message)) return true;
  return isRetryableTransportError(error);
}

module.exports = {
  isEmailDeliveryFailure,
  isRetryableSecurityFailure,
  isRetryableTransportError,
  isTlsTransportError,
};
