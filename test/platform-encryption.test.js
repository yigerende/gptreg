"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { SessionAssetStore } = require("../src/session-asset-store");
const { saveV2State, loadV2State } = require("../src/state-store");
const { protect, parse } = require("../src/platform/runtime-secrets");
test("encrypted engine records retain functional exports and readable metadata", (t) => {
  const old = process.env.GPTREG_RUNTIME_MASTER_KEY;
  process.env.GPTREG_RUNTIME_MASTER_KEY = crypto
    .randomBytes(32)
    .toString("base64");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gptreg-encrypted-"));
  const store = new SessionAssetStore({
    cwd,
    stateDir: ".state",
    cpaDir: ".state/output",
  });
  t.after(() => {
    store.close();
    if (old) process.env.GPTREG_RUNTIME_MASTER_KEY = old;
    else delete process.env.GPTREG_RUNTIME_MASTER_KEY;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const asset = store.upsert({
    email: "sealed@example.test",
    password: "sensitive-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    accessToken: "sensitive-access",
    security: { passwordStatus: "configured", totpStatus: "configured" },
  });
  const raw = fs.readFileSync(store.filePath(asset.id), "utf8");
  assert.ok(!raw.includes("sensitive-password"));
  assert.ok(!raw.includes("sensitive-access"));
  assert.ok(raw.includes("sealed@example.test"));
  assert.equal(store.get(asset.id).password, "sensitive-password");
  assert.equal(store.export([asset.id], { kind: "credentials" }).exported, 1);
  const cpa = store.replaceCpa(
    asset.id,
    {
      email: asset.email,
      access_token: "sensitive-oauth",
      refresh_token: "sensitive-refresh",
    },
    { runId: "encrypted-run", jobId: "job1" },
  );
  const cpaRaw = fs.readFileSync(cpa.filePath, "utf8");
  assert.ok(!cpaRaw.includes("sensitive-oauth"));
  assert.equal(parse(cpaRaw).refresh_token, "sensitive-refresh");
  const state = {
    schemaVersion: 2,
    mode: "gpt-re-orchestrator-v2",
    runId: "encrypted-run",
    status: "running",
    configFingerprint: "0".repeat(64),
    phase: "normal",
    mailboxes: [],
    jobs: [{ password: "sensitive-job" }],
    workers: [],
    proxyLeases: {},
    proxyHealth: {},
    proxyCandidates: [],
    finalizationQueue: [],
    smsMarkets: {},
    events: [],
  };
  const file = path.join(cwd, "state.json");
  saveV2State(file, state);
  assert.ok(!fs.readFileSync(file, "utf8").includes("sensitive-job"));
  assert.deepEqual(loadV2State(file), state);
  const envelope = JSON.stringify(protect({ password: "secret" }));
  delete process.env.GPTREG_RUNTIME_MASTER_KEY;
  assert.throws(() => parse(envelope), /master key/);
});
