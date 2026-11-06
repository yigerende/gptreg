import { lazy, Suspense } from "react";
import {
  Activity,
  ChartNoAxesCombined,
  Users,
  Ticket,
  Settings,
  LayoutDashboard,
  Package,
  Bell,
  ScrollText,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { Link, useRouter } from "../router";
import Shell, { type NavGroup } from "./Shell";
import AdminPlatform from "./AdminPlatform";
import CustomPage from "./CustomPage";
import AdminEntry from "./AdminEntry";
import type { Row } from "./client";
const AdminRisk = lazy(() => import("./AdminRisk"));
const AdminSuppliers = lazy(() => import("./AdminSuppliers"));
const groups: NavGroup[] = [
  {
    label: "运营洞察",
    items: [
      { path: "/admin", name: "运营概览", icon: LayoutDashboard },
      { path: "/admin/orders", name: "订单监控", icon: Activity },
      { path: "/admin/risk", name: "风控监控", icon: ShieldCheck },
      { path: "/admin/finance", name: "财务报表", icon: ChartNoAxesCombined },
      { path: "/admin/suppliers", name: "供应商统计", icon: ChartNoAxesCombined },
    ],
  },
  {
    label: "客户与服务",
    items: [
      { path: "/admin/users", name: "账户管理", icon: Users },
      { path: "/admin/accounts", name: "账号交付", icon: KeyRound },
      { path: "/admin/codes", name: "积分兑换码", icon: Ticket },
      { path: "/admin/products", name: "服务与定价", icon: Package },
    ],
  },
  {
    label: "站点与配置",
    items: [
      { path: "/admin/announcements", name: "站点公告", icon: Bell },
      { path: "/admin/audit", name: "操作审计", icon: ScrollText },
      { path: "/admin/settings", name: "站点设置", icon: Settings },
    ],
  },
];
export default function AdminChrome({
  user,
  pub,
  onLogout,
}: {
  user: Row;
  pub: Row;
  onLogout: () => void;
}) {
  const { path, search } = useRouter();
  const current = groups.flatMap((g) => g.items).find((x) => x.path === path);
  return (
    <Shell
      user={user}
      pub={pub}
      onLogout={onLogout}
      admin
      groups={groups}
      title={current?.name || "页面不存在"}
      actions={
        <>
          <a
            className="p-mode-switch"
            href="/"
            target="_blank"
            rel="noopener noreferrer"
          >
            用户工作台 ↗
          </a>
          <AdminEntry />
        </>
      }
    >
      {path.startsWith("/admin/custom/") ? (
        <CustomPage id={path.slice(14)} admin />
      ) : path === "/admin/risk" ? (
        <Suspense fallback={<div className="p-loading">正在打开风控监控…</div>}>
          <AdminRisk />
        </Suspense>
      ) : path === "/admin/suppliers" ? (
        <Suspense fallback={<div className="p-loading">正在打开供应商统计…</div>}><AdminSuppliers /></Suspense>
      ) : current ? (
        <AdminPlatform
          key={path + search}
          tab={path === "/admin" ? "overview" : path.split("/")[2]}
        />
      ) : (
        <div className="p-card p-empty">
          页面不存在，<Link to="/admin">返回运营概览</Link>
        </div>
      )}
    </Shell>
  );
}
