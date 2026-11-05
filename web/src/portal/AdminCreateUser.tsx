import { useState } from "react";
import { Modal, Feedback, useAction } from "./Workspace";
import { call } from "./client";
export default function AdminCreateUser({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    a = useAction();
  return (
    <Modal title="创建客户账户" onClose={onClose}>
      <Feedback a={a} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a
            .run(
              () =>
                call("/api/admin/v1/users", "POST", { email, name, password }),
              "账户已创建",
            )
            .then((r) => r && onClose());
        }}
      >
        <p className="p-muted">
          创建普通用户账户，初始积分为 0。创建后可通过调整积分或兑换码充值。
        </p>
        <label>
          邮箱
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          用户名
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          初始密码
          <input
            required
            type="password"
            minLength={10}
            maxLength={72}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="p-button" disabled={a.busy}>
          {a.busy ? "创建中…" : "创建账户"}
        </button>
      </form>
    </Modal>
  );
}
