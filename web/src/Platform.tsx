import { lazy, Suspense, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Users,
  ChartNoAxesCombined,
  Code2,
  KeyRound,
  LayoutDashboard,
  Settings,
  Wallet,
  Sparkles,
} from "lucide-react";
import { Link, Router, useRouter } from "./router";
import Auth from "./portal/Auth";
import Workspace from "./portal/Workspace";
import CustomerAccounts from "./portal/CustomerAccounts";
import Dashboard from "./portal/Dashboard";
import {
  CustomerOrderCenter,
  FundsAccount,
  PersonalSettings,
} from "./portal/CustomerCenter";
import CustomPage from "./portal/CustomPage";
import Docs from "./portal/Docs";
import Shell, { type NavGroup } from "./portal/Shell";
import { call, currentUser } from "./portal/client";
import { loginLocation, loginReturnLocation } from "./auth-navigation";
import "./portal/portal.css";
import "./portal/workspace.css";
import "./portal/center.css";
const PartnerPage=lazy(()=>import("./portal/PartnerPage"));
const AdminConsole = lazy(() => import("./AdminConsole"));
const AdminChrome = lazy(() => import("./portal/AdminChrome"));
const AdminEntry = lazy(() => import("./portal/AdminEntry"));
const customerGroups: NavGroup[] = [
  {
    label: "注册与交付",
    items: [
      { path: "/", name: "工作台概览", icon: LayoutDashboard },
      { path: "/register", name: "注册服务", icon: Sparkles },
      { path: "/orders", name: "订单中心", icon: ChartNoAxesCombined },
      { path: "/accounts", name: "我的账号", icon: KeyRound },
      { path: "/wallet", name: "资金账户", icon: Wallet },
    ],
  },
  {
    label: "工具与账户",
    items: [
      { path: "/keys", name: "开发接入", icon: Code2 },
      { path: "/docs", name: "接口文档", icon: BookOpen },
      {path:"/partners",name:"伙伴计划",icon:Users},
      { path: "/profile", name: "个人设置", icon: Settings },
    ],
  },
];
export default function Platform() {
  const q = useQueryClient(),
    { path, search, navigate } = useRouter();
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
    const expired = () => {
      void q.cancelQueries();
      q.removeQueries({ predicate: query => !['me', 'public'].includes(String(query.queryKey[0])) });
      q.setQueryData(['me'], null);
    };
    window.addEventListener('gptreg:session-expired', expired);
    return () => window.removeEventListener('gptreg:session-expired', expired);
  }, [q]);
  useEffect(() => {
    if (me.isLoading || me.error || me.data === undefined) return;
    if (!me.data && path !== '/login' && path !== '/docs') navigate(loginLocation(path, search), { replace: true });
    else if (me.data && path === '/login') navigate(loginReturnLocation(search, me.data.role), { replace: true });
  }, [me.isLoading, me.error, me.data, path, search, navigate]);
  useEffect(() => {
    if (q.getQueryData(["me"])) void q.invalidateQueries({ queryKey: ["me"] });
  }, [path, q]);
  useEffect(() => {
    if (!pub.data) return;
    document.title = `${pub.data.site_name} · ${path === "/docs" ? "开发者文档" : "用户工作台"}`;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = pub.data.brand.icon_url;
  }, [pub.data, path]);
  async function logout() {
    try {
      await call("/api/auth/logout", "POST", {});
    } finally {
      q.clear();
      navigate("/login", { replace: true });
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
  if (path === "/docs")
    return (
      <div className="portal">
        <Docs pub={pub.data} signedIn={Boolean(me.data)} />
      </div>
    );
  if (!me.data)
    return (
      <div className="portal">
        <Auth
          pub={pub.data}
          onLogin={async () => {
            await q.invalidateQueries({ queryKey: ["me"] });
          }}
        />
      </div>
    );
  if (path.startsWith("/admin/engine") && me.data.role === "admin")
    return (
      <>
        <div className="p-engine-return">
          <a href="/admin">← 运营控制台</a>
          <a href="/">用户工作台</a>
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
  if (
    (path === "/admin" || path.startsWith("/admin/")) &&
    me.data.role === "admin"
  )
    return (
      <Suspense
        fallback={<div className="portal p-loading">正在打开运营控制台…</div>}
      >
        <AdminChrome user={me.data} pub={pub.data} onLogout={logout} />
      </Suspense>
    );
  const visibleGroups = customerGroups.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) => me.data.navigation?.includes(i.path),
    ),
  }));
  const current = visibleGroups
    .flatMap((g) => g.items)
    .find((x) => x.path === path);
  const custom = path.startsWith("/custom/");
  return (
    <Shell
      user={me.data}
      pub={pub.data}
      onLogout={logout}
      groups={visibleGroups}
      title={custom ? "更多服务" : current?.name || "功能暂未开放"}
      actions={
        me.data.role === "admin" ? (
          <Suspense fallback={null}>
            <AdminEntry operations />
          </Suspense>
        ) : null
      }
    >
      {custom ? (
        <CustomPage id={path.slice(8)} />
      ) : !current ? (
        <div className="p-card">
          <h1>此功能暂未开放</h1>
          <Link to="/">返回工作台</Link>
        </div>
      ) : path === "/" ? (
        <Dashboard user={me.data} pub={pub.data} />
      ) : path === "/orders" ? (
        <CustomerOrderCenter user={me.data} pub={pub.data} />
      ) : path === "/accounts" ? (
        <CustomerAccounts key={`${me.data.id}:${search}`} userId={me.data.id} />
      ) : path === "/wallet" ? (
        <FundsAccount user={me.data} pub={pub.data} />
      ) : path === "/partners" ? (<Suspense fallback={<div className="p-loading">正在读取伙伴记录…</div>}><PartnerPage/></Suspense>) : path === "/profile" ? (
        <PersonalSettings user={me.data} pub={pub.data} onLogout={logout} />
      ) : (
        <Workspace
          key={`${me.data.id}:${path}${search}`}
          page={path.slice(1)}
          user={me.data}
          pub={pub.data}
        />
      )}
    </Shell>
  );
}
