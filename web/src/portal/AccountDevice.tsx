import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { call, copy, type Row } from "./client";
import { Modal } from "./Workspace";

export default function AccountDevice({ account, admin = false, onClose }: {
  account: Row; admin?: boolean; onClose: () => void;
}) {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setData(null); setError(""); setNotice("");
    call(`/api/${admin ? "admin" : "user"}/v1/accounts/${encodeURIComponent(account.id)}/device-fingerprint`)
      .then(value => { if (active) setData(value); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [account.id, admin]);
  const device = data?.device_fingerprint, p = device?.profile || {};
  const size = (w?: number, h?: number) => w && h ? `${w} × ${h}` : "";
  const fields = [
    ["浏览器指纹", device?.fingerprint], ["设备 ID", device?.deviceId],
    ["注册地区", device?.countryCode], ["浏览器", [p.browser, p.browserVersion].filter(Boolean).join(" ")],
    ["User-Agent", p.userAgent], ["操作系统", p.oscpu || p.platform],
    ["语言", p.language], ["语言列表", p.languages?.join(", ")], ["Accept-Language", p.acceptLanguage],
    ["时区", p.timeZone], ["CPU 线程", p.hardwareConcurrency],
    ["屏幕分辨率", size(p.screen?.width, p.screen?.height)],
    ["可用屏幕", size(p.screen?.availWidth, p.screen?.availHeight)],
    ["窗口内部尺寸", size(p.viewport?.innerWidth, p.viewport?.innerHeight)],
    ["窗口外部尺寸", size(p.viewport?.outerWidth, p.viewport?.outerHeight)],
    ["像素缩放比", p.viewport?.devicePixelRatio], ["颜色深度", p.screen?.colorDepth],
    ["GPU 厂商", p.gpu?.vendor], ["GPU 渲染器", p.gpu?.renderer],
    ["最大触点", p.maxTouchPoints], ["存储配额（字节）", p.storageQuotaBytes], ["指纹配置版本", p.schemaVersion],
  ];
  return <Modal title="账号设备指纹" onClose={onClose}>
    <p>{account.email}</p>
    <p className="p-muted">注册时保存的设备信息，缺失字段留空。注册地区为记录的配置地区。</p>
    {error ? <div className="p-alert" role="alert">{error}</div> : !data ? <p role="status">正在读取设备指纹…</p> : <>
      {!device && <p className="p-notice">此账号暂未保存设备信息。</p>}
      {notice && <p role="status">{notice}</p>}
      {fields.map(([label, value]) => <label className="p-credential-field" key={label}>
        {label}<div className="p-inline"><textarea readOnly rows={2} value={value == null ? "" : String(value)} />
          <button className="p-button secondary" aria-label={`复制${label}`} disabled={value == null || value === ""}
            onClick={() => void copy(String(value)).then(() => setNotice(`${label}已复制`)).catch(() => setNotice("复制失败，请手动复制"))}><Copy size={15} /></button>
        </div>
      </label>)}
    </>}
  </Modal>;
}
