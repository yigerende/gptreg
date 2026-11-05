import { useState, type ReactNode } from "react";
import {
  LogOut,
  Menu,
  X,
  Wallet,
  ShieldCheck,
  ChevronRight,
  Globe2,
} from "lucide-react";
import { Link, useRouter } from "../router";
import type { Row } from "./client";

import AnnouncementCenter from "./AnnouncementCenter";
import { useMenus } from "./CustomPage";
export type NavGroup = {
  label: string;
  items: { path: string; name: string; icon: typeof Wallet }[];
};
export default function Shell({
  user,
  pub,
  groups,
  title,
  admin = false,
  actions,
  onLogout,
  children,
}: {
  user: Row;
  pub: Row;
  groups: NavGroup[];
  title: string;
  admin?: boolean;
  actions?: ReactNode;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { path } = useRouter(),
    [mobile, setMobile] = useState(false);
  const available = (feature: string) =>
    user.role === "admin" || pub.features?.[feature] !== false;
  const menus = useMenus().data?.items || [];
  const customPrefix = admin ? "/admin/custom/" : "/custom/";
  return (
    <div
      className={`portal p-workspace-shell ${admin ? "p-operations-shell" : "p-customer-shell"}`}
    >
      <header className="p-workspace-header">
        <Link to="/" className="p-brand">
          <img className="p-logo" src={pub.brand.icon_url} alt="" />
          <span>
            {pub.site_name}
            <small>{pub.brand.english_name}</small>
          </span>
        </Link>
        <div className="p-console-label">
          {admin ? "运营控制台" : "账号服务工作台"}
          <span>{admin ? "ADMIN" : "WORKSPACE"}</span>
        </div>
        <div className="p-header-actions">
          {actions}
          {!admin && <AnnouncementCenter key={user.id} user={user} pub={pub} />}
          {available("wallet") && (
            <Link className="p-wallet-chip" to="/wallet">
              <Wallet size={16} />
              <b>{user.points.toLocaleString()}</b>
              <small>积分</small>
            </Link>
          )}
          <Link to="/profile" className="p-user-chip" aria-label="个人设置">
            {user.name.slice(0, 1).toUpperCase()}
          </Link>
          <button
            className="p-header-icon"
            onClick={onLogout}
            aria-label="退出登录"
          >
            <LogOut size={18} />
          </button>
          <button
            className="p-header-icon p-mobile-menu"
            onClick={() => setMobile(true)}
            aria-label="打开菜单"
          >
            <Menu size={21} />
          </button>
        </div>
      </header>
      {mobile && (
        <button
          className="p-nav-backdrop"
          aria-label="关闭菜单"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`p-workspace-side ${mobile ? "open" : ""}`}>
        <button
          className="p-header-icon p-mobile-close"
          aria-label="收起菜单"
          onClick={() => setMobile(false)}
        >
          <X size={20} />
        </button>
        <div className="p-side-intro">
          <span className="p-eyebrow">
            {admin ? "OPERATIONS" : "MY WORKSPACE"}
          </span>
          <h3>{admin ? "让运营，心中有数。" : "让每次交付，清晰有序。"}</h3>
        </div>
        <nav>
          {groups.map((group) => (
            <section key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMobile(false)}
                  className={path === item.path ? "active" : ""}
                >
                  <item.icon size={18} />
                  <span>{item.name}</span>
                  {path === item.path && <i />}
                </Link>
              ))}
            </section>
          ))}
          {menus.length > 0 && (
            <section>
              <p>更多服务</p>
              {menus.map((m: Row) => {
                const icon = m.icon ? (
                  <img className="p-menu-nav-icon" src={m.icon} alt="" />
                ) : (
                  <Globe2 size={18} />
                );
                return m.open_new_tab ? (
                  <a
                    key={m.id}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {icon}
                    <span>{m.label}</span>↗
                  </a>
                ) : (
                  <Link
                    key={m.id}
                    to={customPrefix + m.id}
                    onClick={() => setMobile(false)}
                    className={path === customPrefix + m.id ? "active" : ""}
                  >
                    {icon}
                    <span>{m.label}</span>
                  </Link>
                );
              })}
            </section>
          )}
          <section className="p-mobile-account-actions">
            <p>账户操作</p>
            {!admin && actions}
            {admin && <a href="/" target="_blank" rel="noopener noreferrer">用户工作台 ↗</a>}
            <Link to="/profile">个人设置</Link>
            <button className="p-link" onClick={onLogout}>
              退出当前账户
            </button>
          </section>
        </nav>
        <div className="p-side-foot">
          <ShieldCheck size={19} />
          <div>
            {admin ? "独立运营与执行空间" : "你的专属账号服务空间"}
            <small>
              {pub.brand.english_name} ·{" "}
              {admin ? "OPERATIONS" : "ACCOUNT SERVICES"}
            </small>
          </div>
        </div>
      </aside>
      <div className="p-workspace-body">
        <main className="p-workspace-main">
          <div className="p-breadcrumb">
            <span>{admin ? "运营中心" : "我的空间"}</span>
            <ChevronRight size={13} />
            <b>{title}</b>
            <small>
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </small>
          </div>
          {children}
        </main>
        <footer className="p-workspace-footer">
          <span>
            {pub.brand.english_name} / {pub.brand.tagline}
          </span>
          <div>
            {available("docs") && <Link to="/docs">接口文档</Link>}
            <Link to="/profile">个人设置</Link>
            {pub.brand.support_url && (
              <a
                href={pub.brand.support_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                联系支持 ↗
              </a>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
