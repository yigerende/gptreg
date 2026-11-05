import { lazy, Suspense, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChartNoAxesCombined,
  ChevronRight,
  Code2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { Link, Router, useRouter } from "./router";
import Auth from "./portal/Auth";
import Workspace from "./portal/Workspace";
import Docs from "./portal/Docs";
import { call, currentUser } from "./portal/client";
import "./portal/portal.css";
const AdminConsole = lazy(() => import("./AdminConsole"));
const AdminPlatform = lazy(() => import("./portal/AdminPlatform"));
export default function Platform() {
  const q = useQueryClient(),
    { path, navigate } = useRouter(),
    [mobile, setMobile] = useState(false);
  const pub = useQuery({
    queryKey: ["public"],
    queryFn: () => call("/api/public"),
    refetchOnWindowFocus: false,
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: currentUser,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (q.getQueryData(["me"])) void q.invalidateQueries({ queryKey: ["me"] });
  }, [path, q]);
  useEffect(() => {
    if (!pub.data) return;
    document.title = `${pub.data.site_name} · 用户工作台`;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = pub.data.brand.icon_url;
  }, [pub.data]);
  async function logout() {
    try {
      await call("/api/auth/logout", "POST", {});
    } finally {
      q.clear();
      navigate("/");
      location.reload();
    }
  }
  if (pub.isLoading || me.isLoading)
    return <div className="portal p-loading">正在打开工作台…</div>;
  if (pub.error || (me.error && me.data === undefined))
    return (
      <div className="portal p-loading">
        服务暂时不可用。
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  if (path === "/docs" && !me.data)
    return (
      <div className="portal">
        <header className="p-public-header">
          <Link className="p-brand" to="/">
            <img className="p-logo" src={pub.data.brand.icon_url} alt="" />
            {pub.data.site_name}
          </Link>
          <Link className="p-button" to="/">
            登录工作台
          </Link>
        </header>
        <main className="p-public-docs">
          <Docs />
        </main>
      </div>
    );
  if (!me.data)
    return (
      <div className="portal">
        <Auth
          pub={pub.data}
          onLogin={() => {
            q.invalidateQueries({ queryKey: ["me"] });
            if (path.startsWith("/admin")) navigate("/admin");
            else navigate("/");
          }}
        />
      </div>
    );
  if (path.startsWith("/admin/engine") && me.data.role === "admin")
    return (
      <>
        <div className="p-engine-return">
          <a href="/admin">← 平台管理</a>
          <a href="/">用户前台</a>
        </div>
        <Suspense
          fallback={<div className="portal p-loading">正在加载注册管理台…</div>}
        >
          <Router base="/admin/engine">
            <AdminConsole />
          </Router>
        </Suspense>
      </>
    );
  const menus = [
    { path: "/", name: "控制台", icon: LayoutDashboard, page: "home" },
    {
      path: "/orders",
      name: "我的订单",
      icon: ChartNoAxesCombined,
      page: "orders",
    },
    { path: "/accounts", name: "我的账号", icon: KeyRound, page: "accounts" },
    { path: "/wallet", name: "积分钱包", icon: Wallet, page: "wallet" },
    { path: "/keys", name: "API 管理", icon: Code2, page: "keys" },
    { path: "/docs", name: "API 文档", icon: BookOpen, page: "docs" },
    { path: "/profile", name: "个人设置", icon: Settings, page: "profile" },
    ...(me.data.role === "admin"
      ? [{ path: "/admin", name: "平台管理", icon: ShieldCheck, page: "admin" }]
      : []),
  ];
  const current = menus.find((m) => m.path === path);
  return (
    <div className="portal p-shell">
      <aside className={`p-sidebar ${mobile ? "open" : ""}`}>
        <Link className="p-brand" to="/">
          <img className="p-logo" src={pub.data.brand.icon_url} alt="" />
          {pub.data.site_name}
        </Link>
        <span className="p-sidebar-label">工作空间</span>
        <nav>
          {menus.map((m) => (
            <Link
              key={m.path}
              to={m.path}
              onClick={() => setMobile(false)}
              className={path === m.path ? "active" : ""}
            >
              <m.icon size={18} />
              {m.name}
              {path === m.path && <ChevronRight size={15} />}
            </Link>
          ))}
        </nav>
        <div className="p-sidebar-bottom">
          <div className="p-avatar">
            {me.data.name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <b>{me.data.name}</b>
            <small>{me.data.role === "admin" ? "管理员" : "用户账户"}</small>
          </div>
          <button aria-label="退出登录" onClick={logout}>
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          className="p-overlay"
          aria-label="关闭菜单"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="p-body">
        <header className="p-topbar">
          <button
            className="p-menu-toggle"
            aria-label="打开菜单"
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X size={21} /> : <Menu size={21} />}
          </button>
          <span>{current?.name || "页面不存在"}</span>
          <div>
            <span className="p-muted">可用积分</span>
            <b>{me.data.points.toLocaleString()}</b>
            <Link to="/wallet">充值 / 兑换</Link>
          </div>
        </header>
        <main className="p-main">
          <Suspense fallback={<div className="p-card">加载中…</div>}>
            {!current ? (
              <div className="p-card">
                <h1>页面不存在</h1>
                <Link to="/">返回控制台</Link>
              </div>
            ) : current.page === "docs" ? (
              <Docs />
            ) : current.page === "admin" ? (
              <AdminPlatform />
            ) : (
              <Workspace
                key={me.data.id}
                page={current.page}
                user={me.data}
                pub={pub.data}
                onLogout={logout}
              />
            )}
          </Suspense>
        </main>
        <footer className="p-footer">
          {pub.data.site_name}
          <span>{pub.data.brand.tagline}</span>
          {pub.data.brand.support_url && <a href={pub.data.brand.support_url} target="_blank" rel="noopener noreferrer">联系客服 ↗</a>}
        </footer>
      </div>
    </div>
  );
}
