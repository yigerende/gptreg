'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateV2Config } = require('../src/config-v2');
const { configFingerprint } = require('../src/state-store');
const { isRetryableTransportError, isRetryableSecurityFailure } = require('../src/transport-errors');
const { executionProgress } = require('../src/platform/execution-progress');
const { snapshot, applySnapshot } = require('../src/execution-settings');
const Fastify = require('fastify');
const { registerExecutionSettings } = require('../src/ui-server/execution-settings-routes');

test('empty mailbox timeout is not a network failure even when a legacy record marked it retryable', () => {
  for (const code of ['EMAIL_OTP_TIMEOUT','EMAIL_NOT_DELIVERED_TO_TARGET']) {
    assert.equal(isRetryableTransportError({ code, retryable: true }), false);
    assert.equal(isRetryableSecurityFailure({ code, message: 'timeout' }), false);
  }
  assert.equal(isRetryableSecurityFailure({ code: 'ETIMEDOUT' }), true);
});
test('new settings do not invalidate legacy fingerprints and active tasks restore their snapshot', () => {
  const old = validateV2Config({ aliases:{strategy:"root"}, sms: { provider:'mock' } });
  const previous = structuredClone(old); delete previous.retryPolicy; delete previous.sms.sendRetryLimit; delete previous.sms.oauthCodeTimeoutMs;
  assert.equal(configFingerprint(old), configFingerprint(previous));
  const saved = snapshot(old), next = validateV2Config({ aliases:{strategy:"root"}, sms: { provider:'mock', sendRetryLimit:0, replacementBudget:0 }, mail:{ timeoutMs: 5000 }, retryPolicy:{ waiting_security_retry:{maxRetries:0} } });
  assert.equal(next.sms.replacementBudget, 0);
  assert.equal(next.retryPolicy.waiting_security_retry.maxRetries, 0);
  assert.equal(applySnapshot(next,saved).mail.timeoutMs, 120000);
  assert.equal(next.sms.sendRetryLimit, 1);
  assert.throws(() => validateV2Config({ aliases:{strategy:"root"},retryPolicy:{ waiting_security_retry:{maxRetries:-1} }}));
  assert.throws(() => validateV2Config({ aliases:{strategy:"root"},sms:{sendRetryLimit:4}}));
});
test('execution message distinguishes password OTP waiting from account registration', () => {
  assert.match(executionProgress({jobs:[{status:'running',sessionState:{security:{passwordStatus:'waiting_otp'}}}]},{}),/补密码邮箱验证码/);
  assert.match(executionProgress({jobs:[{status:'waiting',phase:'waiting_security_email_retry',securityEmailRetries:1}]},{}),/同邮箱重试/);
});
test('configuration endpoint exposes only allowlisted tuning fields and validates updates before writing', async t => {
  const app=Fastify(); t.after(()=>app.close());
  let config=validateV2Config({ aliases:{strategy:"root"},sms:{provider:'mock',apiKey:'DO_NOT_EXPOSE'},mail:{password:'PRIVATE'}}), writes=0;
  const manager={ starting:false,stateFiles:()=>[],cachedState:()=>({status:'waiting'}) };
  registerExecutionSettings(app,{normalized:()=>config,update:({config:patch})=>{writes++; config={...config,...patch};}},manager);
  const result=await app.inject('/api/v1/platform-config');
  assert.equal(result.statusCode,200); assert.ok(result.json().fields.length>25);
  assert.doesNotMatch(result.body,/DO_NOT_EXPOSE|PRIVATE/);
  for (const values of [{'mail.apiKey':'bad'},{'sms.codeTimeoutMs':0},{'retryPolicy.waiting_security_retry.delaysMs':[]}])
    assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values}})).statusCode,400);
  assert.equal(writes,0);
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.sendRetryLimit':0}}})).statusCode,200);
  assert.equal(writes,1);
  const bounded = await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.numberAttemptLimit':5,'retryPolicy.waiting_session_proxy_retry.maxRetries':2}}});
  assert.equal(bounded.statusCode,200);
  assert.equal(config.sms.replacementBudget,4);
  assert.equal(bounded.json().fields.find(f=>f.path==='sms.numberAttemptLimit').value,5);
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.numberAttemptLimit':0}}})).statusCode,400);
  manager.stateFiles=()=>['legacy'];
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.sendRetryLimit':1}}})).statusCode,409);
  manager.cachedState=()=>({runId:'customer-old',status:'partial'});
  manager.customerPendingRunIds=new Set(['customer-old']);
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.sendRetryLimit':1}}})).statusCode,409);
  manager.customerPendingRunIds=new Set();
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/platform-config',payload:{values:{'sms.sendRetryLimit':1}}})).statusCode,200);
});
