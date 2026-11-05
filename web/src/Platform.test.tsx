import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Platform from "./Platform";
import { Router } from "./router";
import { OrderDetail } from "./portal/Workspace";

const pub = { site_name: "GPT Register", brand: { icon_url: "/site-icon", english_name: "GPTREG", tagline: "清晰交付", terms: "约定", support_url: "" }, registration_open: true, price_standard: 50, price_oauth: 100, max_quantity: 50 };
const member = { id: "member", name: "演示用户", role: "user", points: 500, frozen: 0, email: "member@example.test" };
const clients: QueryClient[] = [];
function mount(child = <Platform />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><Router>{child}</Router></QueryClientProvider>);
}
async function advance(ms = 50) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function mockFetch(user: typeof member | null, order = { status: "completed" }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    const status = url === "/api/user/v1/me" && !user ? 401 : 200;
    return new Response(JSON.stringify(url === "/api/public" ? pub : url === "/api/user/v1/me" ? user || { error: "请先登录" } : { items: [], ...order }), { status });
  });
}
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("portal refresh behavior", () => {
  it("keeps the anonymous login form, focus and typed input stable for 65 seconds", async () => {
    vi.useFakeTimers(); window.history.replaceState({}, "", "/");
    const fetcher = mockFetch(null); mount(); await advance();
    const input = screen.getByLabelText("登录账号");
    fireEvent.change(input, { target: { value: "typing@example.test" } }); input.focus();
    const calls = fetcher.mock.calls.length;
    await advance(65000);
    expect(screen.getByLabelText("登录账号")).toBe(input);
    expect((input as HTMLInputElement).value).toBe("typing@example.test");
    expect(document.activeElement).toBe(input);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText("正在打开工作台…")).toBeNull();
  });
  it.each(["/", "/orders", "/accounts", "/wallet", "/keys", "/profile"])("does not poll an idle user page %s", async path => {
    vi.useFakeTimers(); window.history.replaceState({}, "", path);
    const fetcher = mockFetch(member); mount(); await advance();
    const calls = fetcher.mock.calls.length; await advance(65000);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("refreshes an active order then stops after settlement without replacing its dialog", async () => {
    vi.useFakeTimers(); let count = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => new Response(JSON.stringify(String(input).includes("registration-orders")
      ? { id: "order-1", status: ++count === 1 ? "running" : "completed", quantity: 1, unit_price: 50, charged: count === 1 ? 0 : 50, released: 0, delivered: count === 1 ? 0 : 1, items: [] } : member)));
    mount(<OrderDetail id="order-1" onClose={() => {}} />); await advance();
    const dialog = screen.getByRole("dialog");
    await advance(5100); expect(screen.getByText("全部完成")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    await advance(65000); expect(count).toBe(2);
  });
});
