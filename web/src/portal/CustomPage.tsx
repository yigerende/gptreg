import { useQuery } from "@tanstack/react-query";
import { call, type Row } from "./client";
import { Link } from "../router";
export function useMenus() {
  return useQuery({
    queryKey: ["navigation"],
    queryFn: () => call("/api/user/v1/navigation"),
  });
}
export default function CustomPage({
  id,
  admin = false,
}: {
  id: string;
  admin?: boolean;
}) {
  const { data, isLoading, error } = useMenus(),
    item = data?.items?.find((m: Row) => m.id === id);
  if (isLoading) return <div className="p-card">加载页面…</div>;
  if (error) return <div className="p-alert">{error.message}</div>;
  if (!item)
    return (
      <div className="p-card p-empty">
        菜单不存在或没有访问权限。
        <Link to={admin ? "/admin" : "/"}>返回工作台</Link>
      </div>
    );
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">SERVICE PAGE</span>
          <h1>{item.label}</h1>
        </div>
        {!item.hide_open_button && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-button secondary"
          >
            新窗口打开 ↗
          </a>
        )}
      </div>
      <iframe
        className="p-custom-frame"
        title={item.label}
        src={item.url}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      />
    </>
  );
}
