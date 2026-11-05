import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrderSubmission } from "./orderSubmission";
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
const response = (status = 202, body: unknown = { id: "order-1" }) =>
  new Response(JSON.stringify(body), { status });
describe("durable customer order submission", () => {
  it("reuses the original body/key after lost responses, remount and mode changes", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(response(200));
    const confirmed = vi.fn();
    let hook = renderHook(() => useOrderSubmission("alice", true, confirmed));
    act(() => hook.result.current.setQuantity(3));
    act(() => hook.result.current.setRegion("JP"));
    await act(() => hook.result.current.submit());
    const first = fetcher.mock.calls[0][1]!;
    expect(hook.result.current.pending).toBe(true);
    expect(hook.result.current.error).toContain("尚未确认");
    hook.unmount();
    hook = renderHook(() => useOrderSubmission("alice", false, confirmed));
    expect(hook.result.current.oauth).toBe(true);
    expect(hook.result.current.quantity).toBe(3);
    expect(hook.result.current.region).toBe("JP");
    // Even an attempted change cannot replace the persisted submission payload.
    act(() => {
      hook.result.current.setQuantity(9);
      hook.result.current.setOauth(false);
      hook.result.current.setRegion("CL");
    });
    await act(() => hook.result.current.submit());
    expect(fetcher.mock.calls[1][1]?.headers).toEqual(first.headers);
    expect(fetcher.mock.calls[1][1]?.body).toEqual(first.body);
    expect(confirmed).toHaveBeenCalledWith("order-1");
    expect(hook.result.current.pending).toBe(false);
  });
  it("replays a pre-upgrade intent without adding a region field", async () => {
    window.localStorage.setItem("gptreg:pending-order:legacy", JSON.stringify({ key: "legacy-request-key", quantity: 2, need_oauth: false }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(200));
    const h = renderHook(() => useOrderSubmission("legacy", true, vi.fn()));
    await act(() => h.result.current.submit());
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ quantity: 2, need_oauth: false });
    expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("legacy-request-key");
  });
  it("does not send a second request on double click and only uses a new key after confirmation", async () => {
    let finish!: (r: Response) => void;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(response(202, { id: "order-2" }));
    const h = renderHook(() => useOrderSubmission("alice", false, vi.fn()));
    let first!: Promise<void>;
    act(() => {
      first = h.result.current.submit();
      void h.result.current.submit();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish(response());
      await first;
    });
    await act(() => h.result.current.submit());
    expect(
      (fetcher.mock.calls[0][1]?.headers as Record<string, string>)[
        "Idempotency-Key"
      ],
    ).not.toEqual(
      (fetcher.mock.calls[1][1]?.headers as Record<string, string>)[
        "Idempotency-Key"
      ],
    );
  });
  it("keeps an uncertain intent after login expires, but allows edits after an initial definite rejection", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(401, { error: "请登录" }))
      .mockResolvedValueOnce(response(402, { error: "积分不足" }));
    const a = renderHook(() => useOrderSubmission("alice", false, vi.fn()));
    await act(() => a.result.current.submit());
    await act(() => a.result.current.submit());
    expect(a.result.current.pending).toBe(true);
    const b = renderHook(() => useOrderSubmission("bob", true, vi.fn()));
    expect(b.result.current.pending).toBe(false);
    await act(() => b.result.current.submit());
    expect(b.result.current.pending).toBe(false);
    expect(b.result.current.error).toContain("积分不足");
    expect(a.result.current.pending).toBe(true);
  });
  it("sends no request if persisting the intent fails", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const h = renderHook(() => useOrderSubmission("alice", false, vi.fn()));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    await act(() => h.result.current.submit());
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.result.current.error).toContain("storage unavailable");
  });
});
