import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminRisk from "./AdminRisk";
const names = [
  "login",
  "redeem",
  "submit",
  "query",
  "export",
  "write",
  "account",
  "api_key",
];
const cfg = {
  enabled: true,
  revision: 0,
  rules: Object.fromEntries(
    names.map((n) => [
      n,
      { mode: "observe", limit: 30, window_seconds: 60, cooldown_seconds: 60 },
    ]),
  ),
  trusted_proxies: [],
  retention_days: 30,
  refresh_seconds: 5,
  scan_seconds: 60,
  behavior_window_seconds: 900,
  login_source_accounts: 10,
  duplicate_count: 10,
  cancel_count: 10,
  failure_min_count: 5,
  failure_percent: 50,
  queue_count: 100,
  queue_seconds: 600,
  processing_seconds: 1200,
  large_adjustment: 10000,
  finance_checks: true,
};
const monitor = {
  items: [
    {
      id: 1,
      user_id: "alice",
      account: "alice@example.test",
      user_name: "客户 Alice",
      category: "application",
      kind: "queue_long",
      severity: "warning",
      message: "注册订单排队时间较长",
      occurrences: 1,
      operation: "scan",
      status: 0,
      last_seen: "2026-11-05T08:00:00Z",
    },
  ],
  total: 1,
  summary: { requests: 42, pending: 1, restrictions: 1, paused_customers: 0 },
  restrictions: [
    {
      id: "limit1",
      label: "alice@example.test",
      rule: "query",
      hits: 31,
      blocked_until: "2026-11-05T09:00:00Z",
    },
  ],
  customers: [],
  traffic: [
    {
      user_id: "alice",
      email: "alice@example.test",
      key_id: "key1",
      key_name: "测试密钥",
      operation: "query",
      channel: "api",
      requests: 42,
      errors: 1,
      blocked: 1,
      average_ms: 8,
    },
  ],
  refresh_seconds: 5,
  monitoring_enabled: true,
  generated_at: "2026-11-05T08:00:00Z",
  last_scan: "2026-11-05T08:00:00Z",
};
let client: QueryClient;
function setup() {
  vi.useFakeTimers();
  const requests: { url: string; method: string; body: any }[] = [];
  let config = structuredClone(cfg);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input),
      method = init?.method || "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    let data: any = { ok: true };
    if (url.endsWith("/settings")) {
      if (method === "PUT") config = { ...body, revision: config.revision + 1 };
      else data = { settings: config, defaults: cfg };
    } else if (url.includes("/monitor")) data = monitor;
    else if (url.includes("/api/admin/v1/users"))
      data = {
        items: [{ id: "alice", name: "Alice", email: "alice@example.test" }],
      };
    else if (url.endsWith("/customers/alice") && method === "GET")
      data = {
        user_id: "alice",
        paused: false,
        paused_until: null,
        limits: {},
      };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminRisk />
    </QueryClientProvider>,
  );
  return requests;
}
async function tick(ms = 50) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("administrator risk monitor", () => {
  it("does not poll by default and stops opted-in polling while hidden, editing or unmounted", async () => {
    const requests = setup();
    await tick();
    const count = () =>
      requests.filter((r) => r.url.includes("/monitor")).length;
    expect(screen.getByText("注册订单排队时间较长")).toBeTruthy();
    const initial = count();
    await tick(16000);
    expect(count()).toBe(initial);
    fireEvent.click(screen.getByLabelText("自动更新数据"));
    await tick(5100);
    expect(count()).toBeGreaterThan(initial);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    const beforeHidden = count();
    await tick(12000);
    expect(count()).toBe(beforeHidden);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    await tick();
    const beforeConfig = count();
    await tick(12000);
    expect(count()).toBe(beforeConfig);
    cleanup();
    await tick(12000);
    expect(count()).toBe(beforeConfig);
  });
  it("saves configurable policies and preserves revision without background refetch overwriting draft", async () => {
    const requests = setup();
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    await tick();
    fireEvent.change(screen.getByLabelText("查询与轮询处理方式"), {
      target: { value: "enforce" },
    });
    fireEvent.change(screen.getByLabelText("查询与轮询最大次数"), {
      target: { value: "65" },
    });
    fireEvent.change(screen.getByLabelText("可信代理地址"), {
      target: { value: "127.0.0.1\n10.1.0.0/24" },
    });
    await tick(15000);
    expect(
      (screen.getByLabelText("查询与轮询最大次数") as HTMLInputElement).value,
    ).toBe("65");
    fireEvent.click(screen.getByRole("button", { name: "保存风控配置" }));
    await tick();
    const saved = requests.find(
      (r) => r.method === "PUT" && r.url.endsWith("/settings"),
    );
    expect(saved?.body.rules.query).toMatchObject({
      mode: "enforce",
      limit: 65,
    });
    expect(saved?.body.trusted_proxies).toEqual(["127.0.0.1", "10.1.0.0/24"]);
    expect(saved?.body.revision).toBe(0);
    expect(screen.getByText("风控配置已保存")).toBeTruthy();
  });
  it("selects a customer, pauses only new orders and saves per-customer limits", async () => {
    const requests = setup();
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "客户规则" }));
    fireEvent.click(screen.getByRole("button", { name: "配置客户" }));
    await tick();
    fireEvent.change(screen.getByLabelText("选择风控客户"), {
      target: { value: "alice" },
    });
    await tick();
    fireEvent.click(screen.getByLabelText("暂停该客户提交新订单"));
    fireEvent.change(screen.getByLabelText("客户查询与轮询次数"), {
      target: { value: "88" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存客户规则" }));
    await tick();
    expect(
      requests.find(
        (r) => r.method === "PUT" && r.url.endsWith("/customers/alice"),
      )?.body,
    ).toMatchObject({
      paused: true,
      paused_until: null,
      limits: { query: 88 },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("requires explicit confirmation for releasing restrictions and revoking a key", async () => {
    const requests = setup();
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "当前限制" }));
    fireEvent.click(screen.getByRole("button", { name: "解除限制" }));
    expect(requests.some((r) => r.url.endsWith("/release"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认操作" }));
    await tick();
    expect(
      requests.some(
        (r) => r.url.endsWith("/limits/limit1/release") && r.method === "POST",
      ),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "访问统计" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销密钥" }));
    expect(requests.some((r) => r.url.endsWith("/revoke"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认操作" }));
    await tick();
    expect(
      requests.some(
        (r) => r.url.endsWith("/keys/key1/revoke") && r.method === "POST",
      ),
    ).toBe(true);
  });
});
