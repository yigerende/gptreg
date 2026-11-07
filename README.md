# GPT-Register 自动化注册与 OAuth 认证交付包

高性能 ChatGPT 自动化账号注册、Sentinel 防护绕过、邮件/短信自动接码及 OAuth PKCE 令牌全生命周期管理系统。

---

## 核心特性

- **完整全流程自动化**：
  - **OpenAI 协议模拟**：基于真实最新模板，支持客户端指纹（Firefox Profile）、浏览器 Headers 深度拟真。
  - **Sentinel PoW & Cloudflare 绕过**：内置 OpenAI Sentinel PoW 算力算法、动态 SDK 加载器、Canvas/WebGL 表面拟真与 Cloudflare JSD 握手。
  - **邮件全自动接码**：原生集成 SMSBower、Mail.com、Fastmail、iCloud、Xiaopingguo 等邮件协议，自动轮询并精准解析 OTP 临时验证码。
  - **短信全自动接码**：原生支持 SMSBower 与 Firefox Fun 平台，具备手机号租用、验证码轮询、风控预算控制、换号重试策略。
  - **OAuth 2.0 PKCE 认证流程**：支持全套 PKCE 流程、密码认证、TOTP 双重认证生成、Access Token / Refresh Token / Session Token 自动交换与持久化。
- **现代化可视化控制台**：已内置预构建的 Web 控制台前端（位于 `web/dist`），开箱即用，支持实时任务看板、日志流、代理池管理、定时 Robot 调度器与账号资产导出。
- **灵活的调用方式**：支持 Web UI 控制台、CLI 命令行工具（单账号/批量）、独立脚本，以及 Node.js 模块化编程接口引用。
- **极简与轻量交付**：已剥离无用历史日志、冗余 HAR 数据包及第三方业务模块，纯净脱敏，适合独立部署。

---

## 目录结构

```text
gpt-register/
├── bin/
│   ├── gpt-register.js            # CLI 命令行快捷入口
│   └── gpt-re.js                  # 完整命令行执行引擎
├── src/                           # 核心业务模块源码
│   ├── ui-server/                 # Fastify Web API 服务与静态资源挂载
│   ├── chatgpt-session-runner.js  # 注册与会话核心执行器
│   ├── registration-runner.js     # 分步注册流程编排
│   ├── cockpit-oauth-runner.js    # OAuth PKCE 认证及 Token 交换
│   ├── oauth-pkce.js              # PKCE 验证算法与令牌请求
│   ├── sentinel-pow.js            # OpenAI Sentinel PoW 算力计算
│   ├── sentinel-runtime.js        # Sentinel 浏览器沙箱环境
│   ├── sentinel-sdk-loader.js     # Sentinel SDK 加载与缓存
│   ├── cloudflare-jsd.js          # Cloudflare 挑战绕过
│   ├── client-profile.js          # 客户端指纹与环境模拟
│   ├── sms-provider.js            # 短信接码服务提供商 (SMSBower / Firefox)
│   ├── email-flow.js              # 邮箱接码与 OTP 提取流程
│   ├── proxy-pool.js              # 代理轮换与健康检查池
│   ├── proxy-catalog.js           # 动态代理源管理
│   ├── orchestrator-v2.js         # 多 Worker 批量并发注册调度器
│   ├── session-asset-store.js     # 产出账号与 Token 存储管理
│   └── config-v2.js               # 配置加载与规范化校验
├── web/
│   ├── dist/                      # 预构建编译好的 Web 控制台静态前端 (开箱即用)
│   ├── src/                       # 前端源码 (React + TypeScript + Tailwind)
│   └── package.json               # 前端项目配置
├── scripts/
│   ├── register-one.js            # 命令行单账号直接注册脚本
│   ├── oauth-login.js             # 命令行单账号 OAuth 登录与 Token 获取脚本
│   ├── archive-settled-assets.js  # 历史账号数据归档脚本
│   └── run-tests.js               # 单元测试执行器
├── test/                          # 核心注册与认证功能测试集
├── gpt-re.config.json             # 当前运行配置文件 (已脱敏模板)
├── gpt-re.config.example.json     # 完整配置参考示例
├── proxy-pool.txt                 # 静态代理列表文件
├── dynamic-proxy-pools.json       # 动态代理池状态文件
├── start-gpt-re.bat               # Windows 一键启动脚本 (批处理)
├── start-gpt-re.ps1               # Windows PowerShell 启动管理脚本
├── start.bat                      # Windows 快速启动入口
├── start.sh                       # Linux / macOS 启动脚本
├── index.js                       # Node.js 模块导出主入口
└── package.json                   # 项目依赖与 NPM 脚本定义
```

