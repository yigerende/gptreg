import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Modal } from "./Workspace";
import type { Row } from "./client";
export default function AnnouncementCenter({
  user,
  pub,
}: {
  user: Row;
  pub: Row;
}) {
  const q = useQueryClient(),
    key = `gptreg-notices:${user.id}`;
  const [open, setOpen] = useState(false),
    [unreadOnly, setUnreadOnly] = useState(false);
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(key) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  });
  const items: Row[] = [
    ...(pub.announcement
      ? [{ id: "legacy", title: "站点公告", body: pub.announcement }]
      : []),
    ...(pub.announcements || []),
  ];
  const version = (r: Row) => JSON.stringify([r.title, r.body]);
  const unread = (r: Row) => seen[r.id] !== version(r),
    count = items.filter(unread).length;
  function save(value: Record<string, string>) {
    setSeen(value);
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  return (
    <>
      <button
        className="p-announcement-trigger"
        aria-label={`通知公告，${count} 条未读`}
        onClick={() => {
          setOpen(true);
          void q.invalidateQueries({ queryKey: ["public"] });
        }}
      >
        <Bell size={17} />
        <span>公告</span>
        {count > 0 && <b>{count > 99 ? "99+" : count}</b>}
      </button>
      {open && (
        <Modal title="通知公告" onClose={() => setOpen(false)}>
          <div className="p-section-heading">
            <div className="p-segment">
              <button
                className={!unreadOnly ? "selected" : ""}
                onClick={() => setUnreadOnly(false)}
              >
                全部公告
              </button>
              <button
                className={unreadOnly ? "selected" : ""}
                onClick={() => setUnreadOnly(true)}
              >
                未读 {count}
              </button>
            </div>
            <button
              className="p-link"
              disabled={!count}
              onClick={() =>
                save(Object.fromEntries(items.map((r) => [r.id, version(r)])))
              }
            >
              <CheckCheck size={16} />
              全部已读
            </button>
          </div>
          {!items.length && (
            <div className="p-empty">暂无公告，服务动态将在这里展示。</div>
          )}
          {items
            .filter((r) => !unreadOnly || unread(r))
            .map((r) => (
              <article className="p-notice-card" key={r.id}>
                <div className="p-section-heading">
                  <h3>{r.title}</h3>
                  {unread(r) && <span className="p-status active">未读</span>}
                </div>
                <p>{r.body}</p>
                {unread(r) && (
                  <button
                    className="p-link"
                    onClick={() => save({ ...seen, [r.id]: version(r) })}
                  >
                    标为已读
                  </button>
                )}
              </article>
            ))}
          {unreadOnly && !count && items.length > 0 && (
            <div className="p-empty">全部公告已读。</div>
          )}
        </Modal>
      )}
    </>
  );
}
