'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHar } = require('../src/har');
const {
  makeInitialOrchestratorState,
  readJson,
  runOrchestrator,
  summarizeOrchestratorState,
} = require('../src/orchestrator');
const { MockSmsProvider } = require('../src/sms-provider');

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function mockRunnerExecutor(har) {
  return async (request, step, state) => {
    if (step.type === 'sentinel') {
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: har.log.entries[step.index].response.content.text,
        },
        cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
      };
    }

    const isLogin = state.mode === 'pure-url-oauth-login-runner';
    const jsonByStep = {
      login_authorize_continue: {
        continue_url: 'https://auth.openai.com/log-in/password',
        page: { type: 'login_password' },
      },
      password_verify: {
        continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        page: { type: 'sign_in_with_chatgpt_codex_consent' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }],
        },
      },
      authorize_continue: {
        continue_url: 'https://auth.openai.com/create-account/password',
        page: { type: 'create_account_password' },
      },
      user_register: {
        continue_url: 'https://auth.openai.com/email-verification',
        page: { type: 'email_verification' },
      },
      email_otp_validate: {
        continue_url: 'https://auth.openai.com/phone-verification',
        page: { type: 'phone_verification' },
      },
      phone_otp_send: {
        continue_url: 'https://auth.openai.com/phone-verification',
        page: { type: 'phone_otp_verification' },
      },
      phone_otp_validate: {
        continue_url: 'https://auth.openai.com/about-you',
        page: { type: 'about_you' },
      },
      create_account: {
        continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        page: { type: 'sign_in_with_chatgpt_codex_consent' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }],
        },
      },
      workspace_select: isLogin
        ? {
          continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit',
          page: { type: 'redirect' },
          'oai-client-auth-session': {
            workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }],
          },
        }
        : {
          code: 'login_request_expired',
          message: 'Your login session has expired, please try again.',
        },
    };

    const redirects = {
      bootstrap_oauth_authorize: 'https://auth.openai.com/api/oauth/oauth2/auth?unit=1',
      bootstrap_oauth_auth: 'https://auth.openai.com/api/accounts/login?login_challenge=unit',
      bootstrap_accounts_login: 'https://auth.openai.com/log-in',
      email_otp_send: 'https://auth.openai.com/email-verification',
      oauth_auth_login_verifier: 'https://auth.openai.com/api/accounts/consent?consent_challenge=unit',
      oauth_consent: 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=unit',
      oauth_auth_consent_verifier: `http://localhost:1455/auth/callback?code=ac_orchestrator_unit&state=${state.oauth.state}`,
    };
    const statuses = {
      bootstrap_oauth_authorize: 302,
      bootstrap_oauth_auth: 302,
      bootstrap_accounts_login: 302,
      email_otp_send: 302,
      oauth_auth_login_verifier: 302,
      oauth_consent: 302,
      oauth_auth_consent_verifier: 303,
      workspace_select: isLogin ? 200 : 400,
    };

    return {
      request,
      response: {
        status: statuses[step.name] || 200,
        url: request.url,
        location: redirects[step.name] || '',
        contentType: 'application/json',
        text: JSON.stringify(jsonByStep[step.name] || {}),
      },
      cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
    };
  };
}

test('orchestrator completes registration fallback login and writes CPA artifact', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-orchestrator-'));
  const config = {
    runId: 'run-unit',
    mail: {
      accounts: [{ id: 7, email: 'base@example.test' }],
      defaultCode: '717548',
    },
    aliases: {
      count: 1,
      runTag: 'ctf',
    },
    sms: {
      provider: 'mock',
      numbers: ['+15550000001'],
      codes: ['463193'],
    },
    registration: {
      exchangeToken: true,
      dynamicSentinel: false,
      name: 'ctf',
      birthdate: '2001-01-01',
    },
    output: {
      stateDir: tempDir,
      cpaPath: path.join(tempDir, 'cpa.json'),
    },
  };
  const state = makeInitialOrchestratorState(config);
  const smsProvider = new MockSmsProvider(config.sms);
  const expiresAt = Math.floor(Date.parse('2026-07-29T00:00:00.000Z') / 1000);
  const aliasEmail = 'base+ctfAbCd@example.test';
  const aliasRandomValues = [0, 27, 2, 29];
  const idToken = jwt({ email: aliasEmail, exp: expiresAt });
  const accessToken = jwt({
    email: aliasEmail,
    exp: expiresAt,
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-unit' },
  });

  await runOrchestrator(har, state, config, {
    cwd: tempDir,
    smsProvider,
    aliasRandomInt: () => aliasRandomValues.shift(),
    executor: mockRunnerExecutor(har),
    tokenExecutor: async (request) => ({
      request,
      response: {
        status: 200,
        url: request.url,
        contentType: 'application/json',
        text: JSON.stringify({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'refresh-token-unit',
          expires_in: 3600,
        }),
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].email, aliasEmail);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].oauthCode, 'ac_orchestrator_unit');
  assert.equal(state.jobs[0].workspaceId, 'workspace-unit');

  const cpa = readJson(config.output.cpaPath);
  assert.equal(cpa.type, 'gpt-re.cpa.v1');
  assert.equal(cpa.accounts[0].type, 'codex');
  assert.equal(cpa.accounts[0].email, aliasEmail);
  assert.equal(cpa.accounts[0].access_token, accessToken);

  const summary = summarizeOrchestratorState(state);
  assert.equal(JSON.stringify(summary).includes(accessToken), false);
  assert.equal(summary.jobs[0].email, '<redacted:email>');
});
