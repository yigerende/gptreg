"use strict";
const pagination = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
];
const paths = {};
function operation(path, method, summary, scope, options = {}) {
  paths[path] ||= {};
  paths[path][method] = {
    summary,
    description: `需要权限：${scope || "有效 API Key"}。仅操作当前用户的数据。`,
    operationId: `${method}_${path.replace(/[^a-z0-9]+/gi, "_")}`,
    security: [{ BearerAuth: [] }],
    ...options,
    responses: {
      [method === "post" && path === "/open/v1/registration-orders"
        ? "202"
        : "200"]: {
        description: "成功",
        content: {
          "application/json": { schema: options.result || { type: "object" } },
        },
      },
      400: { $ref: "#/components/responses/Error" },
      401: { $ref: "#/components/responses/Error" },
      402: { $ref: "#/components/responses/Error" },
      403: { $ref: "#/components/responses/Error" },
      404: { $ref: "#/components/responses/Error" },
      409: { $ref: "#/components/responses/Error" },
      429: { $ref: "#/components/responses/Error" },
      503: { $ref: "#/components/responses/Error" },
    },
  };
  delete paths[path][method].result;
}
const identifier = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
const order = { $ref: "#/components/schemas/Order" };
operation("/open/v1/me", "get", "查询用户及可用、冻结积分", "", {
  result: { $ref: "#/components/schemas/User" },
});
operation("/open/v1/products", "get", "查询两种模式的积分单价和每单上限", "", {
  result: {
    type: "object",
    properties: {
      orders_open: { type: "boolean" },
      max_quantity: { type: "integer" },
      currency: { const: "points" },
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            need_oauth: { type: "boolean" },
            unit_price: { type: "integer" },
            name: { type: "string" },
          },
        },
      },
    },
  },
});
operation(
  "/open/v1/registration-orders",
  "post",
  "创建注册订单",
  "orders:write",
  {
    parameters: [
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "8～128 位可见 ASCII。同一用户同键同请求返回原订单（200）；不同内容返回409。",
        schema: { type: "string", minLength: 8, maxLength: 128 },
      },
    ],
    requestBody: body({
      type: "object",
      additionalProperties: false,
      required: ["quantity"],
      properties: {
        quantity: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "期望交付的账号数，实际每单上限以 products 为准",
        },
        need_oauth: {
          type: "boolean",
          default: false,
          description: "true 需要完整 OAuth 授权数据",
        },
      },
    }),
    result: order,
  },
);
operation(
  "/open/v1/registration-orders",
  "get",
  "分页查询订单",
  "orders:read",
  {
    parameters: pagination,
    result: {
      type: "object",
      properties: {
        items: { type: "array", items: order },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
    },
  },
);
operation(
  "/open/v1/registration-orders/{id}",
  "get",
  "查询订单进度与子任务",
  "orders:read",
  {
    parameters: [identifier],
    result: {
      allOf: [
        order,
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  position: { type: "integer" },
                  status: {
                    enum: [
                      "queued",
                      "running",
                      "oauth_pending",
                      "review",
                      "delivered",
                      "failed",
                      "cancelled",
                    ],
                  },
                  attempts: { type: "integer" },
                  oauth_attempts: { type: "integer" },
                  message: { type: "string" },
                  updated_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      ],
    },
  },
);
operation(
  "/open/v1/registration-orders/{id}/cancel",
  "post",
  "取消尚未执行部分；已启动的部分确认结果后结算",
  "orders:write",
  { parameters: [identifier], result: order },
);
operation("/open/v1/accounts", "get", "分页查询已交付账号", "accounts:read", {
  parameters: [
    ...pagination,
    { name: "order_id", in: "query", schema: { type: "string" } },
  ],
  result: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            order_id: { type: "string" },
            email: { type: "string" },
            need_oauth: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
          },
        },
      },
      limit: { type: "integer" },
      offset: { type: "integer" },
    },
  },
});
operation(
  "/open/v1/accounts/{id}/credentials",
  "get",
  "读取账号密码、2FA及所购买的 OAuth 数据",
  "credentials:read",
  {
    parameters: [identifier],
    result: { $ref: "#/components/schemas/Credentials" },
  },
);
operation(
  "/open/v1/accounts/export",
  "post",
  "批量导出 TXT / CSV 凭据或含 OAuth 的 JSON",
  "credentials:read",
  {
    requestBody: body({
      type: "object",
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string" },
        },
        format: { enum: ["txt", "csv", "json"], default: "txt" },
      },
    }),
    result: {
      type: "object",
      properties: { filename: { type: "string" }, content: { type: "string" } },
    },
  },
);
const openapi = {
  openapi: "3.1.0",
  info: {
    title: "GPT Register 开放 API",
    version: "1.0.0",
    description:
      "积分按成功交付账号结算。下单预留数量×单价，失败/取消未执行部分释放。OAuth 与标准账号分别定价，下单锁定单价。轮询建议间隔5秒。默认每用户120次/分钟、下单20次/分钟。",
  },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "API Key" },
    },
    responses: {
      Error: {
        description:
          "400 参数错误；401 密钥无效；402 积分不足；403 权限不足；404 资源不存在；409 幂等冲突；429 限流；503 暂停受理。",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string" },
                status: { type: "integer" },
              },
            },
          },
        },
      },
    },
    schemas: {
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          name: { type: "string" },
          role: { enum: ["admin", "member"] },
          status: { type: "string" },
          points: { type: "integer", description: "可用积分" },
          frozen: { type: "integer", description: "预留积分" },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "string" },
          quantity: { type: "integer" },
          need_oauth: { type: "boolean" },
          unit_price: {
            type: "integer",
            description: "下单时单个账号价格，单位积分",
          },
          status: {
            enum: [
              "queued",
              "running",
              "review",
              "completed",
              "partial",
              "failed",
              "cancelled",
            ],
          },
          delivered: { type: "integer" },
          charged: { type: "integer" },
          released: { type: "integer" },
          cancel_requested: { type: "boolean" },
          source: { enum: ["web", "api"] },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      Credentials: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          email: { type: "string" },
          password: { type: "string" },
          totp_secret: { type: "string" },
          totp_code: { type: "string" },
          totp_expires_in: { type: "integer" },
          oauth: {
            type: "object",
            description: "仅 need_oauth=true 的交付包含。请按敏感凭据保存。",
            properties: {
              access_token: { type: "string" },
              refresh_token: { type: "string" },
              id_token: { type: "string" },
            },
          },
        },
      },
    },
  },
};
module.exports = { openapi };
