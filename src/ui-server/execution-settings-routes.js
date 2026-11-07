'use strict';
const settings = require('../execution-settings');
const { HttpError } = require('./utils');
function registerExecutionSettings(app, configService, runManager) {
  const read = () => {
    const config = configService.normalized();
    return { fields: settings.fields.map(f => f.path === 'sms.replacementBudget' ? {
      ...f, path: 'sms.numberAttemptLimit', label: '每个账号最多尝试号码数', min: 1, max: 31,
      defaultValue: 5, value: config.sms.replacementBudget + 1,
      help: '包含首次号码，默认共 5 个；全部失败后结束该账号，处理号码租约并退回未交付积分。',
    } : ({ ...f,
      defaultValue: f.path === 'mail.maxPollAttempts' && config.mail.provider !== 'smsbower' ? 15 : f.defaultValue,
      value: settings.get(config, f.path) ?? f.defaultValue,
    })) };
  };
  app.get('/api/v1/platform-config', async (_r, reply) => { reply.header('Cache-Control', 'no-store'); return read(); });
  app.put('/api/v1/platform-config', async (r, reply) => {
    const values = r.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(r.body).some(k => k !== 'values')) throw new HttpError(400, '请提交配置字段');
    const patch = {};
    try {
      for (const [path, value] of Object.entries(values)) {
        if (path === 'sms.numberAttemptLimit') {
          if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error('号码尝试次数须为 1～31 的整数');
          if (Object.hasOwn(values, 'sms.replacementBudget')) throw new Error('请只提交一种号码次数参数');
          settings.set(patch, 'sms.replacementBudget', value - 1);
          continue;
        }
        const field = settings.fields.find(f => f.path === path);
        if (!field) throw new Error('不支持的配置字段');
        settings.set(patch, path, settings.validateValue(field, value));
      }
    } catch (e) { throw new HttpError(400, e.message); }
    // New tasks snapshot these fields. Legacy unresolved checkpoints still
    // depend on the old config fingerprint and must not be invalidated.
    if (runManager.starting || runManager.customerStarting || runManager.auxiliaryStarting || runManager.stateFiles().some(file => {
      const s = runManager.cachedState(file);
      if (s.executionSettings) return false;
      if (s.customerExecution || String(s.runId || '').startsWith('customer-')) {
        // Settled customer runs cannot resume. Historical partial results must
        // not block tuning forever; pending cleanup is included in this set.
        return !runManager.customerPendingRunIds || runManager.customerPendingRunIds.has(s.runId);
      }
      return !['complete','failed','cancelled'].includes(s.status);
    })) throw new HttpError(409, '请等待旧版未完成任务结束，再修改运行参数');
    configService.update({ config: patch });
    reply.header('Cache-Control', 'no-store'); return read();
  });
}
module.exports = { registerExecutionSettings };
