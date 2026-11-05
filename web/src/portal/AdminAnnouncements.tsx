import { Plus, ArrowUp, ArrowDown, Trash2, Bell } from "lucide-react";
import { uid, type Row } from "./client";
const localTime = (v: string) =>
  v
    ? new Date(new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
export default function AdminAnnouncements({
  settings: s,
  field,
}: {
  settings: Row;
  field: (key: string, value: any) => void;
}) {
  const rows: Row[] = s.announcements || [];
  const update = (i: number, v: Row) =>
    field(
      "announcements",
      rows.map((r, n) => (i === n ? { ...r, ...v } : r)),
    );
  const move = (i: number, step: number) => {
    const a = [...rows];
    [a[i], a[i + step]] = [a[i + step], a[i]];
    field("announcements", a);
  };
  return (
    <>
      <div className="p-inline-help">
        <Bell size={20} />
        管理多条公告、展示顺序和定时上下线。全部修改在保存后生效，时间使用当前电脑时区。
      </div>
      {s.announcement && (
        <section className="p-card">
          <h2>原有站点公告</h2>
          <label>
            公告内容
            <textarea
              rows={3}
              maxLength={5000}
              value={s.announcement}
              onChange={(e) => field("announcement", e.target.value)}
            />
          </label>
          <p className="p-muted">
            保留现有内容，清空后可完全使用下方公告列表。
          </p>
        </section>
      )}
      {!rows.length && (
        <section className="p-card p-empty">
          <Bell size={30} />
          <h2>把重要消息告诉用户</h2>
          <p>发布服务说明、运营通知或使用指南。</p>
        </section>
      )}
      {rows.map((r, i) => (
        <section className="p-card" key={r.id}>
          <div className="p-section-heading">
            <b>公告 {i + 1}</b>
            <div className="p-inline">
              <button
                type="button"
                className="p-header-icon"
                aria-label={`上移公告 ${i + 1}`}
                disabled={!i}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={16} />
              </button>
              <button
                type="button"
                className="p-header-icon"
                aria-label={`下移公告 ${i + 1}`}
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={16} />
              </button>
              <button
                type="button"
                className="p-header-icon danger"
                aria-label={`删除公告 ${i + 1}`}
                onClick={() =>
                  field(
                    "announcements",
                    rows.filter((_, n) => n !== i),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
          <label>
            标题
            <input
              required
              maxLength={120}
              value={r.title}
              onChange={(e) => update(i, { title: e.target.value })}
            />
          </label>
          <label>
            内容
            <textarea
              rows={5}
              maxLength={5000}
              value={r.body}
              onChange={(e) => update(i, { body: e.target.value })}
            />
          </label>
          <div className="p-form-grid">
            {[
              ["starts_at", "上线时间（留空立即）"],
              ["ends_at", "下线时间（留空长期）"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="datetime-local"
                  value={localTime(r[key])}
                  onChange={(e) =>
                    update(i, {
                      [key]: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : "",
                    })
                  }
                />
              </label>
            ))}
          </div>
          <label className="p-check">
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={(e) => update(i, { enabled: e.target.checked })}
            />
            启用公告
          </label>
          <details className="p-announcement-strip">
            <summary>用户端预览</summary>
            <h3>{r.title || "公告标题"}</h3>
            <p>{r.body || "公告内容"}</p>
          </details>
        </section>
      ))}
      <button
        type="button"
        className="p-button secondary"
        disabled={rows.length >= 50}
        onClick={() =>
          field("announcements", [
            ...rows,
            {
              id: uid(),
              title: "",
              body: "",
              enabled: true,
              starts_at: "",
              ends_at: "",
            },
          ])
        }
      >
        <Plus size={17} />
        新增公告
      </button>
    </>
  );
}
