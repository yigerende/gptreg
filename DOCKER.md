# Docker 部署

本项目以原始交付包为基线，保留 SMSBower Gmail 卡片中的租约、接口配置、保存和只读连接测试。Docker 使用独立入口，桌面启动方式保持原包行为。

## 固定部署映射

- GitHub：`https://github.com/yigerende/gptreg.git`，分支 `main`
- 正式目录：`/opt/1panel/apps/gptreg`
- Compose project：`gptreg`，service：`app`，容器：`gptreg-app`
- 端口：宿主机 `8963` → 容器 `3210`
- 持久化目录：`.runtime/`，包含配置、代理池、账号、任务、日志和控制台访问凭据

首次启动生成空白数据；本地业务配置、密钥和历史数据不进入 GitHub 或镜像。容器中的供应商 API 默认直连。原包的维护代理功能仍需在界面配置适合服务器使用的代理。

## 首次安装

```sh
cd /opt/1panel/apps
git clone https://github.com/yigerende/gptreg.git gptreg
cd gptreg
install -d -m 0700 -o 1000 -g 1000 .runtime
printf 'GPTREG_VERSION=%s\n' "$(git rev-parse HEAD)" > .env
docker compose -p gptreg -f compose.yml build app
docker compose -p gptreg -f compose.yml up -d --no-deps --no-build app
```

访问 `http://服务器地址:8963`。浏览器会要求输入用户名和密码，首次生成的凭据位于 `.runtime/console-auth.json`，仅在服务器本机查看，不要提交到仓库。容器默认用户 UID 1000，运行配置文件必须可由该用户读写。

## 后续更新

固定流程：本地修改与验证 → 提交推送 GitHub → 正式原目录拉取 GitHub → 构建镜像 → 空闲检查、备份 → 仅重建本项目应用 → 验证。

1. 本地执行 `npm test`、必要的前端测试与 `npm --prefix web run build`，确认运行数据和密钥未被跟踪，再提交推送 `main`。
2. 正式目录执行 `git pull --ff-only origin main`，核对提交。记录旧 `.env` 和容器镜像；旧容器继续运行时，更新 `.env` 的 `GPTREG_VERSION` 为新提交，执行 `docker compose -p gptreg -f compose.yml build app`。
3. 使用认证后的 `/api/v1/health`、`/api/v1/rebind/status` 及界面确认无运行任务、换绑或自动任务；备份完整 `.runtime/`、`.env`、`compose.yml` 和当前版本信息至 `/opt/1panel/apps/codex-release-backups/gptreg/<发布时间>/`。只有发布和备份验证成功后才按项目保留最近三份。
4. 精确切换：

```sh
cd /opt/1panel/apps/gptreg
docker compose -p gptreg -f compose.yml up -d --no-deps --no-build --force-recreate app
```

5. 检查 `http://127.0.0.1:8963/healthz`、认证后的页面/API、静态资源、容器健康和日志；核对持久化配置、数据及其他容器 ID/启动时间未改变。

保留旧镜像用于回滚；回滚只切换应用镜像，不能用旧数据备份覆盖新产生的数据。不执行全局 `prune`、其他项目的 Compose 命令或 `docker compose down -v`。源码必须从 GitHub 拉取，不上传本地源码覆盖正式目录。

SSH 使用当前默认路由、22 端口、一个会话串行操作，不绑定源 IP/网卡；失败后等待几秒重试。GitHub 自动构建镜像流水线未配置。
