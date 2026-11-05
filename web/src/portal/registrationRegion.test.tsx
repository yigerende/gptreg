import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "../router";
import Workspace from "./Workspace";

const clients: QueryClient[] = [];
const pub = { features: {}, orders_open: true, max_quantity: 100, price_standard: 50, price_oauth: 100 };
const user = { id: "region-member", points: 5000 };
const response = (body: unknown) => new Response(JSON.stringify(body));
function mount() {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(q);
  return render(<QueryClientProvider client={q}><Router><Workspace page="register" pub={pub} user={user} /></Router></QueryClientProvider>);
}
afterEach(() => { cleanup(); clients.splice(0).forEach(q => q.clear()); window.localStorage.clear(); vi.restoreAllMocks(); });

it("defaults to random, lists configured regions and sends the chosen country", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    if (options?.method === "POST") throw new Error("response lost");
    return response({ default_region: "random", regions: [{ code: "JP", name: "日本" }, { code: "CL", name: "智利" }] });
  });
  mount();
  await screen.findByRole("option", { name: "日本 · JP" });
  const select = screen.getByLabelText("注册地区");
  expect(select).toHaveValue("random");
  expect(screen.getAllByRole("option")).toHaveLength(3);
  fireEvent.change(select, { target: { value: "JP" } });
  fireEvent.click(screen.getByRole("button", { name: "提交注册" }));
  await screen.findByRole("button", { name: "确认上次提交" });
  const post = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ registration_region: "JP", quantity: 1 });
  expect(select).toBeDisabled();
});

it("blocks a new order if its selected region disappears on refresh", async () => {
  let regions = [{ code: "JP", name: "日本" }];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ regions }));
  mount();
  await screen.findByRole("option", { name: "日本 · JP" });
  fireEvent.change(screen.getByLabelText("注册地区"), { target: { value: "JP" } });
  regions = [];
  fireEvent.click(screen.getByRole("button", { name: "刷新地区" }));
  await screen.findByText("所选地区当前不可用，请刷新或重新选择。");
  expect(screen.getByRole("button", { name: "提交注册" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("注册地区"), { target: { value: "random" } });
  expect(screen.getByRole("button", { name: "提交注册" })).toBeEnabled();
});

it("keeps random available on discovery failure and permits confirming an existing unavailable region", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const first = mount();
  await screen.findByText("地区列表暂不可用，可刷新重试或使用随机地区。");
  expect(screen.getByRole("button", { name: "提交注册" })).toBeEnabled();
  first.unmount();
  window.localStorage.setItem("gptreg:pending-order:region-member", JSON.stringify({ key: "original-region-key", quantity: 2, need_oauth: true, registration_region: "JP" }));
  mount();
  expect(screen.getByLabelText("注册地区")).toBeDisabled();
  const confirm = screen.getByRole("button", { name: "确认上次提交" });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  const request = fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!;
  expect(JSON.parse(String(request.body))).toEqual({ quantity: 2, need_oauth: true, registration_region: "JP" });
  expect((request.headers as Record<string, string>)["Idempotency-Key"]).toBe("original-region-key");
});