---

## 快速上手

### 1. 环境准备

- **Node.js**: `>= 20.0.0`
- **操作系统**: Windows / Linux / macOS

### 2. 安装依赖

进入 `gpt-register` 根目录：
```bash
npm install --omit=dev
```
> 如需运行前端重新编译或运行完整测试，请运行 `npm install`。

### 3. 配置参数

复制或编辑 `gpt-re.config.json`，填入接码平台密钥及代理配置：
- **短信接码平台配置** (`sms`): 填写 `smsbower` 或 `firefox` 的 `apiKey`。
- **邮件服务配置** (`mail`): 填写对应的邮箱账号密码或 API Token。
- **代理池配置** (`proxyPool`): 在 `proxy-pool.txt` 中写入 HTTP/Socks5 代理（每行一个）。
- **全部代理列表**：代理页面底部可查看当前国家池及本地端口，按国家、厂商、协议和检测结果筛选，搜索地址、端口和已检测出口 IP，后端每页加载 50 条。支持单条、勾选和当前筛选结果测试，每次最多 1000 条、4 条并行，显示进度、出口 IP、连通性及延迟。检测会产生少量代理流量，不执行注册；结果仅代表当时状态并在服务重启后清空，成功不保证目标网站接受该出口。
- **IPRoyal**：采用 IP 白名单免代理账号密码模式，只需 API Token（已加密保存）和在供应商后台授权服务器出口 IP；白名单 IP 可留空自动检测。系统通过官方白名单管理 API 给每个端口配置国家、独立 session 和粘性时间，保存/刷新按供应商实际可用端口容量生成无凭据 HOST:PORT。各国家共享端口容量，目标数量超出时显示实际条数和提示；不复制入口伪造数量。手工白名单和其他项目条目不修改，使用中/冷却中的连接保持原会话，修改参数需稍后刷新。保留 `.runtime/iproyal-credentials.json`、`.runtime/iproyal-whitelist-owner.json` 和主密钥。删除 API 来源、国家池或清空国家池时，同步删除本项目对应来源的供应商白名单并释放端口（包括旧协议留下的自有条目）；手工和其他项目条目保留。使用中的端口阻止删除，空闲/冷却端口可释放；删除中暂停分配，失败保留来源供重试，定时刷新不会重新创建待删除端口。旧账号密码生成接口自动迁移至白名单 API 根地址，旧密钥保留加密但不再使用或回显。
- **国家池参数**：原注册管理台 → 代理 → 国家代理池，可按厂商保存完整的 API 地址（问号前）、条数、协议和会话粘性时间。API 地址默认沿用现有地址，支持更换 http(s)、域名、端口和路径；国家等查询参数由系统自动生成。每次保存会更新并重新拉取该厂商全部已有国家池，国家保持不变；切换厂商或刷新页面仍保留参数。进度区显示成功/失败数量，失败来源保留上次缓存及其实际协议，重试可再次点保存。「构建并拉取」仅操作当前所选国家；保存参数存于动态代理目录文件，不改变正在使用的连接或供应商已发放代理的租期。

