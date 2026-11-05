'use strict';

const crypto = require('node:crypto');

/**
 * The tracing headers the auth app's own front end attaches to its API calls.
 *
 * These are not browser headers — they come from the Datadog RUM SDK the page
 * loads — but every XHR the auth flow makes carries them, so a request without
 * them is a request no version of that page produced. The console sent none of
 * them, and the capture-replay path it replaced was worse: it replayed the
 * recorded session's ids verbatim, so every account announced the same trace.
 *
 * They are also checkable against each other, which is the reason to generate
 * them properly rather than approximately. In the capture, `traceparent`
 * carries a 64-bit trace id zero-padded into its 128-bit field, and its
 * decimal value is exactly `x-datadog-trace-id`; the span id's decimal value is
 * exactly `x-datadog-parent-id`. Three requests, three matches. A generator
 * that filled these independently would fail that comparison every time.
 */

const TRACE_STATE = 'dd=s:1;o:rum';
const SAMPLED_FLAGS = '01';

function randomId() {
  const bytes = crypto.randomBytes(8);
  return { hex: bytes.toString('hex'), decimal: BigInt(`0x${bytes.toString('hex')}`).toString() };
}

/**
 * One request's worth of tracing headers.
 *
 * @param {string} navigationId  the current document's id. It survives the
 *   page's client-side route changes and is replaced only by a real document
 *   load, which is how the capture behaves: two requests made from the same
 *   loaded page share one, and a request after a navigation carries a new one.
 */
function authTelemetryHeaders(navigationId) {
  const trace = randomId();
  const span = randomId();
  return {
    'x-access-flow-invocation-id': crypto.randomUUID(),
    ...(navigationId ? { 'x-openai-document-navigation-id': navigationId } : {}),
    traceparent: `00-${'0'.repeat(16)}${trace.hex}-${span.hex}-${SAMPLED_FLAGS}`,
    tracestate: TRACE_STATE,
    'x-datadog-origin': 'rum',
    'x-datadog-parent-id': span.decimal,
    'x-datadog-sampling-priority': '1',
    'x-datadog-trace-id': trace.decimal,
  };
}

/** Whether a request is one of the auth app's own API calls. */
function tracedRequest(url, kind) {
  if (kind !== 'fetch') return false;
  try {
    const parsed = new URL(String(url));
    return parsed.host === 'auth.openai.com' && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

module.exports = {
  authTelemetryHeaders,
  tracedRequest,
};
