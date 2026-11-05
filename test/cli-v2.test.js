'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { makeInitialOrchestratorV2State } = require('../src/orchestrator-v2');
const { saveV2State } = require('../src/state-store');

const cli = path.resolve(__dirname, '..', 'bin', 'gpt-re.js');

function baseConfig(tempDir) {
  return {
    schemaVersion: 2,
    mail: { accounts: [{ id: 1, email: 'base@example.test' }] },
    aliases: { plusAddressingEnabled: true, count: 1 },
    sms: { provider: 'mock' },
    registration: { exchangeToken: true },
    output: { stateDir: path.join(tempDir, 'state'), cpaDir: path.join(tempDir, 'output') },
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

test('orchestrator-status recognizes v2 state and redacts mailbox addresses', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-cli-v2-'));
  const config = baseConfig(tempDir);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-cli-unit' });
  state.mailboxes.push({ id: 1, rootEmail: 'base@example.test', status: 'reserved', successCount: 0 });
  const stateFile = path.join(tempDir, 'state.json');
  saveV2State(stateFile, state);

  const result = spawnSync(process.execPath, [cli, 'orchestrator-status', '--state', stateFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 2);
  assert.equal(output.mailboxes[0].email, '<redacted:email>');
});

test('v2 preflight rejects unsafe alias configuration before network calls', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-cli-v2-config-'));
  const configPath = path.join(tempDir, 'config.json');
  const config = baseConfig(tempDir);
  config.aliases.plusAddressingEnabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config));

  const result = spawnSync(process.execPath, [cli, 'orchestrator-preflight', '--config', configPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plusAddressingEnabled/);
});

test('cpa-export emits flat Cockpit JSON for a v2 state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-cli-v2-cpa-'));
  const config = baseConfig(tempDir);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-cli-cpa' });
  const email = 'base+gptre001@example.test';
  const exp = 1_800_000_000;
  state.jobs.push({
    id: 'job-cpa',
    status: 'complete',
    email,
    workspaceId: 'workspace-unit',
    completedAt: '2026-07-28T00:00:00.000Z',
    tokens: {
      id_token: jwt({ email, exp }),
      access_token: jwt({ email, exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-unit' } }),
      refresh_token: 'refresh-unit',
    },
  });
  const stateFile = path.join(tempDir, 'state.json');
  saveV2State(stateFile, state);

  const result = spawnSync(process.execPath, [cli, 'cpa-export', '--state', stateFile, '--raw'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.type, 'codex');
  assert.equal(output.email, email);
  assert.equal(output.account_id, 'workspace-unit');
  assert.equal(Object.hasOwn(output, 'accounts'), false);
});

test('orchestrator-status reads the v2 backup when the primary state is truncated', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-cli-v2-backup-'));
  const config = baseConfig(tempDir);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-cli-backup' });
  const stateFile = path.join(tempDir, 'state.json');
  saveV2State(stateFile, state);
  state.status = 'running';
  saveV2State(stateFile, state);
  fs.writeFileSync(stateFile, '{truncated');

  const result = spawnSync(process.execPath, [cli, 'orchestrator-status', '--state', stateFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.runId, 'run-cli-backup');
  assert.equal(output.status, 'initialized');
});
