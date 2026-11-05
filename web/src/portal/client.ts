export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function call(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<any> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "gptreg",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error || data.message || `请求失败 (${response.status})`,
      response.status,
    );
  return data;
}
export async function currentUser() {
  try {
    return await call("/api/user/v1/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}
export const orderPending = (order?: Row) =>
  Boolean(
    order &&
      ["queued", "running", "oauth_pending", "review"].includes(order.status),
  );
export const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export function download(filename: string, content: string, encoding?: string) {
  const data =
    encoding === "base64"
      ? Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
      : content;
  const u = URL.createObjectURL(
    new Blob([data], {
      type:
        encoding === "base64"
          ? "application/zip"
          : filename.endsWith(".json")
            ? "application/json;charset=utf-8"
            : "text/plain;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
export async function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext)
    await navigator.clipboard.writeText(text);
  else {
    const a = document.createElement("textarea");
    a.value = text;
    document.body.append(a);
    a.select();
    const ok = document.execCommand("copy");
    a.remove();
    if (!ok) throw new Error("无法自动复制，请手动选择内容复制");
  }
}
export const statusNames: Row = {
  queued: "排队中",
  running: "执行中",
  oauth_pending: "授权待完成",
  review: "待核实",
  completed: "全部完成",
  partial: "部分完成",
  failed: "未完成",
  cancelled: "已取消",
  delivered: "已交付",
  active: "正常",
  disabled: "停用",
};
export const date = (v: string) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
