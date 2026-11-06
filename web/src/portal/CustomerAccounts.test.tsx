import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "../router";
import CustomerAccounts from "./CustomerAccounts";
import { mergeSelection } from "./accountSelection";
import * as client from "./client";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((q) => q.clear());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const future = () => new Date(Date.now() + 72 * 3600000).toISOString();
function account(id: string, order = "one", expiry = future()) {
  return {
    id,
    order_id: order,
    email: `${id}@gmail.com`,
    need_oauth: true,
    created_at: new Date().toISOString(),
    download_expires_at: expiry,
  };
}
function group(id: string, count: number, expiry = future()) {
  return {
    id,
    order_id: id,
    need_oauth: true,
    available_count: count,
    last_delivered_at: new Date().toISOString(),
    download_expires_at: expiry,
  };
}
function page(items: unknown[], total = items.length, extra = {}) {
  return { items, total, server_time: new Date().toISOString(), ...extra };
}
function mount() {
  window.history.replaceState(null, "", "/accounts");
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(q);
  return render(
    <QueryClientProvider client={q}>
      <Router>
        <CustomerAccounts userId="member" />
      </Router>
    </QueryClientProvider>,
  );
}

it.each([["邮箱+AT","email_at"],["邮箱+Session","email_session"]])("exports %s with progress and displays complete saved login tokens", async(label,format)=>{
  const token='COMPLETE_SESSION_'+'s'.repeat(12000),row=account('web-token');let finish:(v:unknown)=>void=()=>{};
  const save=vi.spyOn(client,'download').mockImplementation(()=>{});
  const calls=vi.spyOn(client,'call').mockImplementation(async(path,method)=>{
    if(method==='POST')return new Promise(resolve=>{finish=resolve;});
    if(path.includes('/credentials'))return {...row,password:'test',totp_secret:'TEST_2FA',totp_code:'123456',access_token:'WEB_AT',session_token:token,oauth:format==='email_at'?{access_token:'OAUTH_AT',refresh_token:'FULL_RT'}:undefined};
    if(path.includes('account-orders'))return page([group('one',1)],1,{accounts_total:1});
    return page([row]);
  });
  mount();await screen.findByRole('button',{name:'展开订单 one'});
  fireEvent.click(screen.getByRole('button',{name:'按账号'}));await screen.findByText(row.email);
  fireEvent.click(screen.getByRole('checkbox',{name:`选择 ${row.email}`}));
  fireEvent.click(screen.getByRole('button',{name:label}));
  expect(screen.getByRole('status').textContent).toContain('正在生成 1');
  expect(screen.getByRole('button',{name:label})).toBeDisabled();
  expect(calls.mock.calls.find(([,method])=>method==='POST')?.[2]).toEqual({ids:[row.id],format});
  await act(async()=>finish({filename:'tokens.txt',content:'full-export'}));expect(save).toHaveBeenCalledWith('tokens.txt','full-export',undefined);
  fireEvent.click(screen.getByRole('button',{name:'查看凭据'}));
  expect(await screen.findByDisplayValue(token)).toHaveValue(token);expect(screen.getByDisplayValue('WEB_AT')).toBeVisible();
  expect(screen.getByRole('textbox',{name:'RT（Refresh Token）'})).toHaveValue(format==='email_at'?'FULL_RT':'');
  expect(screen.getByRole('textbox',{name:'OAuth AT'})).toHaveValue(format==='email_at'?'OAUTH_AT':'');
  expect(screen.getByRole('textbox',{name:'邮箱'})).toHaveValue(row.email);
  expect(screen.getByRole('textbox',{name:'密码'})).toHaveValue('test');
  expect(screen.getByRole('textbox',{name:'2FA 密钥'})).toHaveValue('TEST_2FA');
  expect(screen.getByRole('textbox',{name:'当前验证码'})).toHaveValue('123456');
  expect(screen.getByRole('button',{name:'刷新验证码'})).toBeVisible();
  const copied=vi.spyOn(client,'copy').mockResolvedValue();
  fireEvent.click(screen.getByRole('button',{name:'复制完整 Session Token'}));
  await waitFor(()=>expect(copied).toHaveBeenCalledWith(token));
  fireEvent.click(screen.getByRole('button',{name:'展开完整 Session Token'}));
  expect(screen.getByRole('textbox',{name:'完整 Session Token完整内容'})).toHaveValue(token);

});

