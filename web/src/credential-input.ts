/**
 * Browser-side parsing and live TOTP for pasted account credentials.
 *
 * This is the only parser: the console posts structured accounts, so the server
 * never sees the pasted text. A duplicate of this lived at
 * `src/credential-import.js` and had already drifted in its reject messages
 * without anything calling it. Kept separate from the page: the parse is worth
 * reading on its own, and the TOTP maths must stay away from React.
 *
 * The live code exists so a bad secret is visible before a run starts rather
 * than after a login has already burned a proxy and a Sentinel challenge.
 */

export type CredentialEntry = {
  line: number;
  email: string;
  password: string;
  totpSecret: string;
};

export type CredentialRejection = {
  line: number;
  input: string;
  code: string;
  reason: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOTP_SECRET_PATTERN = /^[A-Z2-7]{16,}$/;
const SEPARATOR = '----';

function normalizeTotpSecret(value: string) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
}

/**
 * Splits pasted text into usable credentials and the lines that were refused.
 * Every non-blank line lands in exactly one list, so the footer can account for
 * all of the input instead of quietly dropping part of it.
 */
export function parseCredentialInput(content: string) {
  const entries: CredentialEntry[] = [];
  const rejected: CredentialRejection[] = [];
  const seen = new Map<string, number>();

  String(content || '').split(/\r?\n/).forEach((raw, index) => {
    const line = String(raw || '').trim().replace(/^﻿/, '');
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const at = index + 1;
    const reject = (code: string, reason: string) => {
      rejected.push({ line: at, input: line.slice(0, 60), code, reason });
    };

    const parts = line.split(SEPARATOR);
    if (parts.length < 3) {
      reject('CREDENTIAL_INCOMPLETE', '字段不足');
      return;
    }
    const email = parts[0].trim().toLowerCase();
    // A password may itself contain `----`; only the last field is the secret.
    const password = parts.slice(1, -1).join(SEPARATOR).trim();
    const totpSecret = normalizeTotpSecret(parts[parts.length - 1]);

    if (!EMAIL_PATTERN.test(email)) { reject('EMAIL_MALFORMED', '邮箱不合法'); return; }
    if (!password) { reject('PASSWORD_MISSING', '密码为空'); return; }
    if (!TOTP_SECRET_PATTERN.test(totpSecret)) { reject('TOTP_SECRET_MALFORMED', '密钥非 Base32'); return; }
    const previous = seen.get(email);
    if (previous !== undefined) {
      rejected.push({ line: at, input: email, code: 'CREDENTIAL_DUPLICATE', reason: `与第 ${previous} 行重复` });
      return;
    }
    seen.set(email, at);
    entries.push({ line: at, email, password, totpSecret });
  });

  return { entries, rejected };
}

export type EmailEntry = {
  line: number;
  email: string;
};

/**
 * Which source the pasted text describes. A single bare line — an address with
 * no `----` — flips the whole paste to email mode, because the two kinds cannot
 * share one run and the email path is the one the operator reached for.
 */
export function detectCredentialSourceMode(content: string): 'credentials' | 'emails' {
  const lines = String(content || '').split(/\r?\n/)
    .map((raw) => String(raw || '').trim().replace(/^\ufeff/, ''))
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
  if (!lines.length) return 'credentials';
  return lines.some((line) => !line.includes(SEPARATOR)) ? 'emails' : 'credentials';
}

/**
 * Splits pasted text into bare addresses and the lines that were refused, the
 * email-mode twin of parseCredentialInput. A line still carrying `----` is
 * rejected rather than half-read: the two source kinds must not be mixed.
 */
export function parseEmailInput(content: string) {
  const emails: EmailEntry[] = [];
  const rejected: CredentialRejection[] = [];
  const seen = new Map<string, number>();

  String(content || '').split(/\r?\n/).forEach((raw, index) => {
    const line = String(raw || '').trim().replace(/^\ufeff/, '');
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const at = index + 1;
    const reject = (code: string, reason: string) => {
      rejected.push({ line: at, input: line.slice(0, 60), code, reason });
    };
    if (line.includes(SEPARATOR)) { reject('EMAIL_MODE_MIXED', '邮箱模式下不能含 ----'); return; }
    const email = line.toLowerCase();
    if (!EMAIL_PATTERN.test(email)) { reject('EMAIL_MALFORMED', '邮箱不合法'); return; }
    const previous = seen.get(email);
    if (previous !== undefined) {
      rejected.push({ line: at, input: email, code: 'CREDENTIAL_DUPLICATE', reason: `与第 ${previous} 行重复` });
      return;
    }
    seen.set(email, at);
    emails.push({ line: at, email });
  });

  return { emails, rejected };
}

/** Masks a secret for display, keeping just enough to tell two apart. */
export function maskSecret(value: string, keep = 2) {
  const text = String(value || '');
  if (!text) return '—';
  if (text.length <= keep * 2) return '•'.repeat(text.length);
  return `${text.slice(0, keep)}${'•'.repeat(Math.min(8, text.length - keep * 2))}${text.slice(-keep)}`;
}

function base32Decode(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeTotpSecret(secret);
  let bits = '';
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return bytes.length >= 10 ? new Uint8Array(bytes) : null;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** RFC 6238 TOTP, 6 digits, 30-second step, SHA-1 — what OpenAI enrolls. */
export async function totpCode(secret: string, atMs = Date.now()) {
  const raw = base32Decode(secret);
  if (!raw) return '';
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  const counter = Math.floor(atMs / 1000 / 30);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key, buffer));
  const offset = signature[19] & 0xf;
  const truncated = ((signature[offset] & 0x7f) << 24)
    | (signature[offset + 1] << 16)
    | (signature[offset + 2] << 8)
    | signature[offset + 3];
  return String(truncated % 1_000_000).padStart(6, '0');
}

/** Fraction of the current 30-second window still remaining, 1 → 0. */
export function totpRemaining(atMs = Date.now()) {
  return (30 - ((atMs / 1000) % 30)) / 30;
}
