import type { IPRoyalSettings, IPRoyalSettingsSnapshot } from './types';
import './iproyal.css';

export function iproyalSettingsReady(draft: IPRoyalSettings, saved?: IPRoyalSettingsSnapshot) {
  return Boolean(draft.apiToken?.trim() || saved?.apiTokenConfigured);
}

export function IPRoyalFields({ draft, saved, disabled, onChange }: {
  draft: IPRoyalSettings; saved?: IPRoyalSettingsSnapshot; disabled: boolean; onChange: (patch: IPRoyalSettings) => void;
}) {
  return <fieldset className="iproyal-fields" disabled={disabled}>
    <legend>IPRoyal · IP 白名单</legend>
    <div className="iproyal-fields-grid">
      <label><span>API Token <small>{saved?.apiTokenConfigured ? '已配置' : '待配置'}</small></span>
        <input aria-label="IPRoyal API Token" type="password" autoComplete="new-password" spellCheck={false} value={draft.apiToken || ''} placeholder={saved?.apiTokenConfigured ? '已保存，留空保持不变' : '填写 IPRoyal 后台的 API Token'} onChange={event => onChange({ apiToken: event.target.value })} />
      </label>
      <label><span>白名单 IP <small>选填</small></span>
        <input aria-label="IPRoyal 白名单 IP" type="text" autoComplete="off" spellCheck={false} value={draft.whitelistIp ?? saved?.whitelistIp ?? ''} placeholder="留空自动检测服务器出口 IP" onChange={event => onChange({ whitelistIp: event.target.value })} />
      </label>
    </div>
    <p>先在 IPRoyal 后台添加服务器出口 IP。系统使用 API Token 自动配置独立端口、国家和粘性会话，连接代理无需账号密码。</p>
    <p>数量受供应商可用端口限制，各国家共享端口容量，拉取后显示实际条数。已有手工白名单保留；使用中和冷却中的端口保持原会话，参数修改稍后刷新生效。</p>
  </fieldset>;
}
