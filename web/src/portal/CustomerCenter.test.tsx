import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "../router";
import {
  CustomerOrderCenter,
  FundsAccount,
  PersonalSettings,
} from "./CustomerCenter";
import AdminAccounts from "./AdminAccounts";
import * as client from "./client";
import type { ReactNode } from "react";

const user = {
  id: "member",
  role: "member",
  name: "客户",
  email: "member@example.test",
  points: 80,
  frozen: 20,
  created_at: "2026-11-01T00:00:00Z",
};
const pub = { features: {}, brand: { support_url: "" } };
const clients: QueryClient[] = [];
function mount(node: ReactNode) {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(q);
  return render(
    <QueryClientProvider client={q}>
      <Router>{node}</Router>
    </QueryClientProvider>,
  );
}
const response = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((q) => q.clear());
  vi.restoreAllMocks();
});

it("shows available points without subtracting frozen twice and switches funding filters", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      response({
        points: 80,
        frozen: 20,
        items: [],
        total: 0,
        totals: { credited: 100, charged: 0, reserved: 20, released: 0 },
      }),
    );
  const { container } = mount(<FundsAccount user={user} pub={pub} />);
  await waitFor(() =>
    expect(container.querySelector(".p-balance-card strong")?.textContent).toBe(
      "80积分",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "充值记录" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("tab=recharges")),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("开始日期"), {
    target: { value: "2026-11-01" },
  });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("start=2026-11-01"),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "重置" }));
  await waitFor(() =>
    expect((screen.getByLabelText("开始日期") as HTMLInputElement).value).toBe(
      "",
    ),
  );
});

it("keeps complete order identifiers, delivery links and real pagination", async () => {
  const order = {
    id: "order-full-identifier",
    source: "api",
    need_oauth: true,
    quantity: 2,
    delivered: 1,
    unit_price: 100,
    charged: 100,
    released: 0,
    status: "partial",
    created_at: "2026-11-01",
    updated_at: "2026-11-02",
  };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response({ items: [order], total: 21 }));
  mount(<CustomerOrderCenter user={user} pub={pub} />);
  expect(await screen.findByText(order.id)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "领取账号 ↗" }).getAttribute("href"),
  ).toBe(`/accounts?order_id=${order.id}`);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("offset=20")),
    ).toBe(true),
  );
});

it("validates password confirmation and saves profile changes separately", async () => {
  const logout = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      response(
        init?.method === "PATCH"
          ? {
              ok: true,
              relogin: Boolean(JSON.parse(String(init.body)).password),
            }
          : { stats: {} },
      ),
    );
  mount(
    <PersonalSettings
      user={user}
      pub={{ ...pub, features: { orders: false, wallet: false } }}
      onLogout={logout}
    />,
  );
  expect(screen.queryByText("注册记录")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  fireEvent.change(screen.getByLabelText("当前密码"), {
    target: { value: "OriginalPassword" },
  });
  fireEvent.change(screen.getByLabelText("新密码"), {
    target: { value: "NewPassword123" },
  });
  fireEvent.change(screen.getByLabelText("确认新密码"), {
    target: { value: "DifferentPassword" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect(await screen.findByText("两次输入的新密码不一致。")).toBeTruthy();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
    false,
  );
  fireEvent.change(screen.getByLabelText("确认新密码"), {
    target: { value: "NewPassword123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "编辑用户名" }));
  fireEvent.change(screen.getByLabelText("用户名"), {
    target: { value: "新名字" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(2),
  );
  expect(
    JSON.parse(
      String(
        fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")[1][1]
          ?.body,
      ),
    ),
  ).toEqual({ name: "新名字" });
});

it("reveals admin delivery details on demand and exports only selected records", async () => {
  const row = {
    id: "delivery-1",
    email: "delivered@example.test",
    owner_email: "owner@example.test",
    order_id: "order-1",
    need_oauth: true,
    created_at: "2026-11-01",
  };
  const record = {
    email: row.email,
    password: "DeliveredPassword",
    totp_secret: "JBSWY3DPEHPK3PXP",
    totp_code: "123456",
    totp_expires_in: 20,
    oauth: { access_token: "access-test", refresh_token: "refresh-test" },
    delivery: { ...row, owner_name: "客户" },
  };
  const save = vi.spyOn(client, "download").mockImplementation(() => {});
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      response(
        String(_url).includes("/accounts?") ? { items: [row], total: 1 } : init?.method === "POST"
          ? {
              filename: "gptreg-deliveries.json",
              content: JSON.stringify([record]),
            }
          : record,
      ),
    );
  mount(<AdminAccounts rows={[{ id: row.order_id, available_count: 1, owner_email: row.owner_email }]} onOrder={() => {}} />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: new RegExp("订单 " + row.order_id.slice(0,12)) }));
  fireEvent.click(await screen.findByRole("button", { name: "查看凭据" }));
  expect(await screen.findByDisplayValue(record.password)).toBeTruthy();
  expect((screen.getByRole("textbox",{name:"RT（Refresh Token）"}) as HTMLInputElement).value).toBe("refresh-test");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByDisplayValue(record.password)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: `选择 ${row.email}` }));
  fireEvent.click(screen.getByRole("button", { name: "导出完整 JSON" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    ids: [row.id],
    format: "json",
  });
  expect(save.mock.calls[0][1]).toContain("refresh-test");
});
