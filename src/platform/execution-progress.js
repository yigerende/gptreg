"use strict";
function executionProgress(state, item) {
  const job = (state.jobs || []).find(j => ['running', 'waiting', 'queued'].includes(j.status)) || state.jobs?.[0];
  if (!job) return item.need_oauth ? '正在注册并完成 OAuth 授权' : '正在注册账号';
  const security = job.sessionState?.security || {};
  let text;
  if (job.phase === 'waiting_security_email_retry') text = `补密码验证码未收到，等待同邮箱重试（${job.securityEmailRetries || 0}）`;
  else if (job.phase === 'waiting_security_retry' || job.phase === 'resuming_security') text = '账号已创建，正在重试密码／2FA 设置';
  else if (security.passwordStatus === 'waiting_otp') text = '账号已创建，等待补密码邮箱验证码';
  else if (job.sessionState?.step === 'email_otp_sent') text = '等待注册邮箱验证码';
  else if (job.sms?.current && !job.sms.current.targetAccepted) text = `等待短信验证码（已换号 ${job.sms.replacements || 0} 次）`;
  else if (job.oauthState) text = '账号已创建，正在完成 OAuth 授权';
  else if (job.sessionAssetId || job.accountCreatedAt || job.sessionState?.accountCreated) text = security.totpStatus === 'configured' ? '账号已创建，正在校验交付资料' : '账号已创建，正在完成密码／2FA 设置';
  else if (job.phase?.includes('proxy')) text = '等待可用代理，稍后继续注册';
  else text = item.need_oauth ? '正在注册并完成 OAuth 授权' : '正在注册账号';
  if (item.resource_replacements) text += `；已换邮箱 ${item.resource_replacements} 次`;
  return text;
}
module.exports = { executionProgress };
