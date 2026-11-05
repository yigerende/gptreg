import { useQuery } from "@tanstack/react-query";
import { call, download, type Row } from "./client";
export default function Docs() {
  const { data: s, error } = useQuery({
    queryKey: ["openapi"],
    queryFn: () => call("/openapi.json"),
  });
  const base = location.origin;
  return (
    <div className="p-docs">
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">DEVELOPER REFERENCE</span>
          <h1>开放 API 文档</h1>
          <p>从创建订单，到领取结果，使用同一套积分与交付规则。</p>
        </div>
        <button
          className="p-button secondary"
          disabled={!s}
          onClick={() => download("openapi.json", JSON.stringify(s, null, 2))}
        >
          下载 OpenAPI
        </button>
      </div>
      <div className="p-card">
        <h2>快速接入</h2>
        <ol>
          <li>登录用户前台，在「API 管理」创建密钥，勾选所需权限。</li>
          <li>查询商品价格和账户积分，创建订单时提供唯一的幂等键。</li>
          <li>每 5 秒查询一次订单；完成后按订单编号查询已交付账号。</li>
          <li>使用账号 ID 读取凭据，或批量导出 JSON 获取 OAuth 数据。</li>
        </ol>
        <p>
          所有请求使用 <code>Authorization: Bearer YOUR_API_KEY</code>
          。密钥只完整显示一次。
        </p>
        <p>
          默认每用户每分钟 120 次调用，下单每分钟 20 次。返回 429 时等待
          Retry-After 指定秒数后重试。
        </p>
      </div>
      <div className="p-card">
        <h2>下单示例</h2>
        <pre>{`curl '${base}/open/v1/registration-orders' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Idempotency-Key: your-unique-request-001' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"quantity":10,"need_oauth":true}'`}</pre>
        <details>
          <summary>Python 示例</summary>
          <pre>{`import requests, uuid\nbase = '${base}'\nheaders = {'Authorization': 'Bearer YOUR_API_KEY',\n           'Idempotency-Key': str(uuid.uuid4())}\nr = requests.post(base + '/open/v1/registration-orders',\n    headers=headers, json={'quantity': 10, 'need_oauth': True}, timeout=30)\nr.raise_for_status()\norder = r.json()\n# 网络重试务必复用同一个 Idempotency-Key\nprint(requests.get(base + '/open/v1/registration-orders/' + order['id'],\n    headers=headers, timeout=30).json())`}</pre>
        </details>
        <details>
          <summary>Node.js 示例</summary>
          <pre>{`const headers = { Authorization: 'Bearer YOUR_API_KEY',\n  'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() };\nconst response = await fetch('${base}/open/v1/registration-orders', {\n  method: 'POST', headers, body: JSON.stringify({ quantity: 10, need_oauth: true })\n});\nif (!response.ok) throw new Error(await response.text());\nconst order = await response.json();\nconsole.log(order.id); // 保存订单编号，随后轮询查询`}</pre>
        </details>
      </div>
      <div className="p-card">
        <h2>交付与积分</h2>
        <p>
          quantity 表示期望交付数量。need_oauth=false 交付邮箱、密码、2FA；true
          还包含 OAuth 授权数据，两种模式分别定价。
        </p>
        <p>
          下单按当时单价预留积分，成功交付后扣除；失败或取消的未交付部分退回可用积分。授权失败只重试授权，不重复创建账号。重试次数有上限，订单可能部分完成。
        </p>
        <p>
          取消只阻止后续执行，已启动的部分在确认结果后结算。review
          表示需要管理员核实，相关积分继续预留。
        </p>
        <div className="p-table-wrap">
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries({
                queued: "排队等待",
                running: "注册或授权处理中",
                review: "等待人工核实",
                completed: "全部交付",
                partial: "部分交付，其余积分退回",
                failed: "未交付，积分退回",
                cancelled: "已取消，未交付积分退回",
              }).map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {error && <div className="p-alert">文档加载失败，请刷新页面。</div>}
      {s &&
        Object.entries(s.paths as Row).map(([path, methods]) =>
          Object.entries(methods as Row).map(([method, op]) => (
            <div className="p-card" key={method + path}>
              <div className="p-endpoint">
                <b>{method.toUpperCase()}</b>
                <code>{path}</code>
              </div>
              <h3>{op.summary}</h3>
              <p>{op.description}</p>
              {op.parameters?.length > 0 && (
                <div className="p-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>参数</th>
                        <th>位置</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {op.parameters.map((p: Row) => (
                        <tr key={p.name}>
                          <td>
                            {p.name}
                            {p.required ? " *" : ""}
                          </td>
                          <td>{p.in}</td>
                          <td>{p.description || JSON.stringify(p.schema)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {op.requestBody && (
                <details open>
                  <summary>请求 JSON</summary>
                  <pre>
                    {JSON.stringify(
                      op.requestBody.content["application/json"].schema,
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
              <details>
                <summary>响应结构与错误码</summary>
                <pre>{JSON.stringify(op.responses, null, 2)}</pre>
              </details>
            </div>
          )),
        )}
      <div className="p-card">
        <h2>公共响应类型</h2>
        <pre>
          {s ? JSON.stringify(s.components.schemas, null, 2) : "加载中…"}
        </pre>
        <p>
          400 参数错误 · 401 未登录或密钥失效 · 402 积分不足 · 403 权限不足 ·
          404 资源不存在 · 409 幂等冲突 · 429 请求过频 · 503 服务暂停。
        </p>
      </div>
    </div>
  );
}
