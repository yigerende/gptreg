#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadHar } = require('../src/har');
const { buildCpaArtifact, buildLegacyCpaArtifact, summarizeCpaArtifact } = require('../src/cpa-output');
const { validateV2Config } = require('../src/config-v2');
const { buildEmailFlow } = require('../src/email-flow');
const { buildProtocolDrift } = require('../src/protocol-drift');
const { decodePureHttpUrl, executePureHttpUrl } = require('../src/pure-url');
const { buildTokenRequestDescriptor, exchangeTokens } = require('../src/oauth-pkce');
const {
  jobsForCpa,
  loadOrchestratorConfig,
  makeInitialOrchestratorState,
  orchestratorStatePath,
  readJson,
  runOrchestrator,
  summarizeOrchestratorState,
  writeJson,
} = require('../src/orchestrator');
const {
  cancelOrchestratorV2,
  makeInitialOrchestratorV2State,
  preflightOrchestratorV2,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  runStatePathV2,
  skipAliasV2,
  summarizeOrchestratorV2State,
} = require('../src/orchestrator-v2');
const { REGISTRATION_STEP_PATHS, buildRegistrationPlan } = require('../src/registration-flow');
const {
  LOGIN_STEPS,
  loginStatePathForEmail,
  loadRegistrationState,
  makeInitialLoginState,
  makeInitialRegistrationState,
  runLoginFlow,
  runRegistrationFlow,
  saveRegistrationState,
  statePathForEmail,
  summarizeRegistrationState,
} = require('../src/registration-runner');
const { buildSummary, buildUrlChain, decodeUrlizedRequest } = require('../src/url-chain');
const { buildSentinelEnvelope, extractSentinel } = require('../src/sentinel');
const { acquireStateLock, configFingerprint, loadV2State, saveV2State } = require('../src/state-store');

function usage() {
  return [
    'Usage:',
    '  node bin/gpt-re.js summary [file.har]',
    '  node bin/gpt-re.js chain [file.har] [--raw] [--all] [--include-telemetry] [--body]',
    '  node bin/gpt-re.js sentinel [file.har] [--raw] [--body]',
    '  node bin/gpt-re.js protocol-drift [file.har] [--country <cc>]',
    '  node bin/gpt-re.js email-flow --email <addr> [file.har] [--raw]',
    '  node bin/gpt-re.js registration-plan --email <addr> [--step <name>] [--summary] [--email-code <code>] [--phone <number>] [--phone-code <code>] [--raw]',
    '  node bin/gpt-re.js registration-run --email <addr> [--proxy 2080] [--state <file>] [--email-code <code>] [--phone <number>] [--phone-code <code>] [--workspace-id <id>] [--once] [--dry-run] [--restart] [--static-sentinel] [--cloudflare-jsd] [--raw]',
    '  node bin/gpt-re.js registration-status --state <file> [--raw]',
    '  node bin/gpt-re.js oauth-login-run --email <addr> --password <password> [--proxy 2080] [--state <file>] [--workspace-id <id>] [--once] [--dry-run] [--restart] [--static-sentinel] [--cloudflare-jsd] [--raw]',
    '  node bin/gpt-re.js oauth-login-status --state <file> [--raw]',
    '  node bin/gpt-re.js oauth-token-exchange --state <registration-or-login-state> [--proxy 2080] [--dry-run] [--raw]',
    '  node bin/gpt-re.js orchestrator-run --config gpt-re.config.json [--state <file>] [--dry-run] [--exchange-token] [--restart] [--raw]',
    '  node bin/gpt-re.js orchestrator-preflight --config gpt-re.config.json',
    '  node bin/gpt-re.js orchestrator-resume --config gpt-re.config.json --state <file> [--job <job-id>] [--resolve-effect retry] [--raw]',
    '  node bin/gpt-re.js orchestrator-skip-alias --config gpt-re.config.json --state <file> --job <job-id> [--reason <text>]',
    '  node bin/gpt-re.js orchestrator-cancel --config gpt-re.config.json --state <file> [--reason <text>]',
    '  node bin/gpt-re.js orchestrator-status --state <file> [--raw]',
    '  node bin/gpt-re.js cpa-export --state <orchestrator-state> [--output <file>] [--raw]',
    '  node bin/gpt-re.js decode-http-url <gpt-re+http://...>',
    '  node bin/gpt-re.js run-http-url <gpt-re+http://...> [--proxy 2080]',
    '  node bin/gpt-re.js decode-url <gpt-re+har://...>',
    '  node bin/gpt-re.js build-sentinel --p <proof> --flow <flow> --id <oai-did>',
    '  node bin/gpt-re.js verify [file.har]',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'summary';
  const options = {
    command,
    positional: [],
    redact: true,
    includeAll: false,
    includeTelemetry: false,
    includeBodyText: false,
    kv: {},
  };

  function setKv(key, value) {
    options.kv[key] = value;
    if (key.includes('-')) options.kv[key.replace(/-/g, '_')] = value;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--raw') {
      options.redact = false;
    } else if (arg === '--all') {
      options.includeAll = true;
    } else if (arg === '--include-telemetry') {
      options.includeTelemetry = true;
    } else if (arg === '--body') {
      options.includeBodyText = true;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      setKv(key, value);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        setKv(key, true);
      } else {
        setKv(key, next);
        index += 1;
      }
    } else {
      options.positional.push(arg);
    }
  }

  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function loadFromOptions(options) {
  return loadHar(options.positional[0] || options.kv.har).har;
}

