"use strict";
// The public contract also drives the documentation UI. Examples are fictional.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
const num = (description, extra = {}) => ({
  type: "integer",
  description,
  minimum: 0,
  ...extra,
});
const bool = (description) => ({ type: "boolean", description });
const stamp = (description) => str(description, { format: "date-time" });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({
  type: "object",
  properties,
  required,
  ...extra,
});
const orderStates = {
  queued: "排队等待执行",
  running: "注册或 OAuth 授权处理中",
  review: "兼容旧状态：系统自动恢复，超过时限或次数后自动退款",
  completed: "全部交付完成",
  partial: "部分交付完成，其余已退回积分",
  failed: "没有交付，积分已退回",
  cancelled: "已取消，未交付部分积分已退回",
};
const itemStates = {
  queued: "等待执行",
  running: "注册或授权执行中",
  oauth_pending: "注册完成，等待授权或重试授权",
  review: "自动恢复中",
  delivered: "已交付并扣费",
  failed: "未交付，已退回积分",
  cancelled: "已取消，已退回积分",
};
const errors = {
  400: [
    "参数格式或业务条件不正确",
    "核对类型、数量上限、筛选值和必填参数，修正后提交。",
  ],
  401: [
    "API Key 无效或账户不可用",
    "检查 Bearer 密钥、撤销状态及账户是否停用。网页登录会话不能代替 API Key。",
  ],
  402: [
    "可用积分不足",
    "查询账户 points 并充值；points 已是可用余额，不要再减 frozen。",
  ],
  403: [
    "权限不足或功能未开放",
    "检查密钥权限及站点功能开关，必要时联系管理员。",
  ],
  404: [
    "记录不存在、不属于当前账户或账号资料已到期",
    "核对订单或账号 ID；账号交付满 72 小时后不可再读取或导出，请提前保存。",
  ],
  409: [
    "幂等键与请求内容冲突",
    "相同操作重试须复用相同键和内容；确认要创建新订单时使用新键。",
  ],
  413: ["请求体过大", "总请求体不能超过 1 MiB；账号导出每次最多 1000 个 ID。"],
  429: [
    "请求过频或未完成订单达到上限",
    "有 Retry-After 时按该秒数等待；否则至少等待 60 秒。订单上限需等待已有订单结算，review 继续查询原订单，系统自动恢复或退款。",
  ],
  500: [
    "服务暂时不可用",
    "查询可退避重试；创建订单需复用原幂等键和原内容，避免重复预留积分。",
  ],
  503: [
    "服务或新订单暂停受理",
    "稍后重试；创建订单保留原幂等键。以响应说明判断暂停范围。",
  ],
};
const time = "2026-11-05T04:00:00.000Z";
const orderId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const exampleOrder = {
  id: orderId,
  quantity: 1,
  need_oauth: true,
  registration_region: "random",
  unit_price: 100,
  status: "queued",
  delivered: 0,
  charged: 0,
  released: 0,
  cancel_requested: false,
  source: "api",
  created_at: time,
  updated_at: time,
};
const completeOrder = {
  ...exampleOrder,
  status: "completed",
  delivered: 1,
  charged: 100,
};
const exampleItem = {
  id: itemId,
  position: 1,
  status: "delivered",
  attempts: 1,
  oauth_attempts: 1,
  message: "已交付",
  updated_at: time,
};
const exampleCredentials = {
  asset_id: "engine-asset-example",
  email: "demo.account@gmail.com",
  password: "EXAMPLE_PASSWORD",
  totp_secret: "EXAMPLE_BASE32_SECRET",
  oauth: {
    access_token: "EXAMPLE_ACCESS_TOKEN",
    refresh_token: "EXAMPLE_REFRESH_TOKEN",
  },
};
const account = {
  id: accountId,
  order_id: orderId,
  email: exampleCredentials.email,
  need_oauth: true,
  created_at: time,
  download_expires_at: "2026-11-08T04:00:00.000Z",
};
const schemas = {
  RegistrationRegions: obj({
    default_region: str("省略下单地区参数时使用随机地区", { const: "random" }),
    regions: { type: "array", description: "当前已配置且非空的国家池；只返回代码和名称，不包含代理资料", items: ref("RegistrationRegion") },
  }),
  RegistrationRegion: obj({
    code: str("注册地区代码；GLOBAL 表示供应商分配出口地区的全球池", { pattern: "^(GLOBAL|[A-Z]{2})$" }),
    name: str("地区显示名称"),
  }),
  User: obj({
    id: str("当前平台用户 ID"),
    email: str("平台登录账号；与交付账号邮箱不同"),
    name: str("平台用户名"),
    role: str("账户角色", { enum: ["admin", "member"] }),
    status: str("账户状态", { enum: ["active", "disabled"] }),
    points: num("可直接用于下单的积分，已经扣除预留部分"),
    frozen: num("未结算订单预留的积分"),
    created_at: stamp("账户创建时间"),
  }),
  Products: obj({
    orders_open: bool("当前是否接受新订单；最终以提交结果为准"),
    max_quantity: num("当前每单可提交的最大数量", {
      minimum: 1,
      maximum: 1000,
    }),
    currency: str("计价单位", { const: "points" }),
    products: {
      type: "array",
      description: "两种注册模式的当前单价",
      items: ref("Product"),
    },
  }),
  Product: obj({
    name: str("服务名称"),
    need_oauth: bool("false 为标准账号；true 为含 OAuth 账号"),
    unit_price: num("该模式完整单价，单位积分；OAuth 价格无需再加标准价"),
  }),
  Order: obj({
    id: str("订单 ID；用于查进度和筛选交付账号"),
    quantity: num("期望交付数量", { minimum: 1 }),
    need_oauth: bool("本单是否包含 OAuth 数据"),
    registration_region: { type: ["string", "null"], description: "下单选择的注册地区；random 为每个账号随机选择，历史订单为 null。不是实际出口 IP 的地理检测结果。" },
    unit_price: num("下单时锁定的单个账号价格，单位积分"),
    status: str("订单整体状态；不是 HTTP 请求结果", {
      enum: Object.keys(orderStates),
    }),
    delivered: num("已经完整交付的账号数量"),
    charged: num("实际完成交付累计扣除的积分"),
    released: num("未交付部分累计退回的积分"),
    cancel_requested: bool("是否由管理员请求取消；用户和 API 不支持取消，true 不代表运行中子项已立即结束"),
    source: str("订单创建渠道", { enum: ["web", "api"] }),
    created_at: stamp("创建时间"),
    updated_at: stamp("最后更新时间"),
  }),
  OrderItem: obj({
    id: str("订单子项 ID，仅用于识别进度；不能作为账号 ID 读取凭据"),
    position: num("该账号在订单中的序号，从 1 开始", { minimum: 1 }),
    status: str("单个账号当前状态", { enum: Object.keys(itemStates) }),
    attempts: num("当前邮箱注册阶段已尝试次数；更换邮箱后重新计数"),
    oauth_attempts: num("当前账号 OAuth 阶段已尝试次数；更换邮箱后重新计数"),
    recovery_attempts: num("当前资源的原任务自动恢复次数，恢复和换邮箱都不会重置总执行期限"),
    resource_replacements: num("已更换邮箱次数，不含首次邮箱；换邮箱不重置总时限，不重复扣除积分"),
    next_retry_at: { type: ["string", "null"], format:"date-time", description:"下一次恢复或排队检查时间；执行中不表示会再次启动任务" },
    execution_started_at: { type: ["string", "null"], format:"date-time", description:"首次开始执行时间，排队期间为空" },
    execution_deadline_at: { type: ["string", "null"], format:"date-time", description:"总执行期限；首次执行前为空，恢复和 OAuth 不重置" },
    message: str("当前进度或处理说明"),
    updated_at: stamp("子项最后更新时间"),
  }, ["id","position","status","attempts","oauth_attempts","message","updated_at"]),
  OrderDetail: {
    allOf: [
      ref("Order"),
      obj({
        items: {
          type: "array",
          description: "按 position 升序返回的账号子项进度",
          items: ref("OrderItem"),
        },
      }),
    ],
  },
  Account: obj({
    id: str("交付账号 ID；用于读取凭据及批量导出"),
    order_id: str("交付所属订单 ID"),
    email: str("交付账号的邮箱"),
    need_oauth: bool("该账号是否包含 OAuth 数据"),
    created_at: stamp("交付成功时间，72 小时领取期从此刻起算"),
    download_expires_at: stamp(
      "用户领取资料删除时间；到达此时间后列表不再返回，凭据与导出均不可用。运营后台保留",
    ),
  }),
  OAuth: obj(
    {
      access_token: str("访问令牌"),
      refresh_token: str("刷新令牌"),
      id_token: str("身份令牌，可能不返回"),
    },
    ["access_token", "refresh_token"],
    {
      additionalProperties: true,
      description:
        "OAuth 数据，仅含 OAuth 的交付提供；可能有额外元数据，请保留完整对象",
    },
  ),
  StoredCredentials: obj(
    {
      asset_id: str("交付资产参考标识；查询接口使用 Account.id"),
      email: str("交付邮箱"),
      password: str("账号密码"),
      totp_secret: str("2FA 的 Base32 密钥，请妥善保管"),
      oauth: ref("OAuth"),
    },
    ["asset_id", "email", "password", "totp_secret"],
  ),
  Credentials: {
    allOf: [
      ref("StoredCredentials"),
      obj({
        download_expires_at: stamp(
          "交付成功 72 小时后的资料领取截止时间，UTC ISO 8601",
        ),
        totp_code: str("读取时计算的当前 6 位验证码；前导零须保留"),
        totp_expires_in: num("当前验证码剩余秒数，刷新凭据接口可获得新验证码", {
          minimum: 1,
          maximum: 30,
        }),
      }),
    ],
  },
  ExportResult: obj(
    {
      filename: str("建议保存的文件名，按所选格式设置后缀"),
      content: str(
        "文件正文字符串。json 是完整交付数组；cpa 单账号是 OAuth 对象、多账号是 ZIP 的 Base64；sub 是合并导入 JSON。encoding=base64 时先解码为二进制再保存，否则按 UTF-8 文本保存",
      ),
      encoding: str(
        "仅 CPA 多账号 ZIP 返回 base64；省略时 content 为 UTF-8 文本",
        { enum: ["base64"] },
      ),
    },
    ["filename", "content"],
  ),
  Error: obj({
    error: str("适合展示给用户的中文原因；不要按完整文案编写业务判断"),
    status: num("HTTP 状态码", { minimum: 400, maximum: 599 }),
  }),
};
function pageSchema(name, item) {
  schemas[name] = obj({
    items: { type: "array", description: "当前页记录", items: ref(item) },
    total: num("符合全部筛选条件的总记录数"),
    limit: num("本页最多返回条数", { minimum: 1, maximum: 100 }),
    offset: num("本页起始偏移量", { maximum: 1000000 }),
  });
}
pageSchema("OrderPage", "Order");
pageSchema("AccountPage", "Account");
Object.assign(schemas.AccountPage.properties, {
  server_time: stamp("服务器当前时间，可用于校准领取截止时间"),
  next_expires_at: {
    ...stamp("当前筛选结果中最早的领取截止时间；无可领取账号时为 null"),
    type: ["string", "null"],
  },
});
const pagination = [
  {
    name: "limit",
    in: "query",
    description: "每页条数",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    description: "跳过的记录数，从 0 开始；下一页加上 limit",
    schema: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
  },
];
const mode = {
  name: "mode",
  in: "query",
  description: "按服务模式筛选；不传或空字符串表示全部模式",
  schema: { type: "string", enum: ["standard", "oauth", ""] },
};
const querySearch = (description) => ({
  name: "q",
  in: "query",
  description:
    description +
    "；忽略首尾空白，按字面内容模糊匹配，不区分大小写，% 和 _ 不作通配符",
  schema: { type: "string", maxLength: 200 },
});
const identifier = (kind) => ({
  name: "id",
  in: "path",
  required: true,
  description:
    kind === "order"
      ? "订单 ID，来自创建订单响应 id 或订单列表 items[].id"
      : "交付账号 ID，来自账号列表 items[].id；不是订单/子项/asset_id",
  schema: { type: "string" },
  example: kind === "order" ? "ORDER_ID" : "ACCOUNT_ID",
  "x-source-operation": kind === "order" ? "create_order" : "list_accounts",
});
const response = (description, schema, example) => ({
  description,
  content: { "application/json": { schema, example } },
});
const requestBody = (schema, examples) => ({
  required: true,
  content: { "application/json": { schema, examples } },
});
const paths = {};
function operation(
  path,
  method,
  id,
  summary,
  tag,
  scope,
  description,
  options,
) {
  const {
    result,
    example,
    responseDescription = "查询成功",
    extraResponses = {},
    ...rest
  } = options;
  const create = id === "create_order";
  paths[path] ||= {};
  paths[path][method] = {
    operationId: id,
    summary,
    tags: [tag],
    "x-scope": scope || "",
    description,
    security: [{ BearerAuth: [] }],
    ...rest,
    responses: {
      [create ? 202 : 200]: response(
        create ? "已受理新订单并预留积分，尚未完成交付" : responseDescription,
        result,
        example,
      ),
      ...extraResponses,
      ...Object.fromEntries(
        Object.keys(errors)
          .filter((c) => (c !== "402" && c !== "409") || create)
          .map((code) => [
            code,
            { $ref: `#/components/responses/Error${code}` },
          ]),
      ),
    },
  };
}
operation(
  "/open/v1/me",
  "get",
  "get_me",
  "查询账户与积分",
  "账户与服务",
  "",
  "返回密钥所属的平台用户。points 已是可用积分，frozen 是单独预留的积分，不能再次从 points 中扣除。",
  {
    result: ref("User"),
    example: {
      id: "44444444-4444-4444-8444-444444444444",
      email: "customer@example.com",
      name: "示例用户",
      role: "member",
      status: "active",
      points: 900,
      frozen: 100,
      created_at: time,
    },
  },
);
operation(
  "/open/v1/products",
  "get",
  "get_products",
  "查询注册服务与价格",
  "账户与服务",
  "",
  "返回两种模式的当前完整单价和每单上限。原 quantity 和 need_oauth 调用保持兼容，默认随机地区；无需 product_id。此处的示例价格不是实时价格。",
  {
    result: ref("Products"),
    example: {
      orders_open: true,
      max_quantity: 50,
      currency: "points",
      products: [
        { name: "标准账号", need_oauth: false, unit_price: 50 },
        { name: "OAuth 账号", need_oauth: true, unit_price: 100 },
      ],
    },
  },
);
operation(
  "/open/v1/registration-regions",
  "get",
  "get_registration_regions",
  "查询可选注册地区",
  "账户与服务",
  "",
  "使用现有 Bearer API Key，无需新增 scope。返回后台已配置且非空的国家代理池代码和名称，不返回地址、密钥或库存。random 始终是下单默认值，GLOBAL 仅在配置了全球池时返回；全球池的出口地区由供应商决定。无国家池时 regions=[]，默认随机仍沿用系统固定代理回退。读取配置失败返回503。",
  { result: ref("RegistrationRegions"), example: { default_region: "random", regions: [{ code: "CL", name: "智利" }, { code: "JP", name: "日本" }, { code: "PH", name: "菲律宾" }] } },
);
operation(
  "/open/v1/registration-orders",
  "post",
  "create_order",
  "创建注册订单",
  "注册订单",
  "orders:write",
  "下单锁定模式和价格，预留 quantity × unit_price 积分。标准模式注册并配置密码和 2FA；含 OAuth 模式在同一任务中继续授权，账号已注册但授权未完成时只补授权。邮箱、代理和短信由平台管理，无需传入资源参数。网页和 API 订单共用全平台与单用户并发上限，同一用户多笔订单及 OAuth 合并计数，超出名额自动排队，结束后补位。新订单返回 202；同一用户以相同幂等键和相同参数重试返回原订单当前状态（200），不会重复创建。",
  {
    parameters: [
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "调用方生成并保存的唯一请求标识；8～128 位可见 ASCII，不含空格。网络超时后重试必须保持同一键和内容",
        schema: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[!-~]{8,128}$",
        },
        example: "YOUR_SAVED_REQUEST_ID",
      },
    ],
    requestBody: requestBody(
      obj(
        {
          quantity: num(
            "期望交付数量；实际每单上限以查询服务接口 max_quantity 为准",
            { minimum: 1, maximum: 1000 },
          ),
          need_oauth: {
            ...bool("true 包含完整 OAuth 数据；false 交付邮箱、密码和 2FA"),
            default: false,
          },
          registration_region: str("可选：省略或 random 都默认随机，每个账号独立从有空闲容量的国家池等概率选择。也可传地区查询接口返回的 code（如 JP），本单注册及补 OAuth 均使用该国家池，不自动切换至其他地区。未知或空池地区返回400且不扣积分；下单后池不可用按原任务重试/退款规则处理。重试必须保留相同地区。", { default: "random", pattern: "^(random|GLOBAL|[A-Z]{2})$" }),
        },
        ["quantity"],
        { additionalProperties: false },
      ),
      {
        standard: {
          summary: "标准账号，不含 OAuth",
          value: { quantity: 1, need_oauth: false },
        },
        oauth: {
          summary: "包含 OAuth 授权",
          value: { quantity: 1, need_oauth: true },
        },
        region: {
          summary: "指定日本地区（需先查询可选代码）",
          value: { quantity: 2, need_oauth: true, registration_region: "JP" },
        },
      },
    ),
    result: ref("Order"),
    example: exampleOrder,
    extraResponses: {
      200: response(
        "幂等重试命中已有订单，返回它的当前状态",
        ref("Order"),
        completeOrder,
      ),
    },
  },
);
operation(
  "/open/v1/registration-orders",
  "get",
  "list_orders",
  "筛选与分页查询订单",
  "注册订单",
  "orders:read",
  "仅返回自己的订单，按创建时间及 ID 倒序排序。q、status 和 mode 可组合使用，total 是筛选后的数量。",
  {
    parameters: [
      ...pagination,
      querySearch("搜索订单编号或当前平台用户的登录邮箱；不是交付邮箱"),
      {
        name: "status",
        in: "query",
        description: "按整体订单状态筛选；不传或空字符串表示全部",
        schema: { type: "string", enum: [...Object.keys(orderStates), ""] },
      },
      mode,
    ],
    "x-query-examples": {
      all: { summary: "全部订单，第一页", value: { limit: 50, offset: 0 } },
      filtered: {
        summary: "已完成的 OAuth 订单",
        value: { status: "completed", mode: "oauth", limit: 20, offset: 0 },
      },
      search: {
        summary: "搜索订单编号",
        value: { q: "ORDER_ID", limit: 20, offset: 0 },
      },
    },
    result: ref("OrderPage"),
    example: { items: [completeOrder], total: 1, limit: 50, offset: 0 },
  },
);
operation(
  "/open/v1/registration-orders/{id}",
  "get",
  "get_order",
  "查询订单进度",
  "注册订单",
  "orders:read",
  "订单字段与子项 items 一并返回。HTTP 200 表示查询成功，是否交付须检查 status、delivered 和子项状态。queued/running 建议每 5 秒查询；review 继续查询原订单，系统会自动恢复或结束退款。",
  {
    parameters: [identifier("order")],
    result: ref("OrderDetail"),
    example: { ...completeOrder, items: [exampleItem] },
  },
);
operation(
  "/open/v1/accounts",
  "get",
  "list_accounts",
  "筛选与分页查询交付账号",
  "账号交付",
  "accounts:read",
  "仅返回交付后未满 72 小时的账号基础信息，包含 download_expires_at，不含密码、2FA 或 OAuth。到期账号从列表及 total 中移除，历史订单不受影响。按创建时间及 ID 倒序返回；用 items[].id 读取凭据或导出。",
  {
    parameters: [
      ...pagination,
      {
        name: "order_id",
        in: "query",
        description: "精确匹配订单 ID，来自创建或查询订单响应 id",
        schema: { type: "string" },
        "x-source-operation": "create_order",
      },
      querySearch("搜索交付账号邮箱或所属订单编号"),
      mode,
    ],
    "x-query-examples": {
      order: {
        summary: "领取指定订单的交付账号",
        value: { order_id: "ORDER_ID", limit: 50, offset: 0 },
      },
      oauth: {
        summary: "筛选全部 OAuth 账号",
        value: { mode: "oauth", limit: 50, offset: 0 },
      },
      search: {
        summary: "按邮箱搜索",
        value: { q: "demo.account@gmail.com", limit: 50, offset: 0 },
      },
    },
    result: ref("AccountPage"),
    example: { items: [account], total: 1, limit: 50, offset: 0 },
  },
);
operation(
  "/open/v1/accounts/{id}/credentials",
  "get",
  "get_credentials",
  "读取账号凭据与验证码",
  "账号交付",
  "credentials:read",
  "仅在交付后 72 小时内可读取密码、2FA 密钥和当前验证码；到期返回 404，即使保存过账号 ID 也无法继续领取。只有购买含 OAuth 服务的账号才返回 oauth；标准账号省略该字段。完整 OAuth 对象可能包含额外元数据。",
  {
    parameters: [identifier("account")],
    result: ref("Credentials"),
    example: {
      ...exampleCredentials,
      download_expires_at: account.download_expires_at,
      totp_code: "012345",
      totp_expires_in: 18,
    },
  },
);
operation(
  "/open/v1/accounts/export",
  "post",
  "export_accounts",
  "批量导出交付资料",
  "账号交付",
  "credentials:read",
  "一次传入 1～1000 个账号 ID。任一 ID 不存在、不属于当前用户或已超过交付后 72 小时领取期，则整体返回 404；重复 ID 自动去重，不保证输出顺序与请求顺序相同。TXT/CSV 为基础凭据；JSON 保留完整交付数据。CPA 每个账号一份 OAuth JSON，多账号打包 ZIP（encoding=base64）；SUB 多账号合并为一个 sub2api 导入 JSON。CPA/SUB 只支持完整 OAuth 账号，混入标准账号会整批拒绝。响应始终是 JSON 封装，先解析，ZIP 需 Base64 解码后保存。",
  {
    requestBody: requestBody(
      obj(
        {
          ids: {
            type: "array",
            minItems: 1,
            maxItems: 1000,
            description:
              "交付账号 ID 数组，来自账号列表 items[].id；不能传订单 ID",
            items: { type: "string" },
            "x-source-operation": "list_accounts",
          },
          format: {
            type: "string",
            enum: ["txt", "csv", "json", "cpa", "sub"],
            default: "txt",
            description:
              "txt：邮箱-密码-2fa；json：完整交付；cpa：CPA 导入；sub：sub2api 合并导入",
          },
        },
        ["ids"],
      ),
      {
        json: {
          summary: "JSON，含所购 OAuth 数据",
          value: { ids: ["ACCOUNT_ID"], format: "json" },
        },
        txt: {
          summary: "TXT，邮箱----密码----2FA",
          value: { ids: ["ACCOUNT_ID"], format: "txt" },
        },
        csv: {
          summary: "CSV，三列基础凭据",
          value: { ids: ["ACCOUNT_ID"], format: "csv" },
        },
        cpa: {
          summary: "CPA，每个账号独立 JSON，多账号 ZIP",
          value: { ids: ["ACCOUNT_ID"], format: "cpa" },
        },
        sub: {
          summary: "SUB，多个账号合并 JSON",
          value: { ids: ["ACCOUNT_ID"], format: "sub" },
        },
      },
    ),
    result: ref("ExportResult"),
    example: {
      filename: "gptreg-accounts.json",
      content: JSON.stringify([exampleCredentials], null, 2),
    },
    responseDescription: "导出内容已生成，解析 JSON 后保存 content",
  },
);
// Keep each response example aligned with the selected request scenario.
for (const status of [200, 202]) {
  const base = status === 202 ? exampleOrder : completeOrder;
  paths["/open/v1/registration-orders"].post.responses[status].content[
    "application/json"
  ].examples = {
    standard: {
      summary: "标准账号订单",
      value: {
        ...base,
        need_oauth: false,
        unit_price: 50,
        charged: status === 200 ? 50 : 0,
      },
    },
    oauth: { summary: "OAuth 账号订单", value: base },
  };
  delete paths["/open/v1/registration-orders"].post.responses[status].content[
    "application/json"
  ].example;
}
const exportMedia =
  paths["/open/v1/accounts/export"].post.responses[200].content[
    "application/json"
  ];
