'use strict';

/**
 * File names for everything the console hands over as a download.
 *
 *   CPA-已OAuth-100个-26-10-08-23-00.json
 *
 * Type first, then whether the accounts went through OAuth, how many are in
 * the file, and the local minute it was made — so a folder of exports sorts by
 * kind and then by time, and a buyer's file says what is inside without being
 * opened. Mirrored in `web/src/export-file-name.ts`; keep the two in step.
 */
function pad(value) {
  return String(value).padStart(2, '0');
}

/** Local time as `yy-MM-dd-HH-mm`. Windows file names cannot carry `/` or `:`. */
function exportTimestamp(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return [
    pad(valid.getFullYear() % 100),
    pad(valid.getMonth() + 1),
    pad(valid.getDate()),
    pad(valid.getHours()),
    pad(valid.getMinutes()),
  ].join('-');
}

/** `已OAuth`, `未OAuth`, or both counts when one file holds both kinds. */
function oauthLabel(oauth = 0, pending = 0) {
  const done = Math.max(0, Number(oauth) || 0);
  const waiting = Math.max(0, Number(pending) || 0);
  if (done && waiting) return `已OAuth${done}-未OAuth${waiting}`;
  return waiting ? '未OAuth' : '已OAuth';
}

function exportFileName({ label, count = 0, oauth, pending = 0, at, ext }) {
  const total = Math.max(0, Number(count) || 0);
  const done = oauth === undefined ? total - (Number(pending) || 0) : oauth;
  return `${label}-${oauthLabel(done, pending)}-${total}个-${exportTimestamp(at)}.${ext}`;
}

/**
 * A Content-Disposition that survives the Chinese in these names: an ASCII
 * fallback for old clients plus the RFC 5987 form every current browser reads.
 */
function attachmentDisposition(fileName) {
  const name = String(fileName || 'download');
  // Plain ASCII names (a single account's own CPA file) keep the simple form.
  if (/^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)) return `attachment; filename="${name}"`;
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = { attachmentDisposition, exportFileName, exportTimestamp, oauthLabel };
