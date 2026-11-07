'use strict';

// Public operational metadata only. Credentials, paths and protocol invariants
// deliberately stay outside this allowlist.
const retryDefaults = {
  waiting_session_proxy_retry: { maxRetries: 2, delaysMs: [2000, 5000] },
  waiting_proxy_retry: { maxRetries: 2, delaysMs: [2000, 2000] },
  waiting_transient: { maxRetries: 5, delaysMs: [2000, 5000, 15000, 45000, 120000] },
  waiting_security_retry: { maxRetries: 3, delaysMs: [3000, 10000, 30000] },
  waiting_security_email_retry: { maxRetries: 1, delaysMs: [5000] },
  waiting_phone_continuity: { maxRetries: 3, delaysMs: [3000, 12000, 30000] },
  waiting_phone_confirmation: { maxRetries: 2, delaysMs: [3000, 12000] },
  waiting_sms_cleanup: { maxRetries: 4, delaysMs: [2000, 6000, 15000, 40000] },
  waiting_proxy_pool: { maxRetries: 12, delaysMs: [5000, 15000, 30000, 60000, 120000] },
};
const fields = [];
function number(group, path, label, defaultValue, min, max, help = '') {
  fields.push({ group, path, label, defaultValue, min, max, type: 'number', help });
}
number('邮箱', 'mail.timeoutMs', '每轮验证码等待时间（毫秒）', 120000, 1000, 3600000);
number('邮箱', 'mail.pollIntervalMs', '验证码查询间隔（毫秒）', 5000, 1000, 60000);
number('邮箱', 'mail.maxPollAttempts', '每轮最多查询次数', 24, 1, 200, '与等待时间同时限制，任一达到上限即结束该轮。SMSBower 默认 24，其他邮箱默认 15。');
number('邮箱', 'mail.maxResults', '每次查询最多邮件数', 100, 1, 100);
number('短信', 'sms.codeTimeoutMs', '注册短信每轮等待时间（毫秒）', 120000, 1000, 3600000);
number('短信', 'sms.oauthCodeTimeoutMs', 'OAuth 短信每号码等待时间（毫秒）', 60000, 1000, 300000, '从号码发送成功开始计时；恢复不重置截止时间，超时后处理旧号码再换号。');
number('短信', 'sms.pollIntervalMs', '短信查询间隔（毫秒）', 5000, 1000, 60000);
number('短信', 'sms.sendRetryLimit', '同号码额外重发次数', 1, 0, 3, '仅注册接码；OAuth 不重复发送同号码，避免触发限流。');
number('短信', 'sms.replacementBudget', '最多换号码次数', 4, 0, 30, '不含首次号码。换号前先核实迟到验证码并完成旧号码处理。');
number('短信', 'sms.inventoryWaitMs', '无库存最多等待时间（毫秒）', 600000, 1000, 86400000);
number('短信', 'sms.fraudGuardThreshold', '风控连续失败阈值', 5, 1, 20);
number('短信', 'sms.fraudGuardCooldownMs', '风控冷却时间（毫秒）', 900000, 1000, 86400000);
number('短信', 'sms.maxPendingCancellations', '最多待取消号码', 2, 1, 10);
number('请求与代理', 'registration.authRequestTimeoutMs', '注册单次请求超时（毫秒）', 30000, 1000, 120000);
number('请求与代理', 'registration.securityRequestTimeoutMs', '密码／2FA 请求超时（毫秒）', 30000, 1000, 120000);
number('请求与代理', 'proxyPool.healthCheck.timeoutMs', '代理健康检测超时（毫秒）', 8000, 1000, 120000);
number('请求与代理', 'proxyPool.maxRotationsBeforeBootstrap', '注册前最多轮换代理次数', 2, 1, 20);
const names = {
  waiting_session_proxy_retry: '独立会话连接故障重试',
  waiting_proxy_retry: '同代理网络重试', waiting_transient: '临时网络故障',
  waiting_security_retry: '密码／2FA 网络重试', waiting_security_email_retry: '补密码同邮箱收码重试',
  waiting_phone_continuity: '接码过程网络重试', waiting_phone_confirmation: '手机验证结果核对',
  waiting_sms_cleanup: '号码清理重试', waiting_proxy_pool: '等待空闲代理',
};
for (const [phase, defaults] of Object.entries(retryDefaults)) {
  number('重试策略', `retryPolicy.${phase}.maxRetries`, `${names[phase]}次数`, defaults.maxRetries, 0, 20, '不含首次执行；0 表示不额外重试。');
  fields.push({ group: '重试策略', path: `retryPolicy.${phase}.delaysMs`, label: `${names[phase]}间隔（毫秒）`, type: 'delays', defaultValue: defaults.delaysMs, help: '逗号分隔；超过所填级数后使用最后一个间隔。' });
}
function get(object, path) { return path.split('.').reduce((o, k) => o?.[k], object); }
function set(object, path, value) {
  const parts = path.split('.'); let target = object;
  for (const key of parts.slice(0, -1)) target = target[key] ||= {};
  target[parts.at(-1)] = structuredClone(value);
  return object;
}
function validateValue(field, value) {
  if (field.type === 'delays') {
    if (!Array.isArray(value) || !value.length || value.length > 12 || value.some(n => !Number.isInteger(n) || n < 100 || n > 300000))
      throw new Error(`${field.label}须为 1～12 个 100～300000 毫秒的整数`);
  } else if (!Number.isInteger(value) || value < field.min || value > field.max) {
    throw new Error(`${field.label}须为 ${field.min}～${field.max} 的整数`);
  }
  return value;
}
function normalizeRetryPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(retryDefaults, k))) throw new Error('不支持的重试策略');
  const result = structuredClone(retryDefaults);
  for (const field of fields.filter(f => f.path.startsWith('retryPolicy.'))) {
    const path = field.path.slice(12), value = get(input, path);
    if (value !== undefined) set(result, path, validateValue(field, value));
  }
  return result;
}
function snapshot(config) {
  const result = {};
  for (const field of fields) {
    const value = get(config, field.path);
    if (value !== undefined) set(result, field.path, value);
  }
  return result;
}
function applySnapshot(config, saved) {
  for (const field of fields) {
    const value = get(saved, field.path);
    if (value !== undefined) set(config, field.path, value);
  }
  return config;
}
module.exports = { fields, retryDefaults, get, set, validateValue, normalizeRetryPolicy, snapshot, applySnapshot };
