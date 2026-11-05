# GPT-Register 部署与运维交付手册

正式 Docker 部署使用 [DOCKER.md](DOCKER.md)：GitHub 拉取源码、独立 `gptreg-app` 容器、对外端口 8963、数据保存在 `.runtime/`。以下保留原包的本机及非 Docker 安装说明。

本文档专为交付部署人员编写，指导如何在目标服务器或工作站上完成 GPT-Register 系统的安装、配置、生产守护及安全运维。

---

## 1. 系统要求与环境准备

| 项目 | 最低配置 | 推荐配置 |
| :--- | :--- | :--- |
| **操作系统** | Windows 10/11/Server 2019+, Ubuntu 20.04+, Debian 11+, macOS 12+ | Windows Server 2022 / Ubuntu 22.04 LTS |
| **Node.js** | `>= 20.0.0` (推荐 Node.js 20 LTS 或 22 LTS) | Node.js 22 LTS |
| **内存 (RAM)** | 2 GB | 4 GB 或更高 |
| **网络要求** | 能正常访问目标接码 API、OpenAI 节点（需自备稳定海外住宅代理） | 具有低延迟优质代理通道 |

### 安装 Node.js
- **Ubuntu/Debian**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Windows**:
  从 [Node.js 官方网站](https://nodejs.org/) 下载 Windows 64-bit 安装包安装。

---

## 2. 安装与初始配置

### 2.1 解压并安装依赖

解压交付包至目标目录（如 `/opt/gpt-register` 或 `C:\tools\gpt-register`）：

```bash
cd /opt/gpt-register
npm install --omit=dev
```
> **注意**：前端控制台已预构建于 `web/dist`，无需在部署机安装构建工具即可直接提供 Web UI 访问。

### 2.2 基础配置文件调整

编辑根目录下的 `gpt-re.config.json`：

1. **设置接码平台密钥**：
   ```json
   "sms": {
     "provider": "smsbower",
     "baseUrl": "https://smsbower.page/stubs/handler_api.php",
     "apiKey": "填写您的真实SMSBower_API_KEY",
     "country": { "id": 151, "name": "Chile" }
   }
   ```
2. **设置邮箱接收凭据**：
   ```json
   "mail": {
     "provider": "smsbower",
     "password": "填写您的邮箱密码或Token"
   }
   ```
3. **设置代理池**：
   在 `proxy-pool.txt` 文件中添加您的有效出口代理，例如：
   ```text
   http://username:password@us-proxy.provider.com:10001
   socks5://username:password@us-proxy.provider.com:10002
   ```

---

## 3. 运行与服务守护

### 3.1 方案 A：Windows 一键快速启动

直接双击运行 `start.bat` 或在终端执行：
```cmd
.\start-gpt-re.bat
```
脚本会自动检查端口占用、进行健康检查，并在服务就绪后自动拉起默认浏览器访问 `http://127.0.0.1:3210`。

---

### 3.2 方案 B：Linux PM2 进程守护（生产推荐）

在生产服务器环境下推荐使用 PM2 进行进程守护：

1. 全局安装 PM2：
   ```bash
   npm install -g pm2
   ```
2. 启动服务：
   ```bash
   pm2 start src/ui-server/index.js --name "gpt-register" --env production
   ```
3. 设置开机自启：
   ```bash
   pm2 save
   pm2 startup
   ```
4. 查看运行状态与日志：
   ```bash
   pm2 status
   pm2 logs gpt-register
   ```

---

### 3.3 方案 C：Linux systemd 系统服务

创建 systemd 服务文件 `/etc/systemd/system/gpt-register.service`：

```ini
[Unit]
Description=GPT-Register Console and Engine
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/gpt-register
ExecStart=/usr/bin/node /opt/gpt-register/src/ui-server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=GPT_RE_UI_HOST=127.0.0.1
Environment=GPT_RE_UI_PORT=3210

[Install]
WantedBy=multi-user.target
```

加载并启动服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable gpt-register
sudo systemctl start gpt-register
sudo systemctl status gpt-register
```

---

## 4. 端口与网络安全规范

1. **默认绑定地址**：
   - Web 控制台 API 默认仅绑定回环地址 `127.0.0.1:3210`，杜绝未授权公网访问。
2. **远程管理建议**：
   - 如需在远程办公电脑访问服务器上的 Web 控制台，建议使用 **SSH 端口转发**，安全且无需开放公网端口：
     ```bash
     ssh -L 3210:127.0.0.1:3210 user@your-server-ip
     ```
     随后直接在本地浏览器访问 `http://127.0.0.1:3210` 即可。
   - 若使用 Nginx 反向代理，请务必配置 HTTP Basic Auth 或 IP 白名单限制。

---

## 5. 账号产出与数据备份

所有注册成功且完成 OAuth 验证的账号凭据均保存在：
- `.gpt-re-state/v2/output/`：CPA 格式与 Session 资产持久化目录。
- `.gpt-re-state/v2/state-store.json`：调度器元数据与任务索引。

**数据备份建议**：
建议定期将 `.gpt-re-state/v2/output/` 目录进行压缩归档并同步至离线存储备份。

---

## 6. 常见问题排查 (Troubleshooting)

### Q1: 启动后控制台无法打开
- 检查端口 `3210` 是否已被其他应用占用：
  - Windows: `netstat -ano | findstr 3210`
  - Linux: `lsof -i :3210`
- 检查运行日志：
  - 查看 `.gpt-re-state/v2/runtime/ui-server.stdout.log` 与 `ui-server.stderr.log`。

### Q2: 注册提示代理连接失败或超时
- OpenAI 对注册 IP 的信誉评分要求极高，请确保代理为优质海外独享/动态住宅 IP。
- 在 `gpt-re.config.json` 中可适当放宽 `healthCheck.timeoutMs`（如设为 12000）。

### Q3: 短信验证码获取超时
- 检查短信平台余额是否充足。
- 部分国家号码库存可能波动，可在配置文件的 `sms.countries` 中多配置几个备选国家（例如智利、哥伦比亚、印尼、菲律宾、巴西等）。
