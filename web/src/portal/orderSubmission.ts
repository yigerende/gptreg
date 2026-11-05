import { useEffect, useRef, useState } from "react";
import { ApiError, call, uid } from "./client";

type Intent = { key: string; quantity: number; need_oauth: boolean; registration_region?: string };
const storageKey = (userId: string) => `gptreg:pending-order:${userId}`;
function readIntent(userId: string): Intent | null {
  const text = window.localStorage.getItem(storageKey(userId));
  if (!text) return null;
  const v = JSON.parse(text);
  if (
    typeof v.key !== "string" ||
    !/^[!-~]{8,128}$/.test(v.key) ||
    !Number.isInteger(v.quantity) ||
    v.quantity < 1 ||
    v.quantity > 1000 ||
    typeof v.need_oauth !== "boolean" ||
    (v.registration_region !== undefined && (typeof v.registration_region !== "string" || !/^(random|GLOBAL|[A-Z]{2})$/.test(v.registration_region)))
  )
    throw new Error("上次提交记录无法读取，请先在订单中心核对结果并联系支持");
  return { key: v.key, quantity: v.quantity, need_oauth: v.need_oauth,
    ...(v.registration_region === undefined ? {} : { registration_region: v.registration_region }) };
}
export function useOrderSubmission(
  userId: string,
  initialOAuth: boolean,
  onConfirmed: (id: string) => void,
) {
  const [initial] = useState(() => {
    try {
      return { intent: readIntent(userId), error: "" };
    } catch {
      return {
        intent: null,
        error: "浏览器无法读取提交记录，请恢复本地存储后再试",
      };
    }
  });
  const [pending, setPending] = useState<Intent | null>(initial.intent);
  const [quantity, setQuantity] = useState(initial.intent?.quantity ?? 1);
  const [oauth, setOauth] = useState(
    initial.intent?.need_oauth ?? initialOAuth,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(initial.error),
    [notice, setNotice] = useState("");
  const [region, setRegion] = useState(initial.intent?.registration_region ?? "random");
  const inFlight = useRef(false);
  function restore(intent: Intent | null) {
    setPending(intent);
    if (intent) {
      setQuantity(intent.quantity);
      setOauth(intent.need_oauth);
      setRegion(intent.registration_region ?? "random");
    }
  }
  useEffect(() => {
    const update = (e: StorageEvent) => {
      if (e.key !== storageKey(userId)) return;
      try {
        restore(readIntent(userId));
      } catch {
        setError("提交记录无法读取，请先核对订单中心");
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [userId]);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const expected = pending;
    const work = async () => {
      let intent = readIntent(userId);
      const freshRequest = !intent && !expected;
      // Another tab may already have confirmed the pending request while this
      // tab was waiting for the browser lock. Never convert that retry to a new order.
      if (expected && !intent) {
        const receipt = JSON.parse(
          window.localStorage.getItem(storageKey(userId) + ":receipt") ||
            "null",
        );
        if (receipt?.key === expected.key && typeof receipt.id === "string") {
          restore(null);
          onConfirmed(receipt.id);
          setNotice("上次提交已确认");
          return;
        }
        throw new Error("上次提交记录已变化，请先在订单中心核对结果");
      }
      if (!intent) {
        intent = { key: uid(), quantity, need_oauth: oauth, registration_region: region };
        // Persist before sending. A storage failure must not issue an untracked order.
        window.localStorage.setItem(storageKey(userId), JSON.stringify(intent));
      }
      restore(intent);
      let result;
      try {
        result = await call(
          "/api/user/v1/registration-orders",
          "POST",
          { quantity: intent.quantity, need_oauth: intent.need_oauth,
            ...(intent.registration_region === undefined ? {} : { registration_region: intent.registration_region }) },
          intent.key,
        );
      } catch (e) {
        // These structured application responses prove the request was rejected.
        // Network/5xx/409/invalid responses remain pending with the exact same body/key.
        if (
          freshRequest &&
          e instanceof ApiError &&
          [400, 401, 402, 403, 404, 413, 429].includes(e.status)
        ) {
          window.localStorage.removeItem(storageKey(userId));
          restore(null);
          throw e;
        }
        throw new Error(
          "提交结果尚未确认，已保留原数量、模式和地区。请点击“确认上次提交”继续查询，系统会复用同一请求，避免重复下单。",
        );
      }
      if (!result || typeof result.id !== "string" || !result.id)
        throw new Error("响应未包含订单编号，请点击“确认上次提交”重试");
      window.localStorage.setItem(
        storageKey(userId) + ":receipt",
        JSON.stringify({ key: intent.key, id: result.id }),
      );
      window.localStorage.removeItem(storageKey(userId));
      restore(null);
      setNotice("订单已确认，积分按实际交付结算");
      onConfirmed(result.id);
    };
    try {
      if (navigator.locks)
        await navigator.locks.request(storageKey(userId), work);
      else await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    quantity,
    setQuantity,
    oauth,
    setOauth,
    region,
    setRegion,
    pending: Boolean(pending),
    busy,
    error,
    notice,
    submit,
  };
}