exportMedia.examples = {
  json: { summary: "JSON 文件正文", value: exportMedia.example },
  txt: {
    summary: "TXT 文件正文",
    value: {
      filename: "gptreg-accounts.txt",
      content:
        "demo.account@gmail.com----EXAMPLE_PASSWORD----EXAMPLE_BASE32_SECRET\n",
    },
  },
  csv: {
    summary: "CSV 文件正文（含 BOM）",
    value: {
      filename: "gptreg-accounts.csv",
      content:
        '\uFEFFemail,password,totp_secret\r\n"demo.account@gmail.com","EXAMPLE_PASSWORD","EXAMPLE_BASE32_SECRET"\r\n',
    },
  },
};
exportMedia.examples.cpa = {
  summary: "CPA 单账号独立 JSON（多账号为 ZIP）",
  value: {
    filename: "codex-demo.account@gmail.com.json",
    content: JSON.stringify(
      {
        ...exampleCredentials.oauth,
        email: exampleCredentials.email,
        type: "codex",
      },
      null,
      2,
    ),
  },
};
exportMedia.examples.sub = {
  summary: "SUB 合并导入文件",
  value: {
    filename: "SUB-1.json",
    content: JSON.stringify(
      {
        exported_at: "2026-11-05T00:00:00.000Z",
        proxies: [],
        accounts: [
          {
            name: exampleCredentials.email,
            platform: "openai",
            type: "oauth",
            credentials: {
              ...exampleCredentials.oauth,
              email: exampleCredentials.email,
            },
            concurrency: 10,
            priority: 1,
          },
        ],
      },
      null,
      2,
    ),
  },
};
delete exportMedia.example;
for (const path of ["/open/v1/registration-orders", "/open/v1/accounts"]) {
  const op = paths[path].get;
  const media = op.responses[200].content["application/json"];
  media.examples = Object.fromEntries(
    Object.entries(op["x-query-examples"]).map(([key, ex]) => [
      key,
      {
        summary: ex.summary,
        value: {
          ...media.example,
          limit: ex.value.limit,
          offset: ex.value.offset,
        },
      },
    ]),
  );
  delete media.example;
}
const openapi = {
  openapi: "3.1.0",
  info: {
    title: "GPT Register 开放 API",
    version: "1.6.0",
    description:
      "通过服务端 API 创建标准或含 OAuth 的注册订单，查询进度并领取交付凭据。下单预留积分，按实际交付结算；失败/取消未交付部分释放。所有示例为虚构演示资料，实际价格与上限以接口返回为准。",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "账户与服务", description: "查看用户积分和注册服务价格" },
    { name: "注册订单", description: "创建、筛选和查询自己的订单；用户及 API 不支持取消" },
    { name: "账号交付", description: "领取及导出已交付账号" },
  ],
  paths,
  "x-order-states": orderStates,
  "x-item-states": itemStates,
  "x-scopes": {
    "orders:read": "查询订单列表与进度",
    "orders:write": "创建订单",
    "accounts:read": "查询已交付账号列表",
    "credentials:read": "读取密码、2FA、OAuth 与批量导出",
  },
  "x-errors": Object.entries(errors).map(([status, [message, action]]) => ({
    status: Number(status),
    message,
    action,
  })),
  "x-input-sources": [
    {
      field: "registration_region",
      source: "注册地区查询返回的 regions[].code；省略或 random 为默认随机",
      usage: "可选 JSON 字符串，如 JP；原接入无需修改",
      operation: "get_registration_regions",
    },
    {
      field: "Authorization",
      source: "工作台 → 开发接入 → 创建 API Key",
      usage: "Bearer YOUR_API_KEY",
      operation: "",
    },
    {
      field: "quantity",
      source: "调用方选择数量，不能超过 max_quantity",
      usage: "JSON 整数，例如 1",
      operation: "get_products",
    },
    {
      field: "need_oauth",
      source: "用户选择交付模式，与 products[].need_oauth 对应",
      usage: "JSON 布尔值 true / false，不要传字符串",
      operation: "get_products",
    },
    {
      field: "Idempotency-Key",
      source: "调用方生成并保存的请求唯一标识",
      usage: "请求头，重试时原样复用；新订单使用新键",
      operation: "create_order",
    },
    {
      field: "订单 id / order_id",
      source: "创建响应 id 或订单列表 items[].id",
      usage: "查详情或筛选交付账号",
      operation: "create_order",
    },
    {
      field: "账号 id / ids[]",
      source: "账号列表 items[].id",
      usage: "查凭据路径参数，或导出 JSON 的 ids 数组",
      operation: "list_accounts",
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key",
        description: "在用户工作台的开发接入创建；仅显示一次，撤销后立即失效",
      },
    },
    schemas,
    responses: Object.fromEntries(
      Object.entries(errors).map(([status, [message]]) => [
        `Error${status}`,
        {
          ...response(message, ref("Error"), {
            error: message,
            status: Number(status),
          }),
          ...(status === "429"
            ? {
                headers: {
                  "Retry-After": {
                    description:
                      "命中平台配置的风控频率限制时返回建议等待秒数；未完成订单数量上限等业务限制不保证携带",
                    schema: { type: "integer", example: 60 },
                  },
                },
              }
            : {}),
        },
      ]),
    ),
  },
};
module.exports = { openapi };
