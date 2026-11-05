import { useEffect, useState } from "react";
import { ArrowRight, ShieldCheck, LoaderCircle } from "lucide-react";
import { call, type Row } from "./client";
export default function Auth({
  pub,
  onLogin,
}: {
  pub: Row;
  onLogin: () => void;
}) {
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const needsCode =
    mode === "reset" || (mode === "register" && pub.email_verify_enabled);
  useEffect(() => {
    if (!seconds) return;
    const t = setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);
  function change(m: string) {
    setMode(m);
    setPassword("");
    setConfirm("");
    setCode("");
    setError("");
    setMessage("");
  }
  async function send() {
    setSending(true);
    setError("");
    try {
      const r = await call("/api/auth/email-code", "POST", {
        email,
        purpose: mode === "reset" ? "reset" : "register",
      });
      setSeconds(r.retry_after);
      setMessage(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (mode === "reset" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const r = await call(
        `/api/auth/${mode === "reset" ? "reset-password" : mode}`,
        "POST",
        { email, password, name, code },
      );
      if (mode === "reset") {
        change("login");
        setMessage(r.message);
      } else onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="p-auth">
      <section className="p-auth-story">
        <a className="p-brand" href="/">
          <span className="p-logo">G</span>
          {pub.site_name}
        </a>
        <div>
          <span className="p-eyebrow">YOUR ACCOUNT WORKSPACE</span>
          <h1>
            每一次注册，
            <br />
            都清晰可见。
          </h1>
          <p>
            按需提交，自动排队。
            <br />
            在自己的工作台，管理订单、积分与账号。
          </p>
          <div className="p-story-steps">
            <span>01 选择数量与模式</span>
            <span>02 跟踪注册进度</span>
            <span>03 领取账号凭据</span>
          </div>
        </div>
        <small>一个账户，连接网页操作与开放 API。</small>
      </section>
      <section className="p-auth-panel">
        <form onSubmit={submit}>
          <span className="p-eyebrow">WELCOME TO GPT REGISTER</span>
          <h2>
            {mode === "login"
              ? "欢迎回来"
              : mode === "register"
                ? "建立你的专属空间"
                : "找回你的账户"}
          </h2>
          <p className="p-muted">
            {mode === "reset"
              ? "验证注册邮箱，设置新的登录密码。"
              : "登录后继续管理你的账号与积分。"}
          </p>
          {mode !== "reset" ? (
            <div className="p-tabs">
              <button
                type="button"
                className={mode === "login" ? "selected" : ""}
                onClick={() => change("login")}
              >
                登录账户
              </button>
              {pub.registration_open && (
                <button
                  type="button"
                  className={mode === "register" ? "selected" : ""}
                  onClick={() => change("register")}
                >
                  注册账户
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="p-link"
              onClick={() => change("login")}
            >
              ← 返回登录
            </button>
          )}
          {error && (
            <div className="p-alert" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="p-notice" role="status">
              {message}
            </div>
          )}
          {mode === "register" && (
            <label>
              用户名
              <input
                required
                maxLength={80}
                autoComplete="nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="请输入用户名"
              />
            </label>
          )}
          <label>
            {mode === "login" ? "登录账号" : "邮箱地址"}
            <input
              required
              type={mode === "login" ? "text" : "email"}
              maxLength={254}
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setCode("");
              }}
              placeholder={
                mode === "login" ? "邮箱或管理员账号" : "name@example.com"
              }
              disabled={busy || sending}
            />
          </label>
          {mode === "register" && pub.email_domains?.length > 0 && (
            <small className="p-muted">
              支持的邮箱：{pub.email_domains.join("、")}
            </small>
          )}
          {needsCode && (
            <label>
              邮箱验证码
              <div className="p-inline">
                <input
                  required
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6 位验证码"
                />
                <button
                  className="p-button secondary"
                  type="button"
                  disabled={sending || seconds > 0 || !email || busy}
                  onClick={send}
                >
                  {seconds
                    ? `${seconds} 秒后重发`
                    : sending
                      ? "发送中…"
                      : "获取验证码"}
                </button>
              </div>
              <small>验证码 15 分钟有效，请勿分享给他人。</small>
            </label>
          )}
          <label>
            {mode === "reset" ? "新密码" : "账户密码"}
            <input
              required
              type="password"
              minLength={mode === "login" ? 1 : 10}
              maxLength={72}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "login" ? "输入你的密码" : "至少 10 位密码"}
            />
          </label>
          {mode === "reset" && (
            <label>
              确认新密码
              <input
                required
                type="password"
                minLength={10}
                maxLength={72}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          {mode === "login" && pub.password_reset_available && (
            <button
              className="p-link p-forgot"
              type="button"
              onClick={() => change("reset")}
            >
              忘记密码？
            </button>
          )}
          <button className="p-button full" disabled={busy || sending}>
            {busy ? <LoaderCircle className="p-spin" size={18} /> : null}
            {busy
              ? "请稍候…"
              : mode === "register"
                ? "注册账户"
                : mode === "reset"
                  ? "重置密码"
                  : "进入工作台"}
            {!busy && <ArrowRight size={17} />}
          </button>
          <div className="p-auth-hint">
            <ShieldCheck size={16} />
            {mode === "reset"
              ? "重置后原登录会话和 API 密钥将失效"
              : "仅在你自己的账户空间查看业务资料"}
          </div>
          <a className="p-doc-link" href="/docs">
            查看开放 API 文档 ↗
          </a>
        </form>
      </section>
    </div>
  );
}
