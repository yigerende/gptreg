# 用户平台与开放 API

React 19 / Fastify 5 保留。PostgreSQL 存储用户、积分账本、订单子项、交付归属和 API Key；原引擎运行文件只用于执行检查点。app 提供公开前台、受保护的后台和 API；worker 独占注册引擎，PostgreSQL advisory lock 防止重复领取，内部接口使用独立密钥，不发布端口。

## 用户流程

- 邮箱注册、密码登录、邮件验证码、找回密码、退出、修改资料。注册开关、邮件验证和域名限制均在后台设置。SMTP 未配置时不显示找回密码，不能开启强制邮件验证。
- 初始积分为零；管理员加款或兑换码充值。默认标准账号 50 积分、含 OAuth 100 积分，后台可改。含 OAuth 是完整单价，不再另加标准价。
- 只提交 quantity 和 need_oauth；下单预留积分，锁定单价、模板、重试上限和时限。只有完整交付时结算，部分失败/取消释放对应预留积分。
- 标准交付要求邮箱、已配置密码与 2FA；OAuth 模式在同一个账号上追加授权，要求 access_token / refresh_token。失败只重试授权，不重新创建账号。结果不明进入 review，不盲目重放。
- 当前一个全局主任务，每轮执行一个客户子项，按订单最近调度时间轮转。后台原任务与用户任务共享引擎容量；未来扩大并发必须先隔离资源及检查点，不能直接扩容 worker。
- 我的账号可复制密码/2FA/当前验证码，导出 TXT（邮箱----密码----2FA）或 JSON（包含所购买的 OAuth 数据）。交付账号唯一绑定用户、订单和子项，并标记原引擎资产为已售。历史账号仍为管理员资产，不自动归属客户。

## 入口与接口

用户 `/`、`/orders`、`/accounts`、`/wallet`、`/keys`、`/profile`；平台管理 `/admin`；原管理台 `/admin/engine`。

客户文档 `/docs`，OpenAPI 3.1 `/openapi.json`。外部 API `/open/v1` 只接受 Bearer API Key；网页 `/api/user/v1` 使用 HttpOnly / SameSite Strict 会话。`/api/admin/v1`、原 `/api/v1` 及管理员 JS 包要求管理员会话。所有网页写操作检查同源及自定义头，不启用跨域。

创建订单：

```http
POST /open/v1/registration-orders
Authorization: Bearer YOUR_API_KEY
Idempotency-Key: unique-order-request-001
Content-Type: application/json

{"quantity":10,"need_oauth":true}
```

返回 202 和订单 ID。相同用户同键同请求返回原订单（200），请求不同则 409。查询详情后，通过 accounts 的 order_id 过滤获取已交付结果。默认调用 120 次/用户/分钟、下单 20 次/分钟；轮询建议每 5 秒。密钥仅首次完整显示，数据库存摘要，可撤销，按 orders:read / orders:write / accounts:read / credentials:read 授权。

## 数据与恢复

所有金额为整数积分，事务、行锁、账本唯一 reference 共同保证只结算一次。取消与转入重试/授权阶段共用订单锁，防止取消后的积分永久挂起。每次执行先持久化唯一 run_id，再启动引擎；重启时读取原检查点，缺失或结果不明时转人工核实。

管理员订单详情可查看原任务、恢复原任务或确认未交付并退款。未知结果必须先核实，不能为了释放占位直接重复注册。关闭接单不会中断已受理订单，关闭领取会让已执行部分收尾。

交付凭据、SMTP 密码和引擎关键凭据使用 AES-256-GCM，主密钥位于 `.runtime/platform-secrets.json`。API Key 与会话仅保存摘要，用户密码用带随机盐的 scrypt。旧文件迁移工具支持加密与解密，须停执行器后操作。配置文件及历史运维备份仍需要以 0700 目录/0600 文件和受控备份存储保护；主密钥必须与数据库同时备份。

## 本地验证

```powershell
python scripts/platform-local.py
npm run test:platform
npm test
npm run ui:build
node scripts/platform-preview.js
```

测试库仅监听 127.0.0.1:18983，各次测试使用新 schema，结束删除。预览仅监听 18984，使用独立 portal_preview schema，不启动注册执行器。预览账号和密码只属于临时演示，不是正式凭据。完成后停止预览及 `python scripts/platform-local.py stop`。

正式 Linux 集成验证使用临时数据库运行 `GPTREG_TEST_DATABASE_URL=... npm run test:platform`，测试本身不调用注册供应商、不发送邮件、不消耗付费邮箱。