it('opens only the selected account device without fetching credentials',async()=>{
  const row=account('device');
  const calls=vi.spyOn(client,'call').mockImplementation(async path=>{
    if(path.endsWith('/device-fingerprint'))return {id:row.id,email:row.email,device_fingerprint:{fingerprint:'FULL_FINGERPRINT',deviceId:'DID',profile:{browser:'firefox'}}};
    if(path.includes('account-orders'))return page([group('one',1)],1,{accounts_total:1});
    return page([row]);
  });
  mount();await screen.findByRole('button',{name:'展开订单 one'});
  fireEvent.click(screen.getByRole('button',{name:'按账号'}));await screen.findByText(row.email);
  fireEvent.click(screen.getByRole('button',{name:'查看设备指纹'}));
  expect(await screen.findByDisplayValue('FULL_FINGERPRINT')).toBeVisible();
  expect(calls).toHaveBeenCalledWith('/api/user/v1/accounts/device/device-fingerprint');
  expect(calls.mock.calls.some(([path])=>path.includes('/credentials'))).toBe(false);
});

it("limits merged selections to 1000, ignores duplicate/expired rows, and fills freed slots", () => {
  const now = Date.now(),
    rows = Array.from({ length: 1002 }, (_, i) => account(String(i)));
  const selected = mergeSelection([], rows.slice(0, 999), now);
  const result = mergeSelection(
    selected.items,
    [rows[0], ...rows.slice(999)],
    now,
  );
  expect(result.items).toHaveLength(1000);
  expect(result.limited).toBe(true);
  const next = mergeSelection(
    result.items.slice(1),
    [account("expired", "one", new Date(now).toISOString()), rows[1000]],
    now,
  );
  expect(next.items).toHaveLength(1000);
  expect(next.items.at(-1)?.id).toBe("1000");
  expect(next.items.some((r) => r.id === "expired")).toBe(false);
});

it("expands orders, selects whole orders, keeps other orders when deselecting, and keeps selection across views", async () => {
  const calls = vi.spyOn(client, "call").mockImplementation(async (path) => {
    const u = new URL(path, "http://local"),
      order = u.searchParams.get("order_id");
    if (u.pathname.endsWith("account-orders"))
      return page([group("one", 2), group("two", 1)], 2, { accounts_total: 3 });
    if (u.pathname.endsWith("selection"))
      return page(
        order === "two" ? [account("c", "two")] : [account("a"), account("b")],
      );
    return page(
      order === "one"
        ? [account("a"), account("b")]
        : [account("a"), account("b"), account("c", "two")],
    );
  });
  mount();
  await screen.findByRole("button", { name: "展开订单 one" });
  fireEvent.click(screen.getByRole("button", { name: "展开订单 one" }));
  await screen.findByText("a@gmail.com");
  fireEvent.click(screen.getByRole("checkbox", { name: "全选订单 one" }));
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "选择 a@gmail.com" }),
    ).toBeChecked(),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "全选订单 two" }));
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "全选订单 two" }),
    ).toBeChecked(),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "全选订单 one" }));
  expect(screen.getByRole("checkbox", { name: "全选订单 two" })).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "选择 a@gmail.com" }),
  ).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "按账号" }));
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "选择 c@gmail.com" }),
    ).toBeChecked(),
  );
  expect(
    calls.mock.calls.some(([path]) =>
      path.includes("accounts/selection?order_id=one"),
    ),
  ).toBe(true);
});

