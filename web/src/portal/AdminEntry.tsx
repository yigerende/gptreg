export default function AdminEntry({
  operations = false,
}: {
  operations?: boolean;
}) {
  return (
    <a
      className={
        operations ? "p-mode-switch" : "p-button secondary p-admin-entry"
      }
      href={operations ? "/admin" : "/admin/engine"}
      target="_blank"
      rel="noopener noreferrer"
    >
      {operations ? "运营控制台" : "进入原注册管理台"} ↗
    </a>
  );
}
