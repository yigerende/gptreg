import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  Download,
  Menu,
  Search,
  X,
} from "lucide-react";
import { Link } from "../router";
import { call, copy, download, type Row } from "./client";
import {
  codeSample,
  fieldRules,
  fieldType,
  languages,
  pollingExample,
  requestExamples,
  resolve,
  schemaFields,
  type Language,
  type Operation,
} from "./apiDocs";
import "./docs.css";

const guide = [
  ["start", "快速开始"],
  ["authentication", "鉴权与权限"],
  ["billing", "交付模式与积分"],
  ["inputs", "参数从哪里来"],
  ["workflow", "订单到交付"],
  ["states", "状态与取消"],
  ["pagination", "分页与筛选"],
  ["retries", "幂等与重试"],
];
const reference = [
  ["errors", "错误码与处理"],
  ["schemas", "响应字段字典"],
];
const schemaNames: Row = {
  User: "平台账户",
  Products: "服务与价格",
  Product: "单个服务",
  Order: "订单",
  OrderItem: "订单子项",
  OrderDetail: "订单详情",
  Account: "交付账号",
  OAuth: "OAuth 授权数据",
  StoredCredentials: "导出的凭据",
  Credentials: "凭据与实时验证码",
  ExportResult: "导出响应",
  Error: "错误响应",
  OrderPage: "订单分页",
  AccountPage: "账号分页",
};
function Section({
  id,
  title,
  label,
  children,
}: {
  id: string;
  title: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="d-section" aria-labelledby={`${id}-title`}>
      {label && <span className="d-kicker">{label}</span>}
      <h2 id={`${id}-title`}>
        <a href={`#${id}`}>
          {title}
          <span className="d-anchor">#</span>
        </a>
      </h2>
      {children}
    </section>
  );
}
function Code({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState("");
  useEffect(() => {
    setState("");
  }, [text]);
  return (
    <div className="d-code">
      <div className="d-code-head">
        <span>{label}</span>
        <button
          type="button"
          aria-label={`复制${label}`}
          onClick={async () => {
            try {
              await copy(text);
              setState("已复制");
            } catch {
              setState("复制失败，请手动选择");
            }
          }}
        >
          {state === "已复制" ? <Check size={14} /> : <Copy size={14} />}
          <span role="status">{state || "复制"}</span>
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
function Fields({ fields, input = false }: { fields: Row[]; input?: boolean }) {
  if (!fields.length) return null;
  return (
    <div className="d-table">
      <table>
        <thead>
          <tr>
            <th>字段 / 类型</th>
            <th>{input ? "要求" : "返回"}</th>
            <th>说明与约束</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={`${f.in || ""}:${f.name}`}>
              <td>
                <code>{f.name}</code>
                <small>
                  {f.in && `${f.in} · `}
                  {fieldType(f)}
                </small>
              </td>
              <td>
                <span className={f.required ? "d-required" : "d-optional"}>
                  {f.required
                    ? f.nested
                      ? "父项存在时必有"
                      : input
                        ? "必填"
                        : "必有"
                    : "可选"}
                </span>
              </td>
              <td>
                {f.description || "—"}
                {fieldRules(f) && <small>{fieldRules(f)}</small>}
                {f["x-source-operation"] && (
                  <a href={`#${f["x-source-operation"]}`}>查看字段来源 →</a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Endpoint({
  spec,
  operation: x,
  lang,
  setLang,
}: {
  spec: Row;
  operation: Operation;
  lang: Language;
  setLang: (v: Language) => void;
}) {
  const examples = requestExamples(x);
  const [example, setExample] = useState(Object.keys(examples)[0] || "");
  const [status, setStatus] = useState(x.id === "create_order" ? "202" : "200");
  const response = resolve(spec, x.op.responses[status]);
  const media = response.content?.["application/json"] || {};
  const responseExample =
    media.examples?.[example]?.value ??
    media.example ??
    Object.values(media.examples || {}).map((e: any) => e.value)[0];
  const parameters = (x.op.parameters || []).map((p: Row) => ({
    ...resolve(spec, p.schema),
    ...p,
  }));
  return (
    <Section id={x.id} title={x.op.summary} label={x.op.tags?.[0]}>
      <div className="d-endpoint">
        <b className={`d-method ${x.method}`}>{x.method.toUpperCase()}</b>
        <code>{x.path}</code>
      </div>
      <p>{x.op.description}</p>
      <div className="d-scope">
        Bearer API Key <span>·</span>{" "}
        {x.op["x-scope"] ? (
          <>
            所需权限 <code>{x.op["x-scope"]}</code>
          </>
        ) : (
          "任意有效密钥，无额外权限要求"
        )}
      </div>
      {parameters.length > 0 && (
        <>
          <h3>请求参数</h3>
          <Fields fields={parameters} input />
        </>
      )}
      {x.op.requestBody && (
        <>
          <h3>
            请求正文 <small>application/json</small>
          </h3>
          <Fields
            fields={schemaFields(
              spec,
              x.op.requestBody.content["application/json"].schema,
            )}
            input
          />
        </>
      )}
      <div className="d-example-toolbar">
        <h3>请求示例</h3>
        <label>
          场景
          <select
            aria-label={`${x.op.summary}请求场景`}
            value={example}
            onChange={(e) => setExample(e.target.value)}
            disabled={!Object.keys(examples).length}
          >
            {Object.keys(examples).length ? (
              Object.entries(examples).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.summary}
                </option>
              ))
            ) : (
              <option value="">默认请求</option>
            )}
          </select>
        </label>
      </div>
      <div
        className="d-tabs"
        role="group"
        aria-label={`${x.op.summary}示例语言`}
      >
        {Object.entries(languages).map(([k, v]) => (
          <button
            key={k}
            aria-pressed={lang === k}
            onClick={() => setLang(k as Language)}
          >
            {v}
          </button>
        ))}
      </div>
      <Code
        text={codeSample(x, location.origin, lang, example)}
        label={`${x.op.summary} · ${languages[lang]}`}
      />
      <div className="d-example-toolbar">
        <h3>响应示例</h3>
        <label>
          HTTP 状态
          <select
            aria-label={`${x.op.summary}响应状态`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {Object.keys(x.op.responses).map((c) => (
              <option key={c} value={c}>
                {c}
                {c === "202"
                  ? " · 新订单受理"
                  : c === "200"
                    ? x.id === "create_order"
                      ? " · 幂等重试"
                      : " · 成功"
                    : " · 错误"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="d-muted">{response.description}</p>
      <Code
        text={JSON.stringify(responseExample, null, 2) || "{}"}
        label={`${x.op.summary} · HTTP ${status}`}
      />
      <details className="d-details">
        <summary>查看响应字段说明</summary>
        <Fields fields={schemaFields(spec, media.schema)} />
        {response.headers && (
          <Fields
            input
            fields={Object.entries(response.headers).map(([name, h]) => ({
              ...(h as Row),
              ...resolve(spec, (h as Row).schema),
              name,
              in: "header",
            }))}
          />
        )}
      </details>
    </Section>
  );
}
export default function Docs({
  pub,
  signedIn = false,
}: {
  pub: Row;
  signedIn?: boolean;
}) {
  const {
    data: spec,
    error,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["openapi"],
    queryFn: () => call("/openapi.json"),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [lang, setLang] = useState<Language>("curl"),
    [search, setSearch] = useState(""),
    [mobile, setMobile] = useState(false),
    [active, setActive] = useState(location.hash.slice(1) || "start");
  const operations: Operation[] = Object.entries(spec?.paths || {}).flatMap(
    ([path, methods]) =>
      Object.entries(methods as Row)
        .filter(([method]) =>
          ["get", "post", "put", "patch", "delete"].includes(method),
        )
        .map(([method, op]) => ({ path, method, id: op.operationId, op })),
  );
  const nav = [
    { title: "接入指南", items: guide.map(([id, title]) => ({ id, title })) },
    ...(spec?.tags || []).map((t: Row) => ({
      title: t.name,
      items: operations
        .filter((x) => x.op.tags?.includes(t.name))
        .map((x) => ({
          id: x.id,
          title: x.op.summary,
          method: x.method,
          path: x.path,
        })),
    })),
    {
      title: "参考资料",
      items: reference.map(([id, title]) => ({ id, title })),
    },
  ];
  const matched = nav.map((group) => ({
    ...group,
    items: group.items.filter((i: Row) =>
      `${i.title} ${i.path || ""} ${i.method || ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ),
  }));
  useEffect(() => {
    const scroll = () => {
      const id = location.hash.slice(1) || "start";
      setActive(id);
      if (location.hash)
        document.getElementById(id)?.scrollIntoView?.({ block: "start" });
    };
    const timer = setTimeout(scroll, 0);
    window.addEventListener("hashchange", scroll);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", scroll);
    };
  }, [spec]);
  useEffect(() => {
    if (!spec || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-90px 0px -65% 0px", threshold: 0 },
    );
    document.querySelectorAll(".d-section").forEach((e) => observer.observe(e));
    return () => observer.disconnect();
  }, [spec]);
  return (
    <div className="d-root">
      <a href="#docs-main" className="d-skip">
        跳到文档正文
      </a>
      <header className="d-header">
        <Link to="/" className="d-brand">
          <img src={pub.brand.icon_url} alt="" />
          <strong>{pub.site_name}</strong>
        </Link>
        <span className="d-header-divider" />
        <span className="d-header-label">开发者文档</span>
        <div className="d-header-actions">
          <Link to={signedIn ? "/keys" : "/"} className="d-key-link">
            {signedIn ? "管理 API Key" : "获取 API Key"}
            <ArrowUpRight size={15} />
          </Link>
          <Link to="/" className="d-back">
            <ArrowLeft size={15} />
            {signedIn ? "返回工作台" : "登录工作台"}
          </Link>
          <button
            className="d-menu"
            aria-label={mobile ? "关闭目录" : "打开目录"}
            aria-expanded={mobile}
            aria-controls="docs-nav"
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {mobile && (
        <button
          className="d-backdrop"
          aria-label="收起目录"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`d-sidebar ${mobile ? "is-open" : ""}`} id="docs-nav">
        <div className="d-sidebar-title">
          <BookOpen size={19} /> API REFERENCE <span>v1</span>
        </div>
        <div className="d-search">
          <Search size={16} />
          <input
            aria-label="搜索文档目录"
            placeholder="搜索接口、路径或指南"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button aria-label="清空搜索" onClick={() => setSearch("")}>
              <X size={14} />
            </button>
          )}
        </div>
        <nav aria-label="API 文档目录">
          {matched.map(
            (g) =>
              g.items.length > 0 && (
                <div className="d-nav-group" key={g.title}>
                  <h2>{g.title}</h2>
                  {g.items.map((i: Row) => (
                    <a
                      key={i.id}
                      href={`#${i.id}`}
                      aria-current={active === i.id ? "location" : undefined}
                      onClick={() => {
                        setActive(i.id);
                        setMobile(false);
                      }}
                    >
                      {i.method && (
                        <span className={`d-nav-method ${i.method}`}>
                          {i.method.toUpperCase()}
                        </span>
                      )}
                      {i.title}
                    </a>
                  ))}
                </div>
              ),
          )}
          {matched.every((g) => !g.items.length) && (
            <p className="d-muted">没有匹配的目录，请换个关键词。</p>
          )}
        </nav>
        <button
          className="d-download"
          disabled={!spec}
          onClick={() =>
            download("gptreg-openapi.json", JSON.stringify(spec, null, 2))
          }
        >
          <Download size={16} />
          下载 OpenAPI 3.1
        </button>
      </aside>
      <main className="d-main" id="docs-main">
        <div className="d-hero">
          <span className="d-kicker">
            BUILD WITH {pub.brand.english_name || "GPTREG"}
          </span>
          <h1>
            <span>从一次请求，</span>
            <span>到账号交付。</span>
          </h1>
          <p>
            将实时注册接入你的业务。选择数量与 OAuth 模式，
            <br className="d-desktop-break" />
            通过 API 查询进度、管理订单并领取结果。
          </p>
          <div className="d-hero-badges">
            <span>实时注册</span>
            <span>Google Gmail 邮箱</span>
            <span>动态高权重家宽注册</span>
            <span title="注册任务独立绑定代理出口">1号1IP</span>
            <span title="每个账号独立维护设备标识与会话">1号1指纹</span>
          </div>
          <div className="d-base">
            <span>BASE URL</span>
            <code>{location.origin}/open/v1</code>
          </div>
        </div>
        {isLoading && (
          <div className="d-section" role="status">
            正在加载接口文档…
          </div>
        )}
        {error && (
          <div className="d-section" role="alert">
            <h2>文档暂不可用</h2>
            <p>{error.message}</p>
            <button
              className="p-button secondary"
              onClick={() => void refetch()}
            >
              重新加载
            </button>
          </div>
        )}
        {spec && (
          <>
            <Section id="start" title="快速开始" label="01 / GET STARTED">
              <p>
                使用工作台中的同一账户、积分与交付记录。所有示例均为虚构数据；复制后请替换密钥、请求标识和记录编号。
              </p>
              <div className="d-steps">
                {[
                  [
                    "01",
                    "创建密钥",
                    "进入开发接入，选择所需权限并保存 API Key。",
                    "authentication",
                  ],
                  [
                    "02",
                    "选择服务",
                    "查询当前单价、数量上限和你的可用积分。",
                    "get_products",
                  ],
                  [
                    "03",
                    "提交订单",
                    "先保存幂等键，再提交数量与 OAuth 选项。",
                    "create_order",
                  ],
                  [
                    "04",
                    "领取结果",
                    "按订单查询已交付账号，读取或导出凭据。",
                    "list_accounts",
                  ],
                ].map(([n, t, d, a]) => (
                  <a href={`#${a}`} key={n}>
                    <span>{n}</span>
                    <strong>{t}</strong>
                    <p>{d}</p>
                    <ArrowUpRight size={16} />
                  </a>
                ))}
              </div>
              <div className="d-note">
                <strong>示例运行环境</strong>
                <p>
                  cURL 示例适用于 Bash（Windows 可用 WSL / Git Bash）；Python
                  需安装 requests；Node.js 使用 20 或更新版本。提前设置环境变量{" "}
                  <code>GPTREG_API_KEY</code>
                  。请求来自你的服务端，接口不提供跨域浏览器调用。
                </p>
              </div>
              <p>
                完整操作顺序见<a href="#workflow">订单到交付</a>
                ，每个接口均提供三种语言示例。这里只展示调用代码，不会直接提交订单。
              </p>
            </Section>
            <Section id="authentication" title="鉴权与权限">
              <p>
                在<Link to={signedIn ? "/keys" : "/"}>工作台 → 开发接入</Link>
                创建密钥，完整密钥只显示一次。将它放在请求头中，不要放进
                URL、公开前端代码或日志。
              </p>
              <Code
                label="鉴权请求头"
                text="Authorization: Bearer YOUR_API_KEY"
              />
              <p>
                <code>/open/v1</code> 只接受 API Key，网页登录 Cookie
                不能用于开放接口。密钥撤销或账户停用后返回 401；缺少对应权限返回
                403。
              </p>
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>权限</th>
                      <th>用途</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(spec["x-scopes"]).map(([k, v]) => (
                      <tr key={k}>
                        <td>
                          <code>{k}</code>
                        </td>
                        <td>{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="d-muted">
                账户与价格查询不要求额外权限。所有密钥只能访问所属用户的数据；多个密钥共享用户级调用限额。
              </p>
            </Section>
            <Section id="billing" title="交付模式与积分">
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>模式</th>
                      <th>need_oauth</th>
                      <th>完整交付内容</th>
                      <th>初始默认单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>标准账号</td>
                      <td>
                        <code>false</code>
                      </td>
                      <td>邮箱、密码、2FA 密钥</td>
                      <td>50 积分 / 个</td>
                    </tr>
                    <tr>
                      <td>OAuth 账号</td>
                      <td>
                        <code>true</code>
                      </td>
                      <td>标准内容 + 完整 OAuth 授权数据</td>
                      <td>100 积分 / 个</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                价格可调整，提交前请查询 <a href="#get_products">products</a>
                。OAuth
                单价是完整价格，无需再加标准价；订单以创建时锁定的单价结算。
              </p>
              <div className="d-note">
                <strong>预留 → 交付扣费 → 释放未交付积分</strong>
                <p>
                  下单预留 <code>quantity × unit_price</code>
                  。成功完整交付才扣费，失败或取消的未交付部分退回。
                  <code>points</code> 已是可用余额，
                  <strong>不要再减 frozen</strong>
                  。恢复中的部分继续预留，超时或恢复次数耗尽后自动退款。
                </p>
              </div>
              <p>
                标准模式完成注册及密码、2FA 配置后交付。含 OAuth
                模式会在同一个任务中继续授权；若账号已注册但授权未完成，只对原账号补授权，次数有上限，不重复注册。没有完整授权的
                OAuth 账号不会按标准账号交付或收费。
              </p>
              <p>
                邮箱渠道、代理和短信资源由平台自动管理，调用方只提交数量与是否需要
                OAuth。网页提交结果不明时会保留原请求，刷新后可继续确认；API
                调用方也必须保存并复用原幂等键。
              </p>
              <p>
                网页与 API 订单共用注册队列，同时受全平台和单用户并发上限约束。
                单用户的多笔订单及 OAuth
                任务合并计算，超出名额的账号自动排队，任务结束后补位。
                并发上限由运营配置；请求已受理不代表所有账号立即同时开始。
              </p>
            </Section>
            <Section id="inputs" title="参数从哪里来">
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>参数</th>
                      <th>获取位置</th>
                      <th>如何使用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec["x-input-sources"].map((f: Row) => (
                      <tr key={f.field}>
                        <td>
                          <code>{f.field}</code>
                        </td>
                        <td>
                          {f.operation ? (
                            <a href={`#${f.operation}`}>{f.source}</a>
                          ) : (
                            f.source
                          )}
                        </td>
                        <td>{f.usage}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="d-muted">
                订单 ID、订单子项 ID、交付账号 ID 和 asset_id
                各有用途。读取凭据和批量导出只使用账号列表返回的{" "}
                <code>items[].id</code>，无需提供 product_id。
              </p>
            </Section>
            <Section id="workflow" title="订单到交付">
              <div className="p-alert">
                <strong>账号资料领取期为交付后 72 小时。</strong>{" "}
                请根据账号列表或凭据中的 <code>download_expires_at</code>{" "}
                提前下载。到期后网页及 API
                列表不再显示该账号，读取凭据和导出均返回
                404；历史订单保留，运营后台保留售后记录。同一订单的账号按各自交付时间分别计时。
              </div>
              <ol className="d-flow">
                <li>
                  <a href="#get_me">查询可用积分</a>与
                  <a href="#get_products">服务价格</a>
                  ，确认接单开放、数量符合上限。
                </li>
                <li>
                  生成并保存唯一幂等键，<a href="#create_order">创建订单</a>
                  。保存返回的 <code>id</code>；202 代表受理，不代表账号已交付。
                </li>
                <li>
                  每 5 秒<a href="#get_order">查询该订单</a>
                  。进入结束状态后停止轮询；review 时继续查询原订单，系统自动恢复或退款。
                </li>
                <li>
                  以 <code>order_id</code>{" "}
                  <a href="#list_accounts">查询交付账号</a>
                  。部分完成也可以领取成功的部分。
                </li>
                <li>
                  使用账号 <code>id</code>{" "}
                  <a href="#get_credentials">读取凭据</a>，或每批不超过 1000 个
                  ID <a href="#export_accounts">导出</a>。完整资料选 JSON，导入
                  CPA 选 cpa，导入 sub2api 选 sub。
                </li>
              </ol>
              <details className="d-details">
                <summary>查看 Python 查询进度与分页领取示例</summary>
                <p>
                  将已有订单 ID 填入示例。20
                  分钟只是这段示例的查询时限，不是服务完成时间或订单过期时间。查询停止不会取消订单。
                </p>
                <Code
                  label="Python · 查询订单与领取账号"
                  text={pollingExample(location.origin)}
                />
              </details>
            </Section>
            <Section id="states" title="状态与取消">
              <p>
                HTTP
                状态表示请求结果，订单状态表示交付进度。标准账号注册完成即可交付；OAuth
                订单须完成授权后才计入 delivered。
              </p>
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>订单 status</th>
                      <th>含义</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(spec["x-order-states"]).map(([k, v]) => (
                      <tr key={k}>
                        <td>
                          <code>{k}</code>
                        </td>
                        <td>{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                <a href="#cancel_order">取消订单</a>
                会阻止未执行部分继续处理，运行中部分须确认结果后结算。
                <code>cancel_requested=true</code>{" "}
                不代表全部子项立刻结束。请持续查看订单及 items，直到结算完成。
              </p>
              <details className="d-details">
                <summary>订单子项 items[].status</summary>
                <div className="d-table">
                  <table>
                    <thead>
                      <tr>
                        <th>子项状态</th>
                        <th>含义</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(spec["x-item-states"]).map(([k, v]) => (
                        <tr key={k}>
                          <td>
                            <code>{k}</code>
                          </td>
                          <td>{String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </Section>
            <Section id="pagination" title="分页与筛选">
              <p>
                订单和账号列表统一返回{" "}
                <code>items / total / limit / offset</code>，按创建时间和 ID
                倒序。默认 limit=50、offset=0；limit 为 1～100，offset 为
                0～1,000,000。下一页令 offset 加上 limit，达到 total
                或返回空页时停止。
              </p>
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>列表</th>
                      <th>可组合筛选</th>
                      <th>q 搜索内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <a href="#list_orders">订单</a>
                      </td>
                      <td>status、mode、q</td>
                      <td>订单编号、平台登录邮箱</td>
                    </tr>
                    <tr>
                      <td>
                        <a href="#list_accounts">交付账号</a>
                      </td>
                      <td>order_id、mode、q</td>
                      <td>交付邮箱、所属订单编号</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                mode 支持 <code>standard</code> / <code>oauth</code>
                ，空值表示全部；q 最长 200 字符，忽略首尾空白，大小写不敏感，%
                和 _ 按字面搜索。请正常进行 URL 编码。
              </p>
              <p className="d-muted">
                total
                为筛选后的总数。新增数据可能让偏移分页出现重复记录，客户端可按
                id 去重；领取单笔订单时，建议结束后固定 order_id 分页查询。
              </p>
            </Section>
            <Section id="retries" title="幂等与重试">
              <p>
                创建订单前生成一次 UUID
                等唯一标识，将其与请求内容一起保存，再通过{" "}
                <code>Idempotency-Key</code> 请求头提交。长度
                8～128，使用不含空格的可见 ASCII 字符。
              </p>
              <ul>
                <li>
                  超时或断线不等于创建失败。使用
                  <strong>原键、原 quantity 和 need_oauth</strong>
                  重试；已有订单返回 200，新订单返回 202。
                </li>
                <li>
                  同用户同键更换数量或模式会返回
                  409。只有确定创建另一笔订单时才生成新键；示例占位符必须替换。
                </li>
                <li>
                  访问频率由平台按业务类型、客户及 API 密钥配置；网页与 API
                  共用客户额度。查询进度建议间隔 5 秒。
                </li>
                <li>
                  429 若带 Retry-After，按指定秒数等待；没有时至少等待 60
                  秒。达到未完成订单上限时，需等待旧订单结算；review
                  继续查询原订单，系统自动恢复或退款。
                </li>
                <li>
                  500 / 503 和网络错误可退避重试。下单始终复用原键；401 / 403 /
                  409 应先修正原因，不要无限重试。
                </li>
              </ul>
              <div className="d-note">
                <strong>服务开关与限额</strong>
                <p>
                  API、下单、账号和导出功能受站点配置控制。开放接口整体暂停返回
                  503，某项功能未开放返回 403，新订单暂停返回
                  503。即使价格查询显示可以下单，最终仍以提交结果为准。
                </p>
              </div>
            </Section>
            <div className="d-api-divider">
              <span>02 / API REFERENCE</span>
              <h2>接口参考</h2>
              <p>9 个开放接口 · Bearer 鉴权 · JSON 请求与响应</p>
            </div>
            {operations.map((x) => (
              <Endpoint
                key={x.id}
                spec={spec}
                operation={x}
                lang={lang}
                setLang={setLang}
              />
            ))}
            <Section id="errors" title="错误码与处理" label="03 / REFERENCE">
              <p>
                错误响应为 <code>{'{"error":"原因说明","status":400}'}</code>
                。按 HTTP 状态判断处理策略，error
                适合展示，文案可能调整。请求正文上限为 1 MiB。
              </p>
              <div className="d-table">
                <table>
                  <thead>
                    <tr>
                      <th>HTTP</th>
                      <th>原因</th>
                      <th>建议处理</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec["x-errors"].map((e: Row) => (
                      <tr key={e.status}>
                        <td>
                          <code>{e.status}</code>
                        </td>
                        <td>{e.message}</td>
                        <td>{e.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section id="schemas" title="响应字段字典">
              <p>
                展开查看嵌套字段。“父项存在时必有”表示父对象存在时该字段必有；例如标准账号不含
                oauth。JSON 导出使用 StoredCredentials，不含实时验证码。
              </p>
              {Object.entries(spec.components.schemas).map(([name, schema]) => (
                <details className="d-details" key={name}>
                  <summary>
                    <code>{name}</code>
                    <span>{schemaNames[name]}</span>
                  </summary>
                  <Fields fields={schemaFields(spec, schema as Row)} />
                </details>
              ))}
            </Section>
            <footer className="d-footer">
              <span>
                {pub.site_name} · OpenAPI {spec.openapi}
              </span>
              <a href="#start">回到开始 ↑</a>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
