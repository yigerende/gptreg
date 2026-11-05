const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
export function registrationRegionName(code?: string | null): string {
  if (!code) return "系统默认（历史订单）";
  if (code === "random") return "随机地区";
  if (code === "GLOBAL") return "全球（混合地区） · GLOBAL";
  return /^[A-Z]{2}$/.test(code) ? `${names.of(code) || code} · ${code}` : code;
}
