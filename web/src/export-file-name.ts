/**
 * File names for console downloads, e.g. `CPA-已OAuth-100个-26-10-08-23-00.json`:
 * type, whether the accounts went through OAuth, how many are inside, and the
 * local minute it was made. Mirrors `src/export-file-name.js`, which names the
 * files the server builds (archives, credential text) — keep the two in step.
 */
function pad(value: number) {
  return String(value).padStart(2, '0');
}

/** Local time as `yy-MM-dd-HH-mm`; Windows file names cannot carry `/` or `:`. */
export function exportTimestamp(at: Date = new Date()) {
  return [
    pad(at.getFullYear() % 100),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    pad(at.getHours()),
    pad(at.getMinutes()),
  ].join('-');
}

export function oauthLabel(oauth = 0, pending = 0) {
  const done = Math.max(0, Number(oauth) || 0);
  const waiting = Math.max(0, Number(pending) || 0);
  if (done && waiting) return `已OAuth${done}-未OAuth${waiting}`;
  return waiting ? '未OAuth' : '已OAuth';
}

export function exportFileName({ label, count, oauth, pending = 0, at, ext, tag = '' }: {
  label: string;
  count: number;
  oauth?: number;
  pending?: number;
  at?: Date;
  ext: string;
  /** What the export was restricted to, e.g. a registration country (`US`). */
  tag?: string;
}) {
  const total = Math.max(0, Number(count) || 0);
  const done = oauth === undefined ? total - (Number(pending) || 0) : oauth;
  // Characters Windows refuses in a file name are dropped, not escaped.
  const safeTag = String(tag || '').replace(/[\\/:*?"<>|\s]+/g, '');
  return `${label}${safeTag ? `-${safeTag}` : ''}-${oauthLabel(done, pending)}-${total}个-${exportTimestamp(at)}.${ext}`;
}
