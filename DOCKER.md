# Docker 部署

用户前台与注册后台共用 React/Fastify。app 提供 HTTP 服务，worker 独占原注册引擎，PostgreSQL 保存用户、订单、积分和交付数据。功能与接口说明见 docs/customer-platform.md。

## 固定映射

- GitHub https://github.com/yigerende/gptreg.git，main。
- 正式目录 /opt/1panel/apps/gptreg，Compose project gptreg。
- app / gptreg-app：8963:3210；worker / gptreg-worker：仅内部 3211；postgres / gptreg-postgres：仅内部 5432。
- .runtime/ 保存原配置、任务、管理员初始访问凭据、加密主密钥。postgres-data 为独立数据库卷。不得复用其他项目的数据库或主密钥。
- 前台 /，平台后台 /admin，原注册后台 /admin/engine，文档 /docs，OpenAPI /openapi.json。

## 首次安装

在正式目录克隆代码，创建 UID/GID 1000、0700 的 .runtime 目录。在 .env 设置 GPTREG_VERSION 为提交 SHA，GPTREG_DB_PASSWORD 为独立随机数据库密码（建议 32 字节随机十六进制）。文件权限 0600，不提交 GitHub。

```sh
docker compose -p gptreg -f compose.yml build app
docker compose -p gptreg -f compose.yml up -d --no-build postgres worker app
```

首次管理员使用 .runtime/console-auth.json 中原账号密码登录新网页。凭据只用于第一次建立管理员，以后通过网页修改密码，不由文件覆盖。旧 HTTP Basic 弹窗已由网页登录替代。默认普通模式 50 积分、OAuth 模式 100 积分，管理员可改；新用户初始 0 积分。

全新安装先在平台后台设置注册模板及开放接单；邮箱/代理资源在原注册后台配置。SMTP 配置后可启用邮箱验证与找回密码。正式推荐通过 HTTPS 域名使用，8963 映射保留。

## 从旧单容器迁移

1. 核实旧 app 空闲，备份 .runtime、.env、旧 Compose、镜像和版本，记录其他容器基线。
2. 本地验证并推送 GitHub；正式原目录 git pull --ff-only origin main。
3. 配置独立数据库密码，旧 app 继续运行时预构建新镜像、拉取 PostgreSQL 镜像。
4. 再次检查任务、换绑及机器人无在途操作，停止旧 app；首次启动独立 postgres。
5. 用新镜像执行 `docker compose -p gptreg run --rm --no-deps app node scripts/runtime-encryption.js encrypt`，迁移原任务/账号/OAuth 文件的敏感字段，保留所有账号与配置。此步骤会生成独立主密钥。
6. 启动 worker、app。管理员自动继承原 console-auth 凭据；历史账号保持管理员资产，不会分配给新用户。
7. 验证新登录、原管理接口、前台、文档、持久数据、数据库及执行器健康。更新后仍需保存主密钥备份。

## 后续更新

固定流程：本地验证 → 提交推送 GitHub → 正式原目录拉取 → 预构建 → 空闲检查和备份 → 仅重建 app / worker → 验证。

先关闭新订单受理和队列领取，等待已执行任务收尾，记录并恢复开关原值。备份 PostgreSQL（pg_dump）、完整 .runtime、.env 和 Compose，验证可恢复。归档放 /opt/1panel/apps/codex-release-backups/gptreg/<版本时间>/；发布成功后保留最近三份完整备份。

```sh
docker compose -p gptreg -f compose.yml build app
docker compose -p gptreg -f compose.yml up -d --no-deps --no-build --force-recreate worker app
```

数据库容器和卷保持。镜像提前构建，切换阶段不重复构建。验证 /healthz、/health/ready、登录后的 /api/v1/health、新前台 /api/user/v1/me，以及数据库、主密钥、原配置和其他容器 ID/启动时间。

回滚到本平台版本只切换已验证旧镜像，保留新增数据。若回滚到最早的单容器版本，先停止 worker，用**新镜像**执行 `node scripts/runtime-encryption.js decrypt` 解密当前运行文件，再恢复旧 app/Compose；保留 PostgreSQL 卷，不能用旧备份覆盖新订单。失去主密钥将无法恢复加密凭据。

禁止全局 prune、其他项目 Compose 操作、down -v 或上传本地源码覆盖正式目录。SSH 走当前默认路由、22 端口、单会话串行，不绑定源 IP/网卡；失败等待约 5 秒后重试。GitHub 自动镜像发布流水线尚未配置。
