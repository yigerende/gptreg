# gptreg 项目操作约定

2026-11-05 最新授权：新增独立用户前台、参照 xufu-python 的登录注册/找回密码、积分订单、是否需要 OAuth 两种模式（默认 50 / 100 积分，后台可改）、账号交付和客户开放 API，并推送 GitHub 更新正式。此前“仅保留邮箱设置”的范围已由此授权扩展。现有注册引擎和配置保留，不恢复本机链式代理改造。

正式 Compose 现包含 app / worker / postgres，容器 gptreg-app / gptreg-worker / gptreg-postgres；仅 app 对外 8963。应用与执行器分别启动，执行器由数据库互斥锁确保唯一。用户前台 `/`，平台管理 `/admin`，原控制台 `/admin/engine`，文档 `/docs`，外部接口 `/open/v1`。旧 `/api/v1` 必须管理员会话访问。

数据必须同时保留 PostgreSQL 独立卷、`.runtime/` 与 `.env`。主密钥 `.runtime/platform-secrets.json` 不得丢失或轮换覆盖；新账号、运行检查点和 OAuth 文件敏感字段已加密。回滚到旧版引擎前须停 worker，用新镜像 `node scripts/runtime-encryption.js decrypt` 解密当前运行文件，不能直接用旧备份覆盖新业务数据。先关闭新单及队列领取并等待在途任务结束，再备份数据库和运行目录。首次迁移允许新建本项目数据库和 worker；以后只重建 app / worker，保留数据库容器和数据卷。

验证至少包括 `npm test`、`npm run test:platform`（设置 GPTREG_TEST_DATABASE_URL 指向独立测试库）、前端构建及网页检查；Windows 可用 `python scripts/platform-local.py` 建独立 18983 测试库。不得启动 xufu 或 huixu 的旧本地服务，不发起真实付费注册作为默认测试。完整操作见 `DOCKER.md`、`docs/customer-platform.md`。

用户于 2026-11-05 要求以桌面原包恢复项目，只保留 SMSBower Gmail 设置（租约/接口配置/保存/测试）功能，并补充 Docker 部署。不要自行恢复已经去掉的本机代理开关和链式代理改造。

正式部署参见 `DOCKER.md`。GitHub `yigerende/gptreg`，正式目录 `/opt/1panel/apps/gptreg`，Compose project `gptreg`、service `app`、容器 `gptreg-app`，端口 `8963:3210`。

用户要求所有后续正式更新遵循：本地验证与提交推送 → 正式原目录从 GitHub 拉取 → 预构建 → 空闲检查和备份 → 只重建 app → 验证。不得上传源码覆盖正式目录，不影响其他容器。

首次正式部署必须为空白数据。以后必须保留 `.runtime/` 和 `.env`，不能以本地配置或默认值覆盖。不得提交密钥、运行配置、账号、日志及历史数据。SSH 使用当前默认路由的单个会话，不绑定源 IP/网卡，不改 22 端口；连接失败稍等后重试。
