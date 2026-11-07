import { AppSelect } from './components/AppSelect';
import type { IPRoyalSettings, IPRoyalSettingsSnapshot } from './types';
import './iproyal.css';

export function iproyalSettingsReady(draft: IPRoyalSettings, saved?: IPRoyalSettingsSnapshot) {
  return Boolean((draft.apiToken?.trim() || saved?.apiTokenConfigured)
    && ((draft.authMode ?? saved?.authMode ?? 'credentials') === 'subuser'
      ? (draft.subuserHash ?? saved?.subuserHash ?? '').trim()
      : (draft.username ?? saved?.username ?? '').trim() && (draft.password?.trim() || saved?.passwordConfigured)));
}

export function IPRoyalFields({ draft, saved, disabled, onChange }: {
  draft: IPRoyalSettings; saved?: IPRoyalSettingsSnapshot; disabled: boolean; onChange: (patch: IPRoyalSettings) => void;
}) {
  const mode = draft.authMode ?? saved?.authMode ?? 'credentials';
  return <fieldset className="iproyal-fields" disabled={disabled}>
    <legend>IPRoyal 专属配置</legend>
    <div className="iproyal-fields-grid">
      <label className="iproyal-token-field"><span>API Token <small>{saved?.apiTokenConfigured ? '已配置' : '待配置'}</small></span>
        <input aria-label="IPRoyal API Token" type="password" autoComplete="new-password" spellCheck={false} value={draft.apiToken || ''} placeholder={saved?.apiTokenConfigured ? '已保存，留空保持不变' : '填写 IPRoyal 后台的 API Token'} onChange={event => onChange({ apiToken: event.target.value })} />
      </label>
      <div className="quick-field"><span>代理认证方式</span><AppSelect ariaLabel="IPRoyal 认证方式" value={mode} disabled={disabled} onValueChange={value => onChange({ authMode: value as IPRoyalSettings['authMode'] })} options={[{ value: 'credentials', label: '代理账号密码' }, { value: 'subuser', label: '子用户 ID' }]} /></div>
      {mode === 'credentials' ? <>
        <label><span>代理账号</span><input aria-label="IPRoyal 代理账号" type="text" autoComplete="off" spellCheck={false} value={draft.username ?? saved?.username ?? ''} placeholder="代理连接使用的账号" onChange={event => onChange({ username: event.target.value })} /></label>
        <label><span>代理密码 <small>{saved?.passwordConfigured ? '已配置' : '待配置'}</small></span><input aria-label="IPRoyal 代理密码" type="password" autoComplete="new-password" value={draft.password || ''} placeholder={saved?.passwordConfigured ? '已保存，留空保持不变' : '代理连接使用的密码'} onChange={event => onChange({ password: event.target.value })} /></label>
      </> : <label className="iproyal-subuser-field"><span>子用户 ID</span><input aria-label="IPRoyal 子用户 ID" type="text" autoComplete="off" spellCheck={false} value={draft.subuserHash ?? saved?.subuserHash ?? ''} placeholder="IPRoyal 子用户的 subuser_hash" onChange={event => onChange({ subuserHash: event.target.value })} /></label>}
    </div>
    <p>API Token 在 IPRoyal 后台「设置 → API」获取。代理账号密码与子用户 ID 二选一；点击下方保存，密钥留空会保留已保存的值。</p>
  </fieldset>;
}