### 4. 启动方式

#### 方式 A：启动可视化控制台（推荐）
- **Windows**: 双击 `start.bat` 或运行：
  ```cmd
  .\start-gpt-re.bat
  ```
- **Linux / macOS**:
  ```bash
  chmod +x start.sh
  ./start.sh
  ```
- **通用 NPM 命令**:
  ```bash
  npm start
  ```
启动成功后，浏览器自动打开（或手动访问）: `http://127.0.0.1:3210`。在控制台中可查看实时进度、启动/暂停任务、导入代理、查看成功账号并导出 Token。

#### 方式 B：命令行单账号注册
使用封装脚本直接注册单个账号：
```bash
node scripts/register-one.js --email newuser@example.com --proxy http://127.0.0.1:7890
```

#### 方式 C：命令行 OAuth 登录与 Token 获取
对已有账号执行 OAuth 登录并交换获取 Access Token、Refresh Token、Session 令牌：
```bash
node scripts/oauth-login.js --email user@example.com --password YourPassword123! --proxy http://127.0.0.1:7890
```

#### 方式 D：批量并发自动化任务
```bash
npm run batch
# 或
node bin/gpt-re.js orchestrator-run --config gpt-re.config.json
```

---

## 核心配置说明 (`gpt-re.config.json`)

```json5
{
  "mail": {
    "provider": "smsbower",           // 邮箱提供商: smsbower / mailcom / fastmail / icloud / xiaopingguo
    "password": "YOUR_MAIL_PASSWORD", // 邮箱密码或 API Token
    "timeoutMs": 120000,              // 邮件接收超时 (毫秒)
    "pollIntervalMs": 5000            // 验证码轮询间隔 (毫秒)
  },
  "sms": {
    "provider": "smsbower",           // 短信服务商: smsbower / firefox
    "apiKey": "YOUR_SMS_API_KEY",     // 接码平台 API Key
    "country": {
      "id": 151,
      "name": "Chile"                 // 默认取号国家
    },
    "maxPrice": 0.055                 // 允许的单次接码最高单价 ($)
  },
  "proxyPool": {
    "path": "proxy-pool.txt",         // 静态代理列表路径
    "catalogPath": "dynamic-proxy-pools.json", // 动态代理源文件
    "required": true,                 // 是否必须使用代理
    "healthCheck": {
      "enabled": true,
      "probeUrl": "https://auth.openai.com/"
    }
  },
  "workers": {
    "maxConcurrency": 2               // 注册并发 Worker 线程数
  },
  "registration": {
    "exchangeToken": true,            // 注册成功后是否自动执行 OAuth 令牌交换
    "dynamicSentinel": true,          // 是否启用 Sentinel 动态计算
    "prewarmSentinelSdk": true,       // 预热 Sentinel SDK 缓存
    "browserHeaders": "firefox",      // 请求头拟真模式 (firefox)
    "name": "alex",                   // 注册账号默认姓名
    "birthdate": "2001-01-01"         // 注册账号默认生日
  },
  "output": {
    "stateDir": ".gpt-re-state/v2",   // 任务运行状态目录
    "cpaDir": ".gpt-re-state/v2/output" // 产出账号与凭据保存目录
  }
}
```

---

## 产出物说明

注册成功且完成 OAuth 交换的账号会自动写入 `.gpt-re-state/v2/output/` 目录：
1. **JSON 完整资产包**：包含账号邮箱、密码、Access Token、Refresh Token、Session 状态、TOTP 秘钥、注册时间、国家标签。
2. **Web 控制台导出**：可在控制台页面选择按 CPA 格式（`email----password----refresh_token` 等）、纯 Token 格式或完整 JSON 批量导出。

---

## 验证与测试

在交付部署机器上，可通过运行快速测试集验证当前环境与核心逻辑是否完备：
```bash
npm test
```
全部 58 项核心注册与认证测试用例均应通过。