function proxyFromOptions(options) {
  return options.kv.proxy || process.env.GPT_RE_PROXY || '';
}

function readJsonInput(filePath, label) {
  if (!filePath) throw new Error(`${label} requires a JSON file`);
  const resolved = path.resolve(filePath);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} JSON: ${resolved}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} JSON must contain an object`);
  }
  return value;
}

function v2ConfigFromOptions(options) {
  const configFile = options.kv.config || options.positional[0];
  if (!configFile) throw new Error(`${options.command} requires --config <file>`);
  const config = validateV2Config(loadOrchestratorConfig(configFile));
  return { config, configFile };
}

function assertV2ConfigFingerprint(state, config) {
  const fingerprint = configFingerprint(config);
  if (state.configFingerprint && state.configFingerprint !== fingerprint) {
    throw new Error('V2 state config fingerprint does not match the supplied config');
  }
}

function loadAnyOrchestratorState(stateFile) {
  try {
    return loadV2State(stateFile);
  } catch (error) {
    if (error.code === 'ESTATEVERSION') return readJson(stateFile);
    throw error;
  }
}

async function withV2StateLock(stateFile, command, action) {
  const lock = acquireStateLock(stateFile, { command });
  try {
    return await action();
  } finally {
    lock.release();
  }
}

function verify(har) {
  const rawChain = buildUrlChain(har, {
    redact: false,
    includeAll: false,
    includeTelemetry: true,
    includeBodyText: true,
  });
  const failures = [];

  for (const entry of rawChain.entries) {
    const decoded = decodeUrlizedRequest(entry.urlized);
    if (decoded.method !== entry.method) failures.push(`method mismatch at ${entry.index}`);
    if (decoded.status !== entry.status) failures.push(`status mismatch at ${entry.index}`);
    if (decoded.url !== entry.url) failures.push(`url mismatch at ${entry.index}`);
    if ((decoded.body || '') !== (entry.postData?.text || '')) failures.push(`body mismatch at ${entry.index}`);
  }

  const sentinel = extractSentinel(har, { redact: false, includeBodyText: true });
  if (!sentinel.version) failures.push('missing sentinel version');
  if (sentinel.requests.length === 0) failures.push('missing sentinel req entries');
  if (!sentinel.contract.consumerHeaders.includes('openai-sentinel-token')) {
    failures.push('missing openai-sentinel-token consumer');
  }

  return {
    ok: failures.length === 0,
    failures,
    checked: {
      chainEntries: rawChain.entries.length,
      sentinelRequests: sentinel.requests.length,
      sentinelConsumers: sentinel.consumers.length,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (options.command === 'decode-url') {
    const value = options.positional[0];
    if (!value) throw new Error('decode-url requires a urlized request');
    printJson(decodeUrlizedRequest(value));
    return;
  }

  if (options.command === 'decode-http-url') {
    const value = options.positional[0];
    if (!value) throw new Error('decode-http-url requires a pure HTTP URL');
    printJson(decodePureHttpUrl(value));
    return;
  }

  if (options.command === 'run-http-url') {
    const value = options.positional[0];
    if (!value) throw new Error('run-http-url requires a pure HTTP URL');
    const result = await executePureHttpUrl(value, { proxy: proxyFromOptions(options) });
    printJson({
      request: {
        index: result.request.index,
        method: result.request.method,
        url: result.request.url,
      },
      response: {
        status: result.response.status,
        url: result.response.url,
        location: result.response.location,
        contentType: result.response.contentType,
        textLength: result.response.text.length,
        textPreview: result.response.text.slice(0, 500),
      },
      cookieNames: Object.keys(result.cookies).sort(),
    });
    return;
  }

  if (options.command === 'build-sentinel') {
    const p = options.kv.p;
    const flow = options.kv.flow;
    const id = options.kv.id;
    const extra = options.kv.extra ? JSON.parse(options.kv.extra) : {};
    process.stdout.write(`${buildSentinelEnvelope({ ...extra, p }, flow, id)}\n`);
    return;
  }

  if (options.command === 'orchestrator-preflight') {
    const { config } = v2ConfigFromOptions(options);
    printJson(await preflightOrchestratorV2(config));
    return;
  }

  if (options.command === 'orchestrator-resume') {
    const stateFile = options.kv.state;
    if (!stateFile) throw new Error('orchestrator-resume requires --state <file>');
    const { config } = v2ConfigFromOptions(options);
    const har = loadHar(options.kv.har).har;
    await withV2StateLock(stateFile, options.command, async () => {
      const state = loadV2State(stateFile);
      assertV2ConfigFingerprint(state, config);
      resumeOrchestratorV2State(state, {
        jobId: options.kv.job,
        effectResolution: options.kv.resolve_effect || options.kv.resolveEffect,
      });
      saveV2State(stateFile, state);
      await runOrchestratorV2(har, state, config, {
        saveState: (next) => saveV2State(stateFile, next),
      });
      printJson({ stateFile, ...summarizeOrchestratorV2State(state, { redact: options.redact }) });
    });
    return;
  }

  if (options.command === 'orchestrator-skip-alias') {
    const stateFile = options.kv.state;
    const jobId = options.kv.job;
    if (!stateFile || !jobId) throw new Error('orchestrator-skip-alias requires --state <file> --job <job-id>');
    const { config } = v2ConfigFromOptions(options);
    await withV2StateLock(stateFile, options.command, async () => {
      const state = loadV2State(stateFile);
      assertV2ConfigFingerprint(state, config);
      await skipAliasV2(state, config, jobId, {
        reason: options.kv.reason,
        saveState: (next) => saveV2State(stateFile, next),
      });
      printJson({ stateFile, ...summarizeOrchestratorV2State(state, { redact: options.redact }) });
    });
    return;
  }

  if (options.command === 'orchestrator-cancel') {
    const stateFile = options.kv.state;
    if (!stateFile) throw new Error('orchestrator-cancel requires --state <file>');
    const { config } = v2ConfigFromOptions(options);
    await withV2StateLock(stateFile, options.command, async () => {
      const state = loadV2State(stateFile);
      assertV2ConfigFingerprint(state, config);
      await cancelOrchestratorV2(state, config, {
        reason: options.kv.reason,
        saveState: (next) => saveV2State(stateFile, next),
      });
      printJson({ stateFile, ...summarizeOrchestratorV2State(state, { redact: options.redact }) });
    });
    return;
  }

  if (options.command === 'registration-status') {
    const stateFile = options.kv.state || options.positional[0];
    if (!stateFile) throw new Error('registration-status requires --state <file>');
    printJson({
      stateFile,
      ...summarizeRegistrationState(loadRegistrationState(stateFile), { redact: options.redact }),
    });
    return;
  }

  if (options.command === 'oauth-login-status') {
    const stateFile = options.kv.state || options.positional[0];
    if (!stateFile) throw new Error('oauth-login-status requires --state <file>');
    printJson({
      stateFile,
      ...summarizeRegistrationState(loadRegistrationState(stateFile), { redact: options.redact, steps: LOGIN_STEPS }),
    });
    return;
  }

  if (options.command === 'oauth-token-exchange') {
    const stateFile = options.kv.state || options.positional[0];
    if (!stateFile) throw new Error('oauth-token-exchange requires --state <file>');
    const state = loadRegistrationState(stateFile);
    const request = buildTokenRequestDescriptor({
      code: state.oauthCode || state.oauth?.code,
      oauth: state.oauth,
    });
    if (options.kv.dry_run || options.kv.dryRun) {
      printJson({ stateFile, request });
      return;
    }
    const result = await exchangeTokens(request, {
      executor: (descriptor) => executePureHttpUrl(descriptor, { proxy: proxyFromOptions(options) }),
    });
    state.oauth = {
      ...(state.oauth || {}),
      tokens: result.tokens,
      tokenResponse: {
        status: result.response.status,
        contentType: result.response.contentType,
      },
      tokenExchangedAt: new Date().toISOString(),
    };
    saveRegistrationState(stateFile, state);
    printJson({
      stateFile,
      status: result.response.status,
      tokenKeys: Object.keys(result.tokens || {}).sort(),
      tokens: options.redact === false ? result.tokens : '<redacted:tokens>',
    });
    return;
  }

  if (options.command === 'orchestrator-status') {
    const stateFile = options.kv.state || options.positional[0];
    if (!stateFile) throw new Error('orchestrator-status requires --state <file>');
    const state = loadAnyOrchestratorState(stateFile);
    printJson({
      stateFile,
      ...(state.schemaVersion === 2
        ? summarizeOrchestratorV2State(state, { redact: options.redact })
        : summarizeOrchestratorState(state, { redact: options.redact })),
    });
    return;
  }

  if (options.command === 'cpa-export') {
    const stateFile = options.kv.state || options.positional[0];
    if (!stateFile) throw new Error('cpa-export requires --state <orchestrator-state>');
    const state = loadAnyOrchestratorState(stateFile);
    if (state.schemaVersion === 2) {
      const artifact = buildCpaArtifact({
        jobs: (state.jobs || []).filter((job) => job.status === 'complete' && job.tokens),
      });
      const output = options.kv.output;
      if (output) writeJson(output, artifact);
      printJson(summarizeCpaArtifact(artifact, { raw: options.redact === false }));
      return;
    }
    const artifact = buildLegacyCpaArtifact({
      runId: state.runId,
      jobs: jobsForCpa(state),
    });
    const output = options.kv.output || state.cpaPath;
    if (output) writeJson(output, artifact);
    printJson(options.redact === false ? artifact : {
      output,
      ...summarizeCpaArtifact(artifact),
    });
    return;
  }

  const har = loadFromOptions(options);

  if (options.command === 'summary') {
    printJson(buildSummary(har));
  } else if (options.command === 'chain') {
    printJson(buildUrlChain(har, options));
  } else if (options.command === 'sentinel') {
    printJson(extractSentinel(har, options));
  } else if (options.command === 'protocol-drift') {
    printJson(buildProtocolDrift(har, {
      knownPaths: REGISTRATION_STEP_PATHS,
      country: options.kv.country || '',
      seed: options.kv.seed || '',
    }));
  } else if (options.command === 'email-flow') {
    printJson(buildEmailFlow(har, {
      email: options.kv.email,
      screenHint: options.kv.screen_hint || options.kv.screenHint,
      redact: options.redact,
    }));
  } else if (options.command === 'registration-plan') {
    printJson(buildRegistrationPlan(har, {
      email: options.kv.email,
      password: options.kv.password,
      emailCode: options.kv.email_code || options.kv.emailCode,
      phone: options.kv.phone,
      phoneCode: options.kv.phone_code || options.kv.phoneCode,
      channel: options.kv.channel,
      name: options.kv.name,
      birthdate: options.kv.birthdate,
      workspaceId: options.kv.workspace_id || options.kv.workspaceId,
      step: options.kv.step,
      summary: Boolean(options.kv.summary),
      redact: options.redact,
    }));
  } else if (options.command === 'registration-run') {
    const stateFile = statePathForEmail(options.kv.email, { statePath: options.kv.state });
    let state;
    try {
      if (options.kv.restart) throw Object.assign(new Error('restart requested'), { code: 'ENOENT' });
      state = loadRegistrationState(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = makeInitialRegistrationState(har, {
        email: options.kv.email,
        password: options.kv.password,
        emailCode: options.kv.email_code || options.kv.emailCode,
        phone: options.kv.phone,
        phoneCode: options.kv.phone_code || options.kv.phoneCode,
        channel: options.kv.channel,
        name: options.kv.name,
        birthdate: options.kv.birthdate,
        workspaceId: options.kv.workspace_id || options.kv.workspaceId,
      });
    }

    await runRegistrationFlow(har, state, {
      email: options.kv.email,
      password: options.kv.password,
      emailCode: options.kv.email_code || options.kv.emailCode,
      phone: options.kv.phone,
      phoneCode: options.kv.phone_code || options.kv.phoneCode,
      channel: options.kv.channel,
      name: options.kv.name,
      birthdate: options.kv.birthdate,
      workspaceId: options.kv.workspace_id || options.kv.workspaceId,
      once: Boolean(options.kv.once),
      dryRun: Boolean(options.kv.dry_run || options.kv.dryRun),
      dynamicSentinel: !Boolean(options.kv.static_sentinel || options.kv.staticSentinel),
      cloudflareJsd: Boolean(options.kv.cloudflare_jsd || options.kv.cloudflareJsd),
      proxy: proxyFromOptions(options),
    });
    saveRegistrationState(stateFile, state);
    printJson({
      stateFile,
      ...summarizeRegistrationState(state, { redact: options.redact }),
    });
  } else if (options.command === 'oauth-login-run') {
    const stateFile = loginStatePathForEmail(options.kv.email, { statePath: options.kv.state });
    let state;
    try {
      if (options.kv.restart) throw Object.assign(new Error('restart requested'), { code: 'ENOENT' });
      state = loadRegistrationState(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = makeInitialLoginState(har, {
        email: options.kv.email,
        password: options.kv.password,
        workspaceId: options.kv.workspace_id || options.kv.workspaceId,
      });
    }

    await runLoginFlow(har, state, {
      email: options.kv.email,
      password: options.kv.password,
      workspaceId: options.kv.workspace_id || options.kv.workspaceId,
      once: Boolean(options.kv.once),
      dryRun: Boolean(options.kv.dry_run || options.kv.dryRun),
      dynamicSentinel: !Boolean(options.kv.static_sentinel || options.kv.staticSentinel),
      cloudflareJsd: Boolean(options.kv.cloudflare_jsd || options.kv.cloudflareJsd),
      proxy: proxyFromOptions(options),
    });
    saveRegistrationState(stateFile, state);
    printJson({
      stateFile,
      ...summarizeRegistrationState(state, { redact: options.redact, steps: LOGIN_STEPS }),
    });
  } else if (options.command === 'orchestrator-run') {
    const configFile = options.kv.config || options.positional[0];
    if (!configFile) throw new Error('orchestrator-run requires --config <file>');
    const config = loadOrchestratorConfig(configFile);
    if (Number(config.schemaVersion) === 2) {
      const normalized = validateV2Config(config);
      if (options.kv.exchange_token || options.kv.exchangeToken) normalized.registration.exchangeToken = true;
      if (options.kv.dry_run || options.kv.dryRun) {
        printJson({ dryRun: true, ...(await preflightOrchestratorV2(normalized)) });
        return;
      }

      const initial = makeInitialOrchestratorV2State(normalized, {
        runId: options.kv.run_id || options.kv.runId,
      });
      const stateFile = options.kv.state || runStatePathV2(normalized, initial.runId);
      await withV2StateLock(stateFile, options.command, async () => {
        let state = initial;
        let isNew = true;
        if (!options.kv.restart) {
          try {
            state = loadV2State(stateFile);
            isNew = false;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        assertV2ConfigFingerprint(state, normalized);
        if (isNew) {
          state.preflight = await preflightOrchestratorV2(normalized);
          if (!state.preflight.ready) throw new Error('V2 preflight reported no SMS inventory within maxPrice');
          saveV2State(stateFile, state);
        }
        await runOrchestratorV2(har, state, normalized, {
          saveState: (next) => saveV2State(stateFile, next),
        });
        printJson({ stateFile, ...summarizeOrchestratorV2State(state, { redact: options.redact }) });
      });
      return;
    }
    let state;
    let stateFile = options.kv.state || '';
    try {
      if (!stateFile || options.kv.restart) throw Object.assign(new Error('restart requested'), { code: 'ENOENT' });
      state = readJson(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = makeInitialOrchestratorState(config, {
        runId: options.kv.run_id || options.kv.runId,
      });
      stateFile = stateFile || orchestratorStatePath(state.runId, {
        stateDir: config.output?.stateDir,
      });
    }

    const saveState = (nextState) => writeJson(stateFile, nextState);
    await runOrchestrator(har, state, config, {
      dryRun: Boolean(options.kv.dry_run || options.kv.dryRun),
      exchangeToken: Boolean(options.kv.exchange_token || options.kv.exchangeToken),
      saveState,
    });
    saveState(state);
    printJson({
      stateFile,
      ...summarizeOrchestratorState(state, { redact: options.redact }),
    });
  } else if (options.command === 'verify') {
    const result = verify(har);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${options.command}\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
