import { describe, expect, it } from 'vitest';

import { detectCredentialSourceMode, parseCredentialInput, parseEmailInput } from './credential-input';

describe('detectCredentialSourceMode', () => {
  it('treats a paste of bare addresses as email mode', () => {
    expect(detectCredentialSourceMode('a@x.com\nb@y.com')).toBe('emails');
  });

  it('stays in credentials mode when every line carries the separator', () => {
    expect(detectCredentialSourceMode('a@x.com----pw----ABCDEFGHIJKLMNOP')).toBe('credentials');
  });

  it('flips the whole paste to email mode if any line is bare', () => {
    expect(detectCredentialSourceMode('a@x.com----pw----ABCDEFGHIJKLMNOP\nb@y.com')).toBe('emails');
  });

  it('ignores blank and comment lines and defaults to credentials when empty', () => {
    expect(detectCredentialSourceMode('\n# note\n')).toBe('credentials');
  });
});

describe('parseEmailInput', () => {
  it('parses one address per line, lowercased, keeping line numbers', () => {
    const { emails, rejected } = parseEmailInput('Anzybrte1527@Outlook.com\nbbifxvs428@outlook.com');
    expect(rejected).toHaveLength(0);
    expect(emails).toEqual([
      { line: 1, email: 'anzybrte1527@outlook.com' },
      { line: 2, email: 'bbifxvs428@outlook.com' },
    ]);
  });

  it('rejects a line that still carries the credential separator', () => {
    const { emails, rejected } = parseEmailInput('a@x.com----pw----SECRET');
    expect(emails).toHaveLength(0);
    expect(rejected[0].code).toBe('EMAIL_MODE_MIXED');
  });

  it('rejects a malformed address', () => {
    const { rejected } = parseEmailInput('not-an-email');
    expect(rejected[0].code).toBe('EMAIL_MALFORMED');
  });

  it('flags a duplicate address against the first line it appeared on', () => {
    const { emails, rejected } = parseEmailInput('a@x.com\nA@X.com');
    expect(emails).toHaveLength(1);
    expect(rejected[0].code).toBe('CREDENTIAL_DUPLICATE');
  });

  it('skips blank and comment lines', () => {
    const { emails, rejected } = parseEmailInput('\n# comment\n// c\na@x.com\n');
    expect(rejected).toHaveLength(0);
    expect(emails).toEqual([{ line: 4, email: 'a@x.com' }]);
  });
});

describe('parseCredentialInput still parses triples', () => {
  it('accepts a well-formed triple', () => {
    const { entries, rejected } = parseCredentialInput('a@x.com----pw----ABCDEFGHIJKLMNOP');
    expect(rejected).toHaveLength(0);
    expect(entries[0]).toMatchObject({ email: 'a@x.com', password: 'pw', totpSecret: 'ABCDEFGHIJKLMNOP' });
  });
});