it("enforces the cap for bulk/page/individual selection and shows progress with one export request", async () => {
  const bulk = Array.from({ length: 1000 }, (_, i) => account(`a${i}`));
  let resolveExport: (value: unknown) => void = () => {};
  const save = vi.spyOn(client, "download").mockImplementation(() => {});
  const calls = vi
    .spyOn(client, "call")
    .mockImplementation(async (path, method) => {
      if (method === "POST")
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      if (path.includes("account-orders"))
        return page([group("one", 1001)], 1, { accounts_total: 1001 });
      if (path.includes("selection")) return page(bulk, 1001);
      return page([account("a0"), account("overflow")], 2);
    });
  const { container } = mount();
  await screen.findByRole("button", { name: "展开订单 one" });
  fireEvent.click(
    screen.getByRole("button", { name: "全选全部账号（最多 1000）" }),
  );
  await waitFor(() =>
    expect(
      container.querySelector(".p-account-selection strong b")?.textContent,
    ).toBe("1000"),
  );
  fireEvent.click(screen.getByRole("button", { name: "按账号" }));
  await screen.findByText("overflow@gmail.com");
  expect(
    screen.getByRole("checkbox", { name: "选择 overflow@gmail.com" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择本页全部账号" }));
  expect(
    container.querySelector(".p-account-selection strong b")?.textContent,
  ).toBe("1000");
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 a0@gmail.com" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "选择 overflow@gmail.com" }),
  );
  expect(
    container.querySelector(".p-account-selection strong b")?.textContent,
  ).toBe("1000");
  fireEvent.click(screen.getByRole("button", { name: "CPA" }));
  expect(screen.getByRole("status").textContent).toContain("正在生成 1000");
  expect(
    screen.getByRole("button", { name: "SUB" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "CPA" }));
  expect(
    calls.mock.calls.filter(([, method]) => method === "POST"),
  ).toHaveLength(1);
  const body = calls.mock.calls.find(
    ([, method]) => method === "POST",
  )?.[2] as { ids: string[] };
  expect(body.ids).toHaveLength(1000);
  expect(body.ids).toContain("overflow");
  expect(body.ids).not.toContain("a0");
  await act(async () =>
    resolveExport({
      filename: "accounts.zip",
      content: "UEs=",
      encoding: "base64",
    }),
  );
  expect(save).toHaveBeenCalledWith("accounts.zip", "UEs=", "base64");
});

it("expires the open credentials and selection without periodic network polling", async () => {
  vi.useFakeTimers();
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const row = account("soon", "one", expiry);
  const calls = vi.spyOn(client, "call").mockImplementation(async (path) => {
    const alive = Date.now() < Date.parse(expiry);
    if (path.includes("credentials"))
      return {
        ...row,
        password: "secret",
        totp_secret: "seed",
        totp_code: "123456",
      };
    if (path.includes("account-orders"))
      return page(alive ? [group("one", 1, expiry)] : [], alive ? 1 : 0, {
        next_expires_at: alive ? expiry : null,
      });
    return page(alive ? [row] : [], alive ? 1 : 0);
  });
  const { container } = mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  fireEvent.click(screen.getByRole("button", { name: "按账号" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "选择 soon@gmail.com" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "查看凭据" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  const before = calls.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(calls.mock.calls.length).toBe(before);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3600000);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    container.querySelector(".p-account-selection strong b")?.textContent,
  ).toBe("0");
  expect(
    screen.queryByRole("checkbox", { name: "选择 soon@gmail.com" }),
  ).not.toBeInTheDocument();
});

it("reports a server expiry during export, clears stale selection and refreshes", async () => {
  let accountLoads = 0;
  vi.spyOn(client, "call").mockImplementation(async (path, method) => {
    if (method === "POST")
      throw new client.ApiError("领取资料已超过 72 小时，请刷新后重选", 404);
    if (path.includes("selection")) return page([account("a")]);
    accountLoads++;
    return page([group("one", 1)]);
  });
  const { container } = mount();
  await screen.findByRole("button", { name: "展开订单 one" });
  fireEvent.click(
    screen.getByRole("button", { name: "全选全部账号（最多 1000）" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "CPA" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "CPA" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("72 小时"),
  );
  expect(
    container.querySelector(".p-account-selection strong b")?.textContent,
  ).toBe("0");
  expect(accountLoads).toBeGreaterThan(1);
});
