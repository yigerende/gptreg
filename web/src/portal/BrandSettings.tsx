import { useState } from "react";
import type { Row } from "./client";

export default function BrandSettings({ settings, field }: { settings: Row; field: (key: string, value: any) => void }) {
  const [error, setError] = useState("");
  const brand = settings.brand;
  const update = (key: string, value: string) => field("brand", { ...brand, [key]: value });
  async function upload(file?: File) {
    setError("");
    if (!file) return;
    if (!["image/png", "image/svg+xml"].includes(file.type) || file.size > (file.type === "image/png" ? 256 : 20) * 1024) {
      setError("请选择不超过 256 KB 的 PNG 或 20 KB 的静态 SVG。"); return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      update("icon", data);
    } catch { setError("图片读取失败，请重新选择。"); }
  }
  return <section className="p-card">
    <h2>品牌与服务</h2>
    <p className="p-muted">统一设置登录页、工作台和浏览器标签页的品牌展示，保存后生效。</p>
    <div className="p-brand-icon-editor">
      <img src={brand.icon || "/site-icon/default"} width="64" height="64" alt="站点图标预览" />
      <img src={brand.icon || "/site-icon/default"} width="16" height="16" alt="标签页图标预览" />
      <div>
        <label>上传站点图标<input type="file" accept="image/png,image/svg+xml" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <small className="p-muted">静态 PNG（16～1024 像素，≤256 KB）或静态 SVG（≤20 KB，仅图形）。</small>
        <button type="button" className="p-link" onClick={() => { update("icon", ""); setError(""); }}>恢复默认图标</button>
      </div>
    </div>
    {error && <div className="p-alert" role="alert">{error}</div>}
    <div className="p-form-grid">
      <label>站点名称<input required maxLength={80} value={settings.site_name} onChange={(e) => field("site_name", e.target.value)} /></label>
      <label>英文名称<input maxLength={80} value={brand.english_name} onChange={(e) => update("english_name", e.target.value)} /></label>
      <label>品牌说明<input maxLength={200} value={brand.tagline} onChange={(e) => update("tagline", e.target.value)} /></label>
      <label>客服链接<input type="url" maxLength={2048} placeholder="https://…" value={brand.support_url} onChange={(e) => update("support_url", e.target.value)} /></label>
    </div>
    <label>服务约定<textarea rows={5} maxLength={10000} value={brand.terms} onChange={(e) => update("terms", e.target.value)} /></label>
  </section>;
}
