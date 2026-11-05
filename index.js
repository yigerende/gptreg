'use strict';

const {
  runRegistrationFlow,
  runLoginFlow,
  makeInitialRegistrationState,
  makeInitialLoginState,
  loadRegistrationState,
  saveRegistrationState,
  summarizeRegistrationState,
} = require('./src/registration-runner');

const {
  createOAuthSession,
  buildTokenRequestDescriptor,
  exchangeTokens,
  exchangeCodeForToken,
  validateOAuthCallback,
} = require('./src/oauth-pkce');

const {
  ChatGptSessionRunner,
  totpCode,
} = require('./src/chatgpt-session-runner');

const {
  CockpitOAuthRunner,
} = require('./src/cockpit-oauth-runner');

const {
  runOrchestratorV2,
  preflightOrchestratorV2,
  cancelOrchestratorV2,
  resumeOrchestratorV2State,
} = require('./src/orchestrator-v2');

const {
  createSmsProvider,
} = require('./src/sms-provider');

const {
  ProxyPool,
} = require('./src/proxy-pool');

const {
  SessionAssetStore,
} = require('./src/session-asset-store');

const {
  validateV2Config,
} = require('./src/config-v2');

module.exports = {
  // Registration Flow
  runRegistrationFlow,
  makeInitialRegistrationState,
  loadRegistrationState,
  saveRegistrationState,
  summarizeRegistrationState,

  // OAuth Flow
  runLoginFlow,
  makeInitialLoginState,
  createOAuthSession,
  buildTokenRequestDescriptor,
  exchangeTokens,
  exchangeCodeForToken,
  validateOAuthCallback,
  totpCode,

  // Runners
  ChatGptSessionRunner,
  CockpitOAuthRunner,

  // Orchestrator
  runOrchestratorV2,
  preflightOrchestratorV2,
  cancelOrchestratorV2,
  resumeOrchestratorV2State,

  // Infrastructure & Resources
  createSmsProvider,
  ProxyPool,
  SessionAssetStore,
  validateV2Config,
};
