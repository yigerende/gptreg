"use strict";
// Only fixed descriptions and known codes cross into platform diagnostics.
// Never persist upstream messages, URLs, credentials, or entire preflight data.
const reasons = {
  SESSION_PROXY_CAPACITY: ['waiting', '等待独立会话代理资源', true],
  SESSION_PROXY_BUSY: ['waiting', '等待账号或代理执行占用释放', true],
  SESSION_PROXY_REVOKED: ['configuration', '独立会话凭据已紧急停用'],
  SESSION_PROXY_EXPIRED: ['proxy', '独立代理会话已到期'],
  SESSION_PROXY_CONFIG_INVALID: ['configuration', '独立会话代理配置不可用'],
  SESSION_PROXY_GENERATION_FAILED: ['proxy', '供应商生成独立会话失败'],
  SESSION_PROXY_PROBE_FAILED: ['proxy', '独立会话连通检测失败'],
  EMAIL_NOT_DELIVERED_TO_TARGET: ["mail", "邮箱未收到目标验证码"],
  CHATGPT_SIGNIN_FAILED: ["registration", "注册登录入口请求失败"],
  EMAIL_OTP_TIMEOUT: ["mail", "邮箱验证码等待超时"],
  SENTINEL_PROXY_IDENTITY_CHANGED: ["proxy", "代理切换后会话身份不一致"],
  SENTINEL_CLIENT_IDENTITY_CHANGED: ["execution", "会话设备身份不一致"],
  ERR_SSL_WRONG_VERSION_NUMBER: ["proxy", "代理连接 TLS 协议异常"],
  TERMINAL_RUN: ["execution", "原任务已结束，无法继续恢复"],
  MAILBOX_STATE_REJECTED: ["mail", "邮箱供应商拒绝租约状态变更"],
  COUNTRY_PROXY_POOL_EMPTY: ["proxy", "所选国家代理池为空，请补充代理"],
  COUNTRY_PROXY_POOL_CAPACITY: ["proxy", "所选代理池可用容量不足"],
  COUNTRY_PROXY_POOL_OVERLAP: ["proxy", "所选代理池存在重复代理"],
  LOCAL_PROXY_NOT_FOUND: ["proxy", "指定的固定代理已不存在"],
  PROXY_PREFLIGHT_FAILED: ["proxy", "代理健康检查未通过"],
  OAUTH_PROXY_SELECTION_REQUIRED: [
    "proxy",
    "OAuth 任务需要重新指定国家池或固定代理",
  ],
  PROXY_POOL_BUSY: ["waiting", "代理正在被其他任务占用", true],
  PROXY_USAGE_STORAGE_ERROR: ["configuration", "代理使用记录保存失败，请管理员检查运行数据目录的写入权限与磁盘空间"],
  TASK_SLOT_BUSY: ["waiting", "执行槽正在被其他任务占用", true],
  MAIN_TASK_CAPACITY: ["waiting", "注册执行槽正在被其他任务占用", true],
  CUSTOMER_TASK_CAPACITY: ["waiting", "客户注册并发已满", true],
  CUSTOMER_USER_CAPACITY: ["waiting", "该用户注册并发已满", true],
  AUXILIARY_TASK_CAPACITY: ["waiting", "OAuth 执行槽正在被其他任务占用", true],
  SESSION_ASSET_IN_USE: ["waiting", "账号正在被其他任务使用", true],
  OAUTH_ASSET_COOLDOWN: ["waiting", "账号处于 OAuth 冷却期", true],
  NO_ELIGIBLE_MAILBOX: ["mail", "邮箱库存不足或没有符合条件的邮箱"],
  MAIL_PREFLIGHT_FAILED: ["mail", "邮箱库存、域名或渠道配置检查未通过"],
  MAIL_STOCK_CHECK_FAILED: ["mail", "邮箱库存接口查询失败"],
  MAIL_PROVIDER_UNAVAILABLE: ["mail", "邮箱供应商暂不可用"],
  MAIL_CLIENT_PROVIDER_MISMATCH: ["mail", "账号邮箱来源与任务渠道不一致"],
  SMS_INVENTORY_EMPTY: ["sms", "所选国家暂无符合条件的短信号码"],
  SMS_CODE_TIMEOUT: ["sms", "短信验证码等待超时"],
  OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED: ["sms", "短信换号次数已达上限"],
  SMS_PRICE_ABOVE_MAX: ["sms", "短信报价超过已配置的价格上限"],
  SMS_BALANCE_INSUFFICIENT: ["sms", "短信余额不足以启动任务"],
  SMS_BALANCE_LOW: ["sms", "短信余额不足以启动任务"],
  SMS_PROVIDER_NOT_READY: ["sms", "短信供应商未就绪"],
  SMS_PREFLIGHT_FAILED: ["sms", "短信接口预检失败，请检查供应商配置"],
  BAD_KEY: ["sms", "短信供应商密钥无效"],
  ACCOUNT_INACTIVE: ["sms", "短信供应商账号未激活"],
  BANNED: ["sms", "短信供应商账号不可用"],
  FIREFOX_TOKEN_INVALID: ["sms", "短信供应商凭据无效"],
  FIREFOX_CREDENTIALS_MISSING: ["sms", "短信供应商凭据未配置"],
  NO_BALANCE: ["sms", "短信供应商余额不足"],
  NO_NUMBERS: ["sms", "所选国家暂无短信库存"],
  MAX_PRICE_TOO_LOW: ["sms", "短信报价超过已配置的价格上限"],
  ETIMEDOUT: ["network", "供应商请求超时"],
  ECONNREFUSED: ["network", "供应商或代理连接被拒绝"],
  ENOTFOUND: ["network", "供应商或代理地址解析失败"],
  PREFLIGHT_FAILED: ["configuration", "启动预检失败，请检查原注册台配置"],
  ENGINE_EXECUTION_FAILED: ["execution", "执行未完成，请在原注册台检查该任务"],
};
function executionFailure(error = {}, fallback = "PREFLIGHT_FAILED") {
  const d = error.details || {};
  let code = d.code || error.code;
  if (!code) {
    if (d.mail?.cooldownAssetIds?.length) code = "OAUTH_ASSET_COOLDOWN";
    else if (d.mail?.ready === false)
      code = d.mail.stockError?.code || "MAIL_PREFLIGHT_FAILED";
    else if (d.proxy?.ready === false) code = "PROXY_PREFLIGHT_FAILED";
    else if (d.sms?.required && d.sms.ready === false)
      code = d.sms.issue || "SMS_PREFLIGHT_FAILED";
  }
  if (!Object.hasOwn(reasons, code)) code = fallback;
  const [category, detail, wait = false] = reasons[code];
  const until = Math.max(
    0,
    ...(Array.isArray(d.cooldowns) ? d.cooldowns : []).map(
      (x) => Date.parse(x.cooldownUntil) || 0,
    ),
  );
  return {
    code,
    category,
    detail,
    wait,
    delay: until ? Math.max(30, Math.ceil((until - Date.now()) / 1000)) : 30,
  };
}
module.exports = { executionFailure };
