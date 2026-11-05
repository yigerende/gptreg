"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  zlib = require("node:zlib");
const { oauthExport } = require("../src/platform/account-export");
const jwt = (value) =>
  Buffer.from('{"alg":"none"}').toString("base64url") +
  "." +
  Buffer.from(JSON.stringify(value)).toString("base64url") +
  ".fixture";
function account(index) {
  const email = `fixture-${index}@gmail.com`;
  return {
    email,
    password: "secret-not-for-oauth",
    totp_secret: "JBSWY3DPEHPK3PXP",
    oauth: {
      type: "codex",
      email,
      access_token: jwt({
        exp: 1900000000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: `account-${index}`,
          chatgpt_plan_type: "free",
        },
      }),
      id_token: jwt({ email }),
      refresh_token: `fake-refresh-${index}`,
    },
  };
}
function unzip(result) {
  const data = Buffer.from(result.content, "base64"),
    files = [];
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    const method = data.readUInt16LE(offset + 8),
      checksum = data.readUInt32LE(offset + 14),
      size = data.readUInt32LE(offset + 18),
      nameLength = data.readUInt16LE(offset + 26),
      extra = data.readUInt16LE(offset + 28);
    const name = data
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString();
    offset += 30 + nameLength + extra;
    const packed = data.subarray(offset, offset + size),
      raw = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(zlib.crc32(raw), checksum);
    files.push({ name, value: JSON.parse(raw) });
    offset += size;
  }
  assert.equal(data.readUInt32LE(offset), 0x02014b50);
  return files;
}
test("CPA single JSON and 1000-account ZIP contain isolated importer objects without portal secrets", () => {
  const one = oauthExport([account(0)], "cpa");
  assert.match(one.filename, /\.json$/);
  assert.deepEqual(JSON.parse(one.content), account(0).oauth);
  const result = oauthExport(
    Array.from({ length: 1000 }, (_, i) => account(i)),
    "cpa",
  );
  assert.equal(result.encoding, "base64");
  assert.match(result.filename, /1000\.zip$/);
  const entries = unzip(result);
  assert.equal(entries.length, 1000);
  assert.equal(new Set(entries.map((x) => x.name)).size, 1000);
  for (const [i, entry] of entries.entries()) {
    assert.deepEqual(entry.value, account(i).oauth);
    assert.ok(!entry.name.includes("/"));
  }
  const duplicates = unzip(oauthExport([account(0), account(0)], "cpa"));
  assert.notEqual(duplicates[0].name, duplicates[1].name);
});
test("SUB merges 1000 accounts into the local sub2api import schema and rejects unusable selections", () => {
  const result = oauthExport(
      Array.from({ length: 1000 }, (_, i) => account(i)),
      "sub",
    ),
    document = JSON.parse(result.content);
  assert.match(result.filename, /\.json$/);
  assert.deepEqual(document.proxies, []);
  assert.equal(document.accounts.length, 1000);
  for (const [i, row] of document.accounts.entries()) {
    assert.equal(row.platform, "openai");
    assert.equal(row.type, "oauth");
    assert.equal(row.credentials.chatgpt_account_id, `account-${i}`);
    assert.equal(row.credentials.refresh_token, `fake-refresh-${i}`);
    assert.ok(!row.credentials.password);
  }
  for (const format of ["cpa", "sub"])
    assert.throws(
      () =>
        oauthExport([account(0), { email: "standard@example.test" }], format),
      (e) => e.statusCode === 400,
    );
  assert.throws(
    () =>
      oauthExport(
        [
          {
            ...account(0),
            oauth: { access_token: "bad", refresh_token: "redacted" },
          },
        ],
        "sub",
      ),
    (e) => e.statusCode === 409 && !e.message.includes("redacted"),
  );
});
